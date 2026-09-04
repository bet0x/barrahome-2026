# Your Agent's Biggest Prompt Cost Is Tools It Never Uses

**Published on:** 2026/09/04

**Tags:** ai, agents, nanoinfra, llm, tokens, cost, tool-search, mcp

---

Last week I wrote about nanoinfra, the AI agent I run on my own boxes. This week is about one number on its bill, and how I cut it.

Here is the number. On the demo, a plain "hello" cost 17,302 input tokens. Of those, 10,273 were tool schemas. The model had not called a single tool yet. It had said nothing. The greeting was expensive because every tool the agent owns describes itself in the prompt, on every turn, whether the turn uses it or not.

Two clusters were the worst of it. The diagram tools cost 2,438 tokens. The SSH server tools cost 1,419. Together that is 3,857 tokens, about 22% of the whole prompt, spent on capabilities a "hello" was never going to touch. You pay that on every message, forever.

## Why it happens

A language model can only call a tool it can see. "See" means the tool's name, its description, and the shape of its arguments are all written into the prompt. Ten tools is fine. Fifty tools is a tax you pay on every turn, and it gets worse: past thirty or forty tools the model also picks the wrong one more often. You lose tokens and accuracy at the same time.

The naive fix is to remove tools. But a tool you removed is a capability the agent lost. I did not want a cheaper agent that could do less. I wanted the same agent to stop paying for tools it was not using this turn.

## Step one: let a user ask for a group

The first version put related tools into a named group and gave the group a mode.

- `always` is the old behavior. Every schema in every prompt.
- `mention` hides the schemas. The prompt carries one short line that says the group exists. The schemas arrive only for a turn that names the group with `@`.

So the diagram tools become one line: "these tools are installed, say `@diagrams` to use them this turn". That line is about 50 tokens against the 2,438 the schemas cost. The user decides, per turn, when the tokens are worth spending.

The line is the whole trick. Without it the model cannot see that the capability exists, so it either fails or quietly picks a worse tool. A silently worse answer is harder to notice than a large bill. With the line, the model can say "I can do that if you attach `@diagrams`" instead of guessing.

MCP servers and connectors already worked this way, so the same mode now covers all three: built-in tool groups, MCP servers, and data connectors.

## Step two: let the model ask for itself

`mention` waits for a person. That is fine for two groups. It does not scale, for one reason: each hidden group costs its own line. Hide twenty groups and the lines that describe what you hid start to cost what the schemas did.

So the new release adds a third mode, `search`, and a tool called `tool_search`. The schemas are hidden the same way. But now the model loads a group itself. It calls `tool_search` with a topic, the matching group loads for the rest of the turn, and one shared pointer replaces the per-group lines. One pointer, however many groups you defer. That is the flat cost that makes deferring a lot of tools worthwhile.

<div class="cde-window">
<div class="cde-window-title"><div class="cde-window-btns"><div class="cde-window-btn">&#9866;</div></div><span>The model loads a hidden group mid-turn, then uses it</span><div class="cde-window-btns"><div class="cde-window-btn">&#9634;</div><div class="cde-window-btn">&#10005;</div></div></div>
<div class="cde-window-body">
<div class="mermaid">
sequenceDiagram
    participant U as User
    participant A as Agent
    participant M as Model
    U->>A: "run uptime on the web server"
    Note over A,M: Prompt has the core tools + one pointer.<br/>The server tools are NOT in it.
    A->>M: prompt (no server schemas)
    M->>A: tool_search("run a command over ssh")
    A->>A: load the `servers` group for this turn
    A->>M: next prompt now carries the server tools
    M->>A: execute_on_server("uptime")
    A->>U: the output
</div>
</div>
</div>

This is the same idea Anthropic ships as its tool search tool, where you mark tools `defer_loading` and the model searches a catalog. nanoinfra keeps it provider-agnostic. The model does the search, my gateway attaches the group for the turn, and the next request to the model carries the schemas. It works the same on Anthropic, on an OpenAI-compatible endpoint, and on a self-hosted model, because the mechanism is mine, not the vendor's.

## The rule that does not bend

There is a hard line here, and I want to be clear about it because it is a security property, not a convenience.

An agent has a ceiling: the groups it may reach at all. `search` cannot widen past it. If an agent's ceiling does not include the `servers` group, then `tool_search` never finds it, never offers it, and refuses it even if the model somehow names it. Hiding a schema to save tokens and forbidding a capability for safety are two different switches, and the safety one wins.

I proved this to myself the hard way on the live demo. I set the diagram and server groups to `search`, asked the agent to run something on a server, and `tool_search` answered "nothing is searchable". For a moment I thought it was broken. It was not. The default agent's ceiling was empty, so those groups were off its contract entirely. The search was doing exactly what it should: it will not smuggle a capability past a wall you put up on purpose. Once I gave the agent a ceiling that included the groups, it searched, loaded them, and ran the command.

## One gotcha worth writing down

Changing a group's mode, or an agent's ceiling, needs a restart. Those settings are read once when the gateway starts, on purpose, so the stable part of the prompt stays byte-for-byte identical between turns and the model provider's cache keeps working. Edit the setting, restart, then test. The web UI tells you a restart is pending, but it is the kind of thing you skip once and then spend ten minutes confused about.

## The result

Here is the before and after on the demo, for an agent whose ceiling includes the deferred groups.

| | Tools in the prompt | Builtin schema cost |
|---|---|---|
| Everything `always` | 43 | the full ~10K tokens, every turn |
| Groups on `search` | 22 | core tools only; the rest load on demand |

The core tools a turn almost always needs stay in the prompt: read a file, run a command, search the web, send a message, and `tool_search` itself. The rest, the diagram tools, the server tools, cron, subagents, and anything else you rarely reach for in a given turn, wait until they are searched.

The cost you accept is real, so I will state it plainly. A turn that needed a hidden tool and did not search for it gets a worse answer than it would have. The pointer is what stops that from happening silently, and in practice the model searches when it needs to. You are trading a guaranteed cost on every turn for a small, visible risk on a few turns. For a chatty agent with a long tool list, that is a good trade.

The lesson underneath all of it is the one from the prompt panel: you cannot fix a bill you cannot see. The first thing that changed my mind was watching half of a "hello" turn out to be tools nobody asked for. Measure your prompt before you optimize your agent.

---

*AI was used for research and drafting assistance on this post. Written by a human.*
