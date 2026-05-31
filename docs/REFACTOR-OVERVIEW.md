# ClawTalk Refactor — Overview

> **Status:** orientation (new readers start here) · **Last updated:** 2026-05-31
> One-page narrative for the ClawTalk greenfield rebuild. If you're new to this work, read this first. The detail docs (`01–12`, `SECURITY`, `eval-suite`, `GLOSSARY`) live next door.
>
> Precedence: when this overview disagrees with a canonical detail doc, **the detail doc wins**. See [README.md](./README.md) for the conflict-resolution order.

---

## 1. What this refactor is, in one paragraph

ClawTalk is being **rebuilt greenfield on the existing infrastructure**. The design — workspace tenancy, the canonical Workspace → Folder → Talk + Document model, jobs as first-class scheduled runs, Forge as autonomous content improvement, no Threads — is a clean-slate redesign. The runtime — Cloudflare Workers + Hono + Durable Objects + Hyperdrive + Cloudflare Queues + Supabase Postgres with RLS — is the existing infra. The shipped schema and code (`talk_runs`/`talk_threads`/`registered_agents`/`contents` and the per-user RLS model) is **disposable**: it served as the prototype that proved the requirements, and is being replaced by a fresh Supabase baseline that creates the target schema from an empty database.

This is not "evolve the schema." This is "the schema we have constrains every feature; rebuild it once, then build on top."

---

## 2. Status snapshot (as of 2026-05-31)

| Status            | What                                                                                                                                                          | Where                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| ✅ Merged         | Spec corpus close pass (all P0 + P1 gaps closed across 14 docs)                                                                                               | PR [#497](https://github.com/jokim1/clawtalk/pull/497) → main `05e3a15`                                                      |
| ✅ Merged         | Talk-scoped tools refactor (removed per-agent `tool_permissions_json`)                                                                                        | PR [#499](https://github.com/jokim1/clawtalk/pull/499) → main `82641ed`, used migration **0037**                             |
| ✅ Merged         | 10 deferred design-debt items resolved + REFACTOR-OVERVIEW.md                                                                                                 | PR [#500](https://github.com/jokim1/clawtalk/pull/500) → main `d75550c`                                                      |
| ✅ Merged         | PDF page rasterization Lane A (backend contract)                                                                                                              | PR [#501](https://github.com/jokim1/clawtalk/pull/501) used migration **0038**                                               |
| ✅ Merged         | §11 spec addition: `context_source_pages` + `context_sources.expected_page_count`                                                                             | PR [#503](https://github.com/jokim1/clawtalk/pull/503)                                                                       |
| ✅ Merged         | PDF rasterization Lane B + Lane C T9 (consume page images + client render/upload)                                                                             | PRs [#504](https://github.com/jokim1/clawtalk/pull/504) + [#505](https://github.com/jokim1/clawtalk/pull/505)                |
| ✅ Merged         | PDF rasterization Lane C T10 (render-pages affordance + capability surfacing)                                                                                 | PR [#506](https://github.com/jokim1/clawtalk/pull/506) → main `696302d`                                                      |
| ✅ Merged         | Greenfield schema parked as docs-side canonical reference                                                                                                     | PR #507 → main `b520932`; SQL held at [`docs/canonical-greenfield-migration.sql`](./canonical-greenfield-migration.sql)      |
| ✅ Cutover branch | The active Supabase baseline                                                                                                                                  | `supabase/migrations/0001_clawtalk_greenfield.sql`; old migrations archived under `docs/archive/legacy-supabase-migrations/` |
| ✅ Cutover branch | `agent_role_templates` seed (Phase 1 Step 2)                                                                                                                  | Five user roles copied from `03-agents.md`; Forge system prompts remain placeholders until Joseph authors final copy         |
| ✅ Cutover branch | Cutover foundation: fresh baseline + seed + first-signin workspace bootstrap + §11 verification tests                                                         | Committed on `codex/clawtalk-greenfield-cutover`                                                                             |
| ✅ Cutover branch | Greenfield workspace/talk route modules: core workspace APIs, talk detail/snapshot APIs, and chat enqueue APIs                                                | Commits `9f72e76`, `ff9b6d8`, `cac02ff`                                                                                      |
| ✅ Cutover branch | Greenfield execution ports: queue consumer, executor, and scheduler sweeps target `runs` / `messages` / `talk_agent_snapshots`                                | Commits `55c3d7e`, `3863628`, `c53df5a`                                                                                      |
| ✅ Cutover branch | Greenfield run-state hardening: atomic outbox transitions, notify flush ownership, ordered/parallel sequencing, scheduler sweeps, DLQ retry behavior          | Commit `2363ee1` (`fix: harden greenfield run state machine`)                                                                |
| ✅ Cutover branch | Greenfield API mount extraction: `/me`, workspace/folder/talk CRUD, snapshot/detail/content/thread compatibility, and chat mounts live in `greenfield-api.ts` | API shell extraction slice                                                                                                   |
| ✅ Cutover branch | Greenfield talk roster mutation: `PUT /api/v1/talks/:talkId/agents` now replaces `talk_agents` against workspace agents                                       | API collision cleanup slice                                                                                                  |
| ✅ Cutover branch | Greenfield talk policy facade: `GET/PUT /api/v1/talks/:talkId/policy` now derives from `talk_agents`, preserves the old no-op `PUT` leniency, reports the 5-agent roster cap, and skips a legacy policy mirror | API collision cleanup slice                                                                                                  |
| ✅ Cutover branch | Greenfield talk tools route: `GET/PATCH /api/v1/talks/:talkId/tools` now materializes light-family toggles into canonical `talk_tools.tool_id` rows, freezes active families plus resolved effective tool permissions into run prompt snapshots, and emits `talk_tools_changed` | API collision cleanup slice                                                                                                  |
| ✅ Cutover branch | Greenfield document edit compatibility: `/api/v1/contents/:contentId/edits/:editId/(accept|reject)` and `/runs/:runId/(accept|reject)` now materialize `document_edits` into `doc_blocks`, preserve the legacy response envelope, and keep the implicit-accept PATCH path | API collision cleanup slice                                                                                                  |
| 🔄 Active next    | Retire remaining legacy API collisions: context/resources and jobs                                                                                              | Next slices                                                                                                                  |
| ⏭️ Next           | webapp/ rewrite per §05 Phases (every page touches new tables)                                                                                                | Phased                                                                                                                       |
| ⏭️ Next           | §14 verification test suite (24 invariants)                                                                                                                   | Phased                                                                                                                       |
| ⏭️ Next           | Phase 13 eval gate (harness contract done; scenarios + grader prompts TBD)                                                                                    | Phased                                                                                                                       |

**Why the schema was parked on main.** The schema reference was structurally complete and locally validated, but it was authored as a destructive drop/create script for the old migration stream. Shipping it on `main` without the matching src/ rewrite breaks every accessor + route + test — 38/38 accessor tests + 21/30 google-drive tests fail because they target the dropped legacy tables (CI run on PR #502 confirmed this exactly as §14 predicted). Per Joseph's docs-only posture, PR #507 parked it at [`docs/canonical-greenfield-migration.sql`](./canonical-greenfield-migration.sql). The cutover branch has now converted it into the pure active baseline at `supabase/migrations/0001_clawtalk_greenfield.sql`, archived the old active migration stream, and continues with the coordinated src/webapp rewrite rather than layering a `0040+` migration on top.

For the current implementation audit, see [IMPLEMENTATION-READINESS.md](./IMPLEMENTATION-READINESS.md). For the full gap-by-gap close history, see [SPEC-READINESS.md](./SPEC-READINESS.md). For the canonical decisions, see [DECISIONS.md](./DECISIONS.md). For the phased build sequence, see [05-build-plan.md](./05-build-plan.md).

---

## 3. Why now

The shipped schema is the **proven prototype**, not the target. Specifically:

- **No tenancy.** The shipped DB is per-user (every workspace-shaped concept actually keyed by `owner_id`). Multi-workspace is foundational to the product model (D5) and was never built in.
- **Threads everywhere.** `talk_threads` couples every Talk-level concept to a thread that the new model has no use for. The pending-edit / context / runs surfaces all carry vestigial thread plumbing.
- **Vocabulary fork.** `contents` / `content_id` / `registered_agents` / `propose_content_append` are NanoClaw-era names that don't match the product spec's Document / Agent / `document_edits` vocabulary. Every PR re-translates.
- **Jobs were retrofitted.** The shipped `talk_jobs` writes its prompt as a `talk_message` and lands its output through a dedicated thread. The v8 spec (§12) restructures jobs as scheduled runs with snapshot-isolated prompt provenance and unified output via `document_edits`.
- **Forge was outside the schema.** §09 / §10 described a "content improvement loop" against tables that don't exist in the shipped model; nothing landable could be written until §11 absorbed the Forge schema.
- **RLS was per-user.** The membership predicate is a Workspace-level concept; the shipped model evaluates RLS as `auth.uid() = owner_id`, which works for single-user but breaks the moment a workspace has more than one member.

**The cheapest fix is to rebuild the schema once.** Per [DECISIONS](./DECISIONS.md) D0 + `CLAUDE.md`'s "treat data as disposable" rule, ClawTalk has exactly one live user (Joseph) and only dogfood data. No external users to migrate. No backwards-compat scaffolding to write.

---

## 4. What changes vs what stays

### Stays

- **Cloudflare platform.** Workers, Hono router, Durable Objects (UserEventHub), Hyperdrive (Postgres connection pool), Cloudflare Queues (TALK_RUN_QUEUE), Wrangler dev/deploy, R2 (attachments). [DECISIONS D1.](./DECISIONS.md)
- **Supabase Postgres.** Same database product/runtime and auth bridge pattern (`auth.users` → `public.users` trigger). The implementation can reset/recreate the project/database because old data is disposable.
- **LLM provider layer.** `llm_providers`, `llm_provider_models`, `llm_provider_secrets`, `workspace_provider_secrets` (these are LLM keys, NOT OAuth tokens), plus the live model discovery path (#484) that auto-inserts new Anthropic / NVIDIA models.
- **Event outbox / WebSocket Hibernation streaming.** `event_outbox` → `UserEventHub` DO. All streaming rides this.
- **Auth.** Google OAuth + email magic-link (planned) + device-code (CLI). HttpOnly cookies (`eb_at` / `eb_rt` / `eb_csrf`) + double-submit CSRF. See [SECURITY.md](./SECURITY.md).

### Changes

- **Schema.** Fresh Supabase baseline from an empty DB. The active migration path starts at `supabase/migrations/0001_clawtalk_greenfield.sql`; old `0001`-`0038` migrations are removed or archived from the active path. The canonical SQL reference is parked at [`docs/canonical-greenfield-migration.sql`](./canonical-greenfield-migration.sql), but the active baseline should create final tables directly rather than run a legacy `DROP`/`ALTER` cleanup sequence.
- **Tenancy.** `workspaces` + `workspace_members` from day one; every workspace-owned table carries `workspace_id`; composite FKs prevent cross-workspace references.
- **Runs model.** New `runs` table with `snapshot_group_id` (per-run frozen roster), `agent_snapshot_id` (the acting agent), `trigger` (`user` / `scheduler` / `manual`), `scheduled_for` (slot identity for jobs), `prompt_snapshot_id` (immutable prompt at fire time).
- **Documents model.** First-class `documents` + `doc_tabs` + `doc_blocks` + `document_edits`. Replaces the `contents` / `content_edits` / `content_proposals` stack. Pending edits go through one unified accept path with CAS via `base_block_version` / `base_list_version`.
- **Jobs.** Scheduled single-agent runs per [`12-jobs.md`](./12-jobs.md). Single-txn claim with fire-time dep check; atomic queue-consumer claim; slot dedup + single-flight via partial uniques; output via two booleans (`emit_talk_message`, `emit_document_append`).
- **Forge.** First-class autonomous content improvement per [`09-`](./09-autonomous-content-improvement-prd.md) and [`10-`](./10-forge-design-handoff.md). `improvement_runs` + `document_versions` + held-out persona scoring + winner promotion via `document_edits.source='forge'`.
- **Home.** Inbox + recommendations + news as 14 `home_*` tables (§7), with structured ranking_profiles, algorithm versions + per-workspace assignments for percentage rollouts, news scoring formula reading topic.source_domains / topic.freshness_horizon_days.
- **Agents.** `agents` (workspace-scoped) + `agent_role_templates` (DB-managed role catalog with `version`) + `talk_agent_snapshots` (per-run frozen roster) + `run_prompt_snapshots` (per-run prompt provenance) + `agent_feedback_events`. Includes `is_system=true` agents for Forge rewriter/critic.
- **Tools + Connectors.** `talk_tools(workspace_id, talk_id, tool_id, enabled)` per-Talk toggles. `connectors` workspace-global + `connector_bindings` per-Talk binding. `connector_secrets` (encrypted OAuth tokens, separate from LLM provider keys).
- **RLS.** Workspace-membership predicate via `is_workspace_member` + `is_workspace_admin` security-definer helpers. Member-write canonical; 8 admin-write exceptions (workspace_members, connectors family, home algorithms/ranking). Service-role bypass via Postgres role with `bypassrls` privilege.

---

## 5. The model in one diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│  Workspace  (the tenant root; multi-workspace from day one)          │
│    │                                                                 │
│    ├── workspace_members (owner / admin / member / guest)            │
│    │                                                                 │
│    ├── folders (flat; no nesting)                                    │
│    │     └── Talk (in folder, or "Unfiled" if folder_id = null)      │
│    │                                                                 │
│    ├── Talks                                                         │
│    │     ├── talk_agents (live roster — composer / @mention)         │
│    │     ├── talk_tools (per-Talk tool toggles)                      │
│    │     ├── messages (round-numbered, author = user OR agent)       │
│    │     ├── runs (one per agent reply)                              │
│    │     │     ├── snapshot_group_id → frozen roster (talk_agent_snapshots)│
│    │     │     ├── agent_snapshot_id → the acting agent              │
│    │     │     ├── prompt_snapshot_id → run_prompt_snapshots         │
│    │     │     ├── trigger ∈ user / scheduler / manual               │
│    │     │     └── scheduled_for (slot identity for jobs)            │
│    │     ├── context_sources (URLs / files / past talks / rules)     │
│    │     ├── talk_reads (per-user read state → unread is derived)    │
│    │     └── primary Document (0 or 1; via documents.primary_talk_id)│
│    │                                                                 │
│    ├── Documents                                                     │
│    │     ├── doc_tabs (≥1; last-tab-can't-delete trigger)            │
│    │     │     ├── doc_blocks (h1 / h2 / p / li / meta / code)       │
│    │     │     └── doc_tab_coeditors (per-tab agent permissions)     │
│    │     └── document_edits (pending → accepted / rejected / superseded)│
│    │           ├── source ∈ agent / forge / job                      │
│    │           └── CAS via base_block_version / base_list_version    │
│    │                                                                 │
│    ├── Agents (workspace-scoped; 5 default + 2 system Forge + custom)│
│    │     ├── agent_role_templates (DB-managed role catalog)          │
│    │     ├── team_compositions (curated agent sets)                  │
│    │     └── agent_feedback_events (useful / off_role / ...)         │
│    │                                                                 │
│    ├── Jobs (scheduled single-agent runs)                            │
│    │     ├── schedule_json (interval / daily / weekly + tz)          │
│    │     ├── emit_talk_message + emit_document_append (≥ 1)          │
│    │     └── runs filtered by job_id = history (no separate ledger)  │
│    │                                                                 │
│    ├── Forge (autonomous content improvement)                        │
│    │     ├── ssr_connections (per-workspace SSR/Synthetical binding) │
│    │     ├── forge_personas / reference_sets / questions (cache)     │
│    │     ├── forge_audiences (named persona sets; is_default flag)   │
│    │     ├── improvement_runs (scoped to doc/tab/block)              │
│    │     └── document_versions (per scored candidate)                │
│    │                                                                 │
│    ├── Home                                                          │
│    │     ├── home_inbox_items (12 types incl. job_*, forge_run_*)    │
│    │     ├── home_recommendations (15 kinds)                         │
│    │     ├── home_news_topics → home_news_matches (shared pool)      │
│    │     ├── home_ranking_profiles (16 structured weight columns)    │
│    │     └── home_algorithm_versions + assignments (% rollout)       │
│    │                                                                 │
│    ├── Connectors (workspace-global authorization)                   │
│    │     ├── connector_secrets (encrypted OAuth tokens, JIT-decrypt) │
│    │     └── connector_bindings (per-Talk binding)                   │
│    │                                                                 │
│    └── audit_events (append-only mutation log)                       │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 6. Architecture: how the runtime rides this schema

```
┌──────────────┐   HTTPS    ┌─────────────────────────────────────┐
│   Browser    │ ─────────► │  Cloudflare Worker (Hono routes)    │
│  (webapp/)   │            │   src/clawtalk/web/worker-app.ts    │
└──────┬───────┘            └────────────┬────────────────────────┘
       │ WebSocket                       │ withUserContext(authUid)
       ▼                                 ▼ → set local role authenticated
┌────────────────────┐         ┌──────────────────────────┐
│  UserEventHub DO   │ ◄────── │  Supabase Postgres (RLS) │
│  (per-user; WS     │ outbox  │  - workspaces            │
│   Hibernation)     │ stream  │  - is_workspace_member() │
└────────────────────┘         │  - is_workspace_admin()  │
       ▲                       └──────────────────────────┘
       │ event_outbox NOTIFY                  ▲
       │                                      │ Hyperdrive pool
       │                                      │
┌──────┴───────────────┐         ┌────────────┴─────────────┐
│ Executor             │         │ Scheduler (cron 1-min)   │
│ (per /chat or job)   │         │ src/clawtalk/talks/      │
│ - frozen snapshot    │         │   scheduler.ts           │
│ - tool authorization │         │ - Path A: claim due jobs │
│ - LLM call           │         │   (single-txn)           │
│ - outbox writes      │         │ - Path B: stuck-sweep    │
└──────────┬───────────┘         │   (queued 5min,          │
           │                     │   running 1h)            │
           │ TALK_RUN_QUEUE      └──────────┬───────────────┘
           ▼                                │ dispatchRun()
┌──────────────────────────┐                ▼
│ Queue consumer           │ ◄──── send({runId})
│ src/clawtalk/talks/      │
│   queue-consumer.ts      │
│ - atomic claim:          │
│   UPDATE runs SET        │
│     status='running'     │
│   WHERE id=$ AND         │
│     status='queued'      │
│   RETURNING *            │
└──────────────────────────┘
```

**Key runtime contracts:**

- **Snapshot freeze per run.** When a run is created, the executor (or scheduler) inserts a `talk_agent_snapshots` row per agent in the live `talk_agents` roster, sharing a fresh `snapshot_group_id`. The run carries that group id + the acting agent's snapshot id. Editing an agent or the roster mid-flight doesn't rewrite history — the snapshot is immutable.
- **Atomic queue consumer claim.** `TALK_RUN_QUEUE` is at-least-once and can deliver concurrently. The first consumer to flip `status='queued'` → `'running'` wins; others get an empty `RETURNING` and ack-and-drop.
- **Single-txn job claim.** The scheduler's Path A is one transaction: lock the due job (`FOR UPDATE SKIP LOCKED`), fire-time dep check, roster freeze, INSERT `runs` + `run_prompt_snapshots`, advance `next_due_at`, clear `claimed_at`, COMMIT. Queue dispatch happens outside the txn — if dispatch fails the stuck-queued sweep catches the orphan.
- **Slot identity.** `runs.scheduled_for` + partial unique `(job_id, scheduled_for)` makes "never fire the same job slot twice" a Postgres invariant.
- **Service-role bypass.** Scheduler / queue consumer / outbox writer / Forge executor / news ingest connect without `withUserContext`'s `set local role authenticated` swap, so RLS is bypassed by Postgres role privilege. User-input paths MUST call `withUserContext(authUserId)`.

---

## 7. Cross-cutting decisions (D0–D7, one sentence each)

| ID     | Decision                                                                                                                                                                                                                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D0** | Greenfield rebuild, not migration. Start from a fresh Supabase baseline; treat old schema/data as disposable.                                                                                                                                                                                           |
| **D1** | Cloudflare Workers + Hono + DO + Hyperdrive + Queues + Supabase Postgres. No Redis. No BullMQ. No Next.js.                                                                                                                                                                                              |
| **D2** | Clean data model on Workspace → Folder → Talk + Document hierarchy. No Threads. Multi-workspace from day one.                                                                                                                                                                                           |
| **D3** | Forge rewriter / critic are built-in system agents (`is_system=true` rows in `agents`, hidden from `GET /agents` and roster).                                                                                                                                                                           |
| **D4** | No Threads. Anywhere. The new model never had them; the old model's threads are dropped wholesale.                                                                                                                                                                                                      |
| **D5** | Multi-workspace is foundational. `workspaces` + `workspace_members` from Phase 1 of the rebuild.                                                                                                                                                                                                        |
| **D6** | Jobs designed clean per [`12-jobs.md`](./12-jobs.md): scheduled single-agent prompts firing normal runs; slot identity; archive not delete; service-role auth.                                                                                                                                          |
| **D7** | Schema pressure-test resolutions: composite FKs for tenant integrity, `auth.uid()` RLS identity (no `app.*` GUC), `agent_role_templates` as a DB table, `llm_models` as a single catalog seeded from `llm_provider_models`, Forge SSR per-workspace, secret stores split (LLM keys vs connector OAuth). |

Full decision text + follow-ups: [DECISIONS.md](./DECISIONS.md).

---

## 8. The schema in 30 seconds

- **Drop list:** 37 legacy tables (every `talk_*`, `registered_agents`, `contents` / `content_*`, NanoClaw user/oauth tables, web_search providers, `llm_attempts`). One `DROP TABLE … CASCADE` per §11 §11.1.
- **Kept list:** 12 tables (`users`, `event_outbox`, `idempotency_cache`, `settings_kv`, `provider_oauth_states`, plus the `llm_*` / `workspace_provider_*` stack). `users` gets `display_name → name` rename + drops the NanoClaw-era role / is_active / preferred_web_search_provider_id columns. `llm_provider_models` gets `capabilities_json` + a unique index on `model_id` so the new `llm_models` VIEW can FK against it.
- **New:** 50 tables across §1 identity → §10 audit. 4 deferrable back-edge FKs for true cycles (`messages ↔ runs`, `improvement_runs ↔ document_versions`). 7 trigger functions (universal `tg_touch_updated_at`, 4 business triggers, 2 RLS helpers). RLS enabled on every workspace-owned table.
- **Detail:** [11-data-model.md](./11-data-model.md) is the canonical schema source.

---

## 9. The behavior in 30 seconds

- **A user sends a message in a Talk.** `/chat` writes a `messages` row (`author_kind='user'`), inserts one `runs` row per agent in the live roster (sharing a fresh `snapshot_group_id`), inserts `talk_agent_snapshots` rows for the freeze, enqueues each run onto `TALK_RUN_QUEUE`. The queue consumer atomically flips `status='queued'` → `'running'`, the executor reads `run_prompt_snapshots` (or assembles fresh) + the snapshot's frozen fields + `talk_tools` / connectors authorization + the conversation context, calls the LLM, writes the agent message + advances run state, and emits outbox events that the per-user `UserEventHub` DO streams to the browser.
- **A scheduled Job fires.** The 1-minute cron tick reads `jobs WHERE status='active' AND next_due_at <= now()` `FOR UPDATE SKIP LOCKED`. Per claimed job: single-flight check, fire-time dep check (agent in roster + model enabled + primary doc if `emit_document_append` + tools enabled + connector authorized), roster freeze, INSERT `runs` (`trigger='scheduler'`) + `run_prompt_snapshots` (prompt frozen at fire time), advance `next_due_at`, clear `claimed_at`, COMMIT. Dispatch outside the txn. Any dep failure flips `status='blocked'` + writes a `home_inbox_items.type='job_blocked'` row in the same txn. On run completion, the queue consumer emits `job_output_ready` keyed by `ref_id = run.id` (at-least-once dedup via partial unique).
- **A user runs Forge.** "Improve this doc" projects an `improvement_runs.objective_json` from the workspace's default `forge_audiences` row (G-09.P0.1 RESOLVED — per [`09` §15 Q1](./09-autonomous-content-improvement-prd.md)). The improvement-run executor seeds ~20% of personas as held-out, runs the beam search over `document_versions` (per iteration: mutate, score against in-pool personas via SSR MCP, score against held-out, pick winners). On completion, the winning version lands as a `document_edits` row with `source='forge'`, reviewed through the same accept path the agent edits use.
- **Home surfaces it.** The inbox carries `forge_run_needs_review` items; recommendations include `forge-suggestion` candidates; news matches feed via `home_news_topics` (workspace-scoped, privacy-structural — only `summary` + keywords/entities/source_domains) against the shared `home_news_items` pool.

For per-doc detail:

- Talks + messages + runs: [11 §3](./11-data-model.md) + [06 §3](./06-agent-system-design.md)
- Agents + prompt assembly: [06](./06-agent-system-design.md) + [03](./03-agents.md)
- Jobs: [12](./12-jobs.md) + [11 §8](./11-data-model.md)
- Documents + edits: [11 §5](./11-data-model.md) + [08 §6](./08-information-architecture.md)
- Forge: [09](./09-autonomous-content-improvement-prd.md) + [10](./10-forge-design-handoff.md) + [11 §9](./11-data-model.md)
- Home: [07](./07-homepage-system-design.md) + [11 §7](./11-data-model.md)
- API: [04](./04-api-contracts.md)
- Security: [SECURITY.md](./SECURITY.md)

---

## 10. Phasing — the build sequence

Detail in [05-build-plan.md](./05-build-plan.md). Summary table:

| Phase  | What                                                                                                                                          | Status                                                         |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **0**  | Project setup — commit to Workers/Hono/DO/Hyperdrive/Queues stack                                                                             | ✅ existing infra                                              |
| **1**  | Fresh Supabase baseline (`supabase/migrations/0001_clawtalk_greenfield.sql`) + `agent_role_templates` seed + first-signin workspace bootstrap | ✅ committed on `codex/clawtalk-greenfield-cutover`            |
| **2**  | Workspace switcher + auth                                                                                                                     | ✅ greenfield `/me`, workspace list, and switch routes mounted |
| **3**  | Folders + Talks CRUD + roster                                                                                                                 | ✅ folder/talk CRUD + roster read/write routes mounted         |
| **4**  | Chat → executor → queue consumer → outbox → DO streaming end-to-end                                                                           | 🔄 backend + chat mount committed; frontend integration next   |
| **5**  | Agents page + role templates + prompt assembly                                                                                                | ⏭️                                                             |
| **6**  | Per-Talk tool toggles + workspace-global connectors                                                                                           | ⏭️                                                             |
| **7**  | Documents + tabs + blocks + document_edits accept path                                                                                        | 🔄 compatibility accept/reject path committed; full docs UI next |
| **8**  | Context: URLs / files / past talks / rules / news binding                                                                                     | ⏭️                                                             |
| **9**  | Jobs: scheduler.ts single-txn claim + queue-consumer atomic claim + UI + inbox emit                                                           | ⏭️                                                             |
| **10** | Home: inbox + recommendations + news (deterministic generators first)                                                                         | ⏭️                                                             |
| **11** | Audit + analytics + reset/admin tools                                                                                                         | ⏭️                                                             |
| **12** | Polish, perf, dark mode                                                                                                                       | ⏭️                                                             |
| **13** | Offline agent eval gate (launch-blocking — see [eval-suite.md](./eval-suite.md))                                                              | ⏭️                                                             |
| **14** | Forge (post-MVP): improvement-run executor + SSR connector + gallery + winner-promote                                                         | ⏭️                                                             |

Each phase has explicit entry/exit criteria in §05.

---

## 11. What's locked, what's open

### Locked

- §11 schema (validated end-to-end via `supabase db reset --local`).
- §12 jobs spec + scheduler/executor contract.
- §04 API endpoints + WebSocket event list.
- §06 agent system + roster-vs-snapshot model + system-agent flow.
- §07 home (inbox + recs + news enums + ranking surfaces).
- §09 + §10 Forge (vocab aligned, scope mapping spec'd).
- §01 + §08 product spec + IA (connectors workspace-global, jobs in-scope).
- §05 build plan phase sequence.
- DECISIONS D0–D7.
- SECURITY model.
- 10 deferred design-debt items resolved (forge_audiences `is_default`, fitness shape, score scale, co-editor level, SSR freshness, etc.).

### Open

- Forge `forge_rewriter` + `forge_critic` system prompts — §06 §3.6 still has implementation placeholders; Joseph writes the production prompt text before Forge runtime work ships.
- API shell/resource decomposition — greenfield route modules and their Hono mount layer now cover `/me`, workspace/folders/talk CRUD, roster read/write, the legacy policy facade, talk tools, snapshot/detail/content/thread/document-edit compatibility, and chat enqueue/cancel. The next implementation slices should retire the remaining context/resource/jobs collisions before the frontend Talk rewrite.
- Phase 13 eval scenario content + grader prompts — [eval-suite.md](./eval-suite.md) locks the harness contract but defers scenario content.
- Per-page visual design for new surfaces — [02-visual-system.md](./02-visual-system.md) covers tokens but doesn't have component-level designs for Jobs UI, Forge gallery / run-detail / Audiences, home Forge surfacing, DocTabStrip.
- ~37 P2 polish items per [SPEC-READINESS.md](./SPEC-READINESS.md). None block impl.

### Tracked design debt

[SPEC-READINESS.md](./SPEC-READINESS.md) has every closed gap with a stable ID (G-XX.PY.Z) and resolution note. Future drift is catchable by re-running the same parallel verification pattern used in the 2026-05-30 spec-readiness pass.

---

## 12. Doc navigation map

| Concern                                                               | Owner doc(s)                                                                           |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Product behavior + screens                                            | [01-product-spec.md](./01-product-spec.md)                                             |
| Visual tokens + components                                            | [02-visual-system.md](./02-visual-system.md)                                           |
| 5 default agents' content (system prompts + methodologies)            | [03-agents.md](./03-agents.md)                                                         |
| REST + WebSocket API contracts                                        | [04-api-contracts.md](./04-api-contracts.md)                                           |
| Phased build sequence                                                 | [05-build-plan.md](./05-build-plan.md)                                                 |
| Agent runtime architecture (roles, snapshots, prompt assembly, evals) | [06-agent-system-design.md](./06-agent-system-design.md)                               |
| Home (Inbox + Recommendations + News + Ranking + Algorithms)          | [07-homepage-system-design.md](./07-homepage-system-design.md)                         |
| Information architecture + hierarchy invariants                       | [08-information-architecture.md](./08-information-architecture.md)                     |
| Forge PRD (what/why)                                                  | [09-autonomous-content-improvement-prd.md](./09-autonomous-content-improvement-prd.md) |
| Forge design handoff (how it looks)                                   | [10-forge-design-handoff.md](./10-forge-design-handoff.md)                             |
| **Canonical schema (every table, every constraint)**                  | **[11-data-model.md](./11-data-model.md)**                                             |
| Jobs feature (D6 redesign)                                            | [12-jobs.md](./12-jobs.md)                                                             |
| Decision log (D0–D7 + future)                                         | [DECISIONS.md](./DECISIONS.md)                                                         |
| Security model (auth + RLS + secrets + CSRF + audit)                  | [SECURITY.md](./SECURITY.md)                                                           |
| Phase 13 eval harness contract                                        | [eval-suite.md](./eval-suite.md)                                                       |
| Term reconciliation (shipped names ↔ canonical names)                 | [GLOSSARY.md](./GLOSSARY.md)                                                           |
| Current implementation audit + cutover recommendation                 | [IMPLEMENTATION-READINESS.md](./IMPLEMENTATION-READINESS.md)                           |
| Live implementation tracker                                           | [roadmap.md](./roadmap.md)                                                             |
| Doc-corpus precedence + reading order                                 | [README.md](./README.md)                                                               |
| Gap-closure history + tracker                                         | [SPEC-READINESS.md](./SPEC-READINESS.md)                                               |
| Durable engineering knowledge                                         | [engineering-notes.md](./engineering-notes.md)                                         |
| Retired ClawRocket-era docs (do not implement from these)             | [archive/](./archive/)                                                                 |

**Precedence on conflict:** [DECISIONS.md](./DECISIONS.md) wins over anything else. Then the schema (§11) wins on column-level questions. Then the IA (§08) wins on hierarchy questions. Then the canonical detail doc for that concern.

---

## 13. For the implementation reader

If you're about to write code, here's where to start by task type:

| Task                                                                           | Start here                                                                                                                                                                   |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Writing the `agent_role_templates` seed                                        | [03-agents.md](./03-agents.md) §2 (the 5 templates) + [11 §4](./11-data-model.md) (column shape) + the baseline seed path                                                    |
| Rewriting `src/clawtalk/talks/scheduler.ts` for v8 jobs                        | [12 §5](./12-jobs.md) (Path A single-txn claim + Path B sweep) + [11 §8](./11-data-model.md) (jobs table)                                                                    |
| Rewriting `src/clawtalk/talks/queue-consumer.ts`                               | [12 §5](./12-jobs.md) (atomic claim) + [11 §3](./11-data-model.md) (runs CHECK invariant + partial uniques)                                                                  |
| Rewriting the executor                                                         | [06 §7](./06-agent-system-design.md) (prompt assembly) + [11 §3](./11-data-model.md) (runs/messages/snapshots) + [12 §3](./12-jobs.md) (job output emit)                     |
| Writing accessors for the new schema                                           | [11 §12](./11-data-model.md) (RLS policy worked example + admin exceptions) — every accessor wraps `withUserContext`                                                         |
| Building the Jobs UI                                                           | [04 §18](./04-api-contracts.md) (Jobs endpoints) + [12 §6](./12-jobs.md) (lifecycle & surfacing)                                                                             |
| Building Forge surfaces                                                        | [04 §17](./04-api-contracts.md) (Forge endpoints) + [10](./10-forge-design-handoff.md) (visual handoff) + [09 §13](./09-autonomous-content-improvement-prd.md) (phased plan) |
| Building Home (Inbox / Recommendations / News)                                 | [07](./07-homepage-system-design.md) is huge; start with §6 (Inbox), §7 (Recommendations), §8 (News)                                                                         |
| Implementing RLS policies (greenfield baseline applies the canonical patterns) | [11 §12.1](./11-data-model.md) (canonical pattern) + [11 §12.2](./11-data-model.md) (admin exceptions)                                                                       |
| Writing §14 verification tests                                                 | [11 §14](./11-data-model.md) (24 invariants with expected-failure cases)                                                                                                     |
| Writing eval-gate scenarios                                                    | [eval-suite.md](./eval-suite.md) (harness contract) + [03-agents.md](./03-agents.md) (role rubric) + [06 §14.6](./06-agent-system-design.md) (`AgentAuditResult`)            |
| Frontend onboarding                                                            | [01](./01-product-spec.md) + the prototype (`ClawTalk Salon.html`) + [02](./02-visual-system.md)                                                                             |
| Auth / RLS / secret-store work                                                 | [SECURITY.md](./SECURITY.md) + [11 §12](./11-data-model.md) + `src/clawtalk/identity/` + `src/clawtalk/llm/provider-secret-store.ts`                                         |

---

## 14. Cutover risk: the moment the baseline lands

> **Status (2026-05-30):** Confirmed empirically twice. PR #502 attempted to land the schema as a destructive `0039_clawtalk_greenfield.sql`; CI ran and **38/38 accessor tests + 21/30 google-drive tests failed** because they target the dropped legacy tables. A fresh local audit against the current worktree reproduced the same class of failures: backend tests still query `talks.owner_id`, `users.role`, and `registered_agents` while the DB shape has moved on. PR #502 was closed; PR #507 parked the SQL at [`docs/canonical-greenfield-migration.sql`](./canonical-greenfield-migration.sql). The current cutover branch has promoted that reference into the active fresh baseline and is intentionally expected to keep legacy source tests red until the src/webapp rewrite catches up.

The active greenfield baseline is a **reset**, not a compatibility migration. The moment it lands on `main`:

1. **The old Supabase migration stream is no longer active.** The implementation branch resets/recreates the database and applies `0001_clawtalk_greenfield.sql` from zero.
2. **All legacy product tables are absent from the final schema** (`talk_runs`, `talk_messages`, `talk_threads`, `talk_jobs`, `registered_agents`, `contents`, `content_edits`, `content_proposals`, NanoClaw user/oauth tables, etc.).
3. **Local/staging data is wiped.** Per CLAUDE.md and D0, this is by design — Joseph is the only user and the data is dogfood. Joseph re-OAuths Google / Anthropic / Forge SSR providers after the reset.
4. **Existing `src/` code that references the legacy tables CRASHES IMMEDIATELY.** Every accessor in `src/clawtalk/db/*` that targets `talk_runs` / `talk_messages` / `registered_agents` / `contents` / `content_edits` will throw on first call. Every route in `src/clawtalk/web/routes/*` that depends on those accessors will return 500s.
5. **The webapp breaks.** Every page that fetches from the broken routes will fall back to error states.

This is why [SPEC-READINESS.md](./SPEC-READINESS.md) flags **cutover sequencing plan** as the one remaining design-shaped item. Two paths:

- **Big-bang cutover.** One coordinated branch that lands the fresh baseline + every src/ + webapp/ rewrite + the seed before merging. Maximum churn, single transition window, simplest mental model. Joseph has zero downstream users; downtime is "ClawTalk doesn't work while the branch is mid-cutover."
- **Feature-flag cutover.** Branch the code paths behind `CT_GREENFIELD` (or similar). Old paths read the legacy tables, new paths read the greenfield tables. Migrate per Phase. Higher complexity (dual-path code; runtime forks; double the test surface) for the benefit of "the prod webapp keeps working for the human while I'm migrating."

**Recommendation:** use the big-bang cutover branch. The codebase is too schema-entangled for a clean dual-path flag, and D0 makes dogfood data disposable. **The active implementation now creates `supabase/migrations/0001_clawtalk_greenfield.sql`, resets/recreates Supabase, and removes or archives the old active migration stream.** See [IMPLEMENTATION-READINESS.md](./IMPLEMENTATION-READINESS.md).

---

## 15. Glossary of the most-confused terms

- **Talk** — a context-bound conversation in a workspace. Has a roster, rounds, messages, runs, and 0-or-1 primary Document.
- **Round** — a single turn of the multi-agent loop within a Talk. Messages and runs carry `round int`.
- **Run** — one agent's response within a round. Has a frozen roster snapshot (`snapshot_group_id`), an acting agent (`agent_snapshot_id`), a trigger (`user` / `scheduler` / `manual`), and either a triggering user message (`trigger_message_id`) or a prompt snapshot (`prompt_snapshot_id`).
- **Document** — the long-form editable artifact attached to a Talk (`primary_talk_id`). Composed of `doc_tabs` (≥1) → `doc_blocks` (paragraphs).
- **Tab** — a section within a Document. Co-editors are scoped per-tab (`doc_tab_coeditors`), not per-document.
- **Pending edit** — a `document_edits` row in `status='pending'`. Source can be `agent` (chat agent proposed), `forge` (winner promotion from an improvement run), or `job` (scheduled run output).
- **Job** — a saved scheduled run: prompt + agent + schedule. Fires through the normal run pipeline (`trigger='scheduler'`). NOT a parallel execution path.
- **Forge** — autonomous content-improvement loop. NOT the same as the agent prompt-improvement loop in §06 §14.
- **Snapshot group** — a set of `talk_agent_snapshots` rows sharing a `snapshot_group_id`. Captures the live roster at a point in time so future edits don't rewrite history.
- **Workspace member** — a user in `workspace_members` with a role (`owner` / `admin` / `member` / `guest`). RLS evaluates membership, not ownership.
- **Connector** — a workspace-level OAuth binding to an external service (Slack, GDrive, Gmail, Linear, GitHub, Notion). `connector_secrets` holds the encrypted token. NOT the same as a tool — tools authorize ON the binding.
- **Tool** — what an agent can DO (web search, gdrive_read, gmail_send, etc.). Per-Talk toggles (`talk_tools`). A tool may depend on a connector being authorized.
- **Inbox item** — a Home-surface notification (`home_inbox_items`). 12 canonical types including `job_output_ready`, `job_blocked`, `forge_run_needs_review`.
- **Audience** (Forge) — a saved persona set + reference set + question. The default audience is auto-selected when "Improve this doc" runs without an explicit objective.

Full term reconciliation: [GLOSSARY.md](./GLOSSARY.md).

---

## 16. Where this overview started → where it's going

The clawtalk repo dogfooded a multi-agent reasoning product through the NanoClaw / chassis / Phase 5 era. The shipped schema proved out the agent-room concept, the LLM-orchestration pipeline, the Workers + DO + Queues runtime, and the OAuth / cookie / CSRF auth model. Those proven pieces are what's kept.

But the schema couldn't bear weight beyond what it proved: per-user RLS, threads everywhere, the `contents` / `registered_agents` vocabulary, jobs-as-messages, no tenancy. Two design rebuilds (v7 → v8 jobs spec; the 11-data-model greenfield) and one spec-readiness close pass (~38 P0 + ~72 P1 gaps closed) brought the design to the point where the rebuild is writable from spec.

The schema reference has now been promoted into the active cutover branch, and the first backend runtime spine is committed through greenfield workspace/talk routes, API mount extraction, chat enqueue, queue consumption, execution, scheduler sweeps, and run-state hardening. The next milestones are:

1. **Retire remaining legacy route/accessor collisions one family at a time.**
2. **Port context/resources and jobs to greenfield contracts.**
3. **Keep `worker-app.ts` as public/auth/health/WebSocket glue rather than product-resource logic.**
4. **Start the frontend shell and Talk rewrite once the backend API no longer depends on legacy table families for core Talk workflows.**

When this is done, ClawTalk has a multi-tenant, jobs-aware, Forge-ready, Home-driven, eval-gated, RLS-enforced architecture that the shipped prototype could never have grown into incrementally. That's the bet of this refactor.
