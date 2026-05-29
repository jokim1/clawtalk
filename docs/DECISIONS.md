# ClawTalk — Decision Log

> **Status:** canonical · **Last updated:** 2026-05-28
> Records resolved cross-cutting decisions so docs and agents don't relitigate them. When a doc conflicts with a decision here, this log wins. See [DOC-AUDIT.md](./DOC-AUDIT.md) for the issues that prompted them.

---

## D1 — Tech stack: Cloudflare Workers (P0 #1) — ✅ Decided

**Decision.** The canonical runtime is **Cloudflare Workers + Hono + Durable Objects + Hyperdrive + Cloudflare Queues**, with **Supabase Postgres**. This is what the repo already runs (`CLAUDE.md`, `src/worker.ts`, `wrangler.toml`).

**Rejected.** The Next.js + Node + Redis + BullMQ/Sidekiq stack recommended by `README.md`, `05-build-plan.md` Phase 0, and the archived `CLAWTALK_V2_REBUILD_PLAN.md`. No platform migration. The archived `CLAWTALK_V2_REBUILD_PLAN_REVIEW.md` reached the same conclusion against the real codebase.

**Follow-ups.** Fix `README.md` §tech-stack; fix `05-build-plan.md` Phase 0 ("Provision Redis…") and its Risk register ("Use BullMQ/Sidekiq"); there is no Redis — run queues are CF Queues, websocket pub/sub is the `UserEventHub` Durable Object. Streaming transport is **WebSocket** (not SSE) — drop the SSE hedge in `04-api-contracts.md` §0.

---

## D2 — Target model: adopt the canonical spec, migrate from the shipped schema (P0 #3a) — ✅ Decided

**Decision.** The **canonical target is the `01`/`08` model**, and we will **migrate the codebase toward it** (not align docs down to the current schema). The target hierarchy is:

> **Workspace → Folder (optional) → Talk + Document (optional)**, multi-workspace, **no Threads.**

The live schema (user-owned talks, `talk_threads`, `contents`) is the **migration source**, not the destination. This reverses the earlier provisional "orient to shipped names" lean — on review, Joseph chose to move the product toward the spec model.

**Structural deltas this commits us to** (current → target):

| Concept | Live schema today | Target | Tracked by |
|---|---|---|---|
| Tenancy | user-owned (`talks.owner_id`), no `workspaces` table | **multi-workspace** (`workspaces` + `workspace_members`; talks scoped by workspace) | D5 below |
| Threads | `talk_threads` load-bearing; `contents` attach via threads | **removed**; Document attaches to Talk directly | D4 below |
| Grouping | `talk_folders` | `folders` under a workspace | D5 |
| Scheduled jobs | `talk_jobs` + scheduler built | review + redefine cleanly | D6 below |

**Naming (contents→documents, registered_agents→agents, talk_folders→folders).** Adopt the spec names as the **target** vocabulary; the [GLOSSARY](./GLOSSARY.md) holds the mapping during the transition. Exact table renames are a migration-design detail to settle when each refactor is planned — not a blocker now.

**Follow-ups.** This is a multi-step migration; sequence it (likely: workspaces layer → threads removal → naming) and write a migration plan before touching schema. `09` Forge stays buildable on whichever artifact table exists at the time.

---

## D4 — Remove the Threads concept (refactor) — ✅ Decided, ⏳ not yet planned

**Decision.** Remove Threads. New attachment model: **Talk + optional Document**, no intervening thread. Per `01` §1.4.

**Reality check (why this is a refactor, not a cleanup).** `talk_threads` has ~46 references in `src/`, and the **Content feature attaches `contents` via `talk_threads`** (RLS on contents joins through the thread). Removing threads means reworking the contents↔talk attachment + its RLS. Needs its own plan; don't start ad hoc.

---

## D5 — Shift personal → multi-workspace — ✅ Decided, ⏳ not yet planned

**Decision.** Build the **Workspace** tenant layer from `01` §1.1 / `08` §3.1: `workspaces` + `workspace_members` (owner/admin/member), with talks/folders/documents/agents scoped by `workspace_id`. Today there is no `workspaces` table; talks are user-owned. Migration: introduce workspaces, backfill a default workspace per user, rescope existing rows.

---

## D6 — Jobs: review & redefine — ⏳ Open (needs a definition pass)

**Decision.** Scheduled jobs stay (the `talk_jobs` table + scheduler + `job-accessors` are built and `roadmap.md` #7 is active), **but** the model isn't well understood and needs a review + clean definition before further work — including the open roadmap #7 question of whether jobs post into a Talk thread or append to a Document via the content path. **Next action:** a jobs review (how `talk_jobs`/`scheduler.ts`/`job-accessors` work today → a proposed clean spec). Until then, treat `01` §8's "out of scope" as stale.

---

## D3 — Forge agent roles: built-in system agents (P0 #3b) — ✅ Decided

**Decision.** Forge's **rewriter** and **critic** are **built-in system agents** stored in `registered_agents`, flagged so they are **not shown in the normal workspace roster** and **not user-editable**. Forge invokes them internally via the existing `executeWithAgent` path.

**Rejected.** (a) Reusing the user-facing Critic — couples Forge to a user-editable agent. (b) Making them first-class roster agents — expands the user-facing agent set and editable-fields surface for no benefit.

**Follow-ups.** Define the "system agent" flag + filter in `06-agent-system-design.md`; specify the rewriter/critic prompts; ensure they're excluded from the Agents page and `GET /agents`.

---

## How to use this log

- New cross-cutting decisions get an entry (`D<n>`), a status (✅ Decided / 🟡 Provisional / ⏳ Open), and follow-ups.
- Reference decisions by ID from other docs (e.g. "stack per DECISIONS D1").
- When D2 is finalized, apply the rename/alignment edits and update the canonical docs' status banners.
