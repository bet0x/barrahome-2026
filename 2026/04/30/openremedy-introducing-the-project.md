# OpenRemedy: An Autonomous SRE for Linux Fleets

**Published on:** 2026/04/30

**Tags:** openremedy, sre, agents, llm, automation, incident-response

---

For the last several months I've been building a project I haven't talked about publicly. It's called **OpenRemedy**, and it's an autonomous Site Reliability Engineer for Linux fleets — the platform that picks up the pager at 03:00, diagnoses the alert, runs the fix if it's safe to, and writes the post-incident summary, all before a human gets out of bed.

This post is part introduction, part journal. The technical depth lives in the [whitepaper](https://openremedy.io/whitepaper). Here I want to talk about the why, what I've been wrestling with, and where the project is going.

---

## The problem

If you've been on call for any meaningful infrastructure, you know the rhythm. An alert fires. You wake up, log in, check the dashboards, run the same five commands you ran the last three times this happened. You restart something, watch the metric come back, file an internal ticket nobody will read, go back to sleep. Tomorrow somebody else takes the same alert.

The work is repetitive. The state of the world is observable. The fix is documented in a runbook somewhere. None of this actually requires a human to be awake — except that it always has, because the tools that try to automate it either trust the fleet too much (auto-remediate everything, eventually delete prod) or trust it too little (page a human for every CPU spike, eventually burn out the team).

OpenRemedy is the wedge between those two failure modes. It's an agentic platform that closes incidents on the infrastructure an operator already runs, with safety boundaries that are explicit, layered, and auditable.

---

## What it does

When an alert fires — from a Prometheus webhook, a custom monitor a daemon on the host runs, a Datadog rule, a manual incident the operator filed by hand — the platform classifies it, picks an agent specialised for the affected role (database guardian, container host sentinel, generic SRE), and walks through a deterministic pipeline: triage, diagnose, validate, execute, review.

Only two of those stages call a model. The rest is platform code. The agent's authority to execute a remediation is gated by a trust ladder — every server lives in one of three modes (audit, shadow, live), every agent has a trust level that interacts with each recipe's risk classification, and a separate safety classifier reviews the proposed action before it runs. All of it is tagged, logged, exportable.

The catalogue of remediations is curated, not synthesised. A platform agent doesn't write shell scripts on the fly to fix your database — it picks from a set of vetted recipes that an operator can read, modify, or revoke. The recipes ship with the product; new ones can be added by the operator.

The audit trail is the actual product surface for compliance. Every action is logged with the actor, the IP, the agent that proposed it, the human that approved it (or didn't). The reasoning trail of each stage is reconstructable end-to-end.

If the agent's confidence drops, or the action requires more authority than the agent has been granted, the incident escalates to a human with the full context attached — diagnosis, evidence, proposed action, and why the gate fired. No more "PagerDuty woke you up, here's a one-line alert, good luck."

---

## The adventures of getting here

The shape of the project has changed several times. Some of the pivots were obvious in hindsight, others took weeks of building the wrong thing first.

**The first version was too autonomous.** The original sketch was "give an agent a server and let it run." It took about a week of testing on my own servers to realise that without an explicit trust model, an agent's reasonable-sounding decision could quietly do something irreversible at the wrong time. I needed structure between "talk to the agent" and "the agent acts."

That structure became the trust ladder, and then the server-mode system, and then a safety classifier on top of that, and then a recipe-risk taxonomy underneath that. Each layer was a response to a specific way the previous version could go wrong. None of them were planned up front. The whitepaper has the full taxonomy; the short version is that defense in depth only works if each layer fails for a *different* reason than the others, and getting that right took multiple rewrites.

**Picking the boundary was hard.** Generalist coding agents — Claude Code, Cursor, Copilot — answer the question "what would a senior engineer do here?" across a broad surface. I tried framing OpenRemedy that way at first. It didn't work. The boundary that does work is much narrower: "given a known incident shape on a known kind of server, which of the five known fixes applies, and is it safe to run right now?" Narrower question, sharper answer, much better safety story.

**The audit trail wasn't a feature, it was a constraint.** I started thinking of the audit log as a compliance checkbox. It became the actual control surface — the thing that lets a regulated operator trust the platform enough to give it production authority. Every change in the architecture since has been measured against "is this still reconstructable from the trail." That single rule has killed more clever ideas than I want to admit.

**The first real autonomous resolution was a moment.** A few weeks ago, on a real server, the platform woke up to a service-down alert, walked through diagnose, picked the right recipe, classified it as safe, ran it, verified the service was back up, and closed the incident. I watched it happen from my laptop without touching anything. It's the demo I keep playing back when I doubt the project.

**Tonight, while writing this post, I tested the human-in-the-loop flow end-to-end on this very blog server.** I stopped nginx manually to fake an outage. The platform detected it, ran through the pipeline, paused for my approval at the execute stage, ran the restart recipe when I clicked Approve, and resolved the incident — without me touching anything else. The incident in the dashboard now shows the full reasoning trail. The whole loop, from outage to resolution, took under two minutes. That's the product I've been trying to build.

---

## What it isn't

It isn't a chatbot. The operator doesn't talk to the platform to make it work. The platform watches, decides, acts — and the human's job is to set the policy that decides how much of that loop is autonomous, not to drive every decision.

It isn't a generalist agent. It doesn't write your code or design your schema. The narrowness is what makes the safety story work.

It isn't a Kubernetes-only product. The wedge is generic Linux. If you have a fleet of hosts running services, and somebody on call for those hosts, OpenRemedy is for you.

---

## Where it is now

The platform is running in production on my own infrastructure today, including the host that serves this blog. I've been using it as the primary on-call for everything I run for several weeks. The end-to-end autonomous loop closes real incidents — the kind that wake up a normal operator — without me touching the keyboard.

It is not yet generally available. There's a closed test pool I'm onboarding into in small batches. If you operate a Linux fleet of any meaningful size and the problem in this post resonates, write to me and I'll add you to the queue. I'm being deliberate about the early users because the safety story is the product, and the first month of real-world feedback shapes how strict the defaults ship.

The plan, in the near future, is to **open source it**. The architecture has been designed with that in mind from the start — the configuration model, the recipe catalogue, the audit log shape, the agent trust system are all things I want operators to be able to read, fork, and run themselves on prem. The closed phase is to harden the rough edges before the public sees them. The open phase is the point.

---

## Read more

- [OpenRemedy whitepaper](https://openremedy.io/whitepaper) — the architectural depth this post is deliberately skipping. Five-gate safety model, the trust ladder, the operator control surface, where the platform is going. Citations included.
- [openremedy.io](https://openremedy.io) — landing page, documentation, contact.

If the project is interesting to you, the whitepaper is the next thing to read. If it sounds like something you'd actually want to run on your fleet, drop me a line.

I'll keep posting here as the project moves from closed beta toward the open release.
