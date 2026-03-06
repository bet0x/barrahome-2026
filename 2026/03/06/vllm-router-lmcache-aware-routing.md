# LMCache-Aware Routing: When Prefill Workers Stop Being Stateless

**Published on:** 2026/03/06

**Tags:** vllm, rust, lmcache, inference, kv-cache, optimization, performance

---

In my [previous article](/2026/03/05/vllm-router-fork-production-features) I covered the production features in [my vLLM router fork](https://github.com/bet0x/vllm-router): YAML config, response caching, semantic cluster routing, admin API. This article covers the latest addition — and arguably the most consequential one for PD disaggregation: **LMCache-aware routing**.

The core idea is simple: instead of guessing which worker has KV cache (the `cache_aware` approach with a radix tree), ask the system that actually manages the cache. The LMCache controller knows exactly which worker holds how many cached KV chunks. The router polls it and routes accordingly.

But the implications are bigger than a routing improvement. With LMCache-aware routing, **prefill workers are no longer stateless**. The router knows they hold cache state. It routes to preserve it. This changes the fundamental assumption of PD disaggregation.

---

## The Problem With Guessing

The existing `cache_aware` policy in the vLLM router maintains an approximate radix tree. Every time a request is routed to a worker, the router inserts the prompt's token prefix into a per-worker tree. On the next request, it walks the tree to find which worker has the longest matching prefix and routes there.

This works — until it doesn't:

**Evictions are invisible.** When a vLLM worker evicts KV cache entries due to memory pressure, the router's radix tree doesn't know. It still thinks the prefix is there. It routes the request, the worker recomputes from scratch, and you get a cache miss that looks like a cache hit from the router's perspective.

**Multi-instance state diverges.** If you run multiple router instances (which you should, for HA), each builds its own radix tree independently. Their views of cache state drift apart. One router sends multi-turn session requests to worker A, another sends to worker B — both think they're doing cache-aware routing, both are wrong.

**Cold starts are blind.** After a router restart, the radix tree is empty. Every request is a guess until enough history accumulates to rebuild an accurate tree. During this window, cache hit rates drop to near zero.

The `cache_aware` policy also has a complex dual-mode behavior — it switches between cache-based and load-based routing depending on load imbalance. This works but makes the routing behavior harder to predict and debug.

---

## Data-Driven Routing With LMCache

The `lmcache_aware` policy replaces all of this with a single source of truth: the LMCache controller.

<div class="cde-window">
<div class="cde-window-title"><div class="cde-window-btns"><div class="cde-window-btn">&#9866;</div></div><span>LMCache-Aware Routing Architecture</span><div class="cde-window-btns"><div class="cde-window-btn">&#9634;</div><div class="cde-window-btn">&#10005;</div></div></div>
<div class="cde-window-body">
<div class="mermaid">
graph LR
    C[Client Request] --> R[vLLM Router]
    R -->|polls every 10s| LC[LMCache Controller]
    LC -->|ZMQ reports| W1[vLLM Worker 1<br/>+ LMCache]
    LC -->|ZMQ reports| W2[vLLM Worker 2<br/>+ LMCache]
    R -->|routes to best score| W1
    R -->|routes to best score| W2
</div>
</div>
</div>

The architecture has three components:

**LMCache on each vLLM worker** — configured with `enable_controller: true`, each worker reports its cache state to the controller via ZMQ. This includes `key_count` (number of cached KV chunks), heartbeat timestamps, and instance identity.

**LMCache controller** — a lightweight FastAPI service (no GPU needed) that aggregates cache state from all workers and exposes it via HTTP. It runs as a single pod in Kubernetes.

**The router's `lmcache_aware` policy** — spawns an async Tokio task that polls `GET /controller/workers` at a configurable interval. It maintains an in-memory map of `instance_id → key_count` and uses this to score routing decisions.

### The Scoring Formula

For each healthy worker, the policy computes:

```
score = cache_weight * normalized_key_count + (1 - cache_weight) * normalized_inverse_load
```

Where:
- `normalized_key_count` = worker's `key_count` / max `key_count` across all workers
- `normalized_inverse_load` = (max_load - worker_load) / max_load
- `cache_weight` is a tunable parameter (default 0.7, range 0.0–1.0)

The worker with the highest score wins. At `cache_weight=1.0`, routing is purely cache-affinity. At `cache_weight=0.0`, it's purely load-based. The default of 0.7 strongly prefers workers with more cached data but still accounts for load distribution.

```rust
fn compute_score(
    &self,
    worker: &dyn Worker,
    max_key_count: usize,
    max_load: usize,
    instance_id: Option<&str>,
    cache_state: &HashMap<String, WorkerCacheInfo>,
) -> f64 {
    let cache_weight = self.config.cache_weight as f64;
    let load_weight = 1.0 - cache_weight;

    let normalized_cache = if let Some(id) = instance_id {
        if let Some(info) = cache_state.get(id) {
            if max_key_count > 0 {
                info.key_count as f64 / max_key_count as f64
            } else { 0.0 }
        } else { 0.0 }
    } else { 0.0 };

    let normalized_inverse_load = if max_load > 0 {
        (max_load - worker.load().min(max_load)) as f64 / max_load as f64
    } else { 1.0 };

    cache_weight * normalized_cache + load_weight * normalized_inverse_load
}
```

### Graceful Fallback

When the controller is unreachable — timeout, error, not yet deployed — the policy delegates to a configurable fallback (default: `power_of_two`). No error reaches the client. When the controller comes back, routing automatically switches to cache-aware. This makes deployment incremental: you can add the controller later without changing the router config.

---

## Regular Mode: The Simplest Win

The most straightforward use of `lmcache_aware` is in regular (non-PD) mode — multiple vLLM workers behind the router, all serving the same model. No prefill/decode split, just a pool of workers.

```yaml
mode:
  type: regular
  worker_urls:
    - "http://vllm-worker-001:8000"
    - "http://vllm-worker-002:8000"

policy:
  type: lmcache_aware
  controller_url: "http://lmcache-controller:9000"
  poll_interval_secs: 10
  cache_weight: 0.7
  lookup_mode: occupancy
  fallback_policy: "power_of_two"
  controller_timeout_ms: 2000
  lmcache_worker_map:
    "vllm-001": "http://vllm-worker-001:8000"
    "vllm-002": "http://vllm-worker-002:8000"
```

This is the setup that gives you the biggest improvement with the least architectural change. You're already running multiple workers — you already have cache affinity problems. Every multi-turn conversation that lands on a different worker than its previous turn wastes GPU cycles recomputing KV.

With `lmcache_aware` in regular mode:

- Turn 1 goes to Worker 1 (load balanced, both workers are empty)
- LMCache on Worker 1 reports 100 cached chunks to the controller
- Turn 2 arrives — the router polls the controller, sees Worker 1 has 100 chunks, Worker 2 has 10
- Turn 2 routes to Worker 1 — prefix cache hit, skip recomputation

Without it, Turn 2 goes to Worker 2 via round robin or power-of-two — full recomputation.

This is the right starting point for most teams. If you're running multi-turn workloads behind multiple vLLM instances, add the LMCache controller and switch to `lmcache_aware` before even considering PD disaggregation.

---

## Why This Changes PD Disaggregation

In the standard PD disaggregation model, the mental model is clean:

- **Prefill workers** are stateless. Any prefill worker can handle any request. Use load balancing.
- **Decode workers** are stateful. They hold the KV cache across turns. Use session affinity.

This mental model is wrong as soon as you introduce LMCache.

With LMCache enabled, prefill workers **also** hold KV cache. When Worker 1 prefills a request, LMCache stores the computed KV chunks in local CPU memory (and optionally reports them to the controller). If Turn 2 of the same conversation arrives at Worker 1, it gets a prefix cache hit and skips recomputation. If it arrives at Worker 2, it recomputes everything.

**Prefill workers are now stateful.** The question is whether the router knows it.

Without `lmcache_aware`, the answer is no — the router treats prefill workers as interchangeable. With `lmcache_aware`, the router has real visibility into which prefill worker holds cached data for which conversations.

This is the configuration that makes PD disaggregation cache-aware at both layers:

```yaml
mode:
  type: pd_disaggregation
  prefill_urls:
    - "http://prefill-1:8081"
    - "http://prefill-2:8081"
  decode_urls:
    - "http://decode-1:8083"
    - "http://decode-2:8083"

prefill_policy:
  type: lmcache_aware
  controller_url: "http://lmcache-controller:9000"
  poll_interval_secs: 10
  cache_weight: 0.8
  fallback_policy: "power_of_two"
  controller_timeout_ms: 2000
  lmcache_worker_map:
    "prefill-instance-1": "http://prefill-1:8081"
    "prefill-instance-2": "http://prefill-2:8081"

decode_policy:
  type: consistent_hash
  virtual_nodes: 160
```

**Prefill side:** `lmcache_aware` routes to the worker with the most relevant cached KV chunks. In multi-turn conversations, this means Turn 2 goes to the same prefill worker that processed Turn 1 — because the controller reports that worker has 100 cached chunks while others have 10.

**Decode side:** `consistent_hash` with sticky sessions pins each conversation to the same decode worker. This hasn't changed — decode workers accumulate state across turns by design.

<div class="cde-window">
<div class="cde-window-title"><div class="cde-window-btns"><div class="cde-window-btn">&#9866;</div></div><span>PD Disaggregation: Before and After LMCache-Aware</span><div class="cde-window-btns"><div class="cde-window-btn">&#9634;</div><div class="cde-window-btn">&#10005;</div></div></div>
<div class="cde-window-body">
<div class="mermaid">
sequenceDiagram
    participant Client
    participant Router
    participant LC as LMCache Controller
    participant P1 as Prefill Worker 1
    participant P2 as Prefill Worker 2
    participant D1 as Decode Worker
    Client->>Router: Turn 1
    Router->>P1: Route to Prefill 1 (load balanced)
    P1->>D1: Transfer KV cache via NIXL
    Note over P1: LMCache reports 100 chunks to controller
    D1-->>Client: Response
    Client->>Router: Turn 2
    Router->>LC: Poll: P1=100 chunks, P2=10 chunks
    Note over Router: Score P1=0.87, P2=0.23
    Router->>P1: Route to Prefill 1 (cache hit)
    Note over P1: Prefix cache hit, only compute new tokens
    P1->>D1: Transfer incremental KV
    D1-->>Client: Response (faster)
</div>
</div>
</div>

Without `lmcache_aware`, Turn 2 might go to Prefill Worker 2 via round robin or power-of-two — full recomputation, no cache benefit, wasted GPU cycles.

---

## cache_aware vs lmcache_aware

Both policies aim for the same goal — route to the worker with the most relevant cache. They differ fundamentally in how they know where the cache is:

<table>
<tr><th>Aspect</th><th>cache_aware</th><th>lmcache_aware</th></tr>
<tr><td>Cache state source</td><td>Approximate radix tree built from request history</td><td>Real state from LMCache controller</td></tr>
<tr><td>Eviction visibility</td><td>No — tree doesn't know when vLLM evicts</td><td>Yes — controller reflects actual cache occupancy</td></tr>
<tr><td>Multi-router consistency</td><td>No — each router builds its own tree</td><td>Yes — all routers poll the same controller</td></tr>
<tr><td>Cold start behavior</td><td>Empty tree, blind routing until history accumulates</td><td>Polls controller immediately, gets current state</td></tr>
<tr><td>Infrastructure required</td><td>None — runs standalone</td><td>LMCache controller + LMCache on each worker</td></tr>
<tr><td>Load balancing</td><td>Dual-mode: cache-based when balanced, load-based when imbalanced</td><td>Single formula: weighted score with tunable cache_weight</td></tr>
<tr><td>Per-request overhead</td><td>Radix tree lookup (microseconds)</td><td>HashMap read (microseconds) — polling is background</td></tr>
<tr><td>Regular mode</td><td>Works (but guesses)</td><td>Works — simplest and most impactful improvement</td></tr>
<tr><td>PD disaggregation</td><td>Works as prefill policy (guesses)</td><td>Works as prefill policy with real cache visibility</td></tr>
<tr><td>Best for</td><td>Deployments without LMCache, simpler setups</td><td>Any deployment with LMCache: regular or PD, multi-turn workloads</td></tr>
</table>

The `cache_aware` policy isn't obsolete — it's the right choice when you don't have LMCache deployed. It works well enough for many workloads and has zero infrastructure dependencies. But when you have LMCache (which you should if you're running multi-turn at scale), `lmcache_aware` is strictly better because it uses real data instead of approximations.

---

## The Moving Parts

The integration requires three components: an LMCache controller (lightweight FastAPI pod, no GPU), LMCache enabled on each vLLM worker with `enable_controller: true`, and the router configured with `lmcache_aware` policy. The one detail worth highlighting here is the `lmcache_worker_map` — the controller identifies workers by `instance_id` while the router identifies them by URL. The map bridges these two identities. Without it, the router can't correlate cache state to its worker pool and routing degrades to pure load balancing.

Full configuration examples are in the [repository](https://github.com/bet0x/vllm-router): `configs/lmcache-aware.yaml` for regular mode and `configs/pd-lmcache-aware.yaml` for PD disaggregation. The [LMCache integration docs](https://github.com/bet0x/vllm-router/blob/main/docs/lmcache-integration.md) cover prerequisites, Kubernetes manifests, and troubleshooting.

---

## Redis at Two Layers

In my deployment I use Redis at two distinct layers, and it's worth being explicit about why they're different things.

### LMCache + Redis: Distributed KV Cache

LMCache supports a [multi-tier storage hierarchy](https://docs.lmcache.ai/kv_cache/redis.html): GPU memory, CPU DRAM, local disk, and a remote backend. When configured with `remote_url: "redis://host:6379"`, KV cache chunks are serialized and stored in Redis as the outermost tier. This means any worker can pull cached KV chunks from Redis — even if it didn't compute them originally.

This changes the cache locality picture. Without Redis, KV cache is trapped on the worker that computed it. If the router sends Turn 2 to the wrong worker, that worker starts from scratch. With Redis as remote backend, the wrong worker can still pull the KV from Redis — it's slower than a local CPU cache hit, but faster than full recomputation.

**Does this make `lmcache_aware` routing unnecessary?** No. The storage hierarchy matters:

<table>
<tr><th>Cache Location</th><th>Latency</th><th>What Triggers It</th></tr>
<tr><td>Local GPU memory</td><td>&lt;1us</td><td>Same worker, same session, still in VRAM</td></tr>
<tr><td>Local CPU DRAM</td><td>~10us</td><td>Same worker, evicted from GPU, still in RAM</td></tr>
<tr><td>Redis (remote)</td><td>~1ms</td><td>Any worker, fetched over network</td></tr>
<tr><td>Recomputation</td><td>~100ms+</td><td>Cache miss everywhere</td></tr>
</table>

Routing to the worker that has the KV in local CPU (~10us) is still two orders of magnitude faster than pulling from Redis (~1ms). And Redis pulls add network traffic that scales with context length. `lmcache_aware` routing minimizes Redis fallback by preferring workers with local cache. Redis is the safety net, not the primary path.

I'm currently running Redis for both layers, but my intention is to migrate to [Valkey](https://github.com/valkey-io/valkey) after more extensive testing. Valkey is the open-source fork of Redis (post-license change), wire-compatible, and backed by the Linux Foundation. The LMCache and router Redis clients use standard Redis protocol — the migration should be a URL swap, but I want to validate performance under KV cache workloads before committing.

For my LMCache + Redis setup, see my [previous article on LMCache + Redis](/2026/02/08/lmcache-redis-distributed-kv-cache).

### Router + Redis: Response Caching

Separately, the router fork supports Redis as a [response cache backend](/2026/03/05/vllm-router-fork-production-features). This is an entirely different use case: caching complete LLM responses (not KV chunks) so that identical requests return instantly without touching any vLLM worker. When running multiple router instances, a shared Redis cache ensures deduplication across all instances.

These two Redis uses are complementary:
- **LMCache Redis** prevents KV recomputation across workers (inference-level optimization)
- **Router Redis** prevents duplicate inference entirely for repeated prompts (request-level optimization)

---

## Two Phases

### Phase 1: Occupancy Routing (implemented)

`lookup_mode: occupancy`

The router polls `GET /controller/workers` at the configured interval. Each worker's total `key_count` (number of cached KV chunks across all sessions) is used for scoring. Workers with more cached data are preferred.

This is a coarse signal — it tells you "Worker 1 has more cache than Worker 2" but not "Worker 1 has cache for this specific conversation". In practice, it's still far better than guessing because it reflects real state including evictions, and in multi-turn workloads the worker with the most cache is usually the one that processed your previous turns.

### Phase 2: Prefix Lookup (not yet implemented)

`lookup_mode: prefix_lookup`

The config accepts this value and the plumbing exists (`needs_request_text()` returns true in this mode), but the actual `POST /lookup` call to the controller is **not implemented yet**. Today, setting `lookup_mode: prefix_lookup` will not give you per-request prefix matching — routing still uses the occupancy-based scoring.

The design for Phase 2: per-request `POST /lookup` to the controller with the tokenized prompt. The controller already exposes this endpoint in LMCache (`lmcache.v1.api_server`):

```
POST /lookup
{"tokens": [1, 2, 3, 4, 5, ...]}

Response:
{"layout_info": {"vllm-001": ["LocalCPUBackend", 768]}}
```

The `layout_info` maps `instance_id` to `(location, matched_token_count)`. This gives exact prefix-match routing — "Worker vllm-001 has 768 tokens cached for this exact prefix."

**What's needed to implement it:**
- The router needs to tokenize the incoming prompt before the lookup call. The tokenizer must produce the same token IDs as vLLM/LMCache (same HuggingFace model). The fork already supports HuggingFace, TikToken, and SentencePiece tokenizers.
- The `select_worker_with_headers` method needs to call `POST /lookup` with the token IDs and use the `matched_token_count` as the cache score instead of `key_count`.
- Latency budget: the lookup adds a per-request HTTP call, mitigated by `controller_timeout_ms`.

Phase 2 is where `lmcache_aware` will become qualitatively different from any other routing policy — routing based on actual cached content for the specific incoming request, not aggregate occupancy.

---

## Practical Takeaways

- **Start with regular mode.** If you have multiple vLLM workers behind a router, `lmcache_aware` in regular mode is the simplest and highest-impact change. You don't need PD disaggregation to benefit.
- **Start with Phase 1 (occupancy).** It requires zero changes to the tokenizer setup and gives you the biggest improvement over `cache_aware` or `power_of_two` — real cache visibility instead of guessing.
- **Use `cache_weight: 0.7` as default.** This strongly prefers cached workers but doesn't create hot spots. Tune down to 0.5 if you see load imbalance.
- **Set `fallback_policy: "power_of_two"`.** If the controller goes down, this is the best general-purpose fallback. The transition is transparent to clients.
- **Always configure `lmcache_worker_map`.** Without it, the routing degrades to pure load balancing because the router can't correlate controller data to its workers.
- **For PD mode: `lmcache_aware` for prefill, `consistent_hash` for decode.** This is the recommended production configuration when you do need PD disaggregation with multi-turn workloads.
- **Monitor cache hit rates.** The router exports per-policy Prometheus metrics. Compare cache hit rates between `cache_aware` and `lmcache_aware` before and after deployment.
- **The controller is lightweight.** It needs 500m CPU and 512Mi memory. Don't skip deploying it because you think it's heavy — it's cheaper than the GPU cycles you waste on cache misses.

---

## What's Next

**Phase 2 (prefix lookup)** is the priority. The LMCache controller already exposes the `/lookup` endpoint — the missing piece is the router-side implementation: tokenize the prompt, call the endpoint, use the matched token count for scoring. The plumbing exists; the logic doesn't yet.

Once implemented, combined with P2P cache sharing between LMCache instances, the end state looks like:

1. The router tokenizes the incoming prompt and asks the controller which worker has the longest cached prefix
2. Routes to that worker — exact prefix cache hit
3. If no single worker has the full prefix, LMCache can pull missing chunks from another worker via P2P (NIXL)
4. The decode worker receives the KV cache and continues generation

That's the end state for cache-aware routing: real state, exact matching, cross-worker sharing.

---

## Sources

- [Fork repository](https://github.com/bet0x/vllm-router) — full source code and configs
- [LMCache project](https://github.com/LMCache/LMCache) — the KV cache management system
- [Previous article: vLLM Router fork features](/2026/03/05/vllm-router-fork-production-features)
- [vLLM Router and PD Disaggregation](/2026/02/07/vllm-router-pd-disaggregation) — background on cache-aware routing
- [LMCache + Redis: Distributed KV Cache](/2026/02/08/lmcache-redis-distributed-kv-cache) — LMCache deep dive
