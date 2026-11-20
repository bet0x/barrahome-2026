# Sir Evals a lot

**Published on:** 2026/11/19

**Tags:** ai, agents, evals, llm, sre, kosken, prompts, testing

---

I build Kosken, an SRE platform, based on my experience experimenting with OpenRemedy and Nanoinfra.

In short: a small agent watches each Linux machine, and when a monitor fails, Kosken opens an incident. Fixed rules look at it first. If they can't settle it, a model diagnoses it with read-only checks and proposes one signed recipe, and a set of gates and, when needed, a person decide whether it runs. I wrote about the two earlier projects in [OpenRemedy: An Autonomous SRE for Linux Fleets](/2026/04/30/openremedy-introducing-the-project.md) and [nanoinfra: an AI Agent That Lives on My Own Boxes](/2026/08/28/nanoinfra-introducing-the-project.md).

<div class="cde-window">
<div class="cde-window-title"><div class="cde-window-btns"><div class="cde-window-btn">&#9866;</div></div><span>The path of an incident</span><div class="cde-window-btns"><div class="cde-window-btn">&#9634;</div><div class="cde-window-btn">&#10005;</div></div></div>
<div class="cde-window-body">
<div class="mermaid">
flowchart TB
    subgraph decide ["1. Decide what is wrong"]
    direction LR
    A["Monitor<br/>a check fails"] --> B["Signal<br/>opens an incident"] --> C["Playbook<br/>a false positive<br/>ends here"] --> D["Triage<br/>model"] --> E["Diagnosis<br/>model, read-only<br/>proposes a recipe"]
    end
    subgraph act ["2. Decide what runs"]
    direction LR
    F["Gates<br/>allow, ask<br/>or deny"] --> G["Approval<br/>when a gate asks"] --> H["Executor<br/>on the machine"] --> I["Check<br/>of the fix"] --> J["Review<br/>a miss becomes<br/>an eval case"]
    end
    decide --> act
</div>
</div>
</div>

That's a lot of parts that can change: the prompt, a tool, the loop that drives the model, a playbook, the agent. I change one of them almost every day. For months I had no way to tell whether a change made the diagnoses better or worse, other than reading incidents and forming an opinion. This is the story of the day I stopped doing that, and most of what I found wasn't in the model.

## It started with a Review tab

An eval needs something to compare against, and for an SRE tool that something is a person who reads a closed incident and says whether the diagnosis was right. So I added a Review tab to every incident with two questions: was the cause right, partly right or wrong, and was the fix right.

Then I went through about a hundred closed incidents from my lab and answered them. It was a tedious hour. It was also the hour that taught me the most, starting with the fact that three of those incidents got a "right" while they were still diagnosing. You can't grade a diagnosis that isn't done, so the tab now shows only on closed incidents.

A Partly or a Wrong answer does one more thing. It turns the incident into a candidate eval case, which keeps what the model saw: the input of the diagnosis, every tool call it made with the exact output, and what a person expects. That last part is the cause in words, a few key terms the answer has to contain, the fixes I accept and the recipes I forbid.

To run a case, a replay feeds the current prompt and model the same input. When the model asks for a check, the replay answers with the recorded output, and nothing touches a machine. A second model compares the cause it wrote with the expected one, and plain code checks the fixes against the accepted and forbidden lists.

## The false alarms

My first cases came from a bug, and I caused it.

I was deploying the platform that afternoon while the lab ran. Each deploy restarts the platform, and the agents lose their connection for a few seconds. The agent had a habit I didn't know about: a monitor check that was running at that moment got cut off, and the agent reported it as failed instead of "couldn't evaluate". After one deploy, five monitors fired in the same second. Three services, a container and a URL behind nginx, and every one of them was healthy.

Kosken got all five right. Each diagnosis said there was no fault and nothing to fix, which was true. I fixed the agent so a cut-off check counts as an error, and the platform ignores errors.

What bothered me was how much work it took to say "nothing is wrong". The recorded diagnoses used between 18 and 30 tool calls each, and 30 is the limit. The worst one checked six services, the container, the network and the listening ports, searched the recipe catalog eight times and then ran out of calls. That incident closed with "the diagnosis used its turn budget" and no diagnosis at all.

Those diagnoses became my first eight cases. The expected answer is "no fault, no change", and starting or restarting the healthy service is forbidden. A model that "fixes" something that isn't broken fails the case.

## The first run, twice

I started the first eval run, and a few minutes later I deployed again. Then again. The same deploys that made the false alarms killed the run. The job had a single attempt and no way to pick up where it stopped, so it sat at "Running" and blocked the next run until I fixed it. Now a run gets three attempts, each attempt skips the repeats that already have a result, and I can stop a run by hand. If you write an eval runner, make it survive a deploy before anything else, because you will deploy in the middle of a run.

The second try finished. Eight cases, three repeats each, on the prompt that was live, `diagnose@14`. Four of eight cases passed. When the model finished a diagnosis it was almost always right (86% of the causes), and one repeat named the wrong cause and proposed a forbidden recipe, which the forbidden list caught. But 10 of the 24 repeats didn't finish at all, and they all failed with the same line:

```
agent loop: tool call limit reached
30 checks, 21 not recorded, 14 model calls, 142,118 tokens
```

## Reading the calls

The pass rate on its own would have sent me to the prompt. Instead I put the recorded calls of each case next to the numbers of each failed repeat, and read the code of the loop and the replay. I found three problems, and they were in three different places.

The first one was in the loop. When the model hits the limit, the loop tells it "The tool call limit is reached. Give your final answer now." My prompt tells the model to finish by calling the `conclude` tool. So the model did exactly what it was told and called `conclude`, and the loop counted that as a second call past the limit and stopped the run.

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

That one hurt, because it wasn't only in the eval. It's why the nginx incident in production closed with nothing. The model had found the answer and the loop threw it away. Now the loop has closing tools: past the limit, the model can still call `conclude` once, and the message at the limit says so.

The second problem was in my replay. It answered a call only when the tool and the arguments matched a recorded call exactly. But the model in a replay doesn't ask the same way twice. It asked for `kosken-api` where the recording had `kosken-api.service`, for 80 lines of journal where the recording had 60, for a six-hour window where the recording had one hour, and for port `"8082"` as text where the recording had a number. Every one of those got "Not recorded in this case." The model took that as a temporary failure and tried again with other values, and that's where the 17 to 21 unrecorded calls per repeat came from.

A replay that's too strict produces the same numbers as a model that's too curious. If I hadn't read the calls, I'd have spent the evening tightening the prompt against my own harness. The replay now matches a call by what it reads, meaning the tool, the recipe and the unit, container or port, and it ignores size and time arguments. It answers with the recorded output and says the limits were different. A call that reads something genuinely new still gets "not recorded", with a note that other values won't help. Each repeat also keeps the list of its calls now, so the next time I don't have to guess where the budget went.

The third problem was the model, and it costs money in production too. The prompt says to run every read-only check that can show the cause before concluding. That's a good rule when something is broken. When a monitor fired once and came back by itself, the model applies the same rule and goes through the whole machine. A false alarm needs about four steps: the status of the unit, the signals, the journal of the unit and of the agent around that time, and a conclusion. So `diagnose@15` keeps that kind of diagnosis short, names a lost agent connection or a check that timed out as known reasons for a single failure, and asks the model not to rerun a check with bigger limits unless the first output was cut.

## The second run

I meant to change one thing at a time, so I could tell which fix did what. Then I shipped the loop fix, the replay fix and the new prompt in the same deploy, and ran the same eight cases again.

| | `diagnose@14`, old loop and replay | `diagnose@15`, new loop and replay |
|---|---|---|
| Cases passed | 4 of 8 | 8 of 8 |
| Causes right | 86% | 96% |
| Repeats with an error | 10 | 1 |
| Wrong fixes proposed | 1 | 0 |
| Tool calls per repeat | 23.5 | 11.3 |
| Tokens per repeat | 123,563 | 77,340 |
| Tokens for the run | 2.97 M | 1.86 M |

Because I mixed the changes, I had to go back to the call lists to split the credit, and luckily each fix leaves its own mark. No repeat reached the limit this time, the highest was 28 calls, so the loop fix didn't do anything in this run. It's there for the next diagnosis that runs out. The replay fix shows up as calls answered "with other limits", up to five in a repeat, and each of those would have been a dead end and a retry before. The prompt shows up in the call count, which fell by half. A kinder replay stops the retries, but it can't make the model ask for less. Most repeats of the worker and memcached cases now finish in six or seven calls, close to those four steps.

The one error was the grader handing back an empty answer, so it gets a second try now. The one "partly" found no fault, correctly, and then insisted the agent hadn't lost its connection, and the grader was right to mark it down.

There was one more surprise, in my own arithmetic. The summary of the first run said 74,582 tokens per repeat, which looked cheaper than the second run. It added up the tokens of the repeats that finished and divided by all of them. The ten repeats that hit the limit were the most expensive ones, and they counted as zero. The real number was 123,563. An eval that reports cost needs its cost tested like everything else.

## Where it stands

I still owe one run: the old prompt on the new loop and replay. That's the clean baseline I should have had, and the next prompt change will need it anyway.

The nginx case is still the one I don't like. It's the incident that ran out of calls in production, and in this run it took 28, 16 and 21 calls. It passes now, but it costs about twice what the others cost, and that's the next thing I'll read through call by call.

What I keep coming back to is that the worst bug of the day wasn't a wrong answer. It was a right answer that the loop threw away, on a real incident, and nothing on the incident page pointed at the loop. I found it because a pass rate of 50% didn't make sense next to causes that were 86% right, and that made me read the calls instead of the prompt.

---

*AI was used for research and drafting assistance on this post. Written by a human.*
