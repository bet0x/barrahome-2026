# LMCache + Redis: Distributed KV Cache for Enterprise LLM Inference

**Tags:** ai, llm, vllm, redis, kv-cache, optimization, inference

---

In my [previous article about vLLM router and PD disaggregation](/2026/02/07/vllm-router-pd-disaggregation.md), I discussed how prefix-cache-aware routing solves cache hit rate problems when distributing prefill and decode across different nodes. That article focused on **where to route requests** to maximize cache hits.

This article tackles a different but complementary problem: **where to store the KV cache itself**. Enter LMCache with Redis — a distributed KV cache layer that transforms how we manage, share, and reuse cached key-value tensors across LLM inference workloads.

## The Problem: KV Cache is Stuck in GPU Memory

Traditional LLM inference keeps the entire KV cache in GPU memory during generation. This works fine for single requests, but creates several problems at scale:

**Memory Pressure:**
- Long context (32K, 128K+ tokens) consumes massive GPU memory
- Limits batch size and concurrent requests
- Forces expensive GPU upgrades

**No Cache Sharing:**
- Each vLLM instance has its own isolated cache
- Repeated content (RAG passages, system prompts) gets recomputed
- Multi-turn conversations can't reuse previous context

**Wasted Computation:**
- Same document chunks processed repeatedly across sessions
- Customer support bots re-encode identical policy text
- RAG systems recompute embeddings for common passages

**Limited Prefix Caching:**
- vLLM's native prefix cache only works within a single instance
- Only matches tokens at the **beginning** of prompts
- Doesn't help when repeated content appears mid-prompt or at the end

## What is LMCache?

[LMCache](https://github.com/LMCache/LMCache) is an open-source KV cache management layer that extends LLM inference engines (vLLM, SGLang) with a **multi-tier storage hierarchy** for KV caches. Instead of keeping everything in GPU memory, LMCache can offload and share caches across:

- **GPU memory** (active working set)
- **CPU DRAM** (hot cache with pinned memory)
- **Local storage** (NVMe, SSD)
- **Remote backends** (Redis, Mooncake, S3, InfiniStore)

### Key Innovation: Chunk-Level Caching

Unlike traditional prefix caching, LMCache operates at the **chunk level** (default: 256 tokens). This enables:

✅ **Position-independent matching** — reuses chunks regardless of where they appear in the prompt  
✅ **Cross-instance sharing** — multiple vLLM workers share the same cache  
✅ **Flexible granularity** — configurable chunk sizes and overlap strategies  

**Example:**

Traditional prefix cache:
```
Prompt A: "Return policy: You can return items within 30 days. How do I..."
Prompt B: "How do I process returns? Return policy: You can return items within 30 days."
          ❌ No cache hit — repeated text is not at the beginning
```

LMCache chunk-level cache:
```
Prompt A: "Return policy: You can return items within 30 days. How do I..."
          └─ Chunk hash: abc123 (cached)

Prompt B: "How do I process returns? Return policy: You can return items within 30 days."
          └─ Chunk hash: abc123 ✅ Cache hit!
```

## Why Redis as the Storage Backend?

LMCache supports multiple storage backends (local CPU, disk, Redis, Mooncake, S3), but Redis stands out for production deployments:

**Low-Latency Retrieval:**
- Sub-millisecond lookups for cached chunks
- Significantly faster than disk or S3
- Production-proven at scale

**Structured Storage:**
- Stores KV cache data + metadata separately
- Supports filtering by model, temperature, format
- Hash-based key structure for efficient lookups

**Production-Ready Features:**
- Redis Sentinel for high availability
- TTL management for cache freshness
- Horizontal scaling with Redis Cluster
- Monitoring and observability built-in

**Ecosystem Integration:**
- Works with Redis Cloud, AWS ElastiCache, Azure Cache
- Compatible with existing Redis infrastructure
- Familiar operational tooling (redis-cli, monitoring)

## Architecture Overview

<div class="cde-window">
<div class="cde-window-title"><div class="cde-window-btns"><div class="cde-window-btn">&#9866;</div></div><span>LMCache Multi-Tier Storage Architecture</span><div class="cde-window-btns"><div class="cde-window-btn">&#9634;</div><div class="cde-window-btn">&#10005;</div></div></div>
<div class="cde-window-body">
<div class="mermaid">
graph TB
    subgraph vLLM_Instance[vLLM Instance]
        A[Request] --> B[Token Chunking]
        B --> C{Cache Lookup}
        C -->|Hit| D[Inject Cached KV]
        C -->|Miss| E[Compute KV via Forward Pass]
        E --> F[Store in GPU Memory]
        F --> G[Offload to CPU DRAM]
    end
    subgraph Storage_Hierarchy[LMCache Storage Hierarchy]
        G -->|Async Write| H[Local Disk/NVMe]
        H -->|LRU Eviction| I[Redis Backend]
    end
    subgraph Redis_Storage[Redis Storage]
        I --> J[Metadata Entry]
        I --> K[KV Bytes Entry]
    end
    subgraph Future_Requests[Future Requests]
        L[New Request] --> M{Check Redis}
        M -->|Cache Hit| N[Prefetch to CPU]
        N --> O[Restore to GPU]
        O --> D
    end
    style I fill:#c8a060,stroke:#8a6520,color:#fff
    style J fill:#5f9ea0,stroke:#3d6e70,color:#fff
    style K fill:#5f9ea0,stroke:#3d6e70,color:#fff
</div>
</div>
</div>

### Data Flow Breakdown

**1. Chunk Hashing:**
- Input tokens split into chunks (e.g., 256 tokens)
- SHA-256 hash computed for each chunk
- Hash used as lookup key across storage tiers

**2. Storage Hierarchy:**

| Tier | Latency | Capacity | Use Case |
|------|---------|----------|----------|
| GPU Memory | <1us | 24-80GB | Active generation |
| CPU DRAM | ~10us | 128GB-2TB | Hot cache (pinned memory) |
| Local NVMe | ~100us | 1-10TB | Recent sessions |
| Redis | ~1ms | Unlimited | Shared across cluster |

**3. Cache Operations:**

- **Offload:** GPU → CPU (frees GPU memory for new requests)
- **Evict:** CPU → Redis (LRU policy, async writes)
- **Prefetch:** Redis → CPU (on cache hit)
- **Restore:** CPU → GPU (zero-copy DMA transfer)

## Redis Storage Structure

LMCache stores each cached chunk as **two separate Redis entries**:

### Key Format

```
{model_name}@{world_size}@{worker_id}@{chunk_hash}
```

**Example base key:**
```
meta-llama/Llama-3.1-70B@1@0@a7f3b2c9d1e4f5a6b8c9d0e1f2a3b4c5
```

Each chunk has two entries:

1. **Metadata entry** (base key, no suffix)
2. **KV bytes entry** (base key + `_bytes` suffix)

### Metadata Entry (Redis Hash)

```bash
# Metadata stored at base key
HGETALL "meta-llama/Llama-3.1-70B@1@0@abc123"
1) "model_name"
2) "meta-llama/Llama-3.1-70B"
3) "format"
4) "naive"
5) "world_size"
6) "1"
7) "worker_id"
8) "0"
```

### KV Bytes Entry (Binary Blob)

```bash
# KV cache data stored with _bytes suffix
GET "meta-llama/Llama-3.1-70B@1@0@abc123_bytes"
# Returns serialized tensor data (pickle by default, or CacheGen compressed)
```

This separation allows:
- Fast metadata filtering without deserializing tensors
- Efficient storage (only download KV bytes when needed)
- Flexible serialization formats (`naive` vs. `cachegen`)

## Configuration: vLLM + LMCache + Redis

### Step 1: Install Dependencies

```bash
# Install LMCache and vLLM
uv pip install lmcache vllm

# Or install from source
git clone https://github.com/LMCache/LMCache.git
cd LMCache
uv pip install -e . --no-build-isolation
```

### Step 2: Start Redis Server

```bash
# Local Redis (development)
redis-server --port 6379

# Redis Sentinel (high availability)
redis-sentinel /etc/redis/sentinel.conf
```

### Step 3: Configure LMCache

**Option A: Environment Variables**

```bash
export LMCACHE_CHUNK_SIZE=256
export LMCACHE_REMOTE_URL="redis://localhost:6379"
export LMCACHE_REMOTE_SERDE="naive"
```

**Option B: Configuration File (lmcache_config.yaml)**

```yaml
chunk_size: 256
remote_url: "redis://localhost:6379"
remote_serde: "naive"
local_cpu: true
max_local_cpu_size: 5.0  # GB
```

### Step 4: Launch vLLM with LMCache

```bash
vllm serve meta-llama/Llama-3.1-70B-Instruct \
  --kv-transfer-config '{"kv_connector":"LMCacheConnectorV1", "kv_role":"kv_both"}' \
  --gpu-memory-utilization 0.85 \
  --max-model-len 32768
```

**Configuration Parameters:**

- `kv_connector`: `"LMCacheConnectorV1"` for vLLM v1 (latest)
- `kv_role`: `"kv_both"` (read and write), `"kv_producer"` (write only), `"kv_consumer"` (read only)

### Python API Example

```python
import os
from vllm import LLM, SamplingParams

# Configure LMCache
os.environ["LMCACHE_CHUNK_SIZE"] = "256"
os.environ["LMCACHE_REMOTE_URL"] = "redis://localhost:6379"
os.environ["LMCACHE_REMOTE_SERDE"] = "naive"

# Initialize vLLM with LMCache
llm = LLM(
    model="meta-llama/Llama-3.1-70B-Instruct",
    kv_transfer_config={
        "kv_connector": "LMCacheConnectorV1",
        "kv_role": "kv_both"
    },
    gpu_memory_utilization=0.85,
    max_model_len=32768
)

# First request (cache miss - computes KV cache)
prompts = [
    "You can return your item within 30 days of purchase. How do I start a return?"
]
outputs = llm.generate(prompts, SamplingParams(temperature=0.7, max_tokens=256))

# Second request (cache hit - reuses cached chunk)
prompts = [
    "What's your policy? You can return your item within 30 days of purchase."
]
outputs = llm.generate(prompts, SamplingParams(temperature=0.7, max_tokens=256))
# ✅ The repeated chunk is found in Redis and reused
```

## Performance Benchmarks

<div class="cde-window">
<div class="cde-window-title"><div class="cde-window-btns"><div class="cde-window-btn">&#9866;</div></div><span>LMCache + Redis Performance Impact</span><div class="cde-window-btns"><div class="cde-window-btn">&#9634;</div><div class="cde-window-btn">&#10005;</div></div></div>
<div class="cde-window-body">
<div class="mermaid">
graph LR
    subgraph Baseline[Baseline vLLM]
        A1[TTFT: 1.24s]
        A2[Throughput: 230 req/s]
        A3[Cost: X per 1K tokens]
    end
    subgraph WithLMCache[vLLM + LMCache + Redis]
        B1[TTFT: 0.18s]
        B2[Throughput: 420 req/s]
        B3[Cost: 0.36X per 1K tokens]
    end
    A1 -->|6.9x faster| B1
    A2 -->|82% increase| B2
    A3 -->|64% reduction| B3
    style B1 fill:#5f9ea0,stroke:#3d6e70,color:#fff
    style B2 fill:#5f9ea0,stroke:#3d6e70,color:#fff
    style B3 fill:#5f9ea0,stroke:#3d6e70,color:#fff
</div>
</div>
</div>

### Real-World Results

**Multi-Turn QA (Customer Support):**
- **TTFT improvement:** 6.9× faster (1.24s → 0.18s)
- **Throughput:** +82% (230 → 420 req/s)
- **Cost reduction:** 64% per 1K tokens

**RAG Applications (Document Analysis):**
- **Cache hit rate:** 60-80% on repeated passages
- **GPU memory savings:** 40% (more concurrent requests)
- **Latency reduction:** 2× lower end-to-end latency

**Long-Context Processing (128K tokens):**
- **Prefill speedup:** 3-10× for repeated document chunks
- **Memory efficiency:** 50% reduction in GPU memory usage
- **Throughput:** 2.3-14× higher at same TTFT (low QPS scenarios)

## Use Cases: When to Use LMCache + Redis

### ✅ Ideal Scenarios

**1. Multi-Turn Conversations**
```
User: "What's the return policy?"
Agent: [Response with policy text]
User: "How long do I have?"
Agent: [Reuses cached policy chunk ✅]
```

**2. RAG Applications**
- Same document chunks retrieved across different queries
- Common passages in knowledge base
- Repeated context in prompt templates

**3. Customer Support Agents**
- Repeated policy statements
- Standard procedure explanations
- Common troubleshooting steps

**4. Document Summarization**
- Overlapping content across documents
- Repeated headers/footers
- Common boilerplate text

**5. Code Generation**
- Standard library imports
- Common code patterns
- Repeated documentation snippets

### ⚠️ Less Effective Scenarios

**Unique, One-Off Queries:**
- Every prompt is completely different
- No repeated content across sessions
- Low cache hit rate → minimal benefit

**Streaming with Very Short Outputs:**
- Redis latency (~1ms) may exceed compute time for tiny generations
- Better to keep cache in GPU/CPU only

**Latency-Critical Applications (<10ms SLA):**
- Redis network round-trip adds 1-3ms overhead
- Consider local CPU DRAM only for ultra-low latency

## Comparison: LMCache vs. Alternatives

<div class="cde-window">
<div class="cde-window-title"><div class="cde-window-btns"><div class="cde-window-btn">&#9866;</div></div><span>Distributed KV Cache Solutions Comparison</span><div class="cde-window-btns"><div class="cde-window-btn">&#9634;</div><div class="cde-window-btn">&#10005;</div></div></div>
<div class="cde-window-body">
| Feature | LMCache + Redis | Mooncake | NVIDIA NXIL |
|---------|-----------------|----------|-------------|
| **Cache Granularity** | Chunk-level (256 tokens) | Chunk-level | Page-level |
| **Storage Backend** | Redis, S3, NFS, local | Distributed memory pool | GPU RDMA fabric |
| **Latency** | ~1ms (Redis) | ~500us (RDMA) | <5us (RDMA) |
| **Multi-Node Support** | Yes | Yes | Yes (same datacenter) |
| **Cross-Datacenter** | Yes (geo-replication) | Limited | No |
| **vLLM Integration** | Native connector | Native connector | Native support |
| **SGLang Support** | Yes | Yes | Limited |
| **Storage Capacity** | Unlimited (Redis/S3) | Limited by cluster RAM | Limited by GPU memory |
| **Operational Complexity** | Low (standard Redis) | Medium (custom cluster) | High (RDMA fabric) |
| **Cost** | Low (commodity Redis) | Medium (RAM expensive) | High (RDMA NICs) |
</div>
</div>

### Key Differences

**LMCache + Redis:**
- Best for: Cross-datacenter deployments, long-term cache persistence, multi-cloud
- Trade-off: Higher latency (~1ms) vs. RDMA solutions

**Mooncake:**
- Best for: Single-datacenter deployments with massive memory pools
- Trade-off: More complex setup, requires dedicated memory nodes
- **Note:** LMCache and Mooncake have partnered — you can use Mooncake as an LMCache backend

**NVIDIA NXIL:**
- Best for: Single-node multi-GPU with ultra-low latency (<5μs)
- Trade-off: Limited to RDMA-connected GPUs, doesn't scale across datacenters

### Hybrid Approach

You can combine multiple backends:

```yaml
# lmcache_config.yaml
chunk_size: 256

# Tier 1: CPU DRAM (hot cache)
local_cpu: true
max_local_cpu_size: 10.0  # GB

# Tier 2: Local NVMe (recent sessions)
local_storage: "/nvme/lmcache"
max_local_storage_size: 100.0  # GB

# Tier 3: Redis (shared across cluster)
remote_url: "redis://redis-cluster:6379"
remote_serde: "naive"
```

## Production Considerations

### High Availability

**Redis Sentinel Configuration:**

```bash
# sentinel.conf
sentinel monitor lmcache-redis redis-master 6379 2
sentinel down-after-milliseconds lmcache-redis 5000
sentinel failover-timeout lmcache-redis 10000
sentinel parallel-syncs lmcache-redis 1
```

**LMCache Connection String:**
```bash
export LMCACHE_REMOTE_URL="redis-sentinel://sentinel1:26379,sentinel2:26379,sentinel3:26379"
```

### Memory Management

**Redis Memory Limits:**

```bash
# redis.conf
maxmemory 50gb
maxmemory-policy allkeys-lru  # LRU eviction for cache entries
```

**LMCache TTL (Optional):**

LMCache doesn't set Redis TTL by default (cache persists forever). For auto-expiration:

```python
# Custom wrapper to set TTL on cached entries
import redis

r = redis.Redis(host='localhost', port=6379)
for key in r.scan_iter("*@kv_bytes"):
    r.expire(key, 86400)  # 24-hour TTL
```

### Monitoring & Observability

**Key Metrics to Track:**

```bash
# Cache hit rate
redis-cli INFO stats | grep keyspace_hits
redis-cli INFO stats | grep keyspace_misses

# Memory usage
redis-cli INFO memory | grep used_memory_human

# LMCache-specific keys
redis-cli KEYS "*@metadata" | wc -l
redis-cli KEYS "*@kv_bytes" | wc -l
```

**Prometheus Metrics:**

- `lmcache_cache_hit_rate` — percentage of cache hits
- `lmcache_gpu_to_cpu_transfer_bytes` — offload volume
- `lmcache_redis_latency_ms` — Redis round-trip time
- `vllm_queue_depth` — request backlog (indicates cache benefit)

### Security

**Redis Authentication:**

```bash
# redis.conf
requirepass your_secure_password

# LMCache config
export LMCACHE_REMOTE_URL="redis://:your_secure_password@localhost:6379"
```

**Network Segmentation:**

- Keep Redis on private network (no public exposure)
- Use TLS for Redis connections: `rediss://` (note the extra 's')
- Firewall rules: only allow vLLM nodes to access Redis

## Debugging: Inspecting Redis Cache

### Connect to Redis

```bash
redis-cli -h localhost -p 6379
```

### List LMCache Entries

```bash
# Count KV cache entries (with _bytes suffix)
KEYS "*_bytes" | wc -l

# Count metadata entries (base keys without _bytes)
# Note: This requires filtering, as base keys don't have a specific suffix
KEYS "*@*@*@*" | grep -v "_bytes" | wc -l

# Sample KV cache keys
KEYS "*_bytes" | head -5

# Sample metadata keys (showing pattern)
KEYS "meta-llama*" | grep -v "_bytes" | head -5
```

### Examine Metadata

```bash
# Get metadata for a specific chunk (base key, no suffix)
HGETALL "meta-llama/Llama-3.1-70B@1@0@abc123"
```

### Check Memory Usage

```bash
# Memory used by KV cache entry
MEMORY USAGE "meta-llama/Llama-3.1-70B@1@0@abc123_bytes"

# Memory used by metadata entry
MEMORY USAGE "meta-llama/Llama-3.1-70B@1@0@abc123"

# Total Redis memory
INFO memory
```

### Delete Stale Entries

```bash
# Delete all LMCache KV cache entries (reset cache)
redis-cli KEYS "*_bytes" | xargs redis-cli DEL

# Delete all metadata entries (use pattern matching carefully)
redis-cli KEYS "*@*@*@*" | grep -v "_bytes" | xargs redis-cli DEL
```

## How LMCache + Redis Relates to vLLM Router

In my previous article about [vLLM router PD disaggregation](/2026/02/07/vllm-router-pd-disaggregation.md), I explained how **prefix-cache-aware routing** solves the problem of low cache hit rates when distributing prefill and decode across different nodes.

Here's how they work together:

### The Complete Picture

```
┌─────────────────────────────────────────────────────┐
│ vLLM Router (NVIDIA Dynamo / vllm-project/router)  │ ← Routing Layer
│ - Decides which node handles prefill/decode         │
│ - Uses consistent hashing for cache locality        │
└─────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────┐
│ LMCache + Redis                                      │ ← Storage Layer
│ - Stores KV cache chunks in Redis                   │
│ - Shares cache across all vLLM instances            │
│ - Chunk-level reuse (position-independent)          │
└─────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────┐
│ vLLM Instances (Prefill + Decode Workers)           │ ← Inference Layer
│ - Fetch cached chunks from Redis when available     │
│ - Offload new chunks to Redis for future reuse      │
└─────────────────────────────────────────────────────┘
```

### Complementary Benefits

**vLLM Router solves:**
- **Routing decision:** "Which node should handle this request?"
- **Cache locality:** "Send prefill to nodes that already have the prefix cached"

**LMCache + Redis solves:**
- **Storage scalability:** "Where do we store KV cache beyond GPU memory?"
- **Cross-instance sharing:** "How do we share cache across all vLLM workers?"
- **Chunk-level reuse:** "How do we match repeated content anywhere in the prompt?"

### Combined Architecture

You can use both together for maximum efficiency:

1. **LMCache stores** all KV chunks in Redis (shared storage layer)
2. **vLLM Router routes** requests using consistent hashing (cache-aware routing)
3. **Cache hits increase** because:
   - Router sends similar requests to the same node (locality)
   - LMCache shares chunks across nodes via Redis (global cache)
   - Chunks match position-independently (flexible reuse)

**Example:**

```
Request A: "Return policy: You can return items within 30 days."
  ├─ Router → sends to Node 1 (based on prefix hash)
  ├─ Node 1 computes KV cache
  └─ LMCache stores chunk in Redis

Request B: "How do I process returns? Return policy: You can return items within 30 days."
  ├─ Router → might send to Node 2 (different prefix)
  ├─ Node 2 checks LMCache
  └─ ✅ Cache hit from Redis (chunk stored by Node 1)
```

## Practical Takeaways

### Use LMCache + Redis when:

✅ You have repeated content across prompts (RAG, multi-turn chat, support bots)  
✅ You run multiple vLLM instances and want cache sharing  
✅ You need long-term cache persistence beyond single sessions  
✅ GPU memory is a bottleneck (long context, high concurrency)  
✅ You can tolerate ~1-3ms additional latency for cache lookups  

### Skip LMCache + Redis when:

❌ Every prompt is unique (no repeated content)  
❌ Ultra-low latency is critical (<10ms SLA)  
❌ You have a single vLLM instance with plenty of GPU memory  
❌ Content changes frequently (low cache reuse rate)  

### Optimization Tips

**1. Tune Chunk Size:**
- Smaller chunks (128 tokens) → higher reuse rate, more storage overhead
- Larger chunks (512 tokens) → lower reuse rate, less storage overhead
- Default 256 tokens is a good starting point

**2. Use Local CPU DRAM First:**
- Configure `max_local_cpu_size` to use pinned memory before Redis
- Significantly reduces Redis load for hot cache

**3. Monitor Cache Hit Rate:**
- Track `keyspace_hits / (keyspace_hits + keyspace_misses)`
- If hit rate < 30%, LMCache may not be beneficial
- Investigate prompt patterns to increase reuse

**4. Combine with Prompt Engineering:**
- Place reusable content (system prompts, guidelines) in consistent positions
- Use templates to standardize repeated sections
- Increases chunk match probability

## Conclusion

LMCache with Redis transforms KV cache from a single-instance, ephemeral resource into a **distributed, shared, persistent layer** that scales across your entire LLM infrastructure.

By combining chunk-level caching with Redis as a storage backend, you get:
- **3-10× faster TTFT** on repeated content
- **60-80% cache hit rates** in real-world RAG/chat applications
- **40-50% GPU memory savings** (more concurrent requests)
- **Cross-instance cache sharing** (no more isolated caches)

When paired with prefix-cache-aware routing (from my previous article), you achieve both optimal **routing decisions** and efficient **cache storage** — the complete solution for distributed LLM inference at scale.

## Resources

- **LMCache GitHub:** [https://github.com/LMCache/LMCache](https://github.com/LMCache/LMCache)
- **LMCache Documentation:** [https://docs.lmcache.ai/](https://docs.lmcache.ai/)
- **Redis Backend Guide:** [https://docs.lmcache.ai/kv_cache/storage_backends/redis.html](https://docs.lmcache.ai/kv_cache/storage_backends/redis.html)
- **vLLM LMCache Examples:** [https://docs.vllm.ai/en/latest/examples/others/lmcache/](https://docs.vllm.ai/en/latest/examples/others/lmcache/)
- **Redis Blog Post:** [Get faster LLM inference with LMCache and Redis](https://redis.io/blog/get-faster-llm-inference-and-cheaper-responses-with-lmcache-and-redis/)
- **LMCache Technical Report:** [ArXiv 2510.09665](https://arxiv.org/abs/2510.09665)

---

**Sources:**
- [GitHub - LMCache/LMCache](https://github.com/LMCache/LMCache)
- [Redis Backend Documentation](https://docs.lmcache.ai/kv_cache/storage_backends/redis.html)
- [Get faster LLM inference and cheaper responses with LMCache and Redis](https://redis.io/blog/get-faster-llm-inference-and-cheaper-responses-with-lmcache-and-redis/)
- [Architecture Overview | LMCache](https://docs.lmcache.ai/developer_guide/architecture.html)
- [LMCache Examples - vLLM](https://docs.vllm.ai/en/latest/examples/others/lmcache/)
- [LMCache: An Efficient KV Cache Layer for Enterprise-Scale LLM Inference](https://arxiv.org/abs/2510.09665)
- [Mooncake | LMCache](https://docs.lmcache.ai/kv_cache/mooncake.html)
- [KV Cache Offloading with Huggingface vLLM Backend](https://kserve.github.io/website/docs/model-serving/generative-inference/kvcache-offloading)
- [Ceph.io — KV Caching with vLLM, LMCache, and Ceph](https://ceph.io/en/news/blog/2025/vllm-kv-caching/)
