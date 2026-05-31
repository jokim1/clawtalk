> **Status:** live implementation tracker · **Last updated:** 2026-05-31
> Orientation: [REFACTOR-OVERVIEW.md](./REFACTOR-OVERVIEW.md) · readiness: [IMPLEMENTATION-READINESS.md](./IMPLEMENTATION-READINESS.md)

# ClawTalk Roadmap

This file tracks shipped state vs. the greenfield refactor. It is not the product spec; use it to orient what exists today and what to implement next.

## Shipped / Current

| Area              | State                                                                                                                                                                                                                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime           | Cloudflare Workers + Hono + Durable Objects + Hyperdrive + Queues + R2 + Supabase Postgres. Keep.                                                                                                                                                                                                                    |
| Auth              | Google OAuth/device-code/cookie + CSRF stack exists. Rework for workspace bootstrap, keep the security shape.                                                                                                                                                                                                        |
| LLM providers     | Provider/model discovery, provider secrets, runtime model guard, and model lifecycle logic exist. Keep and adapt to `llm_models` view over `llm_provider_models`.                                                                                                                                                    |
| Event streaming   | `event_outbox` + `UserEventHub` DO exists. Keep and adapt event payloads to the greenfield API.                                                                                                                                                                                                                      |
| Schema baseline   | Active cutover branch has replaced the legacy migration stream with `supabase/migrations/0001_clawtalk_greenfield.sql`; legacy migrations are archived under `docs/archive/legacy-supabase-migrations/`.                                                                                                             |
| Talk execution    | Greenfield core/detail/chat routes, roster read/write, their Hono mount layer, chat enqueue, queue consumer, executor, scheduler sweeps, and run-state hardening are committed against `messages`, `runs`, `agents`, and `talk_agent_snapshots`. Retire remaining legacy API collisions before frontend replacement. |
| Content/Documents | Legacy `contents` + `content_edits` flow exists, plus recent PDF page rasterization work. Rewrite as `documents` + `doc_tabs` + `doc_blocks` + `document_edits`; preserve rasterization capability in `context_source_pages`.                                                                                        |
| Jobs              | Greenfield scheduler safety sweeps exist; job firing still needs the `12-jobs.md` rewrite so jobs fire normal runs, with slot identity and output through `document_edits`.                                                                                                                                          |
| Frontend          | Vite/React app works but is centered around legacy Talk/content/thread surfaces. Rewrite large surfaces into greenfield modules.                                                                                                                                                                                     |

## Recent Mainline State

- PR #506 has landed: PDF rasterization Lane C T10 render-pages affordance + capability surfacing.
- PR #507 has landed: greenfield schema SQL is parked as `docs/canonical-greenfield-migration.sql`; PR #502 was closed because landing the executable schema alone breaks the legacy source/tests.
- Cutover branch `codex/clawtalk-greenfield-cutover` now has the active fresh baseline at `supabase/migrations/0001_clawtalk_greenfield.sql`, role-template seeds, first-signin workspace bootstrap, and focused §11 invariant tests. We are not layering a `0040+` migration over disposable data.
- Commits `9f72e76`, `ff9b6d8`, and `cac02ff` added greenfield workspace/talk route modules for core APIs, detail/snapshot APIs, and chat enqueue.
- Commits `55c3d7e`, `3863628`, and `c53df5a` ported the queue consumer, executor, and scheduler sweeps to greenfield `runs` / `messages` / `talk_agent_snapshots`.
- Commit `2363ee1` hardened greenfield run-state behavior across queue consumer, scheduler, in-process dispatch, outbox notify timing, DLQ retry behavior, executor ordered/parallel prompt semantics, and bootstrap idempotency tests.
- The API shell extraction slice moves greenfield `/me`, workspace/folder/talk CRUD, snapshot/detail/content/thread compatibility, and chat mounts into `src/clawtalk/web/routes/greenfield-api.ts`.
- The roster mutation cleanup slice moves `PUT /api/v1/talks/:talkId/agents` to greenfield `talk_agents` / workspace `agents` and removes that legacy route collision.
- The talk policy cleanup slice moves `GET/PUT /api/v1/talks/:talkId/policy` to a greenfield compatibility facade derived from `talk_agents`, keeps the old no-op `PUT` name-normalization leniency, reports the greenfield 5-agent roster cap, and does not reintroduce a policy mirror.
- The tools cleanup slice moves `GET/PATCH /api/v1/talks/:talkId/tools` to greenfield `talk_tools`, materializes the existing light-family frontend contract into canonical per-tool rows, freezes active families plus resolved effective tool permissions into greenfield run prompt snapshots for execution, emits `talk_tools_changed`, and removes the legacy `active_tool_families_json` route collision.

## Refactor Roadmap

| Step | Work                                                                                                                       | Gate                                                                                                                                        |
| ---- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Cutover foundation: fresh Supabase baseline, role-template seed, first-signin workspace bootstrap, §11 verification tests. | ✅ Applies on empty/reset DB; workspace + default agents seed; first invariant tests pass.                                                  |
| 2    | Greenfield route/accessor spine: workspace/talk core APIs, detail/snapshot APIs, chat enqueue.                             | ✅ Focused greenfield core/detail/chat route tests pass.                                                                                    |
| 3    | Greenfield execution backend: queue consumer, executor, scheduler sweeps, run-state hardening.                             | ✅ Atomic outbox/state transitions, notify timing, ordered/parallel behavior, scheduler sweeps, and DLQ retry tests pass.                   |
| 4    | API shell/resource decomposition cleanup.                                                                                  | 🔄 Greenfield mount glue, roster mutation, policy facade, tools routes/tool-gating snapshot, and document edit compatibility extracted; next retire context/resources and jobs one family at a time. |
| 5    | Frontend shell + Talk rewrite.                                                                                             | New shell and Talk page use greenfield APIs; `TalkDetailPage.tsx` legacy surface is retired.                                                |
| 6    | Documents.                                                                                                                 | Primary document, tabs/blocks, pending edit accept/reject, PDF/page context path work against new schema.                                   |
| 7    | Agents, tools, connectors, context.                                                                                        | Agent editing, prompt snapshots, tool gating, connector binding, and context sources are greenfield.                                        |
| 8    | Jobs.                                                                                                                      | Scheduler/run-now/queue/output/inbox behavior passes `12-jobs.md` verification.                                                             |
| 9    | Home, Settings, polish, eval gate.                                                                                         | Home inbox/recommendations/news are deterministic first; agent eval gate passes before broader launch.                                      |
| 10   | Forge.                                                                                                                     | Post-MVP feature flag: SSR connection, audiences, improvement runs, gallery, promote to `document_edits`.                                   |

## Active Decision

Proceed with the **big-bang cutover branch** from [IMPLEMENTATION-READINESS.md](./IMPLEMENTATION-READINESS.md). A dual-path feature flag is not recommended unless Joseph explicitly needs the legacy dogfood app to remain usable throughout the rewrite.
