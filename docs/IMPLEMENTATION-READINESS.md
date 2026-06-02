> **Status:** live implementation bridge · **Date:** 2026-06-02
> Orientation: [REFACTOR-OVERVIEW.md](./REFACTOR-OVERVIEW.md) · sequence: [05-build-plan.md](./05-build-plan.md) · schema: [11-data-model.md](./11-data-model.md)

# ClawTalk Implementation Readiness

This is the live bridge between the greenfield docs and the codebase as it exists today. It answers one question: are we ready to stop planning and start the refactor?

## Verdict

**Implementation is underway and currently paused at a review gate.** The cutover branch has committed the Phase 1 foundation plus the first backend greenfield runtime stack: workspace/talk route modules (`9f72e76`, `ff9b6d8`, `cac02ff`), queue consumer (`55c3d7e`), executor (`3863628`), scheduler sweeps (`c53df5a`), and the run-state hardening slice (`2363ee1`). The current uncommitted staged slice retires the remaining legacy context/runtime execution surface: provider replay moves to a private trusted table, runtime identity comes from `talk_agent_snapshots.provider_id/model_id`, source references use final `context_sources.id` with compatibility alias fallback, and the old `CleanTalkExecutor` fails closed. Local code verification is clean; the slice should not be committed until GStack Review is rerun after the Codex CLI quota resets. The correct path remains a **greenfield application cutover on the existing Cloudflare/Supabase runtime**, not a dual-path incremental migration or a long chain of compatibility migrations.

That means:

- Keep the proven infrastructure: Cloudflare Workers, Hono, Durable Objects, Hyperdrive, Queues, R2, Supabase Postgres, postgres.js, the LLM provider layer, auth cookie/CSRF shape, and the event outbox/UserEventHub streaming contract.
- Replace the product schema and product-facing code paths: all legacy Talk/thread/content/registered-agent/job accessors, routes, API types, and large frontend surfaces are rewritten against the §11 model.
- Treat old Supabase data and migration history as disposable. The implementation branch should reset/recreate the database and start the active migration path at `supabase/migrations/0001_clawtalk_greenfield.sql`; archive or remove the old `0001`-`0038` migration stream from the active path.
- Do not preserve a legacy runtime fork behind `CT_GREENFIELD`. The current code is schema-entangled enough that a feature-flag cutover would double the surface area without buying meaningful safety for a one-user dogfood product.

## Audit Inputs

Reviewed:

- Canonical docs: `01` through `12`, `DECISIONS.md`, `SECURITY.md`, `SPEC-READINESS.md`, `DOC-AUDIT.md`, `GLOSSARY.md`, `engineering-notes.md`, `eval-suite.md`. `canonical-greenfield-migration.sql` is a historical pointer only; the executable schema source is `supabase/migrations/0001_clawtalk_greenfield.sql`.
- Current source: `src/worker.ts`, `src/db.ts`, `src/clawtalk/web/worker-app.ts`, `src/clawtalk/web/routes/*`, `src/clawtalk/db/*`, `src/clawtalk/talks/*`, `src/clawtalk/agents/*`, `src/clawtalk/identity/*`, `src/clawtalk/llm/*`, `webapp/src/*`, `prototype/*`, `shared/data.jsx`.
- Current migration stream: the active implementation branch has `supabase/migrations/0001_clawtalk_greenfield.sql`; historical `0001` through `0038` plus rollback baggage live under `docs/archive/legacy-supabase-migrations/`.

Static shape observed on 2026-05-31:

| Area                     | Finding                                                                                                                                                                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend route surface    | `src/clawtalk/web/worker-app.ts` is 2,004 LOC after delegating greenfield shell/detail/chat/policy/tools mounts to `src/clawtalk/web/routes/greenfield-api.ts` (974 LOC). Remaining shell work is retiring legacy route collisions.       |
| Backend data layer       | `src/clawtalk/db/accessors.ts` is 3,363 LOC and still centralizes legacy Talk/thread/message/run behavior. It is a rewrite boundary, not a file to keep extending.                                                                        |
| Executor/context         | `new-executor.ts` is 2,869 LOC and `context-loader.ts` is 2,680 LOC. Salvage the proven streaming/tool/context ideas, but rewrite the DB contract and split responsibilities.                                                             |
| Frontend Talk page       | `webapp/src/pages/TalkDetailPage.tsx` is 10,815 LOC. This is the largest snappiness and maintainability risk; rewrite as feature modules with server-state boundaries.                                                                    |
| Frontend API client      | `webapp/src/lib/api.ts` is 4,502 LOC and still exposes `Content`, `Thread`, `registered-agent`, and connector-era types. Replace with resource-specific clients generated from greenfield contracts or kept as small typed modules.       |
| Legacy schema references | 51 source files still reference `talk_threads`, `talk_runs`, `talk_messages`, `registered_agents`, `contents`, `content_edits`, or `talk_jobs`.                                                                                           |
| Greenfield runtime       | Core/detail/chat routes, their Hono mount layer, chat enqueue, queue consumer, executor, scheduler sweeps, outbox notify timing, and DLQ handling now target greenfield tables. Legacy collision cleanup and frontend integration remain. |
| Test corpus              | 97 test files across backend + webapp. Many backend tests assert legacy schema behavior and should be rewritten, not repaired one-by-one.                                                                                                 |

## Verification Run

Commands run from `/Users/josephkim/.codex/worktrees/381b/clawtalk`:

| Command                                                                                                                              | Result            | Notes                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci`                                                                                                                             | Pass              | Local shell Node is `v22.22.1`, package requires `>=24 <25`; install completed with engine warnings.                                                                                                                                     |
| `npm --prefix webapp ci`                                                                                                             | Pass              | Same Node engine warning.                                                                                                                                                                                                                |
| `npm run typecheck`                                                                                                                  | Pass              | After dependencies installed.                                                                                                                                                                                                            |
| `npm --prefix webapp run typecheck`                                                                                                  | Pass              | After dependencies installed.                                                                                                                                                                                                            |
| `npm --prefix webapp run test`                                                                                                       | Pass              | 30 files, 299 passed, 1 skipped. React Router v7 warnings and Tiptap duplicate-link warnings remain non-blocking.                                                                                                                        |
| bundled Node 24 `scripts/run-vitest.mjs run`                                                                                         | Fails as expected | 41 passed / 26 failed files; 770 passed / 220 failed / 127 skipped tests. Dominant failure: tests and source expect legacy columns/tables (`talks.owner_id`, `users.role`, `registered_agents`) that are absent in the current DB shape. |
| `npm run db:reset`                                                                                                                   | Pass              | Applies the single active baseline `0001_clawtalk_greenfield.sql` from zero.                                                                                                                                                             |
| bundled Node 24 `npm run typecheck`                                                                                                  | Pass              | After Phase 1 bootstrap/source edits.                                                                                                                                                                                                    |
| bundled Node 24 `scripts/run-vitest.mjs run src/clawtalk/workspaces/bootstrap.test.ts src/clawtalk/schema/greenfield-schema.test.ts` | Pass              | 2 files, 5 tests. Covers workspace bootstrap, role/team seed idempotency, legacy table absence, last-tab guard, run trigger shape, and home inbox dedup.                                                                                 |
| bundled Node 24 `scripts/run-vitest.mjs run ...greenfield slice tests...`                                                            | Pass              | 14 files, 107 tests after `2363ee1`. Covers atomic outbox rollback, notify timing, ordered/parallel state-machine behavior, scheduler sweeps, bootstrap idempotency, executor prompt semantics, and worker DLQ ack/retry behavior.       |
| bundled Node 24 `scripts/run-vitest.mjs run src/clawtalk/web/worker-app.test.ts src/clawtalk/web/routes/greenfield-*.test.ts`        | Pass              | 4 files, 20 tests after the greenfield API mount extraction. Confirms worker auth mounts and core/detail/chat route behavior still pass.                                                                                                 |
| `CLAWTALK_ALLOW_UNSUPPORTED_NODE=1 npm run test -- src/clawtalk/web/routes/greenfield-jobs.test.ts`                                  | Pass              | 28 tests after the disabled non-target job-roster snapshot regression fix.                                                                                                                                                                |
| `CLAWTALK_ALLOW_UNSUPPORTED_NODE=1 npm run test -- ...current staged slice suite...`                                                  | Pass              | 12 files, 199 tests. Covers provider replay scope/budget, fail-closed retired executor gate, queue consumer persistence privacy, greenfield executor replay/history behavior, context readiness, schema invariants, and route contracts.  |
| `npm run typecheck`                                                                                                                  | Pass              | After the current staged runtime-retirement slice.                                                                                                                                                                                        |
| `npm run build`                                                                                                                      | Pass              | After the current staged runtime-retirement slice.                                                                                                                                                                                        |
| `git diff --cached --check`                                                                                                          | Pass              | Current staged slice has no whitespace diff errors.                                                                                                                                                                                       |
| Claude Review                                                                                                                       | Pass              | Clean on 2026-06-02 compact staged-slice artifact.                                                                                                                                                                                       |
| Karpathy diff review                                                                                                                | Partial pass      | Local Karpathy traceability review found no scope issue. The Codex CLI-backed attempt was blocked by usage quota.                                                                                                                        |
| GStack Review                                                                                                                       | Blocked           | First run found one P2 in job snapshot creation; the code was fixed and verified. Required rerun is blocked by Codex CLI usage quota until 2026-06-07 08:23 America/Los_Angeles.                                                          |

The backend test failure is useful audit evidence: the code and tests are already straddling incompatible schema worlds. This confirms the docs' cutover warning and argues against a prolonged dual-path migration.

## Architecture Decision

Use a **big-bang cutover branch** with thin vertical slices, not a production feature flag.

Rationale:

- The current product tables are disposable per D0 and already block the target product shape: no true workspace tenancy, threads everywhere, content/document vocabulary drift, jobs-as-messages, and per-user RLS.
- A flag would require maintaining both `owner_id` and `workspace_id` authorization paths, both thread and no-thread route contracts, and both content/document clients. That doubles bugs in the most sensitive parts of the app.
- The safer engineering move is to land the fresh greenfield baseline and the minimum viable rewritten runtime together on a cutover branch, with verification gates after each vertical slice.

## Implementation Order

Start with a refactor branch and proceed in this order:

1. **Cutover foundation** ✅ committed
   - Create a fresh Supabase baseline at `supabase/migrations/0001_clawtalk_greenfield.sql`.
   - Remove or archive the old `supabase/migrations/0001`-`0038` files from the active migration path. If using the same Supabase project, reset/recreate the database instead of preserving migration history.
   - Use `11-data-model.md` as the schema design source and keep `supabase/migrations/0001_clawtalk_greenfield.sql` as the single executable final-state DDL: create all final tables directly; no legacy `DROP`/`ALTER` compatibility sequence, no backfill.
   - Add the `agent_role_templates` seed and first-signin workspace bootstrap.
   - Add §11 verification tests first, including composite-FK, RLS, document-edit CAS, jobs invariants, and system-agent visibility.

2. **Greenfield data access** 🔄 partially committed
   - Create small accessors by resource: `workspaces`, `folders`, `talks`, `messages`, `runs`, `agents`, `documents`, `context`, `tools`, `connectors`, `jobs`, `home`, `forge`.
   - Workspace/talk/chat/run accessors now exist for the first greenfield spine.
   - Remove reliance on the monolithic `db/accessors.ts` as call sites move.
   - Every user path enters through `withUserContext`; every service path is explicitly service-role.

3. **API shell rewrite** 🔄 partially committed
   - Replace `worker-app.ts` route mounting with resource route modules.
   - Greenfield shell/detail/chat routes now mount through `greenfield-api.ts`; `worker-app.ts` keeps public auth/health/content-images/WebSocket patterns plus legacy surfaces that still need cutover.
   - Keep public auth, health, content-image serving, and WebSocket upgrade patterns.
   - Finish the remaining legacy route collision for resources/connector bindings, then complete the greenfield jobs scheduler/runtime follow-through.

4. **Talk execution vertical slice** 🔄 partially underway
   - New `/chat` writes `messages`, freezes `talk_agent_snapshots`, creates `runs`, enqueues to `TALK_RUN_QUEUE`, and streams through `event_outbox`.
   - Queue consumer keeps the proven atomic-claim shape but targets `runs`.
   - Committed hardening (`2363ee1`) already makes the run state machine safer: claim/complete/fail/DLQ transitions write outbox rows in the same transaction, notify fan-out happens post-commit, ordered/parallel sequencing is separated, and scheduler sweeps avoid promoting parallel siblings.
   - Executor reads prompt snapshots, `talk_tools`, connector authorization, and context through the new schema.
   - Current staged slice retires legacy runtime/context leftovers: `new-executor.ts` keeps only shared tool/image helpers plus a fail-closed `CleanTalkExecutor`, message provider replay is private/server-only, and replay/historical context selection is scoped to the acting source agent + frozen provider/model.

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

| Path                        | Target                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| App shell first render      | Authenticated shell displays cached workspace + sidebar within 300 ms after bundle load.                                                          |
| Talk open                   | Sidebar-to-Talk snapshot fetch under 250 ms local/staging p50, under 750 ms p95.                                                                  |
| Send message acknowledgment | `/chat` returns queued run IDs under 300 ms p50 before LLM work starts.                                                                           |
| First token                 | Preserve existing inline/queue optimization where possible; first streamed token under provider TTFT + 500 ms app overhead.                       |
| Sidebar updates             | WebSocket/outbox update visible within 250 ms after DB commit in local/staging.                                                                   |
| Document edit accept        | Single pending edit accept under 300 ms p50, with CAS conflict reported cleanly.                                                                  |
| Frontend responsiveness     | No single React component over 1,000 LOC in the rewritten greenfield UI; route-level bundles split for Home/Talk/Documents/Agents/Settings/Forge. |

## Cleanup Needed During Implementation

These are documentation/project hygiene tasks, not product blockers:

- Keep this file current after each committed slice.
- Treat `SPEC-READINESS.md` and `DOC-AUDIT.md` as historical gap logs; live readiness is here.
- Keep `docs/roadmap.md` focused on current implementation state.
- Use the bundled Node 24 runtime or switch local shell to `.nvmrc` before backend tests.

## Current Pause Point

The active staged slice is **ready for final review, not implementation continuation**. It should be committed only after the required review loop completes:

- Re-run GStack Review on the staged diff after the Codex CLI quota resets.
- If GStack returns clean, commit the staged slice as `refactor: retire legacy context runtime`.
- If GStack finds an issue, patch only that finding, rerun focused tests + `npm run typecheck` + `npm run build` + `git diff --cached --check`, then rerun Claude/GStack/Karpathy review gates before committing.

Do not start frontend rewrite or the next backend slice until this staged slice is committed.

## Next Ready Signal

After the staged runtime-retirement slice is committed, the next implementation slice should begin the webapp/Talk rewrite against final greenfield APIs. It is ready to commit when:

- One UI/resource family moves off legacy route/accessor contracts without widening the slice.
- Focused route/accessor tests cover auth/RLS behavior and happy/error paths for that resource family.
- `worker-app.ts` continues shrinking or stays as mount-only glue for that family.
- Node 24 typecheck, focused backend tests, gstack review, Karpathy diff review, and Claude review pass.
