#!/usr/bin/env python3
"""
Minimal OpenAI-compatible proxy for /v1/chat/completions.

Security goals:
- Keep upstream API key/model/base URL only on server.
- Allow browser access only from configured website origins.
"""

import json
import os
from typing import Any

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
MAX_BODY_BYTES = int(os.getenv("MAX_BODY_BYTES", "600000"))
UPSTREAM_BASE_URL = os.getenv("UPSTREAM_BASE_URL", "https://api.openai.com").rstrip("/")
UPSTREAM_API_KEY = os.getenv("UPSTREAM_API_KEY", "")
UPSTREAM_MODEL = os.getenv("UPSTREAM_MODEL", "gpt-4o-mini")
UPSTREAM_TIMEOUT_SECONDS = float(os.getenv("UPSTREAM_TIMEOUT_SECONDS", "45"))


app = FastAPI(title="barrahome LLM Proxy", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["POST", "OPTIONS"],
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
                status_code=400, content={"error": "Invalid content-length"}
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
    }


@app.post("/v1/chat/completions")
async def chat_completions(payload: ChatCompletionsRequest) -> JSONResponse:
    if not UPSTREAM_API_KEY:
        raise HTTPException(
            status_code=500, detail="UPSTREAM_API_KEY is not configured"
        )

    if payload.stream:
        raise HTTPException(
            status_code=400, detail="stream=true is not supported by this proxy"
        )

    upstream_payload = payload.model_dump(exclude_none=True)
    upstream_payload["model"] = UPSTREAM_MODEL

    headers = {
        "Authorization": f"Bearer {UPSTREAM_API_KEY}",
        "Content-Type": "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=UPSTREAM_TIMEOUT_SECONDS) as client:
            upstream_response = await client.post(
                f"{UPSTREAM_BASE_URL}/v1/chat/completions",
                headers=headers,
                json=upstream_payload,
            )
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=502, detail=f"Upstream request failed: {exc}"
        ) from exc

    content_type = upstream_response.headers.get("content-type", "")
    if "application/json" in content_type:
        try:
            data = upstream_response.json()
        except json.JSONDecodeError as exc:
            raise HTTPException(
                status_code=502, detail=f"Invalid JSON from upstream: {exc}"
            ) from exc
        return JSONResponse(status_code=upstream_response.status_code, content=data)

    return JSONResponse(
        status_code=502,
        content={
            "error": "Unexpected upstream content-type",
            "content_type": content_type,
        },
    )
