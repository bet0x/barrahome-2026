#!/usr/bin/env python3
"""
OpenAI-compatible proxy for /v1/chat/completions with:
- server-side upstream key/model/base URL
- strict Origin allow-list
- in-memory chat sessions
- server tool: read_article(article_url)
"""

import json
import os
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_list(name: str, default: str) -> list[str]:
    raw = os.getenv(name, default)
    return [item.strip() for item in raw.split(",") if item.strip()]


ALLOWED_ORIGINS = _env_list(
    "ALLOWED_ORIGINS",
    "https://barrahome.org,https://www.barrahome.org",
)
ALLOW_REQUESTS_WITHOUT_ORIGIN = _env_bool("ALLOW_REQUESTS_WITHOUT_ORIGIN", False)
MAX_BODY_BYTES = int(os.getenv("MAX_BODY_BYTES", "700000"))
UPSTREAM_BASE_URL = os.getenv("UPSTREAM_BASE_URL", "https://api.openai.com").rstrip("/")
UPSTREAM_API_KEY = os.getenv("UPSTREAM_API_KEY", "")
UPSTREAM_MODEL = os.getenv("UPSTREAM_MODEL", "gpt-4o-mini")
UPSTREAM_TIMEOUT_SECONDS = float(os.getenv("UPSTREAM_TIMEOUT_SECONDS", "45"))

BLOG_CONTENT_ROOT = Path(
    os.getenv("BLOG_CONTENT_ROOT", str(Path(__file__).resolve().parents[1]))
).resolve()
ALLOWED_ARTICLE_YEAR_DIRS = {"2025", "2026"}
MAX_ARTICLE_CHARS = int(os.getenv("MAX_ARTICLE_CHARS", "140000"))

SESSION_TTL_SECONDS = int(os.getenv("SESSION_TTL_SECONDS", "7200"))
MAX_SESSION_MESSAGES = int(os.getenv("MAX_SESSION_MESSAGES", "24"))

TOOL_READ_ARTICLE = {
    "type": "function",
    "function": {
        "name": "read_article",
        "description": "Read a markdown blog article from barrahome.org by URL and return plain text content.",
        "parameters": {
            "type": "object",
            "properties": {
                "article_url": {
                    "type": "string",
                    "description": "Absolute URL of the article, e.g. https://barrahome.org/2026/02/01/nginx-markdown.md",
                }
            },
            "required": ["article_url"],
            "additionalProperties": False,
        },
    },
}

# session_id -> {article_url, article_title, history, last_seen, seeded_once}
SESSIONS: dict[str, dict[str, Any]] = {}

app = FastAPI(title="barrahome LLM Proxy", version="2.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["POST", "OPTIONS", "GET"],
    allow_headers=["Content-Type"],
)


class ChatMessage(BaseModel):
    role: str
    content: str | list[dict[str, Any]]


class ChatCompletionsRequest(BaseModel):
    model_config = ConfigDict(extra="allow")
    model: str | None = None
    messages: list[ChatMessage]
    temperature: float | None = None
    max_tokens: int | None = None
    stream: bool = False
    top_p: float | None = None
    frequency_penalty: float | None = None
    presence_penalty: float | None = None
    user: str | None = None
    metadata: dict[str, Any] | None = None


def _validate_origin(request: Request) -> None:
    origin = request.headers.get("origin", "").strip()
    if not origin:
        if ALLOW_REQUESTS_WITHOUT_ORIGIN:
            return
        raise HTTPException(
            status_code=403,
            detail="Origin header is required for this proxy.",
        )
    if origin not in ALLOWED_ORIGINS:
        raise HTTPException(
            status_code=403,
            detail=f"Origin not allowed: {origin}",
        )


def _cleanup_sessions() -> None:
    now = int(time.time())
    expired = []
    for sid, data in SESSIONS.items():
        if now - int(data.get("last_seen", now)) > SESSION_TTL_SECONDS:
            expired.append(sid)
    for sid in expired:
        SESSIONS.pop(sid, None)


def _safe_article_path(article_url: str) -> Path:
    parsed = urlparse(article_url)
    relpath = unquote(parsed.path).lstrip("/")
    parts = [p for p in Path(relpath).parts if p and p != "."]

    if not relpath or not relpath.endswith(".md"):
        raise HTTPException(
            status_code=400,
            detail="article_url must point to a .md path",
        )

    # Restrict tool file access to year post folders only.
    if not parts or parts[0] not in ALLOWED_ARTICLE_YEAR_DIRS:
        raise HTTPException(
            status_code=403,
            detail="Only /2025/*.md and /2026/*.md are allowed",
        )

    candidate = (BLOG_CONTENT_ROOT / relpath).resolve()
    root = BLOG_CONTENT_ROOT

    if candidate != root and root not in candidate.parents:
        raise HTTPException(status_code=400, detail="Invalid article path")

    if not candidate.exists() or not candidate.is_file():
        raise HTTPException(status_code=404, detail=f"Article not found: {relpath}")

    return candidate


def _read_article(article_url: str) -> str:
    target = _safe_article_path(article_url)
    text = target.read_text(encoding="utf-8", errors="replace")
    if len(text) > MAX_ARTICLE_CHARS:
        text = text[:MAX_ARTICLE_CHARS]
    return text


def _extract_last_user_question(messages: list[ChatMessage]) -> str:
    for msg in reversed(messages):
        if msg.role != "user":
            continue
        if isinstance(msg.content, str):
            question = msg.content.strip()
            if question:
                return question
        else:
            parts = []
            for part in msg.content:
                if isinstance(part, dict):
                    val = part.get("text")
                    if isinstance(val, str):
                        parts.append(val)
            joined = "\n".join(parts).strip()
            if joined:
                return joined
    raise HTTPException(status_code=400, detail="No user message found")


def _extract_assistant_text(response_json: dict[str, Any]) -> str:
    choices = response_json.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    msg = choices[0].get("message") if isinstance(choices[0], dict) else None
    if not isinstance(msg, dict):
        return ""
    content = msg.get("content")
    return content.strip() if isinstance(content, str) else ""


async def _call_upstream(payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    headers = {
        "Authorization": f"Bearer {UPSTREAM_API_KEY}",
        "Content-Type": "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=UPSTREAM_TIMEOUT_SECONDS) as client:
            upstream_response = await client.post(
                f"{UPSTREAM_BASE_URL}/v1/chat/completions",
                headers=headers,
                json=payload,
            )
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=502, detail=f"Upstream request failed: {exc}"
        ) from exc

    content_type = upstream_response.headers.get("content-type", "")
    if "application/json" not in content_type:
        raise HTTPException(
            status_code=502,
            detail=f"Unexpected upstream content-type: {content_type}",
        )

    try:
        data = upstream_response.json()
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=502, detail=f"Invalid JSON from upstream: {exc}"
        ) from exc

    return upstream_response.status_code, data


@app.middleware("http")
async def guard_middleware(request: Request, call_next):
    if request.url.path == "/healthz":
        return await call_next(request)

    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > MAX_BODY_BYTES:
                return JSONResponse(
                    status_code=413,
                    content={"error": "Payload too large"},
                )
        except ValueError:
            return JSONResponse(
                status_code=400,
                content={"error": "Invalid content-length"},
            )

    try:
        _validate_origin(request)
    except HTTPException as exc:
        return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})

    return await call_next(request)


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    return {
        "ok": True,
        "allowed_origins": ALLOWED_ORIGINS,
        "upstream_base_url": UPSTREAM_BASE_URL,
        "upstream_model": UPSTREAM_MODEL,
        "blog_content_root": str(BLOG_CONTENT_ROOT),
    }


@app.post("/v1/chat/completions")
async def chat_completions(payload: ChatCompletionsRequest) -> JSONResponse:
    if not UPSTREAM_API_KEY:
        raise HTTPException(
            status_code=500,
            detail="UPSTREAM_API_KEY is not configured",
        )

    if payload.stream:
        raise HTTPException(
            status_code=400,
            detail="stream=true is not supported by this proxy",
        )

    _cleanup_sessions()

    metadata = payload.metadata or {}
    session_id = str(metadata.get("session_id") or "").strip() or uuid.uuid4().hex
    article_url = str(metadata.get("article_url") or "").strip()
    article_title = str(metadata.get("article_title") or "").strip()
    initial_article_context = str(metadata.get("article_context") or "").strip()

    session = SESSIONS.get(session_id)
    if session is None:
        if not article_url:
            raise HTTPException(
                status_code=400,
                detail="article_url is required when creating a new session",
            )
        session = {
            "article_url": article_url,
            "article_title": article_title,
            "history": [],
            "last_seen": int(time.time()),
            "seeded_once": False,
        }
        SESSIONS[session_id] = session
    else:
        if article_url and article_url != session.get("article_url"):
            # user navigated to another post but reused old session id
            session["article_url"] = article_url
            session["article_title"] = article_title
            session["history"] = []
            session["seeded_once"] = False

    session["last_seen"] = int(time.time())

    question = _extract_last_user_question(payload.messages)
    article_url = str(session.get("article_url") or "")
    article_title = str(session.get("article_title") or "")

    base_messages: list[dict[str, Any]] = [
        {
            "role": "system",
            "content": (
                "You are an expert technical tutor for this specific blog article. "
                "Answer the question directly with concrete details, no meta acknowledgements. "
                "Use read_article(article_url) when you need authoritative article text. "
                "If content is missing, say exactly what is missing."
            ),
        },
        {
            "role": "system",
            "content": (
                f"Current article URL: {article_url}\n"
                f"Current article title: {article_title or 'unknown'}"
            ),
        },
    ]

    if initial_article_context and not session.get("seeded_once"):
        seeded = initial_article_context[:MAX_ARTICLE_CHARS]
        base_messages.append(
            {
                "role": "system",
                "content": "Initial article context provided by client:\n" + seeded,
            }
        )
        session["seeded_once"] = True

    history = list(session.get("history") or [])
    history = history[-MAX_SESSION_MESSAGES:]

    convo_messages = base_messages + history + [{"role": "user", "content": question}]

    upstream_payload: dict[str, Any] = {
        "model": UPSTREAM_MODEL,
        "messages": convo_messages,
        "temperature": payload.temperature if payload.temperature is not None else 0.2,
        "tools": [TOOL_READ_ARTICLE],
        "tool_choice": "auto",
    }
    if payload.max_tokens is not None:
        upstream_payload["max_tokens"] = payload.max_tokens
    if payload.top_p is not None:
        upstream_payload["top_p"] = payload.top_p
    if payload.frequency_penalty is not None:
        upstream_payload["frequency_penalty"] = payload.frequency_penalty
    if payload.presence_penalty is not None:
        upstream_payload["presence_penalty"] = payload.presence_penalty

    status_code, first_response = await _call_upstream(upstream_payload)
    if status_code >= 400:
        first_response["session_id"] = session_id
        return JSONResponse(status_code=status_code, content=first_response)

    assistant_msg = None
    try:
        assistant_msg = first_response["choices"][0]["message"]
    except (KeyError, IndexError, TypeError):
        assistant_msg = None

    final_response = first_response

    tool_calls = []
    if isinstance(assistant_msg, dict):
        raw_tool_calls = assistant_msg.get("tool_calls")
        if isinstance(raw_tool_calls, list):
            tool_calls = raw_tool_calls

    if tool_calls:
        tool_round_messages = convo_messages + [assistant_msg]

        for tool_call in tool_calls:
            fn = (
                (tool_call.get("function") or {}) if isinstance(tool_call, dict) else {}
            )
            fn_name = fn.get("name")
            raw_args = fn.get("arguments") if isinstance(fn, dict) else None
            call_id = tool_call.get("id") if isinstance(tool_call, dict) else None

            tool_result = {"ok": False, "error": "Unsupported tool"}

            if fn_name == "read_article":
                parsed_args: dict[str, Any] = {}
                if isinstance(raw_args, str) and raw_args.strip():
                    try:
                        parsed_args = json.loads(raw_args)
                    except json.JSONDecodeError:
                        parsed_args = {}

                target_url = str(parsed_args.get("article_url") or article_url)
                try:
                    text = _read_article(target_url)
                    tool_result = {
                        "ok": True,
                        "article_url": target_url,
                        "content": text,
                    }
                except HTTPException as exc:
                    tool_result = {
                        "ok": False,
                        "article_url": target_url,
                        "error": str(exc.detail),
                    }

            tool_round_messages.append(
                {
                    "role": "tool",
                    "tool_call_id": call_id,
                    "name": fn_name or "unknown",
                    "content": json.dumps(tool_result, ensure_ascii=True),
                }
            )

        second_payload = {
            "model": UPSTREAM_MODEL,
            "messages": tool_round_messages,
            "temperature": payload.temperature
            if payload.temperature is not None
            else 0.2,
        }
        if payload.max_tokens is not None:
            second_payload["max_tokens"] = payload.max_tokens

        status_code, second_response = await _call_upstream(second_payload)
        second_response["session_id"] = session_id
        if status_code >= 400:
            return JSONResponse(status_code=status_code, content=second_response)
        final_response = second_response

    answer = _extract_assistant_text(final_response)
    session_history = history + [
        {"role": "user", "content": question},
        {"role": "assistant", "content": answer},
    ]
    session["history"] = session_history[-MAX_SESSION_MESSAGES:]
    session["last_seen"] = int(time.time())

    final_response["session_id"] = session_id
    return JSONResponse(status_code=200, content=final_response)
