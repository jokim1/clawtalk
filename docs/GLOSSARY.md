# ClawTalk — Glossary & Canonical Terms

> **Status:** canonical · **Last updated:** 2026-06-06
> One place to resolve vocabulary forks across docs and code. Naming direction is set by [DECISIONS.md](./DECISIONS.md) D2: canonical product terms are Workspace, Folder, Talk, Document, Agent, Job, Home, and Forge.

## Core Concepts

| Term | Means | Current implementation note |
|---|---|---|
| Workspace | Top-level tenant; permissions, billing, provider keys, members, and private data root. | Live greenfield table: `workspaces`; request scoping uses `x-workspace-id`. |
| Folder | Optional flat grouping of Talks. | Live greenfield table: `folders`. Archived docs may say `talk_folders`. |
| Talk | A context-bound multi-agent conversation. | Live table: `talks`. A Talk has no Threads in the target model. |
| Round | One turn of the multi-agent loop. | `messages.round` and `runs.round`. |
| Run | One agent response in a round, or a scheduled/manual Job firing. | Live table: `runs`; freezes `talk_agent_snapshots` and `run_prompt_snapshots`. |
| Agent | A workspace-scoped LLM role/persona. | Live table: `agents`; snapshots live in `talk_agent_snapshots`. Archived docs may say `registered_agents`. |
| Document | Editable long-form artifact attached to a Talk or browsed independently. | Canonical tables: `documents`, `doc_tabs`, `doc_blocks`, `document_edits`. Frontend still has a flat content compatibility facade in places. |
| Document tab | Ordered section inside a Document. | `doc_tabs`; one or more per document. |
| Pending edit | Proposed document mutation awaiting accept/reject. | `document_edits`, with `source` of `agent`, `job`, or `forge`. |
| Tool | What agents can do, such as web search or Drive read. | Per-Talk toggles in `talk_tools`; runtime also applies user/tool permission and connector authorization. |
| Connector | Workspace-level external-service authorization. | `connectors` plus `connector_secrets`; Talk-specific targets use `connector_bindings`. |
| Context | Sources a Talk can read from: primary document projection, supporting docs, files, URLs, rules, past Talks, news. | `context_sources` and `context_source_pages`; primary Document is projected, not stored as a context row. |
| Unfiled | Virtual view of Talks with `folder_id is null`. | Not Home Inbox. |
| Inbox | Home queue of arrivals, blockers, and waiting items. | `home_inbox_items`; writes exist for `job_blocked`, but Home read surface is not built yet. |
| Home | Curator/dashboard surface for Inbox, recommendations, news, and next actions. | Schema exists; production surface is pending. |
| Forge | Autonomous document improvement loop using SSR/Synthetical scoring. | Schema/docs exist; post-MVP runtime/UI. |

## Easy-to-confuse Pairs

- **Thread vs Talk.** Threads are removed. Any `threadId` in current code is a compatibility projection.
- **Connector vs binding.** Connector is the workspace authorization; binding attaches an authorized service target to a Talk.
- **Primary Document vs supporting document.** The primary Document is the editable artifact for a Talk. Supporting documents are read-only context.
- **Document vs old content.** Canonical term is Document. `contents`/`content_edits` are archived-era names or compatibility shapes.
- **Forge content improvement vs prompt improvement.** Forge improves document content. The agent prompt-improvement loop improves role prompts.
- **Unfiled vs Inbox.** Unfiled is organization. Inbox is action queue.

## Retired Terms

The following belong to archived docs or compatibility bridges: ClawRocket, NanoClaw, registered agents, talk threads, contents, content proposals, talk routes, container executor, SQLite, SSE, systemd/Ubuntu deployment.
