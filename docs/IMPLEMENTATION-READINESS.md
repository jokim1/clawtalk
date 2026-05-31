> **Status:** current implementation audit · **Date:** 2026-05-30
> Orientation: [REFACTOR-OVERVIEW.md](./REFACTOR-OVERVIEW.md) · sequence: [05-build-plan.md](./05-build-plan.md) · schema: [11-data-model.md](./11-data-model.md)

# ClawTalk Implementation Readiness

This is the live bridge between the greenfield docs and the codebase as it exists today. It answers one question: are we ready to stop planning and start the refactor?

## Verdict

**Ready to start implementation.** The correct path is a **greenfield application cutover on the existing Cloudflare/Supabase runtime**, backed by a **fresh Supabase schema baseline**, not a dual-path incremental migration or a long chain of compatibility migrations.

That means:

- Keep the proven infrastructure: Cloudflare Workers, Hono, Durable Objects, Hyperdrive, Queues, R2, Supabase Postgres, postgres.js, the LLM provider layer, auth cookie/CSRF shape, and the event outbox/UserEventHub streaming contract.
- Replace the product schema and product-facing code paths: all legacy Talk/thread/content/registered-agent/job accessors, routes, API types, and large frontend surfaces are rewritten against the §11 model.
- Treat old Supabase data and migration history as disposable. The implementation branch should reset/recreate the database and start the active migration path at `supabase/migrations/0001_clawtalk_greenfield.sql`; archive or remove the old `0001`-`0038` migration stream from the active path.
- Do not preserve a legacy runtime fork behind `CT_GREENFIELD`. The current code is schema-entangled enough that a feature-flag cutover would double the surface area without buying meaningful safety for a one-user dogfood product.

## Audit Inputs

Reviewed:

- Canonical docs: `01` through `12`, `DECISIONS.md`, `SECURITY.md`, `SPEC-READINESS.md`, `DOC-AUDIT.md`, `GLOSSARY.md`, `engineering-notes.md`, `eval-suite.md`, `canonical-greenfield-migration.sql`.
- Current source: `src/worker.ts`, `src/db.ts`, `src/clawtalk/web/worker-app.ts`, `src/clawtalk/web/routes/*`, `src/clawtalk/db/*`, `src/clawtalk/talks/*`, `src/clawtalk/agents/*`, `src/clawtalk/identity/*`, `src/clawtalk/llm/*`, `webapp/src/*`, `prototype/*`, `shared/data.jsx`.
- Current migration stream: `supabase/migrations/0001` through `0038` exists today and is historical implementation baggage. The greenfield SQL is parked in docs as a reference; the active implementation branch should replace the active stream with a fresh baseline migration.

Static shape observed on 2026-05-30:

| Area | Finding |
|---|---|
| Backend route surface | `src/clawtalk/web/worker-app.ts` is 2,695 LOC and mounts the legacy product API directly. This should be decomposed around greenfield resources during rewrite. |
| Backend data layer | `src/clawtalk/db/accessors.ts` is 3,351 LOC and still centralizes legacy Talk/thread/message/run behavior. It is a rewrite boundary, not a file to keep extending. |
| Executor/context | `new-executor.ts` is 2,869 LOC and `context-loader.ts` is 2,680 LOC. Salvage the proven streaming/tool/context ideas, but rewrite the DB contract and split responsibilities. |
| Frontend Talk page | `webapp/src/pages/TalkDetailPage.tsx` is 10,815 LOC. This is the largest snappiness and maintainability risk; rewrite as feature modules with server-state boundaries. |
| Frontend API client | `webapp/src/lib/api.ts` is 4,502 LOC and still exposes `Content`, `Thread`, `registered-agent`, and connector-era types. Replace with resource-specific clients generated from greenfield contracts or kept as small typed modules. |
| Legacy schema references | 51 source files still reference `talk_threads`, `talk_runs`, `talk_messages`, `registered_agents`, `contents`, `content_edits`, or `talk_jobs`. |
| Greenfield references | Greenfield concepts exist mainly in docs and some partial code (`workspace_*`, connector refactor, page-rasterization additions), not as a coherent runtime. |
| Test corpus | 97 test files across backend + webapp. Many backend tests assert legacy schema behavior and should be rewritten, not repaired one-by-one. |

## Verification Run

Commands run from `/Users/josephkim/.codex/worktrees/381b/clawtalk`:

| Command | Result | Notes |
|---|---|---|
| `npm ci` | Pass | Local shell Node is `v22.22.1`, package requires `>=24 <25`; install completed with engine warnings. |
| `npm --prefix webapp ci` | Pass | Same Node engine warning. |
| `npm run typecheck` | Pass | After dependencies installed. |
| `npm --prefix webapp run typecheck` | Pass | After dependencies installed. |
| `npm --prefix webapp run test` | Pass | 30 files, 299 passed, 1 skipped. React Router v7 warnings and Tiptap duplicate-link warnings remain non-blocking. |
| bundled Node 24 `scripts/run-vitest.mjs run` | Fails as expected | 41 passed / 26 failed files; 770 passed / 220 failed / 127 skipped tests. Dominant failure: tests and source expect legacy columns/tables (`talks.owner_id`, `users.role`, `registered_agents`) that are absent in the current DB shape. |

The backend test failure is useful audit evidence: the code and tests are already straddling incompatible schema worlds. This confirms the docs' cutover warning and argues against a prolonged dual-path migration.

## Architecture Decision

Use a **big-bang cutover branch** with thin vertical slices, not a production feature flag.

Rationale:

- The current product tables are disposable per D0 and already block the target product shape: no true workspace tenancy, threads everywhere, content/document vocabulary drift, jobs-as-messages, and per-user RLS.
- A flag would require maintaining both `owner_id` and `workspace_id` authorization paths, both thread and no-thread route contracts, and both content/document clients. That doubles bugs in the most sensitive parts of the app.
- The safer engineering move is to land the fresh greenfield baseline and the minimum viable rewritten runtime together on a cutover branch, with verification gates after each vertical slice.

## Implementation Order

Start with a refactor branch and proceed in this order:

1. **Cutover foundation**
   - Create a fresh Supabase baseline at `supabase/migrations/0001_clawtalk_greenfield.sql`.
   - Remove or archive the old `supabase/migrations/0001`-`0038` files from the active migration path. If using the same Supabase project, reset/recreate the database instead of preserving migration history.
   - Use `docs/canonical-greenfield-migration.sql` and `11-data-model.md` as source material, but normalize the active baseline into final-state DDL: create all final tables directly; no legacy `DROP`/`ALTER` compatibility sequence, no backfill.
   - Add the `agent_role_templates` seed and first-signin workspace bootstrap.
   - Add §11 verification tests first, including composite-FK, RLS, document-edit CAS, jobs invariants, and system-agent visibility.

2. **Greenfield data access**
   - Create small accessors by resource: `workspaces`, `folders`, `talks`, `messages`, `runs`, `agents`, `documents`, `context`, `tools`, `connectors`, `jobs`, `home`, `forge`.
   - Remove reliance on the monolithic `db/accessors.ts` as call sites move.
   - Every user path enters through `withUserContext`; every service path is explicitly service-role.

3. **API shell rewrite**
   - Replace `worker-app.ts` route mounting with resource route modules.
   - Keep public auth, health, content-image serving, and WebSocket upgrade patterns.
   - Ship `/me`, workspace switching, folders/talks CRUD, and basic talk snapshot first.

4. **Talk execution vertical slice**
   - New `/chat` writes `messages`, freezes `talk_agent_snapshots`, creates `runs`, enqueues to `TALK_RUN_QUEUE`, and streams through `event_outbox`.
   - Queue consumer keeps the proven atomic-claim shape but targets `runs`.
   - Executor reads prompt snapshots, `talk_tools`, connector authorization, and context through the new schema.

5. **Frontend shell and Talk rewrite**
   - Replace `TalkDetailPage.tsx` with feature modules: shell, roster/composer, run stream, context panel, tools/connectors panels, document pane.
   - Use React Query resource keys per workspace/talk/document, not one giant page state object.
   - Keep the visual prototype and `02-visual-system.md` as UI source of truth.

6. **Documents, Jobs, Home, Settings, Forge**
   - Follow `05-build-plan.md` Phases 6 through 14.
   - Jobs should land before Home so `job_output_ready` and `job_blocked` are real inbox producers.
   - Forge stays post-MVP behind a flag, but its schema ships with the greenfield baseline so the product model is not redesigned twice.

## Performance Targets

The refactor is not only a schema cleanup. It should make ClawTalk feel faster:

| Path | Target |
|---|---|
| App shell first render | Authenticated shell displays cached workspace + sidebar within 300 ms after bundle load. |
| Talk open | Sidebar-to-Talk snapshot fetch under 250 ms local/staging p50, under 750 ms p95. |
| Send message acknowledgment | `/chat` returns queued run IDs under 300 ms p50 before LLM work starts. |
| First token | Preserve existing inline/queue optimization where possible; first streamed token under provider TTFT + 500 ms app overhead. |
| Sidebar updates | WebSocket/outbox update visible within 250 ms after DB commit in local/staging. |
| Document edit accept | Single pending edit accept under 300 ms p50, with CAS conflict reported cleanly. |
| Frontend responsiveness | No single React component over 1,000 LOC in the rewritten greenfield UI; route-level bundles split for Home/Talk/Documents/Agents/Settings/Forge. |

## Cleanup Needed Before First Code PR

These are documentation/project hygiene tasks, not product blockers:

- Keep this file current as implementation starts.
- Treat `SPEC-READINESS.md` and `DOC-AUDIT.md` as historical gap logs; live readiness is here.
- Keep `docs/roadmap.md` focused on current implementation state.
- Use the bundled Node 24 runtime or switch local shell to `.nvmrc` before backend tests.

## Ready Signal

We are ready to start implementation when:

- The implementation branch exists.
- The first PR scope is limited to cutover foundation: fresh baseline schema, seed, bootstrap, and §11 verification tests.
- The team accepts the big-bang cutover assumption above.

As of this audit, those conditions are met except for branch creation and the first code PR. The docs are sufficient to begin.
