# vLLM Router v0.13.0: Medium-Aware Routing

**Published on:** 2026/04/24

**Tags:** vllm, rust, inference, kv-cache, lmcache, routing, performance

---

The [v0.12.0 post](/2026/04/24/vllm-router-v0120-kv-events-routing.md) shipped earlier today and ended with a "What's Next" item promising medium-aware scoring as a concrete v0.13. Here it is.

This is unusual cadence — the time between writing about a gap and shipping the fix was about six hours — but the trigger is interesting enough to write down: I read the [LMCache KV events doc](https://docs.lmcache.ai/production/kv_cache_events.html) while drafting the v0.12 post, noticed the field we weren't handling, and the fix turned out to be small enough that it didn't make sense to wait.

---

## The Field We Were Ignoring

LMCache's `BlockStored` event includes a `medium` field that v0.12 silently dropped on the floor:

```
BlockStored:
  block_hashes: [u64; n]
  parent_block_hash: Option<u64>
  token_ids: [u32; n*block_size]
  block_size: usize
  lora_id: Option<String>
  medium: Option<String>      // ← v0.12 ignored this
```

The value is one of `"gpu"`, `"cpu"`, or `"disk"`, and it tells you which storage tier holds the cached block right now. LMCache offloads cold blocks from GPU HBM to CPU RAM, then spills further to local NVMe when host memory fills up. All three tiers count as "cached" for occupancy purposes — but only one of them is a true zero-fetch hit.

The `kv_aware` policy in v0.12 treated every cached block as equivalent. So a request whose prompt matched 12 blocks on Worker A (all on disk) and 10 blocks on Worker B (all on GPU) would get routed to Worker A. Worker A had "more cached" by raw block count, and that's what the scorer used. The decision was wrong: hitting a disk-tier block requires reading from NVMe and copying back through host RAM into HBM, which is **slower** than just recomputing the prefix on a GPU-resident worker.

---

## What v0.13 Does

The scorer now multiplies each matched block's contribution by a per-medium weight before summing:

```rust
pub struct MediumWeights {
    pub gpu: f32,
    pub cpu: f32,
    pub disk: f32,
}

// Defaults
gpu  = 1.0
cpu  = 0.3
disk = 0.05
```

Under the defaults, the scenario above flips: Worker A's 12 disk blocks score `12 × 0.05 = 0.6`, Worker B's 10 GPU blocks score `10 × 1.0 = 10.0`, Worker B wins decisively. That's the right answer.

The weights are configurable. CPU at `0.3` reflects the rough relative cost of a PCIe round-trip vs a GPU-resident hit on a typical H100/A100 deployment — not a precise number, but the right order of magnitude. Disk at `0.05` says "almost never let disk-tier blocks outvote a GPU prefix."

If you don't trust my defaults, set all three to `1.0` and you get the v0.12 behaviour back — equal weighting, raw block count wins.

```yaml
decode_policy:
  type: kv_aware
  block_size: 16
  enable_speculative: true
  speculative_ttl_ms: 2000
  medium_weights:
    gpu:  1.0
    cpu:  0.3
    disk: 0.05
```

CLI flags: `--kv-medium-gpu-weight`, `--kv-medium-cpu-weight`, `--kv-medium-disk-weight`.

---

## The Backward-Compat Problem and Its Fix

There's a deployment story that's easy to get wrong here. Native vLLM without LMCache offload publishes `BlockStored` events that **don't include the `medium` field at all**. If `kv_aware` defaulted "missing field" to `cpu` or `disk`, every native-vLLM v0.12 deployment would silently down-weight all its cached blocks the moment they upgraded to v0.13. That's a regression.

The fix is a fourth enum variant:

```rust
pub enum BlockMedium {
    Gpu,
    Cpu,
    Disk,
    #[default]
    Unknown,
}
```

`Unknown` is what the decoder emits when the field is missing or unparseable. The scorer treats `Unknown` as if it were `Gpu` — full credit. So pure-vLLM deployments behave exactly like v0.12, and LMCache-augmented deployments get the new weighting. No migration step required.

This is a small detail with outsized importance: the difference between "v0.13 is a drop-in upgrade" and "v0.13 is a coordinated rollout."

---

## The Speculative Edge Case

The speculative-insert path from v0.12 also needs to pick a medium for blocks it pre-populates after a routing decision. The block hasn't been confirmed by `BlockStored` yet, so we don't actually know where it will land — but we know the routing decision targeted *that worker* because *that worker* had the most cached prefix. The optimistic guess is GPU.

If LMCache later confirms the block went to CPU instead (because GPU was full at the moment of insertion), the real `BlockStored` event overwrites the speculative entry's medium. The window where the index could mislead the scorer is bounded by `speculative_ttl_ms` (default 2 seconds) and only matters for a sliver of bursty traffic.

---

## Two Bugs the Compilation Fix Surfaced

While shipping this, I made `cargo test --tests` compile cleanly for the first time since v0.12 — the `engine_wait_timeout_secs` field added in v0.12 had not been propagated to the four `RouterConfig { ... }` literals in `tests/api_endpoints_test.rs`, which broke the integration test build. Once those compiled, a second bug surfaced: `test_unsupported_endpoints` was asserting that `route_completion` returned `501 Not Implemented`. Completion has been a forwarding proxy to upstream OpenAI for some time. The assertion was stale.

Both fixes are in v0.13. The lesson is the obvious one — tests that don't compile aren't tests, and a broken test suite hides whatever lives behind it. The medium-aware feature is the headline; "we can run our own integration tests again" is the quieter but arguably more valuable cleanup.

---

## Numbers

- **+9 lib tests** (5 decoder for medium parsing + aliases, 4 scorer for weighted scoring). 580 → 589 passing.
- **+~450 lines** across decoder, index, scorer, policy, config, CLI, and example YAML.
- **Zero behaviour change** for native vLLM deployments without LMCache offload (Unknown → Gpu weight).
- **Time from "noticed the gap in LMCache docs" to v0.13 tag**: about six hours.

---

## What's Next

The v0.12 post listed three follow-ups. Updated:

- ~~**Medium-aware scoring (v0.13).**~~ Done.
- **Cross-instance KV index sharing.** Still the biggest open item. Sharing the event consumption across router instances (one ingester, multiple readers) is the obvious shape, but the right backend — Redis, Valkey, NATS, raw multicast ZMQ — depends on what the deployment is already running. Probably an interface in v0.14 with a memory backend, then the real one once a clear winner emerges.
- **`pd_uncached_token_threshold` activation.** The threshold is plumbed but unused. The intent is to short-circuit prefill disaggregation when the uncached tail is short enough that running the whole request on the decode worker is faster than the round-trip. Now that the scorer returns weighted scores per worker, the threshold logic has a meaningful score to compare against.

---

## Sources

- [v0.12.0 post](/2026/04/24/vllm-router-v0120-kv-events-routing.md) — context for the gap this post closes
- [Fork repository](https://github.com/bet0x/vllm-router) — full source
- [CHANGELOG.md](https://github.com/bet0x/vllm-router/blob/main/CHANGELOG.md) — the v0.13.0 entry has the file-by-file detail
- [LMCache KV cache events](https://docs.lmcache.ai/production/kv_cache_events.html) — the doc that triggered this release
- [docs/kv-events-routing.md](https://github.com/bet0x/vllm-router/blob/main/docs/kv-events-routing.md) — `medium_weights` reference
