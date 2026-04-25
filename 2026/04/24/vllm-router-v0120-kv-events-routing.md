# vLLM Router v0.12.0: Routing on Real KV Cache Events

**Published on:** 2026/04/24

**Tags:** vllm, rust, inference, kv-cache, routing, zmq, performance

---

> **Update (2026-04-24):** v0.13.0 ships medium-aware scoring — the gap flagged in the [LMCache section](#lmcache-as-a-publisher) and the [What's Next](#whats-next) list below is now closed. See the [follow-up post](/2026/04/24/vllm-router-v0130-medium-aware-scoring.md).

---

A month after the [v0.8.0 article](/2026/03/22/vllm-router-v080-prompt-cache-and-observability.md), the router has shipped four more releases. The headline of v0.12.0 is a new routing policy — `kv_aware` — that stops guessing what's cached and starts knowing.

This is the fifth article in the series. Earlier ones covered the [initial fork features](/2026/03/05/vllm-router-fork-production-features.md), [LMCache-aware routing](/2026/03/06/vllm-router-lmcache-aware-routing.md), the [enterprise routing philosophy](/2026/03/20/vllm-router-road-to-enterprise-routing.md), and [v0.8.0's prompt cache and dashboard](/2026/03/22/vllm-router-v080-prompt-cache-and-observability.md).

---

## The Problem with Prefix-Cache Heuristics

Every prefix-cache-aware router I've built — `cache_aware`, `lmcache_aware/occupancy`, `lmcache_aware/prefix_lookup` — answers the same question with different precision:

> *"Which decode worker has the most of this prompt's KV cache?"*

The answers form a quality ladder:

- **`cache_aware`** keeps a local radix tree of recent prompts. Fast, but it *infers* what's cached from what passed through. If a worker evicts a block, the tree doesn't know.
- **`lmcache_aware/occupancy`** asks the LMCache controller for aggregate cache fill per worker. Real numbers, but answers the wrong question — high occupancy doesn't mean *your* prompt is cached.
- **`lmcache_aware/prefix_lookup`** asks LMCache for a per-request lookup against your token IDs. Correct, but adds a 200ms HTTP round-trip on every request.

vLLM 0.10+ exposes a fourth option that skips the controller entirely: **the workers themselves publish a ZMQ stream of KV cache events.** Every block stored, every block evicted, every cache flush — pushed in real time as msgpack frames. If the router subscribes to that stream and maintains an index, it doesn't have to *ask* what's cached. It already knows.

That's `kv_aware`.

---

## How It Works

<div class="cde-window">
<div class="cde-window-title"><div class="cde-window-btns"><div class="cde-window-btn">&#9866;</div></div><span>kv_aware Architecture</span><div class="cde-window-btns"><div class="cde-window-btn">&#9634;</div><div class="cde-window-btn">&#10005;</div></div></div>
<div class="cde-window-body">
<div class="mermaid">
graph LR
    C[Client Request] --> R[vLLM Router]
    R --> T[Tokenizer<br/>HF model / local]
    T -->|token IDs| BG[BlockKeyGenerator<br/>chained FNV-1a]
    BG -->|block hashes| PS[PrefixScorer]
    PS -->|reads| IDX[(KVBlockIndex<br/>DashMap&lt;hash, workers&gt;)]
    PS -->|longest prefix| R
    R -->|routes| D1[Decode Worker 1<br/>+ ZMQ PUB :5557]
    R -->|routes| D2[Decode Worker 2<br/>+ ZMQ PUB :5557]
    D1 -->|BlockStored / Removed<br/>msgpack via ZMQ| SUB1[KVEventPool<br/>SUB per worker]
    D2 -->|BlockStored / Removed<br/>msgpack via ZMQ| SUB1
    SUB1 -->|re-hash from token_ids| IDX
    PS -.speculative insert.-> IDX
</div>
</div>
</div>

Each vLLM decode worker runs a ZMQ `PUB` socket on port 5557 (configurable). The router opens a `SUB` socket per worker, decodes the msgpack payload, and updates a global index:

```
DashMap<block_hash, Vec<worker_url>>
```

When a request arrives, the policy:

1. Tokenizes the prompt with the configured tokenizer (HF model ID or local `tokenizer.json`).
2. Splits the token IDs into blocks of `block_size` (must match vLLM's `--block-size`).
3. Hashes each block with a chained FNV-1a — the same algorithm vLLM uses internally, seeded from the previous block's hash so block N's key depends on blocks 0..N.
4. Walks the block hashes against the index. For each block, it intersects the set of workers that have that block with the running set of "still in the prefix" workers. A gap freezes the score — no out-of-order credit.
5. Picks the worker with the longest contiguous prefix. Falls back to least-loaded when no worker matches.

```yaml
mode:
  type: vllm_prefill_decode
  prefill_urls:
    - ["http://prefill1:8081", null]
  decode_urls:
    - "http://decode1:8083"
    - "http://decode2:8084"
  decode_policy:
    type: kv_aware
    block_size: 16
    enable_speculative: true
    speculative_ttl_ms: 2000
  kv_events:
    topic_filter: ""
    default_port: 5557

model_path: "meta-llama/Llama-3.1-8B-Instruct"
```

vLLM side — one flag:

```bash
vllm serve meta-llama/Llama-3.1-8B-Instruct \
  --port 8083 \
  --block-size 16 \
  --kv-events-config '{"enable_kv_cache_events": true}'
```

---

## The Hash Space Has to Match

The trickiest part wasn't the ZMQ plumbing — it was making sure the router's hash of "this prompt's blocks" lives in the same hash space as the worker's hash of "this prompt's blocks."

vLLM emits `BlockStored` events with both `block_hashes` *and* `token_ids`. You'd think you could trust the published hash. You can't always — different vLLM versions and different randomization configurations produce different hashes for the same tokens. So the index updater **re-hashes from `token_ids`** using the router's own `BlockKeyGenerator`:

```rust
const FNV_PRIME: u64 = 1099511628211;
const FNV_BASIS: u64 = 14695981039346656037;
let mut h = FNV_BASIS ^ prev_key.wrapping_mul(FNV_PRIME);
for &tok in tokens {
    h ^= tok as u64;
    h = h.wrapping_mul(FNV_PRIME);
}
```

Deterministic, no random seed, stable across restarts and compiler versions. Both sides — the request scorer (from prompt tokens) and the event ingester (from `BlockStored.token_ids`) — produce the same `u64` for the same block. That's the whole correctness invariant.

The msgpack decoder also turned into a small saga. vLLM serializes events as positional flat arrays — `[tag, field1, field2, ...]` — not maps. And the outer envelope is sometimes a 2-tuple `(timestamp, events)` and sometimes a 3-tuple `(timestamp, events, dp_rank)` depending on whether data-parallel mode is on. The decoder handles both. The ZMQ frame itself can also be 2-part (`topic | payload`) or 3-part (`topic | seq | payload`) depending on vLLM's configuration. Both shapes are accepted.

---

## Speculative Insert: Closing the Race Window

There's a race between routing a request and the `BlockStored` event for that request's new blocks landing on the SUB socket. Without mitigation, two requests with the same long prompt arriving within ~10ms of each other would both "miss" — neither would see the prefix the other just primed.

The fix is to **speculatively insert** the uncached tail blocks into the index for the selected worker, the moment the routing decision is made:

```rust
if self.config.enable_speculative {
    let remaining_hashes = &block_hashes[matched..];
    self.block_index.speculative_insert(
        remaining_hashes,
        best_url,
        Duration::from_millis(2000),  // TTL
    );
}
```

If the real `BlockStored` event arrives within 2 seconds (it always does), the speculative entry is replaced by the confirmed one. If it doesn't (worker died, request failed), the entry expires. The next request with the same prefix gets a hit immediately — no waiting.

This is a one-line policy choice with a non-obvious consequence: it's the difference between sequential cold misses and instant warm hits on bursty traffic.

---

## Comparison

| | `cache_aware` | `lmcache_aware/prefix_lookup` | `kv_aware` |
|--|--|--|--|
| Source of truth | Local radix tree from request flow | LMCache controller HTTP API | vLLM ZMQ event stream |
| Per-request overhead | Tree lookup (microseconds) | HTTP round-trip (~200ms) | Index lookup (microseconds) |
| Knows about evictions | No | Yes | Yes |
| Multi-instance coherence | Optional shared table | Shared by controller | Shared by event stream |
| Mode | Regular + PD | LMCache deployments only | PD only (`vllm_prefill_decode`) |
| Requires tokenizer in router | No | Yes (uses worker's `/tokenize`) | Yes (HF model or local) |
| Requires extra services | No | LMCache controller | None — events are in-band |

The interesting cell is the third row. `cache_aware` infers from request flow, so an evicted block looks identical to a cached one until you try it. `kv_aware` and `lmcache_aware/prefix_lookup` both see evictions, but `kv_aware` does it without an HTTP call and without an external service.

---

## LMCache as a Publisher

`kv_aware` was designed against vLLM's native KV event stream, but [LMCache also publishes the same events](https://docs.lmcache.ai/production/kv_cache_events.html) through vLLM/SGLang's ZMQ infrastructure. Same `BlockStored` payload (`block_hashes`, `parent_block_hash`, `token_ids`, `block_size`, `lora_id`), same transport, same `--kv-events-config` flag — plus an LMCache-side toggle:

```yaml
enable_kv_events: true
pre_caching_hash_algorithm: sha256_cbor_64bit
```

The router doesn't need to care which side produced the event. Because the index updater **re-hashes from `token_ids`** with its own FNV-1a, both publishers land in the same hash space regardless of what `pre_caching_hash_algorithm` LMCache chose. So `kv_aware` works with vLLM-only deployments *and* with LMCache-augmented deployments out of the box.

There's one honest caveat. LMCache adds a `medium` field to the `BlockStored` payload — `GPU`, `CPU`, or `disk` — because it offloads cold blocks to host memory and spills to local NVMe. `kv_aware` v0.12.0 ignores that field and treats every cached block as equivalent. In practice this means: for a deployment running LMCache offload, the router will correctly identify which worker has the most cached prefix, but it will overestimate the wall-clock benefit when the prefix lives on CPU or disk rather than GPU HBM. The routing decision is still better than the alternatives — it just isn't as good as it could be. Medium-aware scoring is the next step (see below).

The other LMCache deployment note: when running multi-worker, **use a non-default hash seed per worker** to avoid duplicate event publication. The router's index dedupes `(block_hash, worker)` pairs, so duplicate events are harmless functionally — but a shared seed across workers can cause hash collisions across distinct content, which is a real routing bug. One seed per worker, set via vLLM's `--kv-events-config`, fixes it.

---

## Rendezvous Hashing: A Better `consistent_hash`

The other notable v0.12.0 policy is `rendezvous_hash` — Highest Random Weight (HRW) hashing. Same session-affinity contract as `consistent_hash` (same headers, same fallback order: `x-semantic-cluster-id` → `x-session-id` → `x-user-id` → body fields → body hash), different math:

```rust
let selected = healthy_indices.iter().max_by_key(|&&idx| {
    let candidate = format!("{}:{}", session_key, workers[idx].url());
    fbi_hash(&candidate)
})?;
```

For each request, hash `session_key + worker_url` for every healthy worker and pick the highest. That's it. No ring data structure, no virtual nodes.

Two practical properties make this a better default than ring-based consistent hashing for inference workloads:

1. **More uniform distribution at low session counts.** With 512 sessions and 3 workers, HRW has roughly 49% lower coefficient of variation than a 100-vnode consistent hash. Inference traffic is rarely web-scale millions-of-keys; you're often routing a few hundred concurrent conversations across a handful of GPU pods, and the ring's uneven distribution shows up.
2. **Minimal redistribution on worker change.** When a worker is added or removed, only sessions that mapped *to that worker* move. With consistent hashing, neighboring keys on the ring also shift. The contract test in the repo asserts this: removing one of three workers moves at most a handful of the 300 test sessions (the ones that were on the removed worker), the rest stay put.

The trade-off is `O(n)` per request vs `O(log n)` for the ring. For typical deployments under 20 workers, the difference is in the noise.

---

## What Else Shipped Between v0.8.0 and v0.12.0

The v0.9 → v0.11 releases are smaller, but worth a name-check since I haven't covered them:

- **v0.9.0 — Multi-tenant API keys.** Per-tenant `rate_limit_rps`, `max_concurrent`, `allowed_models` (with wildcards), independent token buckets, hot reload via `POST /admin/reload`. Keys stored as SHA-256 hashes; plaintext never kept after init. Tenant name in `/admin/decisions` and a new `vllm_router_tenant_*` Prometheus metric family.
- **v0.9.1 — Cache similarity in the response.** The cosine similarity score from semantic cache lookups now leaks out as `x-vllm-router-cache-similarity` and as a `vllm_router_cache_similarity` histogram. Lets you tune similarity thresholds against real distributions instead of guessing.
- **v0.10.0 — Golden tests + tenant access checks for `/v1/messages` and `/v1/responses`.** Two routes were skipping `check_tenant_model_access` while `/v1/chat/completions`, `/v1/completions`, and `/v1/embeddings` were enforcing it. Now they all do. The golden tests cover non-stream and streaming variants of every public route with mock workers.
- **v0.11.0 — Unix domain socket backends.** Workers can be addressed as `unix:///path.sock` instead of `http://host:port`. Eliminates local TCP overhead for same-host deployments and removes the need to expose vLLM ports. A transport-aware HTTP client pool routes each request to the right `reqwest::Client` based on URL scheme. PD modes reject UDS at startup with a clear error — KV cache transfer needs a real `host:port`.

And two upstream backports landed in v0.12.0:

- **`--engine-wait-timeout-secs`** (upstream PR #141, Dr. Kashif Khan) — when set, the router holds incoming requests and polls every second for an available worker instead of returning `503` immediately. Designed for Kubernetes rolling updates of large models where load can take 2–10 minutes; without this the rolling update returns 503s for the entire load window. Default `0` preserves the old behavior.
- **Skip decode-side re-tokenization** (upstream PR #144, kouroshHakha) — in the sequential `NixlConnector` PD path, the prefill request now sets `return_token_ids=true` and the router forwards `prompt_token_ids` directly into the decode request body. One fewer tokenization per PD request.

---

## What Stays Out

The constraint hasn't changed: the fork stays a router. It receives a request, decides which worker handles it, and forwards the traffic. KV events arrive as a stream the router *consumes*; it doesn't manage the cache, doesn't migrate blocks between workers, doesn't orchestrate prefill→decode beyond the existing PD handoff. The vLLM project's [semantic-router](https://github.com/vllm-project/semantic-router) does the orchestration story; that's not what this is.

What `kv_aware` adds is the highest-precision answer to the routing question with the lowest per-request overhead — and it does it in 1,300 lines of Rust across `kv_events/` and `kv_index/`, with 608 tests passing and zero `cargo clippy` warnings.

---

## What's Next

- **Medium-aware scoring (v0.13).** Parse the `medium` field from `BlockStored` events (`GPU` / `CPU` / `disk`), propagate it into `KVBlockIndex` per-worker entries, and weight matched blocks in `PrefixScorer` accordingly — GPU at full credit, CPU at a configurable multiplier, disk near zero. This is the single biggest gap exposed by the LMCache integration and is a concrete next implementation, not a hypothetical.
- **Cross-instance KV index sharing.** Today every router instance maintains its own `KVBlockIndex` from its own ZMQ subscriptions. For multi-instance deployments behind a load balancer, sharing the index (or sharing event consumption) would let all instances agree on prefix→worker mappings without each one ingesting the same event stream N times.
- **`pd_uncached_token_threshold` activation.** The threshold is plumbed through but currently reserved. The intent: if a request's uncached tail is small enough, skip prefill disaggregation entirely and run the whole thing on the decode worker. The router knows the uncached count from the score result; it just needs the routing path that acts on it.
- **Valkey migration.** Still on the list. Still pending more validation under KV cache workloads.

The router is at v0.12.0 with 608 tests, ~1300 lines of new event-driven routing code, and a Docker image tagged `barrahome/vllm-router:v0.12.0`. The [GitHub repo](https://github.com/bet0x/vllm-router) has the full source, configs, docs, and the `vllm-pd-kv-events.yaml` config to copy from.

---

## Sources

- [Fork repository](https://github.com/bet0x/vllm-router) — full source, configs, and docs
- [CHANGELOG.md](https://github.com/bet0x/vllm-router/blob/main/CHANGELOG.md) — detailed release history
- [docs/kv-events-routing.md](https://github.com/bet0x/vllm-router/blob/main/docs/kv-events-routing.md) — kv_aware reference
- [Previous: v0.8.0 prompt cache and dashboard](/2026/03/22/vllm-router-v080-prompt-cache-and-observability.md)
- [vLLM KV events config](https://docs.vllm.ai/en/latest/cli/serve/?h=kv+events+config#-kv-events-config) — `--kv-events-config` flag
- [LMCache KV cache events](https://docs.lmcache.ai/production/kv_cache_events.html) — same event payload, plus the `medium` field for offload tier
