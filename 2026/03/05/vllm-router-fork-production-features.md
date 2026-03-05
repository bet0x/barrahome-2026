# vLLM Router: the story of a fork and the features upstream doesn't have

**Published on:** 2026/03/05

**Tags:** vllm, rust, performance, inference, tutorial

In my [previous article](/2026/02/07/vllm-router-pd-disaggregation) I covered why prefix-cache-aware routing matters for PD disaggregation and looked at the vLLM router as one of the production-grade solutions. Since then I've been running it in real workloads and experimenting with features I'd like to see in the routing layer: response caching, semantic-aware routing, graceful operations, config-file-driven deployments.

The upstream router is solid for what it does. But there are features I wanted to try — some experimental, some production-hardened — that don't exist upstream yet. The vLLM project has its own [semantic-router](https://github.com/vllm-project/semantic-router), but it's a more complex system with a broader scope. I wanted something lightweight that I could use for my own experiments and deployments while keeping it enterprise and production-grade. So I maintain [a fork](https://github.com/bet0x/vllm-router) where I can iterate on these ideas.

This article walks through what the fork adds, why each feature exists, and how to configure them.

## What the upstream router gives you

The [vllm-project/router](https://github.com/vllm-project/router) is a Rust-based request router for vLLM. It handles the basics well:

- Five load balancing policies: round robin, random, consistent hash, power of two, cache-aware
- PD disaggregation with separate prefill/decode pools
- Circuit breakers and retries with exponential backoff
- Kubernetes service discovery
- Prometheus metrics
- Bearer token authentication

All configuration is done via CLI flags, which works well for straightforward setups. The fork builds on top of this foundation with experimental and production features that I wanted to have available for my own use cases.

## What the fork adds

Here's the full list of additions. These are features I've been experimenting with or needed for specific deployments — some are battle-tested in production, others are still evolving:

<div class="cde-window">
<div class="cde-window-title"><div class="cde-window-btns"><div class="cde-window-btn">&#9866;</div></div><span>Fork vs Upstream Feature Comparison</span><div class="cde-window-btns"><div class="cde-window-btn">&#9634;</div><div class="cde-window-btn">&#10005;</div></div></div>
<div class="cde-window-body">
<table>
<tr><th>Feature</th><th>Upstream</th><th>Fork</th></tr>
<tr><td>YAML config file (<code>--config-file</code>)</td><td>-</td><td>Full YAML for all settings</td></tr>
<tr><td>Exact-match response cache</td><td>-</td><td>FNV-1a hash, DashMap, TTL + LRU</td></tr>
<tr><td>Semantic similarity cache</td><td>-</td><td>Cosine similarity via embeddings</td></tr>
<tr><td>Semantic cluster routing</td><td>-</td><td>Route by prompt content to worker groups</td></tr>
<tr><td>Anthropic Messages API</td><td>-</td><td><code>POST /v1/messages</code> with streaming</td></tr>
<tr><td>Graceful worker drain</td><td>-</td><td><code>POST /admin/drain</code></td></tr>
<tr><td>Hot config reload</td><td>-</td><td><code>POST /admin/reload</code></td></tr>
<tr><td>Per-worker API keys</td><td>-</td><td>Each backend gets its own Bearer token</td></tr>
<tr><td>Redis cache backend</td><td>-</td><td>Shared cache across router instances</td></tr>
<tr><td>Inbound API key auth</td><td>-</td><td>Static Bearer token for all <code>/v1/*</code></td></tr>
<tr><td>Sticky sessions with failover</td><td>-</td><td>DashMap TTL + ring walk on failure</td></tr>
<tr><td><code>/v1/completions</code>, <code>/v1/embeddings</code>, <code>/v1/rerank</code></td><td>-</td><td>Full proxy + streaming</td></tr>
<tr><td>SentencePiece tokenizer</td><td>-</td><td>Via system libsentencepiece</td></tr>
<tr><td>Per-routing Prometheus metrics</td><td>-</td><td>Worker, cluster, fallback counters</td></tr>
<tr><td>INFO-level routing logs</td><td>-</td><td>Model, worker, method, status, duration</td></tr>
</table>
</div>
</div>

The rest of this article covers the most impactful features in detail.

## YAML configuration

The upstream router requires all settings as CLI flags. A typical production deployment ends up looking like this:

```bash
vllm-router \
  --policy cache_aware \
  --vllm-pd-disaggregation \
  --prefill http://prefill-1:8000 http://prefill-2:8000 \
  --decode http://decode-1:8000 http://decode-2:8000 \
  --bearer-token-file /etc/secrets/token \
  --metrics-port 29000 \
  --health-check-interval 60 \
  --circuit-breaker-failure-threshold 5 \
  --retry-count 3
```

In the fork, the same deployment is a single YAML file:

```yaml
host: "0.0.0.0"
port: 8090
log_level: info

mode:
  type: pd_disaggregation
  prefill_urls:
    - "http://prefill-1:8000"
    - "http://prefill-2:8000"
  decode_urls:
    - "http://decode-1:8000"
    - "http://decode-2:8000"

prefill_policy:
  type: power_of_two
  load_check_interval_secs: 10

decode_policy:
  type: consistent_hash
  virtual_nodes: 160

metrics:
  host: "0.0.0.0"
  port: 29000

health_check:
  check_interval_secs: 60
  timeout_secs: 5
  failure_threshold: 3
  success_threshold: 2
  endpoint: /health
```

```bash
vllm-router --config-file configs/pd-disagg.yaml
```

This is better for version control, easier to review in PRs, and you can template it for Kubernetes ConfigMaps. The config also enables features that would be impractical to express as CLI flags, like semantic cluster definitions or per-worker API key maps.

## Two-level response caching

This is the feature I built first because the use case is so common: the same prompt (or a nearly identical one) gets sent to your inference cluster hundreds of times. Without caching, every single request triggers a full inference pass. The fork adds a two-level cache pipeline:

<div class="cde-window">
<div class="cde-window-title"><div class="cde-window-btns"><div class="cde-window-btn">&#9866;</div></div><span>Response Cache Pipeline</span><div class="cde-window-btns"><div class="cde-window-btn">&#9634;</div><div class="cde-window-btn">&#10005;</div></div></div>
<div class="cde-window-body">
<div class="mermaid">
graph LR
    A[Incoming Request] --> B{Exact Match Cache<br/>FNV-1a hash}
    B -->|Hit| C[Return cached response]
    B -->|Miss| D{Semantic Cache<br/>cosine similarity}
    D -->|Match above threshold| C
    D -->|Miss| E[Route to vLLM worker]
    E --> F[Store response in both caches]
    F --> G[Return response to client]
</div>
</div>
</div>

### Level 1: exact-match cache

The first layer hashes the request body (after stripping non-deterministic fields like `stream`, `user`, and `request_id`) using FNV-1a. If an identical request was seen before and the cached response hasn't expired, it returns immediately without touching any backend worker.

```yaml
cache:
  backend: memory
  max_entries: 2048
  ttl_secs: 120
```

That's it. This alone can save significant compute if your workload has any repetition — think shared system prompts, common user questions, or automated pipelines that retry the same call.

### Level 2: semantic cache

The second layer handles the case where prompts aren't identical but are semantically equivalent. "Explain what a Transformer is" and "What is a Transformer model?" should probably return the same cached response.

The semantic cache embeds each request using an OpenAI-compatible embeddings endpoint (like [Infinity](https://github.com/michaelfeil/infinity) or a vLLM instance serving an embedding model) and compares it against stored embeddings using cosine similarity:

```yaml
semantic_cache:
  embeddings_url: "http://localhost:8030"
  embeddings_model: "BAAI/bge-small-en-v1.5"
  threshold: 0.95
  max_entries: 1024
  ttl_secs: 300
```

The `threshold` parameter controls how similar two prompts need to be. At 0.95, only near-paraphrases match. At 0.80, you'll get broader matches but risk returning irrelevant cached responses. Start high and tune down.

### Redis backend

For multi-instance deployments, in-memory caching means each router instance builds its own cache independently. The fork supports Redis as a shared backend:

```yaml
cache:
  backend: redis
  max_entries: 2048
  ttl_secs: 120
  redis:
    url: "redis://127.0.0.1:6379/0"
    pool_size: 8
    key_prefix: "vllm-router:"
    connection_timeout_ms: 3000
    command_timeout_ms: 500
```

This requires building with `--features redis-cache`. The cache degrades gracefully — if Redis is unreachable, the router treats it as a cache miss and forwards to the backend normally.

**Important:** streaming responses are never cached. Only non-streaming requests go through the cache pipeline.

## Semantic cluster routing

This is the most interesting routing feature in the fork. Instead of routing purely by load or session affinity, semantic cluster routing routes requests **by what the user is asking about**.

The idea: you define clusters of workers, each specialized (or simply allocated) for a domain. You provide example prompts for each cluster. At startup, the router embeds these examples and computes a centroid vector per cluster. When a request arrives, the router embeds it and routes to the cluster whose centroid is closest — if the similarity exceeds a threshold:

<div class="cde-window">
<div class="cde-window-title"><div class="cde-window-btns"><div class="cde-window-btn">&#9866;</div></div><span>Semantic Cluster Routing Flow</span><div class="cde-window-btns"><div class="cde-window-btn">&#9634;</div><div class="cde-window-btn">&#10005;</div></div></div>
<div class="cde-window-body">
<div class="mermaid">
sequenceDiagram
    participant Client
    participant Router
    participant Embed as Embeddings Service
    participant W1 as Coding Workers
    participant W2 as Science Workers
    Client->>Router: "Write a Rust function to sort a list"
    Router->>Embed: Embed request
    Embed-->>Router: Vector [0.12, 0.87, ...]
    Note over Router: cosine_sim(coding_centroid) = 0.91
    Note over Router: cosine_sim(science_centroid) = 0.34
    Note over Router: 0.91 > threshold 0.70
    Router->>W1: Route to coding cluster
    W1-->>Client: Response
</div>
</div>
</div>

Here's the configuration:

```yaml
semantic_cluster:
  embeddings_url: "http://localhost:8030"
  embeddings_model: "BAAI/bge-small-en-v1.5"
  threshold: 0.70
  embedding_timeout_ms: 2000

  clusters:
    - name: coding
      workers:
        - "http://worker-code-1:8000"
        - "http://worker-code-2:8000"
      examples:
        - "Write a Python function to sort a list"
        - "How do I implement a binary search tree in Rust?"
        - "Debug this JavaScript code that throws a TypeError"
        - "Implement a REST API endpoint in FastAPI"

    - name: science
      workers:
        - "http://worker-sci-1:8000"
      examples:
        - "Explain the process of photosynthesis"
        - "What is the difference between mitosis and meiosis?"
        - "Describe Newton's laws of motion"
        - "How does quantum entanglement work?"
```

If no cluster matches above the threshold, the request falls through to the default load balancing policy (round robin, consistent hash, etc.). The router also sets `x-semantic-cluster-id` and other `x-semantic-*` headers on matched requests, which get propagated to vLLM workers.

**When this is useful:** multi-tenant deployments where different teams share a cluster but want their traffic isolated; workloads where different prompt types benefit from different LoRA adapters or model configurations; or simply organizing traffic by domain for better monitoring.

## Anthropic Messages API support

If your clients use the Anthropic SDK, you no longer need a separate translation layer. The fork natively accepts Anthropic's Messages API format and translates it to OpenAI format before forwarding to vLLM:

```bash
curl http://router:3000/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-key" \
  -d '{
    "model": "meta-llama/Llama-3.1-8B-Instruct",
    "max_tokens": 1024,
    "messages": [
      {"role": "user", "content": "What is KV caching in LLMs?"}
    ]
  }'
```

This includes full streaming support with Anthropic's SSE format. The response comes back in Anthropic format — the client never knows it's talking to vLLM.

## Admin API: graceful drain and hot reload

### Graceful worker drain

When you need to take a worker offline for maintenance or scaling down, you don't want to kill in-flight requests. The drain endpoint stops sending new traffic to a worker, waits for active requests to finish, and then removes it:

```bash
# Start draining worker
curl -X POST http://router:3000/admin/drain \
  -H "Authorization: Bearer admin-secret" \
  -H "Content-Type: application/json" \
  -d '{"url": "http://worker-1:8000", "timeout_secs": 300}'

# Check drain status
curl http://router:3000/admin/drain/status?url=http://worker-1:8000 \
  -H "Authorization: Bearer admin-secret"
```

If the in-flight requests don't complete within the timeout, the worker is force-removed. The `GET /workers` endpoint now includes a `draining` field per worker so you can see the full fleet status.

### Hot config reload

Change API keys, add or remove workers, adjust settings — all without restarting the router:

```bash
# Edit the YAML config, then:
curl -X POST http://router:3000/admin/reload \
  -H "Authorization: Bearer admin-secret"
```

The router re-reads the YAML file, diffs the worker lists, gracefully drains any removed workers, and adds new ones. API keys are swapped atomically behind `Arc<RwLock<>>`. No downtime, no dropped connections.

## Per-worker API keys

In multi-provider setups, different backend workers may require different authentication tokens. The upstream router only supports a single global API key. The fork adds per-worker key mapping:

```yaml
api_key: "default-key-for-most-workers"

worker_api_keys:
  "http://worker-provider-a:8000": "sk-provider-a-secret"
  "http://worker-provider-b:8000": "sk-provider-b-secret"
```

The priority chain is: per-worker key (highest) > global `api_key` > `OPENAI_API_KEY` env var (PD mode only) > no Authorization header. This applies to all routing modes: regular, PD disaggregation, and OpenAI proxy.

## Cache-aware routing with tunable parameters

The upstream router has a cache-aware policy, but the fork exposes every knob as a configuration parameter with sensible defaults:

```yaml
policy:
  type: cache_aware

  # Minimum cached prefix ratio to prefer a worker
  cache_threshold: 0.5

  # Absolute request count difference to force rebalancing
  balance_abs_threshold: 32

  # Relative load ratio to force rebalancing
  balance_rel_threshold: 1.1

  # How often to prune the prefix tree (seconds)
  eviction_interval_secs: 30

  # Maximum nodes in the prefix tree per worker
  max_tree_size: 10000
```

The key insight is the dual-mode behavior:

- **When load is balanced:** the policy maximizes cache hits. Requests go to whichever worker has the longest matching prefix.
- **When load is imbalanced** (one worker has `balance_abs_threshold` more requests than another, or `balance_rel_threshold` times the load): the policy switches to load-based selection regardless of cache state.

This prevents the common failure mode where cache-aware routing creates hot spots by always sending similar prompts to the same overloaded worker.

## PD disaggregation with independent policies

A significant improvement over upstream: you can set **different load balancing policies for prefill and decode pools**:

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
  type: power_of_two
  load_check_interval_secs: 10

decode_policy:
  type: consistent_hash
  virtual_nodes: 160
```

This matters because prefill and decode have fundamentally different routing needs. Prefill workers are stateless between turns — any load-balancing policy works, and `power_of_two` avoids hot spots under variable prompt lengths. Decode workers hold the KV cache across turns — `consistent_hash` pins each session to the same worker, preserving the accumulated context.

The router encodes the selected prefill and decode addresses directly in the vLLM request ID:

```
___prefill_addr_<host:port>___decode_addr_<host:port>_<uuid>
```

This tells vLLM where to transfer the KV cache via the NIXL connector (UCX/GDS), without any out-of-band coordination.

## Authentication layers

The fork adds three authentication layers that the upstream router doesn't have:

**Inbound (client to router):**
```yaml
# Static API key for all /v1/* endpoints
inbound_api_key: "sk-my-inference-key"

# Admin endpoints get their own key
admin_api_key: "sk-admin-secret"
```

Health endpoints (`/health`, `/liveness`, `/readiness`) are exempt from authentication — Kubernetes probes work without tokens.

**Outbound (router to workers):** per-worker keys as described above.

**Embeddings endpoint:** separate key for the embedding service used by semantic cache and cluster routing:
```yaml
semantic_cache:
  embeddings_api_key: "sk-embed-secret"
```

## Building and running

### Prerequisites

```bash
# Rust (stable)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# System dependencies (Ubuntu/Debian)
sudo apt-get install -y protobuf-compiler libprotobuf-dev libsentencepiece-dev
```

### Build

```bash
# Standard build
cargo build --release

# With Redis cache support
cargo build --release --features redis-cache
```

### Docker

```bash
docker build -f Dockerfile.router -t vllm-router:latest .
docker run -p 3000:3000 -p 29000:29000 \
  -v /path/to/config.yaml:/config.yaml \
  vllm-router:latest --config-file /config.yaml
```

### Quick test

```bash
# Start the router with round robin
vllm-router --config-file configs/round-robin.yaml

# Send a request
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "meta-llama/Llama-3.1-8B-Instruct",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

## Practical takeaways

- **Start with the YAML config.** It's easier to manage, version-control, and template for Kubernetes. Every `configs/*.yaml` file is a working example.
- **Enable the exact-match cache immediately.** Even a small cache with short TTL saves significant compute if your workload has any repetition. It costs almost nothing to turn on.
- **Use semantic caching carefully.** It adds latency (embedding call per request on cache miss). Only worth it if you have high prompt similarity and the embedding service is fast and local.
- **Semantic cluster routing is for organization, not performance.** It adds ~2ms per request for the embedding lookup. The value is in traffic isolation and specialized worker allocation, not raw speed.
- **Use separate PD policies.** `power_of_two` for prefill, `consistent_hash` for decode. This is the recommended production configuration for multi-turn workloads.
- **Set up the admin API key.** The drain and reload endpoints are powerful — protect them.
- **Monitor with Prometheus.** The fork exports per-routing-decision metrics. Use them to understand cache hit rates, cluster routing decisions, and worker load distribution.

## Feedback

If you're using this fork — or considering it — I'd genuinely like to hear from you. Bug reports, feature requests, questions, and general feedback are all welcome on the [GitHub issues page](https://github.com/bet0x/vllm-router/issues). I'm especially interested in hearing about real-world deployments: what worked, what didn't, and what features would make it more useful for your setup.

## Sources

- [Fork repository](https://github.com/bet0x/vllm-router) — full source code, documentation, and example configs
- [Upstream vLLM router](https://github.com/vllm-project/router) — the original project this fork extends
- [vLLM project](https://github.com/vllm-project/vllm) — the inference engine
- [Previous article: vLLM router and PD disaggregation](/2026/02/07/vllm-router-pd-disaggregation) — background on why cache-aware routing matters
