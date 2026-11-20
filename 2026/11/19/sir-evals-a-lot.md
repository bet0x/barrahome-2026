# Sir Evals a lot

**Published on:** 2026/11/19

**Tags:** ai, agents, evals, llm, sre, kosken, prompts, testing

---

I build Kosken, an SRE platform. A small agent runs on each machine and watches it. When a monitor fires, a model gets the incident and about a dozen tools. The tools run read-only checks, read metrics and signals, search past incidents, and look up recipes in a catalog. The model finds the cause and proposes a fix. A person or a set of gates decides whether the fix runs.

So a diagnosis depends on the agent, the platform, the model, the tools, a long prompt and the recipes. I change one of them almost every day. Until this week I could not say whether a change made Kosken better or worse.

This post is about the first real eval run, and what it found. Most of it was not in the model.

## Feedback first, then cases

An eval needs a ground truth. For an SRE tool, that is a person who reads a closed incident and says whether the diagnosis was right.

Every closed incident now has a Review tab with two questions. Was the cause right, partly right, or wrong? Was the fix right? I answered it for about a hundred closed incidents from my lab. It took an hour and it was tedious, but it was the most useful hour of the week. In the first pass, three incidents got a "right" while they were still diagnosing. Now the Review tab shows only on closed incidents.

A Partly or Wrong answer also creates a candidate eval case from the incident. The case keeps what the model saw:

- The input of the diagnosis: the server, its facts, the monitor, the signals and the notes.
- Every tool call that the model made, with its exact output.
- The result that a person expects. That is the cause in words, key terms that the answer must contain, the fixes that I accept, and the recipes that I forbid.

A replay runs the current prompt and model against the case. When the model asks for a check, the replay gives it the recorded output. Nothing runs on a machine. A second model compares the cause with the expected one. Code checks the fixes and the forbidden recipes, without a model.

## The bug that made the cases

My first eight cases came from one bug in the agent.

I deployed the platform while the lab ran, and the agents lost their connection for a few seconds. The monitor checks that ran at that moment stopped halfway. The agent reported them as failed, when it should have reported "could not evaluate". Five monitors fired in the same second: three services, a container, and a URL behind nginx. All five were healthy.

Kosken got all five right. Each diagnosis said that there was no fault and nothing to fix. I changed the agent so that a check that stops halfway is an error and not a failure, and the platform ignores errors.

Then I looked at what it cost to say "nothing is wrong":

| Recorded diagnosis | Tool calls | Concluded |
|---|---|---|
| SRE 05 api | 18 | yes |
| SRE 03 worker | 20 | yes |
| SRE 03 worker (another one) | 20 | yes |
| SRE 06 memcached | 20 | yes |
| SRE 05 api (another one) | 21 | yes |
| SRE 04 container | 22 | yes |
| SRE 02 nginx app | 29 | yes, on the last call |
| SRE 02 nginx app (another one) | 30 | no |

The limit is 30 tool calls. The last diagnosis in the table never concluded. It checked six services, the container, the network and the listening ports. It searched the recipe catalog eight times. Then it hit the limit, and the incident closed with "the diagnosis used its turn budget".

These diagnoses became my first cases. The expected answer is "no fault, no change". A restart or a start of the healthy service is a forbidden recipe, so a model that "fixes" the service fails the case.

## The first run

The first attempt at a run died halfway, and my own deploys killed it. The job had one attempt and could not resume, so it stayed at "Running" and blocked the next run. I deployed twice in ten minutes that evening. Now a run gets three attempts, each attempt skips the repeats that already have a result, and the owner can stop a run. If you build an eval runner, make it survive a deploy before anything else.

Then I ran the eight cases, three repeats each, on the current prompt, `diagnose@14`:

| | Result |
|---|---|
| Cases passed | 4 of 8 (50%) |
| Cause right, in repeats that finished | 86% |
| Repeats that stopped with an error | 10 of 24 |
| Wrong fixes proposed | 1 |
| Tool calls per repeat | 23.5 |
| Tokens per repeat | 123,563 |

When the model finished, it was almost always right. One repeat named the wrong main cause and proposed a forbidden recipe, and the forbidden list caught it. All ten errors had the same message:

```
agent loop: tool call limit reached
30 checks, 21 not recorded, 14 model calls, 142,118 tokens
```

## Three problems, and one of them was the model

For each failed repeat I read what the model called, what the replay answered, and where the run stopped. I found three different problems.

### 1. The loop did not let the model finish

At the limit, the loop told the model: "The tool call limit is reached. Give your final answer now." My prompt tells the model to end with the `conclude` tool. The model did what the prompt said and called `conclude`. The loop counted that as a second call past the limit and stopped the run with an error.

<div class="cde-window">
<div class="cde-window-title"><div class="cde-window-btns"><div class="cde-window-btn">&#9866;</div></div><span>The model ends the way the prompt says, and the loop stops it</span><div class="cde-window-btns"><div class="cde-window-btn">&#9634;</div><div class="cde-window-btn">&#10005;</div></div></div>
<div class="cde-window-body">
<div class="mermaid">
sequenceDiagram
    participant M as Model
    participant L as Loop
    M->>L: run_check (call 31)
    L->>M: "Limit reached. Give your final answer now."
    M->>L: conclude(findings) (call 32)
    Note over L: second call past the limit
    L--xM: stop: tool call limit reached
    Note over M,L: the diagnosis is lost
</div>
</div>
</div>

This bug was in production too. It is why the nginx incident closed with no diagnosis. The loop now has closing tools. Past the limit, the model can call `conclude` one time, and the message at the limit tells it to. All other tools stay blocked.

### 2. The replay was too strict

The replay answered a call only when the tool and the arguments matched a recorded call exactly. The model in a replay does not always ask the same way as the model in the recording:

- `unit: "kosken-api"` where the recording has `"kosken-api.service"`
- `lines: 80` where the recording has `lines: 60`
- `window: "6h"` where the recording has `"1h"`
- `port: "8082"` as text where the recording has the number

Each of these got "Not recorded in this case." The model took it as a temporary failure and tried again with other values. That explains the 17 to 21 unrecorded calls in each failed repeat. Most of the budget went on retries against my replay.

A replay that is too strict gives the same numbers as a model that asks too much. If I had not read the calls, I would have blamed the prompt.

Now the replay matches a call by what it reads: the tool, the recipe, and the object (the unit, the container or the port). It ignores size and time arguments. It gives the recorded output and says that the limits were different. A call that reads something new still gets "not recorded", and the message says that other values will not help. Each repeat also keeps its list of calls and the answer to each one, so I can see where the budget went.

### 3. The model treats a false alarm like an outage

This problem is in the model, and it costs money in production too. The prompt says: "Before you conclude, run every read-only check that can show the cause." For a real fault, that rule is good. For a monitor that already came back by itself, the model uses it to check the whole machine.

A false alarm needs about four steps. Check the status of the unit. Read the signals. Read the journal of the unit and of the agent around that time. Conclude. So `diagnose@15` adds two rules:

- When a monitor is back in its desired state, the diagnosis stays short. The prompt names a lost agent connection and a check that timed out as known reasons for one failure.
- The model does not run the same check again with other limits, unless the first output was cut and the missing part matters.

## The second run

My plan was to change one thing at a time: the loop first, then the replay, then the prompt. Then I put all three in the same deploy. So the second run measures all three together. Same eight cases, same model, three repeats each:

| | `diagnose@14`, old loop and replay | `diagnose@15`, new loop and replay |
|---|---|---|
| Cases passed | 4 of 8 (50%) | 8 of 8 (100%) |
| Cause right | 86% | 96% |
| Repeats with an error | 10 | 1 |
| Wrong fixes proposed | 1 | 0 |
| Tool calls per repeat | 23.5 | 11.3 |
| Tokens per repeat | 123,563 | 77,340 |
| Tokens for the run | 2.97 M | 1.86 M |

Each fix leaves a different trace in the call lists, so I can still tell them apart.

No repeat reached the limit. The highest count was 28 calls. So the loop fix did nothing in this run. It is there for the next diagnosis that runs out of calls.

The replay fix shows in the answers. Some repeats got up to five calls answered "with other limits". In the first run, each of those calls got "not recorded" and caused more calls.

The prompt shows in the number of calls, which fell by half. A replay that answers more calls can stop the retries, but it cannot make the model ask for less. Most repeats of the worker and memcached cases now end in six or seven calls. That is close to the four steps a false alarm needs.

The one error came from the grader. It gave an empty answer one time, and now it gets a second try. The one "partly" found no fault, which is correct, but it also said that the agent did not lose its connection. The grader was right to mark it down.

I still owe one run: `diagnose@14` on the new loop and replay. The next prompt change needs that baseline anyway.

One case still bothers me. The nginx case that ran out of calls in production took 28, 16 and 21 calls in this run. It passes, but it costs twice as much as the others. I will look at it next.

## What I take from this

The eval tested the whole system, and the worst bug was in how two parts met. The tool limit was reasonable. The prompt that asks for `conclude` was reasonable. Together they threw away correct diagnoses in production. I could not see that in the prompt or on the incident page, because "used its turn budget" looks like the model's fault.

The first pass rate was 50%, and the model caused only part of it. If I had tuned the prompt against that number, I would have tuned it around my own replay. Read the calls of a failed repeat before you touch the prompt. And change one thing per run. I did not, and I had to read 24 call lists to know which fix did what.

Count tokens next to the pass rate, and check how you count them. The repeats that finished in the first run used about 128,000 tokens each to say "nothing is wrong". An eval that counts only pass and fail would call that a success. My summary also had a bug. It added the tokens of the repeats that finished, then divided by all repeats. The first run showed 74,582 tokens per repeat instead of 123,563. The errors used the most tokens, and the summary made that run look like the cheapest one.

The cases came from people. The Review tab is the slow part, and it is also the reason the eight cases exist. Every Partly or Wrong answer becomes a candidate case, and each case stays as a test.

Treat the eval runner like production code. It must survive a deploy, a person must be able to stop it, and it must keep enough detail per repeat to explain a failure. Mine did none of that on the first run.

---

*AI was used for research and drafting assistance on this post. Written by a human.*
