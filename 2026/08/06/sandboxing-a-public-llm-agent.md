# Putting an LLM Agent on My Blog Without Handing Over the Keys

**Published on:** 2026/08/06

**Tags:** ai, security, sandbox, landlock, seccomp, golang, docker, llm, agents

---

There's a terminal on this site. Press the backtick key and it drops down, and you can ask it about anything I've written here. It reads the posts, my CV, the projects page, and answers. No login, no token, nothing to sign up for.

That's a worse idea than it sounds, and the interesting part of this project was not building the agent. It was working out what a stranger can do with an LLM that has file access on my server, and then closing each of those doors. Some of the doors I didn't know were open until code review pointed at them. A few of the things I learned about the sandboxing tools aren't documented anywhere I could find, so this post is mostly those.

## The threat model, stated plainly

An anonymous visitor gets to send arbitrary text to a model that can call tools on my machine. Written that way, the risks sort themselves into four buckets.

**Reading things they shouldn't.** The obvious one. Path traversal, symlinks, absolute paths, whatever gets the tool to open a file outside the content directory.

**Spending my money.** An LLM API bills per token, so an unauthenticated endpoint that calls one is a stranger's budget line. Rate limiting is the only thing standing between a bored person and my invoice.

**Prompt injection.** Content the model reads can contain instructions. My own posts are the corpus so I'm not worried about myself, but the general shape matters: if a tool can execute code or open a socket, injected text can turn the model into a confused deputy.

**Using the box as a launchpad.** If the process can reach the network freely, a compromise turns my VPS into someone else's proxy or scanner.

The design follows from those four, and the ordering matters, because the cheapest defence for each one is a different mechanism and none of them is "the sandbox."

## The shape of it

A Go binary with two subcommands. `supervise` is the container entrypoint and runs as PID 1. It builds a confinement policy and launches `serve` as a child under that policy. `serve` is the HTTP server that talks to the model and executes tools.

<div class="cde-window">
<div class="cde-window-title"><div class="cde-window-btns"><div class="cde-window-btn">&#9866;</div></div><span>Request path: PID 1 builds the policy, the child runs under it</span><div class="cde-window-btns"><div class="cde-window-btn">&#9634;</div><div class="cde-window-btn">&#10005;</div></div></div>
<div class="cde-window-body">
<div class="mermaid">
flowchart LR
    visitor[Visitor<br/>backtick key]
    edge[TLS + reverse proxy<br/>rate limits, real client IP]
    subgraph container[Container]
        direction LR
        pid1[PID 1: supervise<br/>checks the Landlock ABI,<br/>builds the policy, execs the worker.<br/>Exits non-zero if it will not apply.]
        subgraph confined[Landlock + seccomp]
            direction LR
            worker[serve<br/>origin check, per-IP quota,<br/>session checkout, agent loop]
            tools[three read-only file tools<br/>native calls, no subprocess]
            worker <--> tools
        end
    end
    ws[(curated content<br/>read-only mount)]
    api[the model API<br/>the only permitted egress]
    visitor --> edge --> worker
    pid1 -.->|policy applies to the child| confined
    ws --> tools
    worker <--> api
    worker -.->|SSE deltas| visitor
    style pid1 fill:#3a2f1e,color:#fff
    style worker fill:#1e3a2f,color:#fff
    style tools fill:#1e3a2f,color:#fff
    style api fill:#3a1e1e,color:#fff
    style ws fill:#2f2f3a,color:#fff
</div>
</div>
</div>

The confinement comes from [sandlock](https://github.com/multikernel/sandlock), which uses Landlock for filesystem rules and seccomp for network and syscall policy. No namespaces, no root. I picked it over bubblewrap for one reason: it can express "this process may reach exactly one hostname on exactly one port," and bubblewrap's model is all or nothing on network.

## What sandlock actually is, and why it's new

Worth a detour, because the tool is doing something I hadn't seen packaged this way before.

Sandboxing on Linux has traditionally meant namespaces. That's what containers are, that's what bubblewrap does, and it's why rootless containers need `/etc/subuid` configured and user namespaces enabled. sandlock takes a different route: it's a Rust project built on Landlock and seccomp, and it needs no root, no namespaces and no cgroups at all.

Landlock is the newer half of that. It's a Linux security module that lets an *unprivileged* process voluntarily give up access to parts of the filesystem, and then to network operations, with no help from an administrator. That capability arrived in pieces across kernel releases, and the ABI version numbers map directly onto features: filesystem rules landed in 5.13, TCP bind and connect restrictions came with ABI v4 in 6.7, and IPC scoping with ABI v6 in 6.12. sandlock asks for 6.12 by default, which is why the first thing my supervisor does is compare the kernel's reported ABI against the minimum and fail with a legible message instead of the opaque error you get otherwise.

The seccomp half is where it gets unusual. Landlock can restrict TCP ports, but it can't express "you may talk to this hostname." sandlock gets there with seccomp user notification, which lets a supervising process intercept syscalls like `connect` and `sendto` and decide, in userspace, whether to allow each one. That's what makes `api.moonshot.ai:443` expressible as a policy instead of a firewall rule I'd have to maintain by IP. It's also, as I found out, the reason there's no honest way to test that restriction from outside the process: the filter belongs to the process, not to a namespace you can enter.

The performance claims follow from having no namespace or image machinery to set up. Its README benchmarks a sandboxed `/bin/echo` starting in about 5ms against roughly 307ms for Docker, and Redis running at 97% of bare-metal throughput. For my case that's irrelevant, since I start one long-lived process and startup time rounds to nothing. It matters a great deal for the workload the project is clearly aimed at: sandboxing untrusted code many times, quickly, which is exactly the shape of an AI agent executing generated code. There's a lot in there I'm not using, including copy-on-write filesystem layering, HTTP-level ACLs, deterministic execution with frozen time and seeded randomness, port virtualization, and an OCI runtime shim for Kubernetes.

And it is genuinely young. A four-figure commit count and a few hundred stars when I looked, moving quickly, with the Go bindings explicitly listing features not yet wired up. That's not a criticism. It's the reason for the next section.

## Why both, when sandlock is meant to replace containers

This is the fair objection, so let me answer it before anyone else raises it. sandlock's own README positions it as an alternative to containers, not a companion. Its pitch is right there in the first lines: no root, no cgroups, no containers. Running it *inside* Docker is, on its face, doing the same job twice.

I did it anyway, and the reason is not sophisticated. **Porque a seguro se lo llevaron preso.**

sandlock is a young project, and I found a real defect in one of its security controls while building this, which I'll get to below. A control that silently stops enforcing is exactly the kind of thing you do not want to be your only barrier. Docker brings things sandlock does not: process and mount namespaces, a read-only rootfs, dropped capabilities, cgroup limits that actually measure the right thing, and a restart policy. sandlock brings a filesystem allowlist and a one-destination network rule, which is far more specific than anything Docker gives you. The two are strongest in different places.

There is a real cost, and it's not just complexity. As you'll see in a moment, the two layers partly cancel each other out, and I had to give one up to get the other. Knowing which one to sacrifice took measuring rather than guessing. If you're building something similar and the tool surface is narrow enough, one layer is a defensible choice. I'd rather carry the extra layer on a box that also runs things I care about.

## Why there are two processes instead of one

sandlock's Go SDK has a `Confine()` call that sandboxes the current process in place. That's the elegant version: one process, no child, no supervisor. I tried to use it, then read the contract properly on the second attempt:

> Only filesystem fields are honored; configuration that needs a supervisor or a fresh child (seccomp, network, resource limits, environment, ...) is rejected rather than silently ignored.

Filesystem only, and network policy explicitly rejected. Network policy is the entire reason I chose this tool over the alternatives, so the supervisor exists because the thing I care about most cannot be self-applied. One binary, two subcommands, and the parent's only job is to build the policy and hold the child under it.

That "rejected rather than silently ignored" is worth noticing, by the way. A library that refuses a setting it can't honour is doing you an enormous favour. The alternative, accepting `NetAllow` and quietly not enforcing it, would have shipped straight past me.

## Four things about sandlock that cost me real time

None of these are in the docs. I measured all of them.

**Docker's default seccomp profile blocks sandlock completely.** Every attempt to create a sandbox fails with `failed to create sandbox`. I reproduced it on two machines with different kernels and different Docker versions. It works with `--security-opt seccomp=unconfined`.

That's the awkward trade I mentioned. To gain sandlock's confinement you give up Docker's, so you pick one. I went with sandlock and I think it's right, but the reasoning has to be explicit: namespaces, dropped capabilities, the read-only rootfs and the cgroup limits all survive, and sandlock installs its own syscall filter on the worker. The worker is still seccomp-filtered, just by sandlock instead of by Docker. Only PID 1 runs unfiltered, and PID 1 does nothing but launch a child and wait. What I lose is a generic syscall allowlist. What I gain is a filesystem allowlist and a one-destination network rule, both far more specific to the actual risk.

If someone later "hardens" your compose file by deleting that line, the agent stops starting. Leave a comment.

**sandlock's `MaxMemory` cannot be used on a Go process at all.** This one was genuinely opaque. The worker wouldn't start: exit code -1, no output from the child, nothing in the logs. Every other knob worked. `MaxProcesses`, `MaxOpenFiles` and `MaxCPU` were all fine in isolation, and `MaxMemory` alone reproduced it.

The reason is that sandlock accounts memory by intercepting `mmap` lengths rather than measuring resident set size, and the Go runtime reserves an enormous virtual arena at startup. A bare `fmt.Println` program dies at 192M, 512M and 1G and survives only somewhere north of 2G. Meanwhile `/bin/sh`, `/bin/echo` and `python3` all run happily at 192M. It's specific to Go and it isn't a misconfiguration.

So any `MaxMemory` value you set is either useless or a lie, because low enough to be a real limit means the worker never starts. The cgroup handles memory instead, since cgroups measure RSS, which is the thing you actually meant. The setting is now absent from the policy with a comment explaining why, because a future me would absolutely try to add it back.

**sandlock does not build on musl.** I wanted a small Alpine image. The Rust core calls `ptrace` with `c_uint` constants that only match glibc's binding signature, and it fails with about twenty type errors. This isn't a Dockerfile problem and no amount of build flags fixes it. So, Debian, which has the side benefit of matching my server's glibc exactly. The binary I test locally is the binary that runs in production.

**One control is silently unenforced.** `NetAllowBind` is documented as a default-deny allowlist for ports the sandbox may listen on. It works on its own. Combine it with `NetAllow`, which I need since the worker has to reach the API, and the bind restriction stops being enforced with no error and no warning. I measured all three cases:

| Policy | bind allowed port | bind other port |
|---|---|---|
| `NetAllowBind` alone | allowed | **refused** (correct) |
| `NetAllowBind` + `NetAllow` | allowed | **allowed** (not enforced) |
| `NetDenyBind` alone | (not set) | refused (correct) |

My design needs exactly the combination that breaks. The practical impact here is nil, since the worker binds one port and nothing else in the process listens, so I declare it for documented intent and rely on it for nothing. But a security control that stops enforcing without telling you is the worst failure mode there is. If you're using sandlock for bind restrictions specifically, test them rather than trusting them.

There's a fifth, smaller one. `FSWritable` grants read rights along with write, so granting a writable `/tmp` makes every other process's temp files readable from inside the sandbox. I dropped it entirely, since the agent writes nothing to disk. That one only turned up because someone traced the Rust source instead of taking the field name at face value.

## The bugs that had nothing to do with sandboxing

This is the part I'd most want to read if someone else wrote this post. Every one of these was in code I designed, and every one was caught by review rather than by me.

**A forged header defeated the only cost control.** The rate limiter keyed on the left-most `X-Forwarded-For` entry. That header is attacker-controlled, because the proxy in front appends to whatever the client sent rather than replacing it, so a visitor picks their own identity and gets a fresh quota on every request. Demonstrated live: quota exhausted, then four requests differing only in that header, all accepted.

The fix is to trust a header the proxy sets and the client can't reach, and only when the connection actually comes from the proxy. That's standard advice I would have recited if you'd asked me, and I still got it wrong in the code, because I wrote the handler thinking about parsing rather than about trust.

**The turn cap couldn't be enforced as designed.** Each session gets a limited number of turns. The store checked the count under a lock, then the caller incremented it after releasing the lock. Two concurrent requests for one session both see room and both proceed. With a cap of one, twenty concurrent requests all got through.

The interesting bit is that this is a logical race rather than a data race, so the race detector stayed silent. The fix was to redesign the API: a checkout that reserves the turn inside the same critical section as the check, refuses a second concurrent request for the same session, and hands back a release function. The lesson is the same as the header bug. The mistake wasn't in the locking, it was in where I drew the boundary.

**A path could escape via a symlinked parent.** Path validation rejected absolute paths, `..` segments, and symlinks resolving outside the root. But when the final component didn't exist yet, the resolver fell back to the raw lexical path and the prefix check passed trivially. With a symlinked directory and a non-existent file inside it, the function returned success for a path the OS would open outside the root. Fixed by resolving the nearest existing ancestor instead of giving up.

**Error messages leaked the server's absolute paths.** Wrapping an `os` error with `%w` embeds a `*fs.PathError`, which contains the full resolved path. Ask for a file that doesn't exist and the agent tells you where the content directory lives on disk. Errors are now classified and rephrased using only the path the caller supplied.

**A default that failed open.** The binary defaulted to the `serve` subcommand when invoked with no arguments, and `serve` is the *unconfined* worker. A container entrypoint that lost its argument would have silently run the agent with no sandbox at all, which is the exact failure the whole design exists to prevent. The subcommand is now mandatory: no argument prints usage and exits non-zero.

That last one is the one I keep thinking about. Every other bug here is a mistake in reasoning. That one was a convenience default, added without thinking, in the one place where a convenience default is catastrophic.

## The property that makes this defensible

Underneath all the confinement, one design decision does more work than the rest combined: **no tool can execute code, and no tool can open a socket.**

There are three tools. List a directory, read a file, search the content. All three are native file operations in the agent's own process. Nothing shells out, nothing spawns an interpreter, nothing makes a network request. The only outbound connection the whole process makes is to the model API, and it's hardcoded.

The consequence is that prompt injection has no exfiltration path. Hostile text buried in content can make the model *say* something, but there's no mechanism for it to *send* anything anywhere. The model's output goes back to the browser that asked and nowhere else. That's a property of the tool surface rather than of the sandbox, and it holds even if the sandbox fails entirely.

Which is the right way round, because the sandbox is the newest and least battle-tested component in the stack. Landlock and seccomp share the host kernel, and sandlock is young. Given the defect I found in one of its controls, treating it as the last line of defence would be a mistake. So:

- The content directory holds only curated public files. Nothing sensitive is reachable even in the worst case.
- The container has no real home directory. `HOME` points at the read-only mount, so there's no `.ssh`, no `.env`, no shell history to find.
- Path validation is independent of Landlock and stays strict on its own terms.
- The tool surface has nothing an escape primitive could use.

A sandlock failure costs me defence in depth rather than the keys. Add a tool that executes code and every sentence in this section stops being true.

## Failing closed, and proving it

The supervisor exits non-zero rather than running the worker unconfined. That's the most important line of behaviour in the project, so it gets tested directly: run the container without `seccomp=unconfined` and confirm it exits and never serves.

There's a permanent test suite that runs the real policy against the real kernel. It asserts the workspace is readable while `/etc/shadow` is not, that the API host answers while an arbitrary domain and a raw IP are both refused, and that the resource caps actually bite. Those tests need network access and take a couple of seconds, and they're worth every millisecond, because they're the difference between "the policy says X" and "the kernel does X."

One verification I could not do honestly is worth mentioning. I wanted to prove from inside the running container that egress really is restricted. You can't. sandlock enforces network policy through per-process seccomp, so `docker exec`, or entering the network namespace, gives you a process that never inherited the filter. It would reach the whole internet and tell you nothing. I nearly went looking for root access to do it "properly" before realising the test was unsound at the concept level rather than the permission level. The egress restriction is verified by the policy test suite, and that's the level at which it can be verified at all.

## What it costs

Cheap, and not for the reason you'd guess. The model is `kimi-k2.6`, chosen because it's the lowest tier that supports streaming plus tool calls.

A question that reads a full post runs roughly 9,000 input tokens against 850 output, which comes to somewhere between one and three cents. But look at that ratio. The input dominates by a factor of ten, because every tool round resends the whole conversation *plus the file contents*. The per-token price of the model is not what would surprise me on an invoice. The architecture is.

Each tool round is a full extra API round-trip, which is also where the latency lives:

<div class="cde-window">
<div class="cde-window-title"><div class="cde-window-btns"><div class="cde-window-btn">&#9866;</div></div><span>One question, two API round-trips: where the fifteen seconds go</span><div class="cde-window-btns"><div class="cde-window-btn">&#9634;</div><div class="cde-window-btn">&#10005;</div></div></div>
<div class="cde-window-body">
<div class="mermaid">
sequenceDiagram
    participant B as Browser
    participant S as Agent
    participant T as Tools
    participant M as Model API
    B->>S: POST, one question
    S->>S: origin check, per-IP quota,<br/>session checkout reserves a turn
    S-->>B: 200, event stream opens
    Note over S,M: Round 1 costs a full round-trip
    S->>M: conversation + tool schemas
    M-->>S: call search_content
    S-->>B: event: tool_start
    S->>T: native file read, milliseconds
    T-->>S: matches
    S-->>B: event: tool_result
    Note over S,M: Round 2 resends everything, plus the file
    S->>M: conversation + tool result
    M-->>S: token deltas
    S-->>B: event: text (many)
    S->>S: commit history, release the session
    S-->>B: event: done
</div>
</div>
</div>

Two rounds, two round-trips. The tool execution itself is milliseconds. The waiting is the API answering twice, with a bigger prompt the second time. A tool-calling answer takes about fifteen seconds end to end and almost none of that is token generation, since inside a burst the tokens arrive with no measurable gap. Turning the model's thinking mode off and capping the tool rounds at three cut the worst case meaningfully. What you cannot do is make a tool call free, which is worth knowing before you design a chatty agent.

The instrumentation to know this rather than estimate it went in last, which is backwards. If you build one of these, log token usage from the first commit. I spent an afternoon confidently estimating costs I could have simply measured.

## What's still weak

I'd rather write this down than have it discovered.

The markdown renderer in the browser is the only place where untrusted content becomes HTML. It escapes entities before applying any transformation, which is the correct ordering, and it survived a battery of hostile inputs. It has not had an independent security review, unlike everything else here.

Rate limiting keys on the client IP as seen after proxy processing, which currently resolves to the CDN edge rather than the individual visitor. It isn't forgeable, and I tested that, but it's coarser than intended, so visitors sharing an edge share a quota.

Session identifiers are chosen by the client. They're unguessable in practice because the frontend generates UUIDs, but nothing cryptographically binds a session to whoever created it.

And the honest one: a determined distributed effort can still churn other visitors' sessions out of the store. I bounded the memory so it degrades instead of dying, and stopped there, because this is a blog.

## The thing I'd tell you

Every serious problem in this project was in code I wrote and reviewed myself, and every one was found by having something else look at it with fresh eyes and a mandate to try breaking it. My own tests passed. The header forgery, the turn cap race, the symlink escape, the path leak, the fail-open default: all of them survived my review and died in someone else's.

The sandboxing was the fun part and, in the end, the least important part. What makes this safe is the tool surface, and the tool surface is a decision you make in ten minutes at the start and then spend the whole project defending. Every time it's tempting to add a tool that runs a command, the argument in this post collapses.

The code is at [barrahome-2026-agent](https://github.com/bet0x/barrahome-2026-agent) if you want to look at it. Go press the backtick key.

---

*AI was used for research and drafting assistance on this post. Written by a human.*
