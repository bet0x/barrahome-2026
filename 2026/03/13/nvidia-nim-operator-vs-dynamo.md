# NVIDIA NIM vs NVIDIA Dynamo: two different answers to the same problem

**Published on:** 2026/03/13

**Tags:** nvidia, kubernetes, inference, llm, performance

If you're running LLM inference at any real scale on NVIDIA hardware, you'll run into two distinct products that, from a distance, look like they're solving the same thing: getting models onto GPUs efficiently. One is **[NVIDIA NIM](https://docs.nvidia.com/nim/large-language-models/latest/introduction.html)**. The other is **[NVIDIA Dynamo](https://github.com/ai-dynamo/dynamo)**. They're not the same, they're not replacements for each other, and knowing which one to reach for — and when to use both — is the point of this article.

This is the first in a series. Here I'm covering what each system actually is, technically. Subsequent articles will go deeper on deployment, KV-aware routing, and SLA-based autoscaling with NVIDIA Dynamo specifically.

## NVIDIA NIM: what it actually packages

NVIDIA NIM (Neural Inference Microservice) is a containerized inference microservice distributed through [NVIDIA's NGC registry](https://catalog.ngc.nvidia.com/ai-solutions). The pitch is simple: pull a container, give it an NGC API key, and it handles the rest — model download, hardware detection, runtime selection, startup.

What makes NVIDIA NIM different from just running [vLLM](https://github.com/vllm-project/vllm) directly is the profile system. Each NIM container ships with a `model_manifest.yaml` listing every supported execution profile for that model. A profile defines two things: which runtime to use, and how to configure it for specific hardware.

When NIM starts, it inspects the available GPUs and picks the best matching profile using this priority order:

1. [TensorRT-LLM](https://github.com/NVIDIA/TensorRT-LLM) (pre-compiled, hardware-specific engines for H100/A100/L40S etc.)
2. [vLLM](https://github.com/vllm-project/vllm) (general-purpose, works on any compatible NVIDIA GPU)
3. [SGLang](https://github.com/sgl-project/sglang)

So on an H100, you get a pre-built TRT-LLM engine compiled offline by NVIDIA specifically for that GPU. On a T4 or a GPU without a TRT-LLM profile, you get vLLM. You don't configure this — it just happens. Within the TRT-LLM tier, it further prefers: higher precision quantization (FP8 > FP16), latency-optimized over throughput-optimized, highest supported tensor parallelism.

The tradeoff is clear: if your GPU is in the supported matrix, you get something well optimized without the compilation step. If it's not, you fall back to vLLM and the NIM container is mostly just a packaging convenience over running vLLM yourself.

That said — and this is purely my opinion — a few things bother me about NIM in practice. The [vLLM](https://github.com/vllm-project/vllm) version bundled inside NIM containers is not upstream — it's NVIDIA's own fork, pinned and patched internally. In a recent run of NIM 1.15.4 on an RTX A6000 (which has no TRT-LLM profile, so NIM falls back to vLLM), the engine that actually started was `v0.10.2+9dd9ca32.nv25.10`. That `.nv` suffix tells you everything: it's NVIDIA's internal build, not what's on PyPI. If you want [LMCache](https://github.com/LMCache/LMCache), [DFlash](https://github.com/z-lab/dflash) (block diffusion speculative decoding, native in SGLang via `--speculative-algorithm DFLASH`), or any upstream patch merged after NVIDIA froze their fork — it's not there, and there's no supported path to add it. You get exactly what NVIDIA decided to include, nothing more. And on a GPU outside the TRT-LLM support matrix, where NIM's main value proposition (pre-compiled engines) doesn't apply, you end up with a heavier container running a locked-down vLLM.

The containers are also not reusable in any meaningful sense: each model is its own multi-GB image with no shared base layers across models, so every deployment means pulling a significant amount of data again from scratch. And the redistribution policy is restrictive — you can't take a NIM container, modify it, and ship it to someone else without going through NGC. For internal teams that's workable; for anyone building a product on top, it's a real constraint. None of this makes NIM wrong for what it's designed for, but it's worth knowing before committing to it as a deployment standard.

Profile identifiers are SHA256 hashes derived from their content:

```bash
# List all available profiles for this container + hardware
docker run --rm --gpus=all -e NGC_API_KEY=$NGC_API_KEY \
  nvcr.io/nim/meta/llama-3.1-8b-instruct list-model-profiles

# Force a specific profile
docker run --gpus=all -e NGC_API_KEY=$NGC_API_KEY \
  -e NIM_MODEL_PROFILE="tensorrt_llm-H100-fp8-tp1-latency" \
  nvcr.io/nim/meta/llama-3.1-8b-instruct
```

## The NIM Operator: lifecycle management in Kubernetes

Running NVIDIA NIM containers directly is fine for a single deployment. The [NIM Operator](https://github.com/NVIDIA/k8s-nim-operator) (`k8s-nim-operator`, v3.1.0, written in Go) is what makes this manageable at cluster scale. Think of it as the Kubernetes lifecycle manager for NIM — it doesn't change how inference works, it handles deployment, caching, and resource management through CRDs.

<div class="cde-window">
<div class="cde-window-title"><div class="cde-window-btns"><div class="cde-window-btn">&#9866;</div></div><span>NIM Operator CRDs</span><div class="cde-window-btns"><div class="cde-window-btn">&#9634;</div><div class="cde-window-btn">&#10005;</div></div></div>
<div class="cde-window-body">
<table>
<tr><th>CRD</th><th>What it manages</th></tr>
<tr><td><code>NIMService</code></td><td>Individual NIM microservice deployment (the main one)</td></tr>
<tr><td><code>NIMCache</code></td><td>Pre-downloads model/engine from NGC to a PVC; shared across NIMService instances</td></tr>
<tr><td><code>NIMPipeline</code></td><td>Orchestrated multi-step inference workflows</td></tr>
<tr><td><code>NemoCustomizer</code></td><td>Fine-tuning workloads via NeMo</td></tr>
<tr><td><code>NemoEvaluator</code></td><td>Model evaluation runs</td></tr>
<tr><td><code>NemoGuardrail</code></td><td>Safety and constraint enforcement</td></tr>
</table>
</div>
</div>

The two you'll use day-to-day are `NIMCache` and `NIMService`. `NIMCache` is a pre-download job: it authenticates with NGC, downloads the model and the optimized engine for your cluster's GPU type, and stores everything on a PVC. `NIMService` then points at that PVC and creates a Kubernetes `Deployment`, `Service`, and optionally an `HPA`, `Ingress`, and `ServiceMonitor`.

```yaml
# 1. Pre-download the model once, shared across all NIMService instances
apiVersion: apps.nvidia.com/v1alpha1
kind: NIMCache
metadata:
  name: llama-3-8b-cache
spec:
  model:
    ngcAPISecret: ngc-api-secret
    precision: fp8
    engine: tensorrt_llm
    repoName: nim/meta/llama-3.1-8b-instruct
    tags: ["1.2.2"]
  storage:
    pvc:
      storageClass: standard
      size: 50Gi
      accessMode: ReadWriteMany

---
# 2. Deploy the inference service
apiVersion: apps.nvidia.com/v1alpha1
kind: NIMService
metadata:
  name: llama-3-8b
spec:
  image:
    repository: nvcr.io/nim/meta/llama-3.1-8b-instruct
    tag: "1.2.2"
    pullSecrets: [ngc-registry-secret]
  model:
    ngcAPISecret: ngc-api-secret
    nimCache:
      name: llama-3-8b-cache
  resources:
    limits:
      nvidia.com/gpu: "1"
  replicas: 2
  autoscaling:
    enabled: true
    minReplicas: 1
    maxReplicas: 4
```

### Multi-node in NVIDIA NIM

When a model is too large to fit on a single node, NVIDIA NIM supports **tensor parallelism across nodes** — sharding the model weights across multiple nodes and their GPUs. This is not horizontal scaling of independent instances; it's one logical model instance distributed across hardware. It's triggered by necessity (the model doesn't fit on one node), not by demand.

Two K8s orchestration options exist for this:
- **[LeaderWorkerSets](https://github.com/kubernetes-sigs/lws)** (recommended, K8s ≥1.26): creates a Leader pod and Worker pods that coordinate together, treats the whole group as a single replica, and supports autoscaling at the group level.
- **[MPI Operator](https://github.com/kubeflow/mpi-operator)** (older clusters, K8s <1.27): no dynamic scaling, requires redeployment to change replica count.

Only optimized profiles (TRT-LLM) are supported for multi-node NIM deployments.

The HPA that the NIM Operator creates scales replicas based on CPU, memory, or custom metrics you configure. It has no concept of TTFT, ITL, or KV cache state. It's Kubernetes-native autoscaling applied to a container that happens to run a language model.

## NVIDIA Dynamo: a different layer

NVIDIA Dynamo is not a replacement for NVIDIA NIM or vLLM. It's an inference orchestration framework that sits *above* the inference engines. You still run [vLLM](https://github.com/vllm-project/vllm), [TRT-LLM](https://github.com/NVIDIA/TensorRT-LLM), or [SGLang](https://github.com/sgl-project/sglang) as the actual compute backend; NVIDIA Dynamo adds the coordination, routing, and scaling intelligence around them.

The architecture has four main components:

<div class="cde-window">
<div class="cde-window-title"><div class="cde-window-btns"><div class="cde-window-btn">&#9866;</div></div><span>NVIDIA Dynamo Architecture</span><div class="cde-window-btns"><div class="cde-window-btn">&#9634;</div><div class="cde-window-btn">&#10005;</div></div></div>
<div class="cde-window-body">
<div class="mermaid">
graph TB
    Client[Client] --> FE[Frontend\nRust HTTP / OpenAI API]
    FE --> Router[KV Router\nReal-time cache-aware routing]
    Router --> P1[Prefill Workers\nvLLM / TRT-LLM / SGLang]
    Router --> P2[Prefill Workers]
    P1 --> D1[Decode Workers]
    P2 --> D2[Decode Workers]
    Planner[Planner\nSLA-aware autoscaler] --> P1
    Planner --> P2
    Planner --> D1
    Planner --> D2
    KVBM[KVBM\nKV cache tiering] --> P1
    KVBM --> P2
    NIXL[NIXL\nP2P GPU transfer] --> D1
    NIXL --> D2
</div>
</div>
</div>

**[KV Router](https://github.com/ai-dynamo/dynamo/blob/main/docs/components/router/README.md)** is the piece that changes how routing works. Where vLLM's cache-aware router maintains an approximate radix tree of what each worker *probably* has cached, NVIDIA Dynamo's KV Router gets real-time event notifications from every worker as KV blocks are created, filled, or freed. When a request arrives, it computes a cost per worker:

```
cost = overlap_score_weight × prefill_blocks + decode_blocks
```

Lower cost wins. `prefill_blocks` is how many blocks the worker would need to compute from scratch (less if it already has cached blocks for this prompt). `decode_blocks` is the active decode load on that worker. The weight lets you tune toward TTFT (higher → maximize cache reuse) or ITL (lower → distribute decode load evenly).

**[Planner](https://github.com/ai-dynamo/dynamo/blob/main/docs/components/planner/README.md)** is the autoscaler that actually understands what it's scaling. You give it SLA targets:

```yaml
args:
  - --ttft=500.0    # milliseconds, Time to First Token
  - --itl=50.0      # milliseconds, Inter-Token Latency
  - --max-gpu-budget=16
```

It supports two modes: throughput-based (requires pre-deployment profiling, uses ARIMA/Prophet/Kalman to predict traffic and compute required replicas) and load-based (real-time linear regression on active prefill tokens and KV blocks per worker, no profiling needed, experimental). In disaggregated mode it scales prefill and decode workers independently — critical because they have completely different bottlenecks.

**[KVBM (KV Block Manager)](https://github.com/ai-dynamo/dynamo/blob/main/docs/components/kvbm/README.md)** handles KV cache tiering across memory hierarchy: GPU HBM → CPU RAM → local SSD → remote/object storage. The inference engine doesn't need to know about this — KVBM intercepts block allocation and handles placement transparently. When GPU memory fills, blocks spill down the hierarchy and come back on demand. Supported on vLLM and TRT-LLM (not SGLang yet).

**[NIXL](https://github.com/ai-dynamo/nixl)** handles P2P transfers in disaggregated deployments — the KV cache generated by prefill workers needs to reach decode workers. NIXL does this via RDMA/NVLink without copying through the CPU.

The K8s deployment unit is the `DynamoGraphDeployment` (DGD) CRD, which describes the full topology: frontend, router, prefill workers, decode workers, planner. Service discovery runs via [etcd](https://etcd.io); KV events flow through [NATS](https://nats.io).

Beyond the core four, Dynamo ships several features worth calling out:

- **[Speculative decoding](https://github.com/ai-dynamo/dynamo/blob/main/docs/features/speculative-decoding/README.md)** — Eagle3 draft model support on vLLM, SGLang and TRT-LLM in progress. You configure whatever speculator vLLM supports; Dynamo doesn't pin you to what was compiled in.
- **[Dynamic LoRA](https://github.com/ai-dynamo/dynamo/blob/main/docs/features/lora/README.md)** — NIM also supports multi-LoRA via directory polling (`NIM_PEFT_REFRESH_INTERVAL`), but Dynamo takes it further: API-driven load/unload in real time, sources from local storage, S3, or HuggingFace Hub, and a KV router that's LoRA-aware — adapter identity is hashed into block keys so prefix cache reuse works per-adapter. Managed declaratively in K8s via a `DynamoModel` CRD.
- **[Agentic hints](https://github.com/ai-dynamo/dynamo/blob/main/docs/features/agentic_workloads.md)** — per-request metadata (`nvext.agent_hints`) that exposes latency sensitivity for router queue priority, output sequence length hints for better load estimation, TTL-based KV cache pinning, and speculative prefill (pre-warm cache with the predicted next turn after the assistant responds). Designed for agent runtimes where the orchestrator knows what's coming next.
- **[Multimodal](https://github.com/ai-dynamo/dynamo/blob/main/docs/features/multimodal/README.md)** — image support across all three backends, experimental video/audio on vLLM. Includes an embedding cache to skip re-encoding repeated images, and encoder disaggregation for independent vision encoder scaling.
- **[AIConfigurator](https://github.com/ai-dynamo/aiconfigurator)** — CLI tool that runs profiling against your model and hardware, decides whether aggregated or disaggregated serving is better for your SLA targets, and outputs ready-to-deploy K8s manifests. Up to 1.7x better throughput vs manual configuration according to NVIDIA's benchmarks.

## Side by side

<div class="cde-window">
<div class="cde-window-title"><div class="cde-window-btns"><div class="cde-window-btn">&#9866;</div></div><span>NVIDIA NIM vs NVIDIA Dynamo</span><div class="cde-window-btns"><div class="cde-window-btn">&#9634;</div><div class="cde-window-btn">&#10005;</div></div></div>
<div class="cde-window-body">
<table>
<tr><th></th><th>NVIDIA NIM</th><th>NVIDIA Dynamo</th></tr>
<tr><td><b>What it is</b></td><td>Packaged inference microservice (NGC catalog)</td><td>Inference orchestration framework above engines</td></tr>
<tr><td><b>K8s management</b></td><td>NIM Operator (NIMService/NIMCache CRDs)</td><td>DynamoGraphDeployment CRD</td></tr>
<tr><td><b>Inference engine</b></td><td>Bundled (TRT-LLM or vLLM, auto-selected)</td><td>vLLM, TRT-LLM, SGLang — you choose</td></tr>
<tr><td><b>Routing</b></td><td>Standard K8s Service / external load balancer</td><td>Real-time KV-aware router (event-driven)</td></tr>
<tr><td><b>Autoscaling</b></td><td>HPA on CPU/memory or custom metrics</td><td>Planner targeting TTFT/ITL SLAs</td></tr>
<tr><td><b>Multi-node</b></td><td>Tensor parallelism only (model too big for one node)</td><td>Tensor parallelism + disaggregated pool scaling</td></tr>
<tr><td><b>PD disaggregation</b></td><td>Not built in</td><td>First-class, independent prefill/decode pools</td></tr>
<tr><td><b>KV cache offloading</b></td><td>No</td><td>KVBM: GPU → CPU → SSD → remote</td></tr>
<tr><td><b>KV transfer</b></td><td>Not applicable</td><td>NIXL (RDMA/NVLink P2P)</td></tr>
<tr><td><b>Speculative decoding</b></td><td>Only what NVIDIA pre-compiled in the profile</td><td>Any strategy the backend supports (e.g. Eagle3)</td></tr>
<tr><td><b>LoRA serving</b></td><td>Dynamic via directory polling, local filesystem only</td><td>API-driven load/unload, S3/HuggingFace sources, KV-aware per adapter</td></tr>
<tr><td><b>Agentic workloads</b></td><td>No</td><td>Latency hints, cache pinning, speculative prefill</td></tr>
<tr><td><b>NGC integration</b></td><td>Native (API key, model registry, security scans)</td><td>Not built in; you manage image + model pull</td></tr>
<tr><td><b>Setup complexity</b></td><td>Low — one CRD to describe what you want</td><td>Higher — topology, etcd, NATS, profiling</td></tr>
<tr><td><b>Maturity</b></td><td>GA, enterprise supported</td><td>v0.8.1, open source, 6.2k stars, growing fast</td></tr>
<tr><td><b>License</b></td><td>NVIDIA proprietary (NIM), Operator Apache 2.0</td><td>Apache 2.0</td></tr>
</table>
</div>
</div>

## When to use which

**NVIDIA NIM makes sense when:**
- You want a model from the NGC catalog with minimal configuration
- Single-node serving (or multi-node for large models) is sufficient for your scale
- You don't need disaggregated prefill/decode or KV-aware routing
- You want NVIDIA's enterprise support and security-scanned containers
- Your team doesn't want to manage routing topology or scaling logic

**NVIDIA Dynamo makes sense when:**
- You're running workloads where TTFT/ITL SLAs matter at scale and standard HPA isn't cutting it
- You need disaggregated prefill/decode to handle long-context reasoning models ([DeepSeek-R1](https://github.com/deepseek-ai/DeepSeek-R1), [Qwen3](https://huggingface.co/collections/Qwen/qwen3-67dd247413bbe5b6f4b9d9c5)) efficiently
- You want real KV-cache-aware routing, not an approximation
- You need KV cache offloading because your working set doesn't fit in GPU memory
- You're willing to invest in the operational complexity for the throughput and latency gains

**The honest read:** NVIDIA NIM is the right starting point for most teams. It's less to manage and the automatic profile selection genuinely saves time. NVIDIA Dynamo becomes relevant when you've hit the ceiling of what straightforward horizontal scaling gives you — usually when P95 TTFT on long-context requests is too high, or when you're paying for GPU time that's doing redundant prefill compute.

They're not mutually exclusive. NVIDIA's direction seems to be positioning Dynamo as the future backbone for high-scale NIM deployments. The Dynamo containers at `nvcr.io/nvidia/ai-dynamo/` package the same vLLM/TRT-LLM/SGLang engines NIM uses, with Dynamo's orchestration layer wrapping them.

**A fair caveat:** this article focuses on inference serving, and some of the gaps mentioned above — fine-tuning, evaluation, guardrails, data curation — are addressed by other products in NVIDIA's enterprise stack. The NIM Operator already ships CRDs for some of these (NemoCustomizer, NemoEvaluator, NemoGuardrail). That's a broader story for another article; the scope here is specifically what happens between a request arriving and a token going back out.

## What's next

The next article covers deploying NVIDIA Dynamo on Kubernetes: the `DynamoGraphDeployment` CRD, how to configure disaggregated serving, and what the KV router's event flow looks like in practice. After that: the Planner — how to profile your model, set SLA targets, and what the throughput vs load-based scaling modes do differently under load.

## Sources

- [NVIDIA k8s-nim-operator](https://github.com/NVIDIA/k8s-nim-operator) — NIM Operator source, CRD specs
- [NVIDIA NIM for LLMs documentation](https://docs.nvidia.com/nim/large-language-models/latest/) — profiles, Helm, multi-node
- [ai-dynamo/dynamo](https://github.com/ai-dynamo/dynamo) — Dynamo source and documentation
- [Dynamo Router Guide](https://github.com/ai-dynamo/dynamo/blob/main/docs/components/router/router-guide.md) — KV routing internals
- [Dynamo Planner](https://github.com/ai-dynamo/dynamo/blob/main/docs/components/planner/README.md) — autoscaler design and configuration
- [KVBM](https://github.com/ai-dynamo/dynamo/blob/main/docs/components/kvbm/README.md) — KV Block Manager architecture
