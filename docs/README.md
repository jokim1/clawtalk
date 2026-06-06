# ClawTalk · Build Package

This `/docs` folder specifies **ClawTalk** — a multi-agent reasoning product where users invite different LLMs into a "Talk" (a context-bound room) and watch them debate, push back, and synthesize toward a recommendation.

You're reading this because you're an AI coding agent (or engineer) about to work on the product. The **design** is a clean greenfield rebuild (DECISIONS D0); the **infrastructure** is the existing Cloudflare Workers + Supabase Postgres stack. Read the orientation docs below first, then the spec docs in order.

---

## Start here — orientation

| Doc | Why |
|---|---|
| **[REFACTOR-OVERVIEW.md](./REFACTOR-OVERVIEW.md)** | **The single-page narrative for the greenfield rebuild.** Stable orientation: why the model changed, what stays, what changes, runtime architecture, doc navigation. Not a live tracker. |
| **[REFACTOR-AUDIT.md](./REFACTOR-AUDIT.md)** | **Current completion audit.** What is done, what remains, facade debt, Salon gap, missing surfaces, open decisions, and the recommended autonomous workstreams. Read this before starting new work. |
| **[roadmap.md](./roadmap.md)** | Live shipped/in-flight tracker for the refactor. Short operational status. |
| **[PHASE5-AUTONOMOUS-PLAN.md](./PHASE5-AUTONOMOUS-PLAN.md)** | Execution protocol and copy/paste phased prompts for parallel Codex + Claude/Opus `/goal` runs with minimal human checkpoints. |
| **[DECISIONS.md](./DECISIONS.md)** | Resolved cross-cutting decisions (stack, naming, Forge agents). **When a spec doc conflicts with a decision here, this wins.** |
| **[GLOSSARY.md](./GLOSSARY.md)** | Canonical terms + the shipped-DB-name ↔ spec-name mapping. Read it to avoid the vocabulary forks. |
| **[engineering-notes.md](./engineering-notes.md)** | Durable engineering knowledge (architectural commitments, latency hotspots, eval gate). |
| **[archive/](./archive/)** | Retired "ClawRocket"-era docs. **Not current** — do not implement from them. |

Historical audits, handoffs, runbooks, and tactical plans live under [archive/audits/](./archive/audits/), [archive/runbooks/](./archive/runbooks/), and [archive/plans/](./archive/plans/). Old top-level filenames are kept as pointer stubs only so older links resolve.

## Precedence — who wins on conflict

1. **Cross-cutting decisions** → [DECISIONS.md](./DECISIONS.md).
2. **Hierarchy / data model** → [08-information-architecture.md](./08-information-architecture.md).
3. **UI / interaction** → the prototype (`ClawTalk Salon.html` + `prototype/*.jsx`).
4. **Stack / runtime** → repo reality (Cloudflare Workers + Hono + Durable Objects + Hyperdrive + Queues) and [DECISIONS.md](./DECISIONS.md) D1.
5. **What currently exists** → [REFACTOR-AUDIT.md](./REFACTOR-AUDIT.md) + [roadmap.md](./roadmap.md). Use old archived implementation notes only as provenance.
6. **Product behavior** → `01-product-spec.md`. **Anything in [archive/](./archive/) is superseded.**

> ⚠️ **Greenfield build (DECISIONS D0).** The `01`/`08` model — **Workspace → Folder → Talk + Document**, multi-workspace, no Threads — is the design we're building, on the fresh baseline at `supabase/migrations/0001_clawtalk_greenfield.sql`. Backend/runtime cutover has landed; compatibility facades remain only to keep the current webapp alive while each frontend surface moves to native greenfield shapes.

---

## Read in this order

| # | Doc | What it gives you |
|---|---|---|
| 1 | **[01-product-spec.md](./01-product-spec.md)** | The product. Every concept, every screen, every flow. The most important doc. |
| 2 | **[02-visual-system.md](./02-visual-system.md)** | Design tokens — color, type, spacing, components. Use exactly these. |
| 3 | **[03-agents.md](./03-agents.md)** | The 5 default agents (Strategist · Critic · Researcher · Editor · Quant) with full system prompts and methodologies. Seed these into every new workspace. |
| 4 | **[06-agent-system-design.md](./06-agent-system-design.md)** | Production agent architecture: hidden runtime policy, role templates, editable fields, snapshots, prompt assembly, and evals. |
| 5 | **[07-homepage-system-design.md](./07-homepage-system-design.md)** | Home architecture: recommendations, News, Inbox items, ranking, feedback, and auto-optimization. |
| 6 | **[08-information-architecture.md](./08-information-architecture.md)** | Canonical workspace/folder/Talk/document hierarchy, primary document model, Context rules, and IA schema constraints. |
| ★ | **[11-data-model.md](./11-data-model.md)** | The **clean greenfield schema** — every table for the whole product, RLS model, and reuse-vs-rewrite calls. The concrete DB source of truth. |
| 7 | **[04-api-contracts.md](./04-api-contracts.md)** | Backend API endpoints, websocket protocol for streaming, LLM-provider abstraction, OAuth shapes. |
| 8 | **[05-build-plan.md](./05-build-plan.md)** | Recommended build sequence. Infrastructure first, polish last. |

---

## What also lives in this repo

| Path | What it is |
|---|---|
| `ClawTalk Salon.html` | The **working visual prototype** in React + Tailwind. Open it in a browser to see the entire product running with mocked state. This is the source of truth for visual + interaction design. Now includes the latest base-design updates: document tabs, the multi-workspace account switcher, and the resizable document pane. |
| `ClawTalk Forge.html` | The **Forge** clickable prototype — `ClawTalk Salon.html` with `window.CT_FORGE_ENABLED` set, wiring in the autonomous content-improvement flow. See **[10-forge-design-handoff.md](./10-forge-design-handoff.md)**. |
| `ClawTalk Forge - Exploration.html` | Forge design canvas — written rationale plus the entry-surface and gallery-layout options explored before settling on the shipped design. |
| `prototype/*.jsx` | The prototype's source. Component-by-component. Read these alongside the screens you're building. The `forge-*.jsx` modules hold the Forge surfaces; the Salon modules carry Forge integration gated behind `CT_FORGE_ENABLED`. |
| `design-canvas.jsx` | Source for the Forge exploration canvas (`ClawTalk Forge - Exploration.html`). |
| `shared/data.jsx` | Mock data, brand marks, icons, and the canonical agent / team / role definitions. **Seed your DB from this file.** |

---

## How to use this material

1. **Read the prototype first.** Open `ClawTalk Salon.html` in a browser. Click every icon in the left rail, send a message, open the doc pane, hit ⌘K, open the Tools popover, archive a Talk. Get a feel for the product before reading any docs.
2. **Read `01-product-spec.md`** end to end. It tells you *what to build*.
3. **Skim `02-visual-system.md`** — extract the tokens, then refer back as needed.
4. **Read `03-agents.md` carefully.** The 5 default agents and their methodologies are the heart of the product's value. Get them right.
5. **Read `06-agent-system-design.md`** before implementing agent storage, prompt assembly, or the Agents page.
6. **Read `07-homepage-system-design.md`** before implementing Home, Inbox, recommendations, or News.
7. **Read `08-information-architecture.md`** before implementing folders, Talks, Documents, Context, or archive behavior.
8. **Read `04-api-contracts.md`** when you start the backend.
9. **Use `REFACTOR-AUDIT.md` + `PHASE5-AUTONOMOUS-PLAN.md`** to sequence current implementation work. `05-build-plan.md` remains the canonical product build order, not the live status tracker.

When ambiguity arises, the **prototype** is the canonical reference for UI, the **docs** for behavior, and the **user** for product questions you can't answer from either.

---

## Feature PRDs

| # | Doc | What it gives you |
|---|---|---|
| 9 | **[09-autonomous-content-improvement-prd.md](./09-autonomous-content-improvement-prd.md)** | "Forge" — autonomously iterate a Document toward a scored quality bar, using the Synthetical/SSR platform as the scoring oracle. Population-based generate→score→improve loop over the greenfield Document model. The *what & why*. Post-MVP behind a feature flag. |
| 10 | **[10-forge-design-handoff.md](./10-forge-design-handoff.md)** | "Forge" design + interaction handoff — the *how it looks & behaves*. Maps the clickable prototype (`ClawTalk Forge.html`) and its surfaces back to the PRD, with a suggested build order. Front-end mock; all scoring data simulated. |
| 12 | **[12-jobs.md](./12-jobs.md)** | "Jobs" — scheduled single-agent prompts that fire a run on a Talk and land output as a message and/or a pending Document edit. The D6 redesign (no threads, workspace-scoped, short-backoff scheduler). |

---

## Tech stack — decided (see [DECISIONS.md](./DECISIONS.md) D1)

The prototype is React + Tailwind + Babel-in-the-browser. Production runs on the **existing** stack:

- **Runtime:** Cloudflare Workers + Hono + Durable Objects + Hyperdrive. Run queues are **Cloudflare Queues**; websocket pub/sub is the `UserEventHub` Durable Object. **No Redis, no BullMQ/Sidekiq.**
- **Database:** Supabase Postgres (postgres.js + RLS via `withUserContext`).
- **Frontend:** Vite + React under `webapp/`. The production app currently uses hand-written CSS; Salon adoption should happen through the current visual-system decision in [REFACTOR-AUDIT.md](./REFACTOR-AUDIT.md) and [PHASE5-AUTONOMOUS-PLAN.md](./PHASE5-AUTONOMOUS-PLAN.md).
- **LLM providers:** Anthropic Claude, OpenAI GPT, Google Gemini — via the provider abstraction in `04` §14. Model catalog single source of truth: `§11` `llm_models` is a view over `llm_provider_models` (cross-ref `§11` §4).
- **Real-time:** WebSocket only.
- **Auth:** Google OAuth + device-code auth; email magic-link is planned. HttpOnly cookies + double-submit CSRF. Workspace selection is carried per request by `x-workspace-id`, not by minting a new access token on every workspace switch.

> Earlier drafts (and the archived rebuild plan) recommended Next.js + Node + Redis. That was **rejected** — see DECISIONS D1.
