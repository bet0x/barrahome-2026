# vLLM KV Offloading: CPU Cache for High-Throughput Inference

**Tags:** ai, llm, vllm, kv-cache, performance, optimization, inference

---

In my [previous article about LMCache + Redis](/2026/02/08/lmcache-redis-distributed-kv-cache.md), I covered distributed KV caching across multiple vLLM instances for **cross-request cache sharing**. That solution excels at reusing common prefixes across different users and sessions.

This article explores a complementary approach: **vLLM's native KV offloading connector** — a built-in mechanism to extend GPU memory by offloading KV cache to CPU DRAM. Instead of sharing cache across instances, this maximizes throughput for a **single vLLM instance** handling high concurrency.

## The Problem: GPU Memory Preemption Kills Performance

vLLM dynamically manages GPU memory with a paged attention mechanism. When serving multiple concurrent requests, it allocates KV cache blocks on-demand. But what happens when GPU memory fills up?

**Traditional Preemption Penalty:**
1. New high-priority request arrives
2. GPU memory is full
3. vLLM **preempts** (pauses) an in-flight request
4. **Discards its KV cache** to free memory
5. Later, when resuming: **recomputes everything from scratch**

**The Cost:**
- Long prompts (4K, 8K, 16K+ tokens) require expensive prefill recomputation
- Throughput drops as GPU cycles are wasted on redundant work
- Latency spikes for preempted requests
- Effective batch size shrinks

**Example Scenario:**
```
GPU has 80GB VRAM, serving Llama-3.1-70B
- 10 concurrent requests, each with 8K context
- Request #11 arrives → Request #5 gets preempted
- Request #5's 8K-token KV cache is discarded (20GB wasted)
- Later: Request #5 resumes → recomputes 8K tokens from scratch
  → ~800ms prefill penalty on H100
```

## What is vLLM KV Offloading?

Starting with **vLLM 0.9.0** (with major improvements in **v0.12.0** and **v0.14.0**), vLLM introduced the **KV Offloading Connector** — an asynchronous API to offload KV cache from GPU to a larger memory tier (CPU DRAM, NVMe, etc.) **before preemption**.

**Key Benefits:**
- ✅ **Avoid recomputation** — preempted requests reload from CPU cache
- ✅ **Maximize GPU utilization** — offload cold cache, keep hot data on GPU
- ✅ **Increase effective batch size** — serve more concurrent requests
- ✅ **Reduce latency** — 2-22x faster TTFT for cache-hit requests
- ✅ **Async transfers** — DMA-based GPU↔CPU copy doesn't block inference

### Native CPU Backend

The built-in `native` backend uses **CUDA DMA transfers** (`cudaMemcpyAsync`) to move KV blocks between GPU and CPU memory with minimal overhead:

**Transfer Performance (H100 → CPU DRAM):**
- **DMA (bidirectional):** 83.4 GB/s with 2MB blocks
- **Custom CUDA kernel:** 68.5 GB/s (higher variance, GPU core interference)

**Verdict:** DMA wins for contiguous blocks ≥0.5 MB (the common case after v0.12.0 memory layout improvements).

## Architecture: How KV Offloading Works

<div class="cde-window">
<div class="cde-window-title"><div class="cde-window-btns"><div class="cde-window-btn">&#9866;</div></div><span>vLLM KV Offloading Request Lifecycle</span><div class="cde-window-btns"><div class="cde-window-btn">&#9634;</div><div class="cde-window-btn">&#10005;</div></div></div>
<div class="cde-window-body">
<div class="mermaid">
sequenceDiagram
    participant Client
    participant vLLM
    participant GPU as GPU Memory
    participant CPU as CPU Cache
    
    Client->>vLLM: Request A (8K context)
    vLLM->>CPU: Query: A_prefix cached?
    CPU-->>vLLM: Cache miss
    vLLM->>GPU: Allocate KV blocks
    vLLM->>GPU: Prefill 8K tokens
    GPU-->>Client: Generate tokens
    
    Note over vLLM,GPU: GPU memory fills up
    
    Client->>vLLM: Request B (high priority)
    vLLM->>vLLM: Preempt Request A
    vLLM->>CPU: Offload A's KV cache (async)
    vLLM->>GPU: Free A's GPU blocks
    vLLM->>GPU: Allocate for Request B
    
    Note over CPU: A's KV cache stored<br/>in CPU DRAM
    
    Client->>vLLM: Resume Request A
    vLLM->>CPU: Import A's KV cache (async)
    CPU-->>GPU: DMA transfer (83 GB/s)
    GPU-->>Client: Continue generation
    
    Note over vLLM: 2-22x faster TTFT<br/>vs. recomputation
</div>
</div>
</div>

### Request Lifecycle Integration

**Before Inference:**
1. vLLM checks CPU cache for existing KV data
2. If found: **async import** to GPU (DMA transfer)
3. Prefill only new tokens, reuse cached KV

**During Preemption:**
1. vLLM identifies candidate for preemption
2. **Async offload** KV blocks to CPU (background DMA)
3. Free GPU memory for higher-priority request
4. Store metadata (model, prompt hash, block layout)

**On Resume:**
1. Query CPU cache for preempted request
2. Import KV blocks back to GPU
3. Continue generation from checkpoint

**Asynchronous Design:**
- DMA transfers don't block GPU compute
- Model continues processing other requests
- Latency hidden behind concurrent execution

## Configuration: Enabling KV Offloading

### Current CLI (vLLM 0.14.0+)

The simplest way to enable native CPU offloading:

```bash
vllm serve meta-llama/Llama-3.1-8B-Instruct \
  --kv-offloading-backend native \
  --kv-offloading-size 32  # 32 GB of CPU DRAM
```

**Parameters:**
- `--kv-offloading-backend native` — use built-in CPU backend
- `--kv-offloading-size <GB>` — max CPU memory for KV cache

### Legacy Configuration (pre-0.14.0)

For older vLLM versions, use the transfer config:

```bash
vllm serve meta-llama/Llama-3.1-8B-Instruct \
  --kv-transfer-config '{
    "kv_connector": "OffloadingConnector",
    "kv_role": "kv_both",
    "kv_connector_extra_config": {
      "num_cpu_blocks": 8192
    }
  }'
```

**Parameters:**
- `kv_connector` — connector type (`OffloadingConnector`)
- `kv_role` — `kv_both` (send + receive), `kv_producer` (send only), `kv_consumer` (receive only)
- `num_cpu_blocks` — number of 16-token blocks in CPU cache (8192 × 16 = 128K tokens)

### Python API Example

```python
from vllm import LLM, SamplingParams

llm = LLM(
    model="meta-llama/Llama-3.1-8B-Instruct",
    kv_offloading_backend="native",
    kv_offloading_size=32,  # 32 GB CPU cache
    gpu_memory_utilization=0.95,
)

# Long-context prompt (will benefit from offloading)
prompt = """
[8K-token document here]

Summarize the key findings from the above research paper.
"""

sampling_params = SamplingParams(
    temperature=0.7,
    max_tokens=512,
)

outputs = llm.generate([prompt] * 20, sampling_params)  # 20 concurrent requests

for output in outputs:
    print(output.outputs[0].text)
```

## Performance Benchmarks

vLLM's blog post includes benchmarks on **H100 80GB** with **Llama-3.1-8B-Instruct** using the native CPU backend.

### Single Request TTFT (Time-to-First-Token)

When a request's KV cache is already in CPU memory, loading it is **2-22x faster** than recomputing:

<div class="cde-window">
<div class="cde-window-title"><div class="cde-window-btns"><div class="cde-window-btn">&#9866;</div></div><span>TTFT Reduction with CPU Cache Hit</span><div class="cde-window-btns"><div class="cde-window-btn">&#9634;</div><div class="cde-window-btn">&#10005;</div></div></div>
<div class="cde-window-body">

| Prompt Length | Recompute TTFT | CPU Cache TTFT | Speedup |
|---------------|----------------|----------------|---------|
| 512 tokens    | ~200ms         | ~100ms         | **2x**  |
| 2K tokens     | ~800ms         | ~80ms          | **10x** |
| 8K tokens     | ~3200ms        | ~145ms         | **22x** |

</div>
</div>

**Key Insight:** Longer prompts benefit more because DMA transfer time is amortized over larger KV blocks.

### Concurrent Throughput

Benchmark: **10,000 unique 512-token requests** on H100 with varying CPU cache sizes.

<div class="cde-window">
<div class="cde-window-title"><div class="cde-window-btns"><div class="cde-window-btn">&#9866;</div></div><span>Throughput Improvement with CPU Offloading</span><div class="cde-window-btns"><div class="cde-window-btn">&#9634;</div><div class="cde-window-btn">&#10005;</div></div></div>
<div class="cde-window-body">

| CPU Cache Size | Baseline (no offload) | With Offloading | Improvement |
|----------------|----------------------|-----------------|-------------|
| 0 GB (disabled)| 1850 tok/s           | 1850 tok/s      | 1x          |
| 16 GB          | 1850 tok/s           | 3200 tok/s      | **1.7x**    |
| 64 GB          | 1850 tok/s           | 8500 tok/s      | **4.6x**    |
| 128 GB         | 1850 tok/s           | 16,650 tok/s    | **9x**      |

</div>
</div>

**Why the massive gains?**
- High CPU cache size → more requests avoid recomputation
- GPU spends time generating tokens, not re-prefilling
- Effective batch size increases (more concurrent requests fit)

### Memory Layout Optimization (v0.12.0)

Early versions stored KV cache fragmented across transformer layers, creating small transfer blocks (8-72 KB). Version **0.12.0 consolidated KV data into contiguous physical blocks**, dramatically improving transfer efficiency:

**Block Size Evolution:**

| Model | Old Size | New Size | Improvement |
|-------|----------|----------|-------------|
| Llama-3.1-8B | 32 KB | **2 MB** | **62x** |
| DeepSeek-R1-Distill-32B | 16 KB | **2 MB** | **125x** |
| Llama-3.2-1B | 16 KB | **0.5 MB** | **31x** |

**Result:** DMA achieves **32% more throughput** and matches custom CUDA kernel TTFT with the new memory layout.

## Use Cases: When to Use KV Offloading

### ✅ Ideal Scenarios

**1. High Concurrency with Memory Pressure**
- Serving 50+ concurrent requests on a single GPU
- Long contexts (8K, 16K, 32K+ tokens)
- Frequent preemption due to limited GPU memory

**Example:** Customer support chatbot with company knowledge base (16K context) serving 100 concurrent users on 2x A100s.

**2. Bursty Traffic Patterns**
- Traffic spikes require aggressive preemption
- Offloading avoids recomputation penalty
- CPU cache smooths out GPU memory bottleneck

**Example:** API service with 10x traffic during business hours.

**3. Multi-Turn Conversations**
- Long conversation history (5K+ tokens of context)
- Between turns, offload to CPU to serve other users
- Reload quickly when user responds

**Example:** Code assistant with full codebase context (32K tokens) across multiple turns.

**4. Cost Optimization**
- Maximize throughput on existing GPU fleet
- Cheaper to add CPU DRAM than buy more GPUs
- 128GB DDR5 RAM: ~$400 vs. H100 GPU: ~$30,000

### ⚠️ Less Effective Scenarios

**1. Short Contexts (<2K tokens)**
- Prefill recomputation is cheap (~200ms on H100)
- DMA transfer overhead comparable to recomputation
- Minimal benefit unless extreme concurrency

**2. Low Concurrency**
- GPU memory not under pressure
- No preemption happening
- Offloading adds unnecessary complexity

**3. Stateless Workloads**
- Each request is independent, no cache reuse
- Offline batch inference with no preemption
- Better to maximize GPU batch size instead

## Comparison: KV Offloading vs. LMCache

You might be wondering: **How does native KV offloading relate to LMCache?**

<div class="cde-window">
<div class="cde-window-title"><div class="cde-window-btns"><div class="cde-window-btn">&#9866;</div></div><span>KV Offloading vs. LMCache Comparison</span><div class="cde-window-btns"><div class="cde-window-btn">&#9634;</div><div class="cde-window-btn">&#10005;</div></div></div>
<div class="cde-window-body">

| Feature | vLLM KV Offloading | LMCache + Redis |
|---------|-------------------|-----------------|
| **Scope** | Single vLLM instance | Multi-instance cluster |
| **Cache Sharing** | No (local to instance) | Yes (cross-instance) |
| **Matching** | Prefix + resume cache | Chunk-level (position-independent) |
| **Latency** | Sub-ms (DMA) | 1-5ms (network + Redis) |
| **Storage Tier** | CPU DRAM only | CPU, disk, Redis, S3, etc. |
| **Use Case** | High concurrency, single node | Distributed fleet, RAG, shared prompts |
| **Configuration** | Single CLI flag | External Redis + config |
| **Persistence** | No (lost on restart) | Yes (Redis persists cache) |

</div>
</div>

### Key Differences

**vLLM KV Offloading:**
- ✅ Built-in, zero dependencies
- ✅ Fastest retrieval (DMA, no network)
- ✅ Simple configuration
- ❌ No cross-instance sharing
- ❌ No chunk-level matching
- ❌ Lost on vLLM restart

**LMCache + Redis:**
- ✅ Shares cache across vLLM fleet
- ✅ Position-independent chunk matching
- ✅ Persistent across restarts
- ✅ Multi-tier storage (CPU, disk, Redis, S3)
- ❌ Network latency overhead
- ❌ Requires external Redis deployment

### Hybrid Approach: Best of Both Worlds

You can **combine both** for maximum efficiency:

```bash
vllm serve meta-llama/Llama-3.1-70B-Instruct \
  --kv-offloading-backend native \
  --kv-offloading-size 64 \
  --enable-lmcache \
  --lmcache-config lmcache.yaml
```

**lmcache.yaml:**
```yaml
chunk_size: 256
local_cpu: true
max_local_cpu_size: 32  # GB
remote_url: redis://10.0.0.5:6379
remote_serde: cachegen
```

**How it works together:**
1. **LMCache** handles cross-instance sharing (chunk-level matching)
2. **Native offloading** handles local preemption (fast GPU↔CPU)
3. Request hits LMCache Redis → loads to CPU → native offloading manages GPU
4. Best of both: shared cache + fast local offloading

## Production Considerations

### Memory Management

**CPU Memory Planning:**
- Monitor `/proc/meminfo` for available DRAM
- Leave headroom for OS and other processes
- Rule of thumb: allocate 50-70% of DRAM for KV cache

**Example (256GB DRAM server):**
```bash
# Reserve 128GB for KV offloading
vllm serve ... --kv-offloading-size 128
```

### High Availability

**Stateless Design:**
- CPU cache is ephemeral (not persisted)
- On vLLM restart, cache is empty
- Pair with LMCache for persistent cache layer

**Load Balancing:**
- Use sticky sessions to maximize local cache hits
- Route repeat users to same vLLM instance when possible
- Fall back to LMCache if instance fails

### Monitoring

**Key Metrics:**
```python
# vLLM exposes Prometheus metrics
vllm_kv_offload_total          # Total offload operations
vllm_kv_offload_bytes          # Bytes offloaded to CPU
vllm_kv_reload_total           # Cache reloads from CPU
vllm_kv_cache_hit_rate         # % of requests with CPU cache hit
```

**Alerting:**
- Low cache hit rate (<50%) → increase CPU cache size
- High offload latency → check CPU memory bandwidth
- Frequent preemption → add GPU capacity or optimize batching

## Debugging: Inspecting Offload Behavior

### Enable Debug Logging

```bash
export VLLM_LOGGING_LEVEL=DEBUG
vllm serve ... --kv-offloading-backend native
```

**Sample output:**
```
[KVOffloadingConnector] Offloading 2048 blocks (4GB) to CPU for req_id=abc123
[KVOffloadingConnector] DMA transfer completed in 48ms (83.2 GB/s)
[KVOffloadingConnector] Reloading 2048 blocks from CPU for req_id=abc123
[KVOffloadingConnector] Cache hit! TTFT reduced from 3200ms to 145ms
```

### Monitor System Resources

```bash
# Watch CPU memory usage
watch -n 1 "free -h | grep Mem"

# Check DMA bandwidth (requires nvidia-smi)
nvidia-smi dmon -s u

# vLLM stats
curl http://localhost:8000/metrics | grep kv_offload
```

## Practical Takeaways

### Use vLLM KV Offloading when:
1. **Single-instance deployment** with high concurrency
2. **GPU memory pressure** causing frequent preemption
3. **Long contexts** (8K+ tokens) with recomputation penalty
4. **Minimal latency overhead** required (local DMA only)

### Skip KV Offloading when:
1. **Low concurrency** — GPU memory is underutilized
2. **Short contexts** (<2K tokens) — recomputation is cheap
3. **Multi-instance fleet** — use LMCache for cross-instance sharing instead

### Optimization Tips
- Start with 50% of DRAM for offloading, tune based on hit rate
- Combine with LMCache for hybrid local + distributed caching
- Monitor `vllm_kv_cache_hit_rate` — target >70% for optimal ROI
- Use sticky sessions in load balancers to improve local cache hits

## Conclusion

vLLM's native KV offloading connector is a powerful tool for **maximizing single-instance throughput** when GPU memory becomes the bottleneck. By offloading preempted KV cache to CPU DRAM, you can:

- Avoid expensive prefill recomputation (2-22x TTFT reduction)
- Increase concurrent request capacity (up to 9x throughput)
- Optimize GPU utilization at minimal cost (CPU DRAM is cheap)

While LMCache excels at **distributed cache sharing** across a cluster, native KV offloading shines for **local memory extension** with sub-millisecond latency. In production, the two complement each other perfectly:

- **LMCache** → share common prefixes across instances (Redis, chunk-level matching)
- **Native offloading** → extend GPU memory with CPU DRAM (DMA, preemption recovery)

Together, they form a complete KV cache management strategy for high-throughput, cost-efficient LLM inference.

---

## Resources

- [vLLM KV Offloading Blog Post](https://vllm-project-github-da37kiytj-simon-mos-projects.vercel.app/2026/01/08/kv-offloading-connector.html) (official announcement)
- [vLLM Documentation](https://docs.vllm.ai/)
- [KV Offloading Benchmark Code](https://github.com/orozery/playground/tree/kv-offloading-blog/gpu_cpu_benchmark)
- [LMCache GitHub](https://github.com/LMCache/LMCache)
- [My previous article: LMCache + Redis](/2026/02/08/lmcache-redis-distributed-kv-cache.md)
- [My previous article: vLLM Router & PD Disaggregation](/2026/02/07/vllm-router-pd-disaggregation.md)
