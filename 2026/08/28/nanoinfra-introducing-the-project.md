# nanoinfra: an AI Agent That Lives on My Own Boxes

**Published on:** 2026/08/28

**Tags:** ai, agents, nanoinfra, python, react, self-hosted, llm, security, mcp

---

I run my own servers. I wanted an AI agent that runs there too, not in someone else's cloud, and not glued to one chat app or one model vendor. Nothing I tried fit, so I built one. It is called nanoinfra, it is open source, and this post explains what it is and why it is shaped the way it is.

The short version: nanoinfra is a small agent that reads messages from a chat channel, calls a language model, runs tools, and remembers the conversation. Everything past that sentence is detail. But the detail is the point, because the detail is what decides whether you can trust the thing on a real box.

## The one loop everything hangs off

At the center is a small loop. A channel receives a message and puts it on a bus. The loop reads the message, builds the context, and calls the model. The model asks for a tool. The loop runs the tool, gives the result back, and calls the model again. When the model is done, the loop sends the answer back to the channel it came from.

<div class="cde-window">
<div class="cde-window-title"><div class="cde-window-btns"><div class="cde-window-btn">&#9866;</div></div><span>A message from a chat app to an answer, and back</span><div class="cde-window-btns"><div class="cde-window-btn">&#9634;</div><div class="cde-window-btn">&#10005;</div></div></div>
<div class="cde-window-body">
<div class="mermaid">
flowchart LR
    chans[Chat channels<br/>Telegram, Discord, Slack,<br/>Matrix, Signal, email, WebUI]
    bus[(MessageBus<br/>async queue)]
    loop[AgentLoop<br/>session keys, context,<br/>hooks]
    runner[AgentRunner<br/>calls the model,<br/>runs tools, loops]
    tools[Tools<br/>files, shell, web,<br/>MCP, cron, subagents]
    prov[LLM provider]
    chans -->|InboundMessage| bus --> loop --> runner
    runner <--> prov
    runner <--> tools
    runner -->|OutboundMessage| bus --> chans
    style loop fill:#1e3a2f,color:#fff
    style runner fill:#1e3a2f,color:#fff
    style tools fill:#2f2f3a,color:#fff
    style prov fill:#3a1e1e,color:#fff
</div>
</div>
</div>

The bus in the middle is not decoration. It keeps the chat apps and the agent apart. A channel does not know how the agent works, and the agent does not know which app the message came from. Adding a new chat app means writing one channel. It does not mean touching the loop.

## Any chat app, any model

nanoinfra talks to Telegram, Discord, Slack, Matrix, WhatsApp, Signal, email, Microsoft Teams, Mattermost, and its own web UI over a WebSocket. Each one is a self-contained package. The framework finds them by scanning, so a new channel is a drop-in, not a patch to the core.

Models are the same story. It speaks to Anthropic, to anything OpenAI-compatible, to the OpenAI Responses API, to Azure, to Bedrock, to GitHub Copilot, and more. It can also drive a coding-agent CLI as the "model", so you can point it at Claude Code, Codex, or a similar tool and let that do the thinking. One agent, many front doors, many back ends.

## Tools, and the fear that comes with them

A model that can only talk is a chatbot. A model that can act is an agent, and it is also a liability. nanoinfra gives the model real tools: read and write files, run shell commands, search and fetch the web, call MCP servers, schedule cron jobs, spawn subagents, generate images, and run long tasks that outlive a single turn. It can even edit its own configuration.

That list should make you nervous, because it made me nervous. I wrote a whole separate post about putting a public agent on this very blog and closing the doors one by one. nanoinfra is where the general version of that work lives.

## The parts that exist because I did not trust the agent

This is the half of the project I care about most, so it gets its own section.

**Capability gates.** Every tool declares a class: read, local write, inventory write, remote change, or credential access. Policy keys on the class, never on the tool name. A new tool inherits a decision instead of an exemption, and a tool that declares nothing gets the most restrictive class. So an action that changes a remote box, or reads a secret, has to pass a gate. When a person is present, the gate asks. When no person is present, it needs a standing grant that was written down on purpose.

**A privilege split.** In the container image the agent and the thing that runs shell commands are two different users. The agent holds the API key and can reach the model. The executor can run commands but holds no key and has no network. They talk over a Unix socket, which never touches the network stack. A prompt injection that reaches the executor still cannot phone home.

**A real sandbox for shell.** Shell runs under bubblewrap or Landlock, not on the bare host. The filesystem the tools can see is the workspace, and you can lock the agent to it.

**Pairing and channels.** A direct message from a stranger is not trusted by default. Senders pair with a code, per channel, and the store is persistent.

None of this is bolted on at the end. It is the reason the tool list above is safe to offer at all.

## Two ways an unattended turn starts

An agent is more useful when it can act without a human poking it. nanoinfra has two ways to start a turn with nobody watching.

**Cron** schedules by the clock. **Triggers** are a durable file-drop queue that fires when an external system calls a small endpoint with that trigger's own key. Both retry with backoff, both write a run record, and both show up on one screen in the web UI.

There is a step in front of both called commissioning. When you create an automation, nanoinfra runs it once in a preview mode. Every gated tool answers "what would you do", nothing acts, and the result is a verdict. An automation that would have been refused is saved switched off, with the reason attached. You find out before it runs at 3am, not after.

## Named agents, and asking a peer

A recent release added named agents. The deployment has a default agent, and you can define others. Each names its own model, its own prompt, its own skills, and its own ceiling: the tool groups, MCP servers, and connectors it may reach at all. The ceiling narrows and never widens. An agent set to reach one database and nothing else reaches one database and nothing else, whatever the turn asks for.

Agents can also delegate. A coordinator can hand a reading-heavy sub-task to a cheaper agent and keep its own context small. One level deep, checked locally, so a delegation cannot spiral.

## The web UI

There is a React web UI that talks to the gateway over a WebSocket. It is where you read conversations, manage automations, and edit settings without hand-writing JSON. It has a file manager over the active workspace, a prompt panel that shows what each part of the prompt costs in tokens, and a skills marketplace you can install from.

That prompt panel turned out to matter more than I expected. Once you can see that your tool schemas are half the prompt on every turn, you start doing something about it. That "something" is a whole post of its own, and it is the next one.

## Who this is for

nanoinfra is for people who want an AI agent they can run and reason about on their own hardware. You keep the keys. You choose the model. You decide what it can touch, and the framework is built so that decision is real rather than decorative.

The code is at [github.com/nanoinfraorg/nanoinfra](https://github.com/nanoinfraorg/nanoinfra). There is a Discord if you want to talk about it. And there is a live demo you can poke, which is the same code this post describes, running under the same gates.

Next up: why the biggest line on that token bill is usually tools the agent never uses, and what I did about it.

---

*AI was used for research and drafting assistance on this post. Written by a human.*
