# The Swarm: How OpenRemedy's Linux Agents Collaborate (and Why They Don't All Share One Brain)

**Published on:** 2026/05/28

**Tags:** openremedy, agents, llm, swarm, sre, linux, automation, security

---

A month ago I [introduced OpenRemedy](https://openremedy.io) — an autonomous SRE for Linux fleets. That post was the *why*. This one is the *how*: how the agents actually work, why there isn't one big agent but a swarm of small ones, why they deliberately run on different models, and what keeps the whole thing from doing something stupid at 03:00.

I'm going to stay above the implementation. There's a recipe I'm not going to hand out — the exact prompts, the precise gate thresholds, the internal taxonomy. But the *architecture* is worth talking about, because I think the shape of it is where this era of Linux agents is heading: not one heroic model that does everything, but a swarm of specialised, cheap, bounded workers that collaborate and check each other.

---

## One agent is a liability. A swarm is a system.

The naive version of "AI fixes your servers" is a single agent with shell access and a clever prompt. I built that first. It works in a demo and terrifies you in production, because a single agent has a single point of judgment, a single failure mode, and a single bill that scales linearly with how careful you make its reasoning.

OpenRemedy is a **swarm**. An incident isn't handled by *an* agent — it moves through a deterministic pipeline of stages (triage, diagnose, validate, execute, review), and each stage is handled by whichever agent is best suited to it. A database incident gets a database-shaped specialist. A container host gets a container sentinel. A stage that only needs to classify gets a fast, cheap worker; a stage that needs to reason about root cause gets a stronger one.

The key design decision: **most of the pipeline is not the model.** Of those five stages, only a couple actually call an LLM. The rest is platform code — routing, gating, evidence assembly, persistence. The model is a component inside a deterministic machine, not the machine itself. That inversion is the whole ballgame. It's what makes the behaviour auditable, the cost predictable, and the failure modes enumerable.

<div class="cde-window">
<div class="cde-window-title"><div class="cde-window-btns"><div class="cde-window-btn">&#9866;</div></div><span>Incident pipeline — model calls are the exception, not the rule</span><div class="cde-window-btns"><div class="cde-window-btn">&#9634;</div><div class="cde-window-btn">&#10005;</div></div></div>
<div class="cde-window-body">
<div class="mermaid">
flowchart LR
    A[Alert fires] --> T[Triage<br/>classify + route]
    T --> D[Diagnose<br/>root cause]
    D --> V[Validate<br/>challenge the plan]
    V --> G{Guardrails}
    G -->|safe + authorised| E[Execute<br/>vetted recipe]
    G -->|needs approval| H[Human]
    H --> E
    E --> R[Review<br/>verify + report]
    style T fill:#1e3a2f,color:#fff
    style D fill:#1e3a2f,color:#fff
    style V fill:#3a2f1e,color:#fff
    style R fill:#3a2f1e,color:#fff
    style G fill:#3a1e1e,color:#fff
</div>
</div>
</div>

The green stages are where a model thinks. The amber ones are mostly platform code with a model consulted narrowly. The red one is pure code — no model gets a vote on whether something is safe to run. More on that later.

---

## Different agents, different brains — on purpose

Here's the part people don't expect: **the agents don't all run on the same LLM.** That's not an accident of configuration; it's a cost-amortisation strategy baked into the architecture.

Think about what each stage actually demands of a model:

- **Triage** is mostly classification: what kind of incident is this, has it happened before, how severe is it? That's a job a small, fast, cheap model does well. You do not need a frontier model to recognise "nginx is down again."
- **Diagnosis** is where reasoning earns its keep — correlating evidence, ruling out transient causes, choosing the right fix. Here a stronger model pays for itself.
- **Validation** is an adversarial second opinion: challenge the diagnosis, look for the alternative explanation. Different temperament, sometimes a different model entirely.
- **Review** is verification and write-up — again, not the most expensive thinking in the world.

If you run the frontier model on all five stages for every incident, your cost per incident is brutal and most of it is wasted on tasks a cheaper model handles fine. By letting each agent declare which provider and model it runs on, the expensive reasoning lands only where it matters. The cheap stages stay cheap. Across a fleet generating hundreds of incidents a day, that difference is the line between "sustainable" and "I turned it off because the bill scared me."

It also means **no single vendor owns your remediation loop.** One tenant can run triage on a small local-ish model, diagnose on a strong hosted one, and never notice they're crossing provider boundaries mid-incident — the platform abstracts the provider behind a uniform interface. When a provider has a bad day, you reroute a role to another model without rewriting anything. In an era where every model has a different price/latency/quality point and those points move weekly, *not* hard-coding one brain into the system is a feature, not a compromise.

---

## Tools, not free-form shell

An agent that can run arbitrary shell on your production box is a remote code execution vulnerability with a friendly chat interface. I learned this the uncomfortable way.

OpenRemedy's agents don't get a shell. They get **tools** — a bounded, typed surface. Read-only diagnostics are exposed as a fixed vocabulary of verbs (inspect a container, check a service, tail a log, list volumes), each with its arguments validated against an allow-list and quoted before anything touches a host. An argument that carries shell metacharacters doesn't get cleverly escaped and run — it gets *rejected* and handed back to the agent as data. The agent can ask for information in a hundred ways, but it cannot turn a log-path argument into a command.

Remediation is even more constrained. Agents don't write scripts; they **propose recipes** from a curated catalogue — vetted, reviewable units of change that an operator can read, modify, or revoke. The agent's job is to pick the right recipe and the right parameters, not to invent the fix. That distinction is the difference between "the agent recommended restarting the service" and "the agent decided to prune all stopped containers," and yes, the second one is a real story from early testing, and yes, it's exactly why the catalogue is curated now.

Tool output gets scrubbed before it's ever persisted, too — if an application on a host prints a credential to stdout and a diagnostic captures it, that secret is redacted before it lands in a transcript or a timeline. The boundary isn't just "what the agent can do," it's "what the agent's eyes leave behind."

---

## Parallelism: a swarm, running at swarm scale

A single incident moving through five sequential stages is the simple case. The interesting case is *hundreds* of incidents at once, each a pipeline, each with an agent thinking and tools reaching out to hosts — without the whole thing collapsing into one serialized queue or melting a connection pool.

Three kinds of parallelism matter here:

- **Within a stage**, an agent can fan out tool calls that are independent — check three services, read two logs — and the platform runs them concurrently rather than one-at-a-time.
- **Across specialists**, when an incident benefits from multiple perspectives, several specialist agents can diagnose in parallel and their findings get merged, each isolated so one failure can't sink the batch.
- **Across incidents**, the swarm runs many pipelines concurrently, bounded by an explicit concurrency cap so a burst of alerts queues gracefully instead of stampeding the database, the model providers, and the hosts all at once.

That last point sounds obvious and is the hardest to get right. The naive "spawn a task per incident" works until a slow provider, a hung SSH connection, or a saturated connection pool turns a hundred concurrent incidents into a hundred frozen ones. The fixes are unglamorous — bound the work, time-box every external call, never let a blocking operation hold the event loop, make sure a crashed job always resolves its state instead of parking an incident forever. None of it is exciting. All of it is what separates a demo from a platform you'd hand a production fleet.

---

## The guardrails: defense in depth, fail-closed

Here's the rule the whole system is organised around: **no model gets to decide that an action is safe to run.** A model can *propose*. Whether a proposal executes is decided by platform code, in layers, and every layer is designed to fail closed — when in doubt, it asks a human.

Without giving away the exact thresholds, the shape is this:

<div class="cde-window">
<div class="cde-window-title"><div class="cde-window-btns"><div class="cde-window-btn">&#9866;</div></div><span>Two-stage approval gate — every ambiguous outcome escalates</span><div class="cde-window-btns"><div class="cde-window-btn">&#9634;</div><div class="cde-window-btn">&#10005;</div></div></div>
<div class="cde-window-body">
<div class="mermaid">
flowchart LR
    P[Agent proposes a recipe] --> S1{Stage 1<br/>trust x risk x mode}
    S1 -->|not permitted| HUMAN[Escalate to human]
    S1 -->|permitted| S2{Stage 2<br/>safety classifier}
    S2 -->|safe| RUN[Execute]
    S2 -->|unsafe / abstain / timeout / error| HUMAN
    style HUMAN fill:#3a2f1e,color:#fff
    style RUN fill:#1e3a2f,color:#fff
    style S1 fill:#3a1e1e,color:#fff
    style S2 fill:#3a1e1e,color:#fff
</div>
</div>
</div>

**Stage one** is deterministic. Every server runs in one of three modes (roughly: observe-only, propose-but-don't-act, act-when-allowed). Every agent carries a trust level. Every recipe carries a risk classification. The intersection of those three decides whether an action can auto-execute or must wait for a human. It's a lookup, not a judgment call — no model involved.

**Stage two**, only reached when stage one permits auto-execution, is a separate safety review of the specific proposed action. And here's the part that matters: *only* an unambiguous "safe" lets it through. Unsafe, unsure, a timeout, an error, a model that didn't answer — all of those escalate to a human. The default is never "proceed." The default is always "ask."

The reason this works is the same reason defense in depth works anywhere: each layer fails for a *different* reason than the others. The mode gate fails on policy. The trust ladder fails on authority. The risk taxonomy fails on blast radius. The safety classifier fails on the specific action. For an unsafe action to slip through, every one of those independent checks has to be wrong simultaneously and in the same direction — and the whole thing is logged, so when something does go wrong you can reconstruct exactly which layer should have caught it.

And all of it is auditable end-to-end. Who proposed, which agent, which model, which human approved or rejected, what the gate decided and why. The audit trail isn't a compliance checkbox bolted on the side — it's the control surface that lets a regulated operator hand the platform real authority in the first place.

---

## Security isn't a milestone — it's a monthly tax

OpenRemedy has been cooking for about 18 months. I don't say that to brag about persistence; I say it because security in a system that can touch production is not a feature you ship once. It's a tax you pay every month, and the bill is always a little different.

The guardrails above are the *authorisation* story — who's allowed to do what. But authorisation assumes the agent can only act through the doors you built. The other half of the work is making sure there are no windows. And every month, testing the thing against itself, I find another window I have to close.

I'll give the shape of a few without the recipe:

- **The agent's tools were once too trusting.** Early on, a diagnostic tool would take an argument from the model and interpolate it into a command. It sounds harmless until you realise the model reads untrusted data off your servers — log lines, container labels, process names — and a crafted string in that data can become an instruction. The fix was to treat every model-supplied argument as hostile: validate against an allow-list, quote it, and bounce anything suspicious back as *data* instead of running it. That's a window I didn't know was open until I went looking.
- **Secrets leak through the side door.** An agent's transcript is gold for debugging and gold for an attacker. If an application on a host prints a password to its own logs and a diagnostic captures it, that secret would quietly end up in a stored transcript. So tool output gets scrubbed for high-confidence secrets before anything is persisted — conservatively, biased toward missing an exotic format rather than redacting a benign log line and ruining a diagnosis.
- **Scale itself is a security property.** This month's tax was hardening the platform to run hundreds of concurrent incidents without a hung connection, a starved pool, or a stalled model freezing the whole swarm. None of that is glamorous and all of it is safety: a platform that falls over under load is a platform that fails *open* at the worst possible moment.

That's what "maturing month over month" actually looks like from the inside. Not a roadmap of features — a slow accretion of closed windows, each one a specific way I watched the previous version almost go wrong. Eighteen months in, the interesting work isn't making the agents smarter. It's making the system around them harder to fool, harder to break, and honest about what it did. The intelligence was the easy part. The boundaries are the product.

---

## Why this is the shape of things

The hype version of agentic infrastructure is "one super-agent that runs your whole company." I don't believe in it, at least not for systems where a wrong action is expensive and irreversible. The version I believe in — the version I'm building — is a swarm: many small agents, each bounded, each cheap where it can be and strong where it must be, each checking the others, all wrapped in deterministic guardrails that a human can read and revoke.

That's not a limitation I'm apologising for. It's the design. A frontier model is a brilliant, expensive, occasionally overconfident colleague. You don't give that colleague root on the fleet and go to sleep. You give them a bounded role, a clear escalation path, a second opinion, and a paper trail — and you put the cheap, reliable workers on the boring 90% so the brilliant one is only on the clock when it's worth it.

The collaborative Linux swarm — specialised, multi-model, parallel, bounded — is, I think, what "AI runs your infrastructure" actually looks like once you've been burned enough times to stop trusting any single thing. Including the model.

---

*OpenRemedy is in active development. The architecture above is real and running; the exact recipe stays in the kitchen. If you're running Linux fleets and this resonates — or if you think I've got the boundary wrong — I'd genuinely like to hear it: [openremedy.io](https://openremedy.io).*
