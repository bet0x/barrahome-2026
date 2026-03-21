# vLLM Router v0.7.x: The Road to Enterprise Routing

**Published on:** 2026/03/20

**Tags:** vllm, rust, inference, observability, enterprise, routing

---

Since the [LMCache-aware routing article](/2026/03/06/vllm-router-lmcache-aware-routing.md) three things happened: Phase 2 shipped, the routing layer got observability, and I started thinking about what "enterprise routing" actually means for an inference router — without turning it into something it's not.

This is the third article in the series. The [first](/2026/03/05/vllm-router-fork-production-features.md) covered the fork's initial production features. The [second](/2026/03/06/vllm-router-lmcache-aware-routing.md) covered LMCache-aware routing and how it changes PD disaggregation. This one covers the v0.6.11 through v0.7.1 releases and the philosophy behind them.

---

## Phase 2 Shipped: Prefix Lookup Routing

In the last article I was explicit: Phase 2 (prefix lookup) was **not implemented**. The config plumbing existed but the actual `POST /lookup` call to the LMCache controller wasn't wired up.

It is now. Since v0.6.11, `lookup_mode: prefix_lookup` does what it promises — per-request lookup of the longest cached KV prefix:

1. The incoming prompt is tokenized via the vLLM worker's own `/tokenize` endpoint (with chat template applied), ensuring token IDs match exactly what LMCache stores
2. The router sends `POST /lookup` to the controller with the token IDs
3. The controller responds with `layout_info`: which worker holds how many matching tokens
4. The worker with the longest cached prefix gets the request

The scoring changes from occupancy mode's aggregate `key_count` to per-request `matched_token_count`. This is the difference between "Worker 1 has more cache overall" and "Worker 1 has 768 tokens cached for *this specific prompt*."

```yaml
policy:
  type: lmcache_aware
  controller_url: "http://lmcache-controller:9000"
  lookup_mode: prefix_lookup
  cache_weight: 0.8
  fallback_policy: "power_of_two"
  controller_timeout_ms: 2000
```

When the lookup fails or returns no match, the policy falls back to occupancy scoring — not blind load balancing. This makes the transition safe: you don't lose the Phase 1 behavior, you add precision on top of it.

The latency cost is one HTTP round-trip per request to the controller, bounded by `controller_timeout_ms`. In practice, the controller responds in under 5ms. The cache hit savings (skipping prefix recomputation) dwarf this cost by orders of magnitude.

---

## What Enterprise Routing Actually Means

There's a temptation to keep bolting features onto a router until it becomes an inference platform. The vLLM project already has a [semantic-router](https://github.com/vllm-project/semantic-router) that goes in that direction — it's a more complex system with broader scope. I don't want to build that. The fork stays a **router**: it receives requests, decides which worker handles them, and forwards the traffic. Every feature I add has to earn its place within that boundary.

With that constraint, "enterprise routing" means four things:

1. **Explainability** — you can answer "why did this request go to that worker?"
2. **Auditability** — you can replay routing decisions against different configurations
3. **Extensibility** — you can plug in safety checks without modifying router code
4. **Observability** — you can trace a request across the entire routing pipeline

The v0.7.0 and v0.7.1 releases address all four.

---

## Routing Explainability

Every response now includes headers that explain the routing decision:

<table>
<tr><th>Header</th><th>Example Value</th><th>Meaning</th></tr>
<tr><td><code>x-vllm-router-worker</code></td><td><code>http://vllm-worker-001:8000</code></td><td>Which worker handled the request</td></tr>
<tr><td><code>x-vllm-router-method</code></td><td><code>policy</code></td><td>How the route was decided: <code>cache-hit</code>, <code>semantic-hit</code>, <code>cluster</code>, <code>lmcache-prefix</code>, or <code>policy</code></td></tr>
<tr><td><code>x-vllm-router-policy</code></td><td><code>power_of_two</code></td><td>Which policy selected the worker (when method=policy)</td></tr>
<tr><td><code>x-vllm-router-model</code></td><td><code>meta-llama/Llama-3.1-70B</code></td><td>The model that was routed to (after any rewrite rules)</td></tr>
<tr><td><code>x-vllm-router-cache-status</code></td><td><code>miss</code></td><td><code>exact-hit</code>, <code>semantic-hit</code>, or <code>miss</code></td></tr>
<tr><td><code>x-vllm-router-hooks</code></td><td><code>content-safety,pii-mask:transformed</code></td><td>Which hooks ran and their outcome</td></tr>
</table>

This is enabled by default (`expose_routing_headers: true`). You can disable it if you don't want to leak internal topology to clients.

Why this matters: when a request is slow and you need to debug, the first question is always "where did it go?" These headers answer that without digging through logs. When a request hits the response cache instead of a worker, you see `method: cache-hit`. When LMCache prefix lookup routes to a specific worker, you see `method: lmcache-prefix`. No ambiguity.

---

## Decision Export and Replay

Routing explainability tells you what happened per-request. Decision export gives you the full history.

```yaml
decision_log:
  export_path: "/var/log/vllm-router/decisions.jsonl"
  export_interval_secs: 10
  include_request_text: false
```

Every routing decision is logged to an in-memory ring buffer (1000 entries) and periodically flushed to a JSONL file. Each record captures the timestamp, request route, model, method, policy, worker, cache status, HTTP status, and latency.

The interesting part is the **replay** subcommand:

```bash
vllm-router replay \
  --decisions /var/log/decisions.jsonl \
  --config configs/new-policy.yaml
```

This re-evaluates every historical routing decision against a different configuration. The output tells you: "If you had been using `power_of_two` instead of `round_robin`, 87% of requests would have gone to the same worker, 13% would have been different." It also shows latency distribution from the original run.

This is how you make evidence-based policy decisions. Instead of guessing whether `lmcache_aware` would improve your workload, capture a day of `round_robin` decisions, replay them against `lmcache_aware`, and compare. The data answers the question.

---

## Pre-Routing Hooks

Sometimes you need to check a request before routing it — content safety, PII detection, custom validation. The traditional approach is to put a proxy in front of the router. That works but adds latency and another service to manage.

Pre-routing hooks move this into the routing pipeline:

```yaml
pre_routing_hooks:
  - name: "content-safety"
    url: "http://safety-service:9001/check"
    timeout_ms: 200
    on_error: pass
    on_reject: block403
    transform: false
```

The router POSTs the request body to each hook URL in order. Each hook responds with `allow`, `reject`, or `transform`. A rejection stops the chain and returns 403 or 400 to the client. A transform replaces the request body (e.g., PII masking) before routing continues.

The key design decision is **graceful degradation**: `on_error: pass` means if the safety service is down, requests flow through. `on_error: block` means if the safety service is down, requests are rejected. You choose your failure mode per hook.

Hook outcomes appear in the `x-vllm-router-hooks` response header, so you can see exactly which hooks ran and whether any transformed the request.

---

## Model Aliasing and Fallback

When you expose an inference endpoint to internal teams, you don't always want them coupling to the exact HuggingFace model ID. Model rules let you decouple the external name from the internal model:

```yaml
model_rules:
  - match: "gpt-4"
    rewrite: "meta-llama/Llama-3.1-70B"

  - match: "openai/*"
    rewrite: "local-llama-70b"

  - match: "llama-70b"
    fallback:
      - "meta-llama/Llama-3.1-70B-FP8"
      - "meta-llama/Llama-3.1-8B-FP8"
```

Exact match, wildcard suffix (`openai/*`), and fallback chains. A fallback chain tries each model in order and routes to the first one with healthy workers. If no candidate is healthy, the original model name passes through unchanged.

This runs before cache key computation, so the entire pipeline — caching, routing, logging — sees the canonical model name. Model swaps are a config change, not a client change.

---

## OpenTelemetry Tracing

v0.7.1 adds opt-in distributed tracing via OTLP:

```yaml
trace_config:
  otlp_traces_endpoint: "localhost:4317"
  sampling_ratio: 1.0
  excluded_paths:
    - "/health"
    - "/liveness"
    - "/readiness"
```

This is a backport of upstream work by Andrew Bennett at Meta. The core init/layer is integrated — spans are emitted for hook execution, cache lookups, embedding fetches, cluster routing, and worker forwarding. Full request-level span instrumentation (middleware trace context extraction, outbound header injection, PD phase spans) will follow incrementally.

The router propagates W3C TraceContext headers (`traceparent`, `tracestate`) on outgoing requests, so traces connect across the router into the vLLM workers. Even when OTel is disabled, incoming trace headers are forwarded to preserve trace continuity.

---

## Admin State Endpoints

Three new read-only endpoints for runtime inspection:

- `GET /admin/config` — active configuration with secrets redacted (`api_key`, `admin_api_key`, `worker_api_keys` all show as `***`)
- `GET /admin/stats` — cache entries, worker health counts (total, healthy, draining), policy assignments, uptime, decisions logged
- `GET /admin/decisions?limit=50` — recent routing decisions from the in-memory ring buffer

These complement the existing `POST /admin/drain` and `POST /admin/reload` endpoints. Together they give you a complete operational surface: inspect state, drain workers, reload config, export decisions — all without restarting the router.

---

## Upstream Backports

Not everything is net-new. Two upstream fixes came back in v0.7.1:

**Consistent hash header priority** — `x-correlation-id` is now checked before `x-request-id` when building the consistent hash key. This matters for multi-turn conversations: the correlation ID is stable across turns, so it routes all turns to the same worker for cache reuse.

**v0.6.10 backports** — `DPAwareWorker` for data-parallel mode, `DefaultBodyLimit` for multimodal requests with large base64 images, `/v1/responses` transparent proxy in PD mode, and tool message `content` as `Value` to preserve array content.

---

## The Line I Won't Cross

There are features I deliberately keep out. The vLLM project's [semantic-router](https://github.com/vllm-project/semantic-router) handles workflow orchestration, multi-step reasoning pipelines, and complex routing graphs. Those are valuable, but they make the system something different — an inference orchestrator.

The fork stays a router. It receives a request, decides which worker gets it, and forwards the traffic. Pre-routing hooks are the outermost extension point, and they're intentionally limited to allow/reject/transform — not "execute a multi-step pipeline." Model rules rewrite names, not routing graphs. Decision replay compares policies, not workflows.

This constraint is the feature. A router that's just a router is easier to operate, easier to reason about, and easier to replace if something better comes along. The complexity budget goes into making routing decisions well — real cache state, explainable decisions, evidence-based policy selection — not into becoming a platform.

---

## Contract Hardening (v0.7.2)

The same day as v0.7.1, I cut v0.7.2. No new features — just formalization of the contracts introduced in v0.7.0.

**OTel span contract** — 7 child spans in the routing pipeline (`hooks.pipeline`, `hook.execute`, `cache.exact_lookup`, `cache.semantic_lookup`, `embedding.fetch`, `routing.cluster`, `worker.forward`) are now defined as `SPAN_*` constants with an `ALL_SPAN_NAMES` slice. External dashboards can depend on these names without worrying about renames.

**Hook protocol tests** — 18 tests covering every hook outcome: allow, reject (403/400/pass), transform (with/without body, when disabled), timeout, non-200, invalid JSON, connection refused, unknown action, and multi-hook chain ordering.

**Decision log schema v2** — added `schema_version` and `hooks_ran` fields. Backward-compatible: v1 records without `schema_version` deserialize with default `1`. `REQUIRED_FIELDS` and `ALL_FIELDS` constants for external validation tooling.

**Explainability header contract** — `HEADER_*` constants and `ALL_EXPLAINABILITY_HEADERS` slice with 6 contract tests verifying header injection across policy, cache-hit, cluster, and minimal decision scenarios.

34 new tests in this release alone, 524 passing total. This is what "enterprise" means in practice: not more features, but formalized contracts that external tooling can rely on without fear of breaking changes.

---

## What's Next

**Request-level OTel spans** — the tracing foundation is in place, but full per-request instrumentation (middleware context extraction, outbound header injection, PD phase spans) is the next incremental step.

**Valkey migration** — I'm still running Redis for both LMCache KV cache and router response cache. Valkey is the target after more extensive performance validation under KV cache workloads.

**Policy registry for external policies** — the `PolicyFactory` now uses a registry pattern internally. The next step is exposing this for external plugins: compile a custom policy as a Rust crate, register it at startup, reference it by name in YAML. No fork needed for custom routing logic.

---

## Sources

- [Fork repository](https://github.com/bet0x/vllm-router) — full source, configs, and docs
- [CHANGELOG.md](https://github.com/bet0x/vllm-router/blob/main/CHANGELOG.md) — detailed release history
- [Previous: LMCache-aware routing](/2026/03/06/vllm-router-lmcache-aware-routing.md)
- [Previous: fork production features](/2026/03/05/vllm-router-fork-production-features.md)
- [LMCache project](https://github.com/LMCache/LMCache)
