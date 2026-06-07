# Prompt: build ClawTalk

Copy the text below into your AI coding agent (Claude Code, Cursor, etc.) after you've made the project files available to it.

---

```
You are building ClawTalk — a multi-agent reasoning product where users invite a team of LLM personas (Strategist, Critic, Researcher, Editor, Quant) into a "Talk" and watch them debate a question.

This is a greenfield build. The complete specification, design system, agent definitions, API contracts, and build plan live in /docs. A working visual prototype lives at docs/prototypes/ClawTalk Salon.html (with sources in /docs/prototypes/prototype and /docs/prototypes/shared).

Before writing any code:

1. Read /docs/README.md to understand the package.
2. Open docs/prototypes/ClawTalk Salon.html in a browser. Click every icon in the left rail. Send a message in the Pricing v2 Talk. Open the Tools / Context / Connectors popovers. Hit ⌘K. Archive a Talk. Get the feel of the product.
3. Read /docs/01-product-spec.md end to end. This is the canonical spec.
4. Skim /docs/02-visual-system.md and extract design tokens into your stack.
5. Read /docs/03-agents.md carefully — the 5 default agents are the heart of the product.
6. Read /docs/04-api-contracts.md before starting the backend.
7. Use /docs/05-build-plan.md to sequence the work.

Tech stack (recommended, swap with justification):
- Frontend: Next.js (App Router) + React + Tailwind
- Backend: Node + TypeScript + Postgres + Redis
- Streaming: WebSocket for agent token streams
- LLM providers: Anthropic Claude, OpenAI GPT, Google Gemini

Rules of engagement:

- The prototype is the canonical UI reference. When ambiguity arises, match what the prototype does.
- The docs are the canonical behavior reference. If a doc says X and the prototype shows Y, ask me.
- Agent system prompts and methodologies in /docs/03-agents.md are load-bearing. Port them verbatim into your seed function. Do not paraphrase them.
- The 5 default agents and 3 default team compositions are seeded into every new workspace on creation. Use the canonical definitions from /docs/prototypes/shared/data.jsx.
- The chosen visual direction is "Salon" (warm editorial, cream paper, terracotta accent, Newsreader serif). Other variations in /docs/prototypes are reference only.
- Strip the Tweaks panel from production. It's a development affordance.
- Do not invent new tokens, colors, or fonts. Use what's in /docs/02-visual-system.md.
- Do not implement Threads, multi-folder Talks, nested folders, multi-doc-per-Talk, async jobs, community marketplace, or real-time co-editing. All explicitly out of scope for v1 (see spec §8).

Start with Phase 0 of /docs/05-build-plan.md. After each phase, summarize what you built and what's left, then proceed.

When you hit a product question you can't answer from the docs or prototype, stop and ask me. Don't guess.

Begin.
```

---

## Notes for the human handing this off

- This prompt is paired with the `/docs` folder + `/docs/prototypes/prototype` source + `docs/prototypes/ClawTalk Salon.html` prototype. The agent needs all three.
- The agent will produce a lot of code. Review milestones — at end of Phase 1 (data model), Phase 4 (Talks core), Phase 7 (Agents), and Phase 10 (Home). Don't review every commit.
- Expect the LLM provider integration in Phase 4 to consume disproportionate time. It's the highest technical risk in the build.
- The Curator on Home (Phase 10) is behind a feature flag — you can launch v1 without it if quality isn't there yet.

Good luck.
