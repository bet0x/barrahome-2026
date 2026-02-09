# LLM Proxy (`FastAPI`)

This proxy exposes `POST /v1/chat/completions` and forwards to an upstream OpenAI-compatible endpoint.
It keeps the upstream `URL`, `model`, and `API key` on the server.

It also adds:
- in-memory `session_id` conversation state (append user/assistant turns),
- server-side tool `read_article(article_url)` so the model can read article files directly.

## Install

```bash
pip install fastapi "uvicorn[standard]" httpx pydantic
```

## Run

```bash
export UPSTREAM_API_KEY="sk-..."
export UPSTREAM_BASE_URL="https://api.openai.com"
export UPSTREAM_MODEL="gpt-4o-mini"
export ALLOWED_ORIGINS="https://barrahome.org,https://www.barrahome.org"
export BLOG_CONTENT_ROOT="/path/to/barrahome-2026"
uvicorn scripts.llm_proxy:app --host 127.0.0.1 --port 9000
```

## Optional env vars

- `ALLOW_REQUESTS_WITHOUT_ORIGIN=false`
- `MAX_BODY_BYTES=600000`
- `UPSTREAM_TIMEOUT_SECONDS=45`
- `SESSION_TTL_SECONDS=7200`
- `MAX_SESSION_MESSAGES=24`
- `MAX_ARTICLE_CHARS=140000`

## Request shape from frontend

The frontend should send only the current user question in `messages`, and pass session/article data in `metadata`:

```json
{
  "model": "proxy-managed",
  "messages": [
    {"role": "user", "content": "Explain this article step by step"}
  ],
  "metadata": {
    "session_id": "optional-on-first-turn",
    "article_url": "https://barrahome.org/2026/02/01/nginx-markdown.md",
    "article_title": "Setting up nginx to serve markdown",
    "article_context": "optional initial context for first turn only"
  }
}
```

Response includes:

```json
{
  "...": "...normal chat completions fields...",
  "session_id": "reuse-this-on-next-turn"
}
```

## Frontend config

In the page (or global JS config), point the tutor to the proxy:

```html
<script>
  window.BARRAHOME_TUTOR_API_BASE = "https://barrahome.org/ai-proxy";
</script>
```

Then reverse-proxy `/ai-proxy` to `http://127.0.0.1:9000`.

## Nginx example (`/ai-proxy`)

```nginx
server {
    listen 443 ssl http2;
    server_name barrahome.org www.barrahome.org;

    # ... your existing TLS and site config ...

    location /ai-proxy/ {
        proxy_pass http://127.0.0.1:9000/;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_connect_timeout 10s;
        proxy_send_timeout 90s;
        proxy_read_timeout 90s;

        # Avoid buffering long JSON responses
        proxy_buffering off;
    }
}
```
