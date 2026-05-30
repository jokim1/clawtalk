# ClawTalk — Glossary & Canonical Terms

> **Status:** canonical · **Last updated:** 2026-05-28
> One place to resolve the vocabulary forks across docs and code. If two docs use different words for the same thing, this file says which is canonical. Naming direction is set in [DECISIONS.md](./DECISIONS.md) D2 (provisional: orient to shipped DB names).

## Core concepts

| Term | Means | Notes |
|---|---|---|
| **Workspace** | Top-level tenant; permissions/billing/data root. | |
| **Folder** | Optional flat grouping of Talks. | Live: `talk_folders` (pre-migration) → `folders` (post-§11). |
| **Talk** | A context-bound multi-agent conversation. | |
| **Round** | One turn of debate; Editor closes with synthesis. | |
| **Agent** | A fixed-role LLM reasoning role. | Live: `registered_agents` (pre-migration) → `agents` + `talk_agent_snapshots` (post-§11). |
| **Content / Document** | The editable long-form artifact attached to a Talk. | Pre-migration: `contents` (PR #423 hybrid MD+HTML). Post-§11: `documents` + `doc_tabs` + `doc_blocks` + `document_edits`. Canonical name (post-migration): **Document**. |
| **Document tab** | A Google-Docs-style section inside one Content/Document. | Live table: `doc_tabs` (§11 §5). |
| **Pending edit** | An agent-proposed change awaiting accept/reject. | Pre-migration: `content_edits` (PR #423). Post-§11: `document_edits` (with `source ∈ ('agent','forge','job')`). |
| **Tools** | What agents can *do* (web search, Drive read, …). Per-Talk + workspace catalog. | |
| **Connectors** | External service bindings (Slack, Drive, Linear, …). Workspace-global. | |
| **Context** | What the room *knows from* (primary doc, supporting docs, URLs, files, past Talks, rules, news). | |
| **Unfiled** | Virtual view: Talks with `folder_id is null`. **Not** Inbox. | |
| **Inbox** | Home queue of arrivals/blockers/waits. A Talk can be an Inbox item's *target*, never an item itself. | |
| **Curator** | Home copy/summary layer over deterministic state. Not the ranking source of truth. | |
| **Forge** | Autonomous content-improvement loop (generate→score→improve) over Content, using SSR as the scoring oracle. | PRD `09`, design `10`. |

## Easy-to-confuse pairs

- **Parallel mode ≠ "Panel" mode.** Canonical modes are **Ordered / Parallel** (`01`). "Panel" appears only in the archived ClawRocket review — ignore it.
- **Forge content-improvement ≠ agent prompt-improvement.** `06` §14's "Prompt Improvement Loop" improves *agent system prompts*; **Forge** (`09`/`10`) improves *document content*. Both share an "audit → propose → admin-accept → versioned rollout" shape but are different systems.
- **Primary document ≠ supporting document.** A Talk has 0–1 *primary* (editable) Content; many *supporting* documents are read-only via Context.
- **Unfiled ≠ Inbox.** Unfiled = no folder. Inbox = Home arrivals/blockers/waits.
- **Threads = removed.** `01` §1.4 removes Threads (Rounds replace them). The live `talk_threads`/`main_threads` tables are legacy drift — see D2.

## Retired terms (archived docs only)

**ClawRocket**, **Nanoclaw / Main (Nanoclaw)**, **registered route / `talk_routes`**, **container core executor**, **direct-HTTP vs containerized execution domains**, **SQLite**, **SSE event delivery**, **systemd / Ubuntu deployment**. All belong to the retired architecture in [`archive/`](./archive/). The product is **ClawTalk** on **Cloudflare Workers + Supabase Postgres**.
