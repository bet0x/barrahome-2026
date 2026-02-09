# AI Tutor Feature Concept for barrahome.org

## 1. Vision
Build an **AI Tutor** that turns each blog article into a guided learning session.
The tutor should adapt explanations to the reader's level (`Beginner`, `Intermediate`, `Advanced`) and walk them step by step through concepts, examples, and checks for understanding.

## 2. Problem Statement
Current posts are useful but static. Readers with different experience levels may struggle because:
- beginners need simpler explanations and context,
- intermediate users need practical implementation guidance,
- advanced users want deeper tradeoffs and optimization details.

## 3. Product Idea
Add a client-side JavaScript library that connects to a remote LLM service and provides:
- article-aware tutoring,
- level-based explanations,
- progressive lesson flow,
- short quizzes and recap checkpoints,
- optional "next step" actions (commands, experiments, follow-up posts).

## 4. Core User Experience
For each article page:
1. Reader selects level: `Beginner`, `Intermediate`, or `Advanced`.
2. Reader clicks `Start Tutor`.
3. Tutor presents a sequence:
   - context and learning goals,
   - section-by-section explanation,
   - comprehension checks,
   - final summary and practice tasks.
4. Reader can switch level at any time.
5. Tutor persists progress locally (per article).

## 5. System Architecture (High Level)
- Frontend (`barrahome-tutor.js`):
  - extracts article metadata (title, tags, URL, headings),
  - builds a tutoring request,
  - renders tutor UI (chat panel or inline blocks),
  - stores progress in `localStorage`.
- Tutor API (remote backend):
  - receives article context + user level + interaction state,
  - calls LLM with a strict tutor prompt/template,
  - returns structured JSON response.
- LLM Provider:
  - hosted model endpoint (OpenAI-compatible or custom),
  - tunable temperature and token limits per level.

## 6. Suggested API Contract
`POST /api/tutor/session`

Request:
```json
{
  "article": {
    "url": "https://barrahome.org/2026/02/09/vllm-kv-offloading-connector.md",
    "title": "vLLM KV Offloading: CPU Cache for High-Throughput Inference",
    "tags": ["ai", "llm", "vllm", "performance"],
    "content": "...optional sanitized markdown/plain text..."
  },
  "user": {
    "level": "beginner",
    "language": "en"
  },
  "state": {
    "step": 1,
    "history": []
  }
}
```

Response:
```json
{
  "session_id": "sess_abc123",
  "step": 1,
  "title": "Why KV Offloading Matters",
  "explanation": "...",
  "checks": [
    {
      "type": "mcq",
      "question": "What is the main bottleneck discussed?",
      "choices": ["CPU", "Memory", "Disk", "Network"],
      "answer": "Memory"
    }
  ],
  "next_actions": [
    "Run the benchmark command with batch size 64",
    "Compare latency with and without offloading"
  ]
}
```

## 7. Level Design
- Beginner:
  - plain language,
  - define terms before using them,
  - short examples and analogies.
- Intermediate:
  - practical focus,
  - architecture explanations,
  - config and debugging guidance.
- Advanced:
  - performance tradeoffs,
  - low-level reasoning,
  - benchmarking and failure modes.

## 8. Prompting Strategy
Use a structured system prompt with hard constraints:
- never invent details not present in article context,
- mention assumptions explicitly,
- keep answer length bounded,
- always include one comprehension check,
- adapt tone and depth strictly to selected level.

## 9. Safety and Quality Controls
- Content grounding:
  - pass article excerpts/headings as source context,
  - require citations to section titles when possible.
- Hallucination reduction:
  - reject unsupported claims,
  - return "I don't know" when context is missing.
- Rate limits and abuse controls:
  - API key isolation,
  - per-IP request caps.

## 10. Implementation Roadmap
Phase 1 (MVP):
- tutor panel UI,
- level selector,
- single-step explanation + one quiz,
- basic remote API integration.

Phase 2:
- multi-step session state,
- progress persistence,
- section-by-section mode.

Phase 3:
- personalized learning paths across posts,
- "recommended next article" engine,
- analytics dashboard (completion, drop-off, quiz score).

## 11. Technical Decisions to Confirm
1. Should article content be sent fully to the API, or indexed and retrieved server-side?
2. Should the tutor run only in English first, or support Spanish from day one?
3. Do you want a floating chat UI or inline "Tutor Blocks" between sections?
4. Will the API be self-hosted or use a managed LLM gateway?
5. What is the target monthly budget and max cost per tutoring session?

## 12. Success Metrics
- Tutor start rate per article.
- Session completion rate.
- Average steps completed.
- Quiz correctness rate.
- Return visits after tutor interaction.

## 13. Next Deliverable
Create:
- `js/barrahome-tutor.js` (client SDK + UI integration),
- `templates/tutor_panel.html` (UI container),
- backend `/api/tutor/session` endpoint spec and reference implementation.
