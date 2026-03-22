# vLLM Router v0.8.0: Prompt Cache, Shared Prefix Routing, and a Dashboard

**Published on:** 2026/03/22

**Tags:** vllm, rust, inference, cache, grafana, monitoring, performance

---

Two days after the [enterprise routing article](/2026/03/20/vllm-router-road-to-enterprise-routing.md), I shipped three more releases. The v0.7.x series added the observability and extensibility primitives. v0.8.0 takes those primitives and puts them to work: making the router measurably faster and operationally visible.

This is the fourth article in the series. The [first](/2026/03/05/vllm-router-fork-production-features.md) covered the fork's initial features. The [second](/2026/03/06/vllm-router-lmcache-aware-routing.md) covered LMCache-aware routing. The [third](/2026/03/20/vllm-router-road-to-enterprise-routing.md) covered the enterprise routing philosophy.

---

## The Problem: 300ms of Routing Overhead

The LMCache prefix lookup path — which is the smartest way to route requests in a multi-worker deployment — has an unavoidable overhead:

```
Client → Router → POST /tokenize (100ms) → POST /lookup (200ms) → Worker
```

100ms to tokenize the prompt via a vLLM worker (because LMCache stores KV cache keyed by template-applied token IDs, not raw text). 200ms to query the LMCache controller for which worker has the longest cached prefix.

That's 300ms before the first token of actual inference. For system prompts that repeat on 90%+ of production requests, the tokenization step is pure waste — same input, same output, every time.

---

## Token ID Cache: 100ms → <1ms

The fix is obvious once you see it: cache the tokenization result.

```yaml
prompt_cache:
  backend: redis
  ttl_secs: 3600
```

On the first request with a given prompt, the router tokenizes via HTTP as before and stores the result in Redis: `FNV-1a(canonical_json(messages + model)) → token_ids`. On subsequent requests with the same prompt, the router skips the HTTP call entirely.

The cache key uses the same canonicalization as the response cache — stripping `stream`, `user`, and `request_id` before hashing — so a streaming and non-streaming variant of the same prompt share the same cached tokens.

**Impact**: For repeated system prompts (the common case in production), tokenization drops from 100ms to sub-millisecond. The routing overhead goes from 300ms to ~200ms — a 33% reduction. For batch inference or chatbot deployments where the system prompt is identical across all users, the hit rate approaches 100% after warmup.

The token cache supports both in-memory (`DashMap`) and Redis backends. Redis is recommended for multi-instance deployments so all router instances share the warm cache.

---

## Shared Prefix Routing: From 1/N to 100% Cache Utilization

The `cache_aware` policy maintains a radix tree that tracks which worker has which prompt prefix cached. It's fast (O(prefix_length) lookup, lock-free reads) and it works — for a single router instance.

The problem: in a multi-instance deployment with N routers behind a load balancer, each router independently learns prefix→worker mappings. Router A routes "Write a Python function..." to worker-1 and learns the mapping. Router B receives the same prompt but doesn't know about Router A's tree — it routes to worker-3 based on minimum load. The KV cache on worker-1 goes unused.

```yaml
shared_prefix_routing:
  prefix_chars: 256
  ttl_secs: 300
  write_probability: 0.1
  backend: memory    # or redis for cross-instance
```

The shared prefix table supplements the local tree with a cross-instance layer. On every routing decision, if the local tree doesn't have a strong match, the router checks the shared table before falling back to load-based selection. Writes are probabilistic (10% by default) to avoid saturating Redis.

**Impact**: In an N-instance deployment, cache utilization goes from ~1/N (each instance learning independently) to approaching 100% (all instances sharing prefix knowledge). For a 4-instance deployment, that's a theoretical 4x improvement in KV cache hit rate.

The local radix tree stays authoritative — the shared table is a hint, not a source of truth. If the suggested worker is unhealthy, the router falls back gracefully. If Redis is down, routing continues with the local tree. Zero-risk addition.

---

## Grafana Dashboard: From "Check the Logs" to "Look at the Dashboard"

Prior to v0.8.0, the router had 67 Prometheus metrics but no way to see them without writing PromQL queries by hand. Now:

```bash
cd monitoring && docker compose up -d
open http://localhost:3001/d/vllm-router/vllm-router
```

The pre-provisioned dashboard has 18 panels organized in 6 sections:

**Overview** — the stats you check first: active workers, request rate, P99 latency, error rate, cache hit ratio, retry pressure. All stat panels with `or vector(0)` fallback so they show "0" instead of "No data" when nothing has happened yet.

**Request Traffic** — requests/sec by route and latency percentiles (P50/P95/P99) over time. The latency histogram uses the same buckets as the router's internal tracking.

**Workers** — per-worker request rate, total processed requests, and circuit breaker state. The circuit breaker panel uses value mappings: 0 = Closed (green), 1 = Open (red), 2 = Half-Open (yellow).

**Routing Decisions** — distribution of routing methods (policy, cluster, cache-hit, lmcache-prefix) and which policy routed to which worker.

**Cache & Prefix** — three side-by-side panels for the response cache, token cache, and shared prefix table. Empty when those features aren't active.

**Reliability** — retries, circuit breaker outcomes, and errors by type. The retries panel shows both retry attempts and exhausted retries.

### A Fix That Was Hiding

While building the dashboard, I discovered that `vllm_router_cache_hits_total` and `vllm_router_cache_misses_total` were **never actually recorded**. The metrics were defined in `metrics.rs` and the cache was working (you could see `x-vllm-router-cache-status: exact-hit` in the response headers), but nobody called `RouterMetrics::record_cache_hit()` from the routing code. Fixed in v0.8.0. This is the value of operational visibility — you can't improve what you can't measure, and you can't measure what you forgot to instrument.

---

## Performance Summary

| Scenario | Before v0.8.0 | After v0.8.0 | Improvement |
|----------|--------------|--------------|-------------|
| Repeated prompts | Full inference | Sub-ms cache hit | 200x+ |
| LMCache tokenization | 100ms HTTP per request | <1ms cache lookup | 100x |
| LMCache routing overhead | 300ms total | ~200ms | 33% reduction |
| Multi-instance prefix awareness | 1/N utilization | Shared across N | Up to Nx |
| Operational visibility | Logs + manual PromQL | 18-panel Grafana dashboard | Qualitative |

These are routing-layer numbers. The actual end-to-end latency improvement depends on the inference time of your model, which the router doesn't control. But for workloads with repeated system prompts (most production chatbot deployments), the response cache alone can eliminate inference entirely — turning a 200ms+ inference call into a sub-millisecond cache hit.

---

## What's Next

The foundation is solid: explainability headers, admin state endpoints, model aliasing, pre-routing hooks, decision export/replay, token cache, shared prefix routing, OTel tracing, and now a complete monitoring stack.

The remaining gaps from the [gap plan](/2026/03/20/vllm-router-road-to-enterprise-routing.md) are smaller:

- **Redis prefix table for cross-host sharing** — the memory table works for single-host multi-instance (behind a load balancer), Redis is needed for true multi-host
- **Valkey migration** — Redis works, but Valkey is the open-source future

The router is at v0.8.0 with 529 tests, 67+ Prometheus metrics, and zero `cargo clippy` warnings. The [GitHub repo](https://github.com/bet0x/vllm-router) has the full source, configs, docs, and monitoring stack.

