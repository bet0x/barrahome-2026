# What Happened After I Reported Four Bugs to a Young Project

**Published on:** 2026/09/16

**Tags:** security, sandbox, landlock, seccomp, golang, docker, open-source

---

Six weeks ago I wrote about [putting an LLM agent on this blog](/2026/08/06/sandboxing-a-public-llm-agent.md). Half of that post was the threat model and the bugs I'd written into my own code. The other half was a list of things about [sandlock](https://github.com/multikernel/sandlock) that cost me real time and weren't documented anywhere I could find: four of them, plus a smaller fifth.

[Cong Wang](https://www.linkedin.com/in/cong-wang-b96762b/), who maintains the project, told me that [v0.8.8](https://github.com/multikernel/sandlock/releases/tag/v0.8.8) addressed them. I checked before believing it, because "addressed" covers everything from a real fix to a line in a changelog. It's true, and how it's true turned out to be more interesting than the fact.

| What I reported | Status in v0.8.8 |
|---|---|
| `MaxMemory` unusable on a Go process | Fixed, [PR #222](https://github.com/multikernel/sandlock/pull/222) |
| Does not build on musl | Fixed, [PR #224](https://github.com/multikernel/sandlock/pull/224) |
| `NetAllowBind` silently unenforced when combined with `NetAllow` | Fixed, [PR #227](https://github.com/multikernel/sandlock/pull/227) |
| `FSWritable` grants read along with write | Documented |
| Docker's default seccomp profile blocks sandlock | Never a sandlock bug, and my advice was wrong |

One note on sourcing before the details. Where I describe what a fix does internally, that's from reading the merged diff. Where I say a control now works, I've bumped my own pinned checkout to v0.8.8 and measured it against the real policy my agent runs, and I say what I measured.

## The memory limit

`MaxMemory` was the one that had cost me an afternoon of confusion: the worker died with exit code -1 and no output, and only that one setting reproduced it. I'd worked out that sandlock charged memory by intercepting `mmap` lengths while the Go runtime reserves an enormous virtual arena at startup, so any limit low enough to be useful killed the process before `main` ran.

That diagnosis was right and incomplete. The fix skips reservations, because an anonymous mapping with `PROT_NONE` backs nothing, and Go reserves over a gigabyte of it. Then, since free reservations open a hole, `mprotect` is now judged when it grants `PROT_WRITE`, using a BPF argument filter so the expensive part only runs when the length in question would exceed the limit. Both of those I'd have recognised. The third one I would not have found: mapping `/dev/zero` private and writable is anonymous memory that the ledger never saw at all. That's charged now too.

So the interesting part isn't that my report was acted on. It's that following the bug to its cause turned up two bypasses next to it, and one of them was a way to get memory the accounting couldn't see.

On my own kernel, under my own policy: a Go hello world now runs under a 64M limit, where in August the same program died at 192M, at 512M and at 1G and survived only somewhere north of 2G. The 2.9 MB test binary from my sandbox package is killed under 64M and runs under 128M, which is the part I wanted to see. A limit that only kills things when they're genuinely large is a limit; the old behaviour wasn't one.

I'll still let the cgroup do the measuring, for the reason I gave in the original post: cgroups count resident set size, which is the thing I actually meant. The difference is that leaving `MaxMemory` unset is now a choice rather than a workaround, and the comment in my policy explaining its absence says so.

## The musl build

I'd wanted a small Alpine image, got about twenty type errors, worked out that the Rust core called `ptrace` with constants shaped for glibc's binding signature, and settled for Debian.

The fix confirms the cause exactly. The `libc` crate types the `ptrace` request as `c_uint` on glibc and `c_int` on musl, `ioctl` requests as `c_ulong` against `c_int`, and `msg_controllen` as `size_t` against `u32`. Dropping the glibc-shaped casts lets each constant carry its per-target type.

What I find worth the detour is what fixing the build exposed. Two bugs that only appear on musl were hiding behind those compile errors. musl defines `O_SEARCH` as `O_PATH` and folds it into `O_ACCMODE`, and Rust's `OpenOptions` masks custom flags with `!O_ACCMODE`, so on musl the Landlock rule open quietly lost `O_PATH` and became a real read-only open. A read rule on a FIFO would then block child setup forever. And the seccomp scan that looks for argv strings near the execve path buffer read the whole span before looking for a terminator. glibc's `brk` heap keeps that span mapped so it never mattered; musl's allocator leaves unmapped pages between chunks, so the read hit a hole and the child's execve failed with `EFAULT` in nineteen of twenty runs under chroot.

Neither of those is a build problem. They're the kind of thing that only surfaces once someone makes the build possible, which is a decent argument for fixing compile errors you don't personally need fixed.

The practical limit for anyone chasing the small image: the release assets are still glibc only, for x86_64, aarch64 and riscv64. There's no musl target in the release matrix yet and the FFI shared library needs `-C target-feature=-crt-static` to build for musl at all. Alpine is possible now, but you compile it yourself.

## The bind allowlist

This is the one I'd called the worst failure mode there is: `NetAllowBind` works alone, stops being enforced the moment you also set `NetAllow`, and says nothing about it. I'd published a three-row table of what I measured.

The reproduction table in the fix has four rows, and the extra ones are the part that matters. `--net-deny` breaks it the same way `--net-allow` does. So does `--port-remap`. And with `--net-allow` alone and no allowlist declared at all, the default deny-all bind was bypassed too, which means a sandbox that was supposed to be unable to listen on anything could listen on any TCP port.

The cause is the one I'd guessed at from the outside. Any network supervision moves `bind()` onto an on-behalf path where the supervisor binds a duplicate of the child's socket, outside the child's Landlock domain, so the kernel rules never see the call. The handler on that path checked the denylist and had no allowlist to check. It carries both now, refuses TCP binds outside the allowlist with `EACCES` including `bind(0)`, and leaves UDP and non-IP binds alone.

Two details in that fix say something about how it was done. The new integration tests were confirmed to fail before the change. And four existing Python tests for port remapping had been binding ports with no allowlist declared, which means they were passing *through* the bug: they now declare one. Finding that your own test suite was relying on the broken behaviour is the unglamorous half of fixing a security control, and it's the half that tells you the fix is real.

It merged a little over an hour before the release was cut.

I now have a test of my own for this, which is the thing I told you to do and hadn't done. It sets `NetAllow` and `NetAllowBind` the way the agent does, asserts the declared port binds and another one doesn't, and it has teeth: against the pin my repo was carrying it fails with the sandbox happily reporting `bound` on a port outside the allowlist, and on v0.8.8 it passes. Six weeks of "declared for documented intent, relied on for nothing" turns out to have been an accurate description.

The smaller fifth thing is fixed in the only way it could be. `FSWritable` granting read as well as write is Landlock semantics, not a defect, so the field comment now reads "paths the sandbox may read and write" in the Go SDK and the Python docs match. The field name no longer invites the assumption I made.

While I was in there I checked whether `Confine()` had gained anything, since my whole two-process design exists because it can't apply network policy. It hasn't: it's still filesystem only, and still rejects what it can't honour rather than ignoring it. The supervisor stays.

## The one I had wrong

My fourth point was that Docker's default seccomp profile blocks sandlock completely, and that you therefore have to choose: run with `--security-opt seccomp=unconfined` and give up Docker's syscall filter to get sandlock's, or don't run sandlock. I built a whole paragraph of reasoning on that trade-off, explained which side I'd picked and why, and told you to leave a comment in your compose file so nobody deleted the line.

The trade-off doesn't exist. The blocked syscall is `pidfd_getfd`, which the supervisor uses to duplicate the child's descriptors, and Docker's default profile permits it when the container holds `CAP_SYS_PTRACE` ([moby#45622](https://github.com/moby/moby/issues/45622) is the upstream history). The recommended way to run sandlock under Docker is `--cap-add SYS_PTRACE`, with the default profile left alone. If the capability makes you uncomfortable, you take it back from the workload on the sandlock side with `--extra-deny-syscall` for `ptrace`, `pidfd_getfd` and the `process_vm_*` pair, since the supervisor lives outside the sandbox and keeps its own use of them. There's also `--no-supervisor`, which never calls `pidfd_getfd` and runs under the stock profile, at the cost of everything the supervisor provides.

All of that is now on a [FAQ page](https://sandlock.io/faq.html), and it existed before v0.8.8. Someone else hit the same wall a week after my post, [asked about it](https://github.com/multikernel/sandlock/issues/199), and had the answer in five days.

That's the bit I keep turning over. I measured the failure on two machines with different kernels and different Docker versions, which is more work than asking, and then published a workaround as though it were the only option. The measurement was fine. Treating my own conclusion as the end of the inquiry was not. A stranger's one-paragraph question got a better answer than my afternoon.

## The credit

None of this was a bug report. I didn't open an issue, didn't attach a repro, didn't tag anyone. I wrote a blog post about my own weekend project and mentioned, in passing, four things that had annoyed me.

Cong Wang read it, reproduced all of it, and shipped fixes for three with regression tests in two languages and a documentation change for the fourth. No request for a reproduction script, no argument about whether the framing was fair, no defensiveness about a young project being measured in public. In the bind case he went looking and found the bug was wider than I'd reported. In the memory case he found two bypasses I hadn't seen. That's not accepting a report, that's doing the work the report implied.

I've been on the other side of this. Someone writes publicly about your project, gets a detail slightly wrong, and the temptation is to correct the detail and move on. Reading a stranger's blog post as a to-do list, and then finding the parts they missed, is a different instinct. Thank you.

## What I'd tell you

If you measure something odd in a young project, write it down carefully and publish it, because a maintainer who cares will treat careful measurement as a gift regardless of the channel it arrived through. But do ask, too. I now have one finding that was incomplete, one that wasn't a bug at all, and both of those would have taken one question to sort out.

And the original post needs an update, which I've added rather than quietly editing. What I measured in August was true in August. It's just no longer the state of the world, which is the nicest possible reason for a post to go out of date.

---

*AI was used for research and drafting assistance on this post. Written by a human.*
