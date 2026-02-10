# vLLM router: why prefix-cache-aware routing matters for PD disaggregation

**Published on:** 2026/02/07

**Tags:** vllm, linux, performance, tutorial

If you're running vLLM at any reasonable scale with prefill-decode (PD) disaggregation, you've probably hit the same wall: multi-turn conversations kill your KV cache hit rates. The prefill node generates the KV cache, sends it over to the decode node via KVConnector, and everything looks fine on the first turn. By the second or third turn, your cache hit rate is in the floor and both throughput and latency degrade noticeably.

This is not a bug. It's a consequence of how requests get distributed when you don't account for where the cache already lives.

## The problem

In a standard PD disaggregation setup, the flow looks like this:

<div class="cde-window">
<div class="cde-window-title"><div class="cde-window-btns"><div class="cde-window-btn">&#9866;</div></div><span>Round Robin Routing - The Problem</span><div class="cde-window-btns"><div class="cde-window-btn">&#9634;</div><div class="cde-window-btn">&#10005;</div></div></div>
<div class="cde-window-body">
<div class="mermaid">
sequenceDiagram
    participant Client
    participant LB as Load Balancer
    participant P1 as Prefill Node 1
    participant P2 as Prefill Node 2
    participant D1 as Decode Node
    Client->>LB: Turn 1 - "What is KV caching?"
    LB->>P1: Route to Prefill Node 1
    P1->>D1: Transfer KV cache via KVConnector
    D1-->>Client: Response
    Client->>LB: Turn 2 - "Explain more about eviction"
    LB->>P2: Route to Prefill Node 2 (round robin)
    Note over P2: No prefix cache from Turn 1!
    P2->>D1: Full recomputation + transfer
    D1-->>Client: Response (slower)
</div>
</div>
</div>

The load balancer doesn't know or care that Prefill Node 1 already has the prefix cache from Turn 1. It just picks the next available worker. So Prefill Node 2 has to recompute the entire prefix from scratch. Multiply this by thousands of concurrent multi-turn sessions and you get a significant performance hit.

The core issue is simple: **your load balancer is cache-unaware**.

## What prefix-cache-aware routing does

Instead of distributing requests blindly, a cache-aware router tracks which prefill worker has processed which conversation prefix. When Turn 2 arrives, the router knows that Prefill Node 1 already holds that prefix in its KV cache and sends the request there.

<div class="cde-window">
<div class="cde-window-title"><div class="cde-window-btns"><div class="cde-window-btn">&#9866;</div></div><span>Cache-Aware Routing - The Solution</span><div class="cde-window-btns"><div class="cde-window-btn">&#9634;</div><div class="cde-window-btn">&#10005;</div></div></div>
<div class="cde-window-body">
<div class="mermaid">
sequenceDiagram
    participant Client
    participant Router as Cache-Aware Router
    participant P1 as Prefill Node 1
    participant P2 as Prefill Node 2
    participant D1 as Decode Node
    Client->>Router: Turn 1 - "What is KV caching?"
    Router->>P1: Route to Prefill Node 1
    P1->>D1: Transfer KV cache
    D1-->>Client: Response
    Client->>Router: Turn 2 - "Explain more about eviction"
    Note over Router: Prefix match found on P1
    Router->>P1: Route back to Prefill Node 1
    Note over P1: Cache hit - only compute new tokens
    P1->>D1: Transfer incremental KV cache
    D1-->>Client: Response (faster)
</div>
</div>
</div>

The difference is substantial. Instead of recomputing the full prompt on every turn, you only compute the delta. For a conversation that's 10 turns deep with a long system prompt, you're saving a lot of compute.

## Existing solutions

There are currently three notable implementations that tackle this problem. Each takes a different approach but solves the same fundamental issue.

### vllm-project/router

The [vLLM router](https://github.com/vllm-project/router) is a standalone Rust-based request router built specifically for vLLM deployments. It sits between clients and vLLM workers and supports five routing strategies:

- **Round Robin** - sequential, no affinity
- **Random** - uniform selection, no affinity
- **Consistent Hash** - session-to-worker mapping with affinity
- **Power of Two** - picks the least loaded of two random workers
- **Cache-Aware** - prefix cache optimization with affinity

The cache-aware mode is the one that matters here. It tracks prefix patterns and routes follow-up requests to workers that already hold the relevant cache. It also has first-class PD disaggregation support where you can define separate prefill and decode worker pools:

```bash
vllm-router \
  --policy cache_aware \
  --vllm-pd-disaggregation \
  --prefill http://prefill-1:8000 http://prefill-2:8000 \
  --decode http://decode-1:8000 http://decode-2:8000
```

Beyond routing, it includes circuit breakers, retries with exponential backoff, Prometheus metrics, Kubernetes service discovery, and bearer token auth. It's production-grade infrastructure, not a prototype.

### NVIDIA Dynamo KV Router

NVIDIA's [Dynamo](https://docs.nvidia.com/dynamo/latest/router/README.html) includes its own KV router component that solves the same problem but from inside the NVIDIA ecosystem. It maintains a prefix tree of cached blocks across workers and uses a cost function to decide routing:

```
logit = kv_overlap_score_weight * potential_prefill_blocks + potential_active_blocks
```

Lower logit means better target. This value is fed into softmax sampling with temperature to select the worker. The weight parameter lets you tune between optimizing for time-to-first-token (TTFT) or inter-token latency (ITL). It tracks KV cache events from workers and builds a real-time map of where prefixes live. Two tracking modes are available: event-based (accurate, needs NATS) and approximation-based (lightweight).

If you're already running Dynamo, this is built in. If you're not, you won't use this in isolation — it's part of the Dynamo stack.

### Consistent hashing as a baseline

Before reaching for specialized routers, it's worth noting that consistent hashing already provides a basic form of cache affinity. If you hash on a session ID or conversation ID, the same session always hits the same prefill worker. The vLLM router supports this as `consistent_hash` mode.

It's not as smart as full cache-aware routing (it doesn't track actual prefix overlap, just session identity), but it's a significant improvement over round robin and trivial to deploy. For many workloads, this is enough.

## The architecture decision

When you're designing your PD disaggregation stack, the routing layer is not optional — it's the piece that makes or breaks your cache efficiency. Here's how these approaches compare:

<div class="cde-window">
<div class="cde-window-title"><div class="cde-window-btns"><div class="cde-window-btn">&#9866;</div></div><span>Routing Strategy Comparison</span><div class="cde-window-btns"><div class="cde-window-btn">&#9634;</div><div class="cde-window-btn">&#10005;</div></div></div>
<div class="cde-window-body">
<div class="mermaid">
graph LR
    A[Client Requests] --> B{Router Strategy}
    B -->|Round Robin| C[Low Cache Hits<br/>High Recomputation]
    B -->|Consistent Hash| D[Session Affinity<br/>Good Cache Hits]
    B -->|Cache-Aware| E[Prefix Tracking<br/>Best Cache Hits]
    C --> F[Higher Latency<br/>Lower Throughput]
    D --> G[Good Latency<br/>Good Throughput]
    E --> H[Lowest Latency<br/>Highest Throughput]
</div>
</div>
</div>

The tradeoff is complexity vs. performance. Round robin needs nothing. Consistent hashing needs a session identifier in your requests. Full cache-aware routing needs a stateful router that tracks prefix patterns across your fleet.

For most production deployments, start with consistent hashing. If your workload has high prefix diversity (many different system prompts, RAG with varying contexts), then cache-aware routing will give you measurable gains. If you're running the NVIDIA stack, the Dynamo KV router is already there.

## Practical takeaways

- **Don't use round robin with PD disaggregation.** You'll waste compute recomputing prefixes that already exist on other workers.
- **Session affinity is the minimum.** Use consistent hashing on conversation or session IDs.
- **Cache-aware routing is the ceiling.** The vLLM router's `cache_aware` mode or Dynamo's KV router will squeeze out the best performance.
- **The router is Rust, not Python.** The vLLM router is written in Rust for a reason — at this layer, every microsecond of routing overhead matters when you're handling thousands of requests per second.
- **Monitor your KV cache hit rates.** If they're low in multi-turn scenarios, your routing is the first thing to look at.

The question from the vLLM community that prompted this post is a common one: "why are my cache hit rates terrible with PD disaggregation?" The answer is almost always the same — the router doesn't know where the cache is.
