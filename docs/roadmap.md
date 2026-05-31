> **Status:** live implementation tracker · **Last updated:** 2026-05-30
> Orientation: [REFACTOR-OVERVIEW.md](./REFACTOR-OVERVIEW.md) · readiness: [IMPLEMENTATION-READINESS.md](./IMPLEMENTATION-READINESS.md)

# ClawTalk Roadmap

This file tracks shipped state vs. the greenfield refactor. It is not the product spec; use it to orient what exists today and what to implement next.

## Shipped / Current

| Area | State |
|---|---|
| Runtime | Cloudflare Workers + Hono + Durable Objects + Hyperdrive + Queues + R2 + Supabase Postgres. Keep. |
| Auth | Google OAuth/device-code/cookie + CSRF stack exists. Rework for workspace bootstrap, keep the security shape. |
| LLM providers | Provider/model discovery, provider secrets, runtime model guard, and model lifecycle logic exist. Keep and adapt to `llm_models` view over `llm_provider_models`. |
| Event streaming | `event_outbox` + `UserEventHub` DO exists. Keep and adapt event payloads to the greenfield API. |
| Schema baseline | Active cutover branch has replaced the legacy migration stream with `supabase/migrations/0001_clawtalk_greenfield.sql`; legacy migrations are archived under `docs/archive/legacy-supabase-migrations/`. |
| Talk execution | Working legacy flow over `talk_threads`, `talk_messages`, `talk_runs`, `registered_agents`. Rewrite against `messages`, `runs`, `agents`, `talk_agent_snapshots`. |
| Content/Documents | Legacy `contents` + `content_edits` flow exists, plus recent PDF page rasterization work. Rewrite as `documents` + `doc_tabs` + `doc_blocks` + `document_edits`; preserve rasterization capability in `context_source_pages`. |
| Jobs | Legacy `talk_jobs` scheduler exists. Rewrite per `12-jobs.md`: jobs fire normal runs, with slot identity and output through `document_edits`. |
| Frontend | Vite/React app works but is centered around legacy Talk/content/thread surfaces. Rewrite large surfaces into greenfield modules. |

## Recent Mainline State

- PR #506 has landed: PDF rasterization Lane C T10 render-pages affordance + capability surfacing.
- PR #507 has landed: greenfield schema SQL is parked as `docs/canonical-greenfield-migration.sql`; PR #502 was closed because landing the executable schema alone breaks the legacy source/tests.
- Cutover branch `codex/clawtalk-greenfield-cutover` now has the active fresh baseline at `supabase/migrations/0001_clawtalk_greenfield.sql`, role-template seeds, first-signin workspace bootstrap, and focused §11 invariant tests. We are not layering a `0040+` migration over disposable data.

## Refactor Roadmap

| Step | Work | Gate |
|---|---|---|
| 1 | Cutover foundation: fresh Supabase baseline, role-template seed, first-signin workspace bootstrap, §11 verification tests. | ✅ Applies on empty/reset DB; workspace + default agents seed; first invariant tests pass. |
| 2 | Greenfield accessors + API shell: workspaces, folders, talks, messages, runs, agents. | `/me`, workspace switch, sidebar, Talk CRUD, and basic snapshot work without legacy tables. |
| 3 | Talk execution vertical slice. | User sends a message, runs are queued/claimed, one agent streams, messages/runs/snapshots/outbox persist. |
| 4 | Frontend shell + Talk rewrite. | New shell and Talk page use greenfield APIs; `TalkDetailPage.tsx` legacy surface is retired. |
| 5 | Documents. | Primary document, tabs/blocks, pending edit accept/reject, PDF/page context path work against new schema. |
| 6 | Agents, tools, connectors, context. | Agent editing, prompt snapshots, tool gating, connector binding, and context sources are greenfield. |
| 7 | Jobs. | Scheduler/run-now/queue/output/inbox behavior passes `12-jobs.md` verification. |
| 8 | Home, Settings, polish, eval gate. | Home inbox/recommendations/news are deterministic first; agent eval gate passes before broader launch. |
| 9 | Forge. | Post-MVP feature flag: SSR connection, audiences, improvement runs, gallery, promote to `document_edits`. |

## Active Decision

Proceed with the **big-bang cutover branch** from [IMPLEMENTATION-READINESS.md](./IMPLEMENTATION-READINESS.md). A dual-path feature flag is not recommended unless Joseph explicitly needs the legacy dogfood app to remain usable throughout the rewrite.
