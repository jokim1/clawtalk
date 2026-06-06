# ClawTalk Refactor — Overview

> **Status:** orientation for new readers · **Last updated:** 2026-06-06
> This is the stable narrative. For live state, read [REFACTOR-AUDIT.md](./REFACTOR-AUDIT.md), [roadmap.md](./roadmap.md), and [PHASE5-AUTONOMOUS-PLAN.md](./PHASE5-AUTONOMOUS-PLAN.md).

---

## 1. What This Refactor Is

ClawTalk is a greenfield rebuild on the existing production platform.

The product model changed: Workspace → Folder → Talk + Document, multi-workspace, no Threads, scheduled Jobs as first-class runs, Home as the main work queue, and Forge as post-MVP autonomous document improvement.

The infrastructure stayed: Cloudflare Workers, Hono, Durable Objects, Hyperdrive, Cloudflare Queues, Supabase Postgres, WebSocket streaming, cookie auth, CSRF, and the existing LLM provider abstraction.

The cutover is no longer theoretical. The fresh baseline is active at `supabase/migrations/0001_clawtalk_greenfield.sql`, the legacy runtime has been retired, and the remaining work is mostly frontend/product completion plus compatibility-facade deletion.

---

## 2. Current State

| Area | State |
|---|---|
| Backend/data cutover | Done enough to build on. Greenfield runtime is live; legacy execution fails closed. |
| Frontend structure | Mid-flight. `TalkDetailPage.tsx` and `SettingsPage.tsx` are smaller but still too large. |
| De-facade | Not started in earnest. The webapp still consumes old-shaped DTOs. |
| Salon visual system | Not implemented in production. |
| Product surfaces | Home, native Documents, standalone Agents, Archive, command palette, and New Talk sheet remain. |
| Eval gate | Spec only. No runnable harness yet. |
| Forge | Post-MVP schema/docs only. |

The authoritative completion audit is [REFACTOR-AUDIT.md](./REFACTOR-AUDIT.md).

---

## 3. Why the Schema Was Rebuilt

The old schema proved the multi-agent room idea, but it could not support the product cleanly:

- It was user-owned, not workspace-owned.
- Threads were baked into every Talk workflow, while the target model has no Threads.
- Content/Document vocabulary was split across old `contents` tables and new product docs.
- Jobs were retrofitted as messages in dedicated threads instead of scheduled runs.
- Forge and Home did not fit the old model.
- RLS was ownership-based instead of workspace-membership-based.

D0 in [DECISIONS.md](./DECISIONS.md) locked the answer: rebuild the schema once from a fresh baseline because Joseph is the only user and dogfood data is disposable.

---

## 4. The Model

```text
Workspace
  workspace_members
  folders
    talks
  talks
    talk_agents
    messages
    runs
    context_sources
    jobs
    primary Document?      via documents.primary_talk_id
  documents
    doc_tabs
      doc_blocks
    document_edits
  agents
    agent_role_templates
    talk_agent_snapshots
    run_prompt_snapshots
  connectors
    connector_secrets
    connector_bindings
  home_inbox_items
  home_recommendations
  home_news_*
  forge_*
  audit_events
```

Key rules:

- Workspace is the tenant root.
- Folders are flat and optional.
- A Talk has no Threads.
- A Talk has zero or one primary editable Document.
- A Talk can read many supporting documents through Context.
- Runs freeze agent snapshots so future edits do not rewrite history.
- Jobs fire normal runs and may emit a Talk message and/or pending Document edit.

Details live in [08-information-architecture.md](./08-information-architecture.md), [11-data-model.md](./11-data-model.md), and [12-jobs.md](./12-jobs.md).

---

## 5. Runtime Shape

```text
Browser
  | REST + WebSocket
  v
Cloudflare Worker (Hono)
  | withUserContext(auth uid) for user paths
  v
Supabase Postgres with RLS
  ^
  | event_outbox
UserEventHub Durable Object

TALK_RUN_QUEUE
  -> queue consumer
  -> GreenfieldTalkExecutor
  -> LLM providers
  -> messages / runs / outbox

Cron scheduler
  -> due jobs
  -> run_prompt_snapshots
  -> TALK_RUN_QUEUE
```

Service-role internal paths, such as scheduler, queue consumer, outbox writer, news ingest, and future Forge execution, bypass RLS intentionally. User-input paths must call `withUserContext`.

---

## 6. Locked Decisions

| ID | Decision |
|---|---|
| D0 | Greenfield rebuild, not migration. |
| D1 | Cloudflare Workers + Hono + Durable Objects + Hyperdrive + Queues + Supabase Postgres. |
| D2 | Workspace → Folder → Talk + Document. No Threads. |
| D3 | Forge rewriter/critic are hidden system agents. |
| D4 | No Threads in the new model. |
| D5 | Multi-workspace is foundational. |
| D6 | Jobs are scheduled runs with slot identity and archive semantics. |
| D7 | Schema pressure-test resolutions: composite FKs, auth.uid RLS, DB role templates, final model catalog. |
| D8 | Autonomous implementation runs are scoped with `/goal` packets and cross-review. |

Full text: [DECISIONS.md](./DECISIONS.md).

---

## 7. Current Build Sequence

The active sequence is tracked in [roadmap.md](./roadmap.md). Short version:

1. Keep docs current and archive historical handoffs.
2. Build Salon foundation.
3. Continue Talk/Settings structural cleanup.
4. Build native Documents and retire the content facade.
5. Build Home.
6. Finish de-facade and delete compatibility routes.
7. Finish Agents/Archive/New Talk/command palette/settings gaps.
8. Implement the eval gate.
9. Build Forge after MVP.

Run this through the `/goal` protocol in [PHASE5-AUTONOMOUS-PLAN.md](./PHASE5-AUTONOMOUS-PLAN.md).

---

## 8. Doc Map

| Concern | Start here |
|---|---|
| Current state | [REFACTOR-AUDIT.md](./REFACTOR-AUDIT.md) |
| Current execution order | [roadmap.md](./roadmap.md) |
| Autonomous execution protocol | [PHASE5-AUTONOMOUS-PLAN.md](./PHASE5-AUTONOMOUS-PLAN.md) |
| Product behavior | [01-product-spec.md](./01-product-spec.md) |
| Visual system | [02-visual-system.md](./02-visual-system.md) |
| Agents | [03-agents.md](./03-agents.md), [06-agent-system-design.md](./06-agent-system-design.md) |
| API | [04-api-contracts.md](./04-api-contracts.md) |
| Build sequence | [05-build-plan.md](./05-build-plan.md) |
| Home | [07-homepage-system-design.md](./07-homepage-system-design.md) |
| IA | [08-information-architecture.md](./08-information-architecture.md) |
| Forge | [09-autonomous-content-improvement-prd.md](./09-autonomous-content-improvement-prd.md), [10-forge-design-handoff.md](./10-forge-design-handoff.md) |
| Schema | [11-data-model.md](./11-data-model.md) |
| Jobs | [12-jobs.md](./12-jobs.md) |
| Security | [SECURITY.md](./SECURITY.md) |
| Eval | [eval-suite.md](./eval-suite.md) |
| Terms | [GLOSSARY.md](./GLOSSARY.md) |

Archived audits/runbooks/plans are under [archive/](./archive/). They are provenance, not current implementation guidance.
