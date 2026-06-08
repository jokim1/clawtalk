# ClawTalk Refactor — Full Completion Audit

> **Status:** live audit snapshot updated 2026-06-08 for the Phase 5 native Documents API unblocker, MVP dry-run CI eval gate, first duplicate-route de-facade deletion, and Home P2 hardening.
> **Purpose:** answer how much of the greenfield refactor is actually complete, what remains, and how to improve the plan so Codex + Claude/Opus can execute with minimal human interruption.
> **Method:** second-pass audit against current main after PR #541, with later Phase 5 backend/eval evidence folded into the live status rows.

---

## 0. TL;DR

The backend/data cutover is real. The product refactor is not done.

| Layer | Done | Evidence |
|---|---|---|
| Backend / data cutover | ~90% ✅ | Greenfield is the only live runtime. Legacy runtime/accessors were retired, and backend CI is a signal again. Remaining backend work is mainly facade deletion, Home lifecycle gaps, and Forge. |
| Frontend structural decomposition | ~70% ✅ | `TalkDetailPage.tsx` is 1,429 LOC and `SettingsPage.tsx` is 1,066 LOC. Talk shell/render surface and page-owned controllers are extracted alongside Settings Profile/Tools/OAuth panels; remaining frontend work is product surfaces, Salon migration, and native facade consumers, not god-file decomposition. |
| De-facade | ~5% 🔄 | The dead duplicate `worker-app.ts` Hono mounts for sidebar reorder and run-context were deleted; remaining compat facades still serve live consumers: synthetic threads, runs-with-`threadId`, flat content markdown/html, snapshot compat, policy/tool/connectors facades, run-context synthesis, and the attachments guard. |
| Visual system (Salon) | Foundation + shell shipped 🔄 | Salon foundation shipped in PR #547: `webapp/src/salon/*` CSS-variable tokens (`--salon-*`), fonts (Newsreader/Geist/Geist Mono), brand mark, and the primitive library (CTMark/CTIcon/Avatar/AgentAvatar/RunPill/Chip/Kbd/Button/Input/Modal/Sheet/Popover) with behavior-preserving proof migrations + a smoke suite. Surfaces re-skinned (PR #550): Home, Archive, Registered Agents + agent profile, the Talks list page, and the sign-in surface — each off its legacy classes with dead `styles.css` rules trimmed + a responsive Playwright spec. App shell shipped (PR #550): the prototype 3-column icon-rail (`webapp/src/components/shell/`: `IconRail` + `SecondaryList` + `RailProfileMenu`) replacing `ClawTalkSidebar`/`WorkspaceSwitcher`/`SidebarProfileMenu` + the `App.tsx` header; talk CRUD/DnD/⌘K preserved, desktop collapse + mobile drawer, ~550 LOC dead CSS removed. Contrast fixed: `--salon-accent-strong` `#b05530` (≈ 5.0:1 on white) backs text-bearing primary buttons. Remaining: `TalkDetailPage`/`SettingsPage`-owned CSS. |
| Net-new product surfaces | ~25% 🔄 | Live app covers Talk list, Talk detail, Settings, and Salon-native Home (read API + write lifecycle), New Talk sheet, ⌘K command palette, Registered Agents panel + standalone agent profile, and Archive (all PR #550), plus the native Documents UI — `/app/documents` index + `/app/documents/:id` viewer + pending-edit accept/reject console (PR #557). Home P2 hardening routes `open_document_edit` to native Documents, keeps optimistic summary/curator state coherent, and returns 403 for guest lifecycle writes. Native Documents backend routes/client methods exist (PR #552). Forge remains post-MVP. |
| Eval gate | ~40% 🔄 | `eval/` exists with six launch-critical dry-run scenarios, deterministic fixtures, grader prompt contracts, harness tests, and `npm run eval`; PR CI now runs the deterministic dry-run gate, while live backend/provider grading is still unwired. |

The biggest missing work is Talk/Settings Salon completion, in-Talk native Documents, remaining Home lifecycle actions, de-facade, live eval hardening, and final surface completion. Forge remains post-MVP.

---

## 1. What "fully refactored" Means

V2 is defined by:

- Canonical docs `docs/01` through `docs/12`.
- The Salon visual system in `docs/02-visual-system.md`.
- The reference prototype at `docs/prototypes/ClawTalk Salon.html`, `docs/prototypes/prototype/*.jsx`, and `docs/prototypes/shared/data.jsx`.
- The greenfield schema at `supabase/migrations/0001_clawtalk_greenfield.sql`.

The full surface area is roughly:

- ~22 user-reachable surfaces: Sign-in, Home, Talk list/sidebar, Talk detail, Talk+doc pane, Agents, Agent profile, Documents, Document editor, Settings subpanels, Archive, workspace switcher, New Talk sheet, command palette, dialogs, Forge, and admin/audit surfaces.
- ~12 feature areas: talks, agents, documents, jobs, Home, connectors, tools, context, settings/BYOK, workspaces/identity, evals, Forge.
- Cross-cutting mandates: Salon, density, eval gate, workspace RLS, provider abstraction, performance, accessibility, mobile, dark mode decision, audit/security, and de-facade.

The current refactor plan is a subset of that denominator. It must be explicit about which parts are MVP and which are post-MVP.

---

## 2. Status by Roadmap Step

| Step | Title | Status |
|---|---|---|
| 1 | Cutover foundation | ✅ Done |
| 2 | Greenfield route/accessor spine | ✅ Done |
| 3 | Execution backend | ✅ Done |
| 4 | API shell cleanup / legacy retirement | ✅ Done |
| 5 | Frontend shell + Talk rewrite | ✅ Structural target met. TalkDetailPage shell/render surface and page-owned controllers are extracted below the roadmap LOC target; Salon migration and product-surface work remain separate lanes. |
| 6 | Documents | 🔄 Native backend API/client path exists for list/detail tabs+blocks+pending edits and edit accept/reject; standalone Documents UI (index + viewer + edit-review console) shipped (PR #557). Remaining: in-Talk doc pane (deferred behind TalkDetail refactor #549). |
| 7 | Agents/tools/connectors/context | 🔄 Backend mostly greenfield behind facades; frontend still consumes compat shapes; standalone Agents page not built. |
| 8 | Jobs | 🔄 Backend and Talk Jobs panel mostly usable. PR #552 added `emit_document_append` and `job_output_ready` inbox/outbox production; DB-backed verification remains. |
| 9 | Home, Settings, polish, eval gate | 🔄 Eval dry-run harness + CI gate shipped (PR #553); Salon foundation + shell + Home shipped (PR #547/#550); Home P2 hardening fixed native Documents deep links, optimistic curator sync, and guest-writer 403s; Settings structural extraction complete for Profile, Tools/Google/WebSearch, and provider OAuth (PR #548); product gaps remain. |
| 10 | Forge | ⛔ Schema/docs only, intentionally post-MVP. |

---

## 3. Backend / Data Layer

The cutover is comprehensive enough to build on:

- `queue-consumer.ts` runs the greenfield executor.
- The retired executor path fails closed with `LEGACY_EXECUTOR_RETIRED`.
- Core routes, chat enqueue, scheduler, context compatibility, connector/tool compatibility, and jobs compatibility are on greenfield tables.

### 3a. Compat-facade Inventory

Each facade should get a deletion ticket with owner, consumers, native replacement, and deletion test.
The current readiness ledger and grep script live in [DE-FACADE-READINESS.md](DE-FACADE-READINESS.md) and `scripts/de-facade-readiness.sh`.

| # | Facade | Current role | Native replacement |
|---|---|---|---|
| 1 | Synthetic threads | `threadId` is fabricated even though the schema has no threads. | Frontend treats Talk as the conversation and drops `threadId`. |
| 2 | Runs/messages with `threadId` | DTO compatibility for old reducers/hooks. | Native run/message DTOs using `responseGroupId`, `round`, and run ids. |
| 3 | Content markdown/html | Native document blocks are flattened to `{ bodyMarkdown, bodyHtml }`. | Block editor on `documents`/`doc_tabs`/`doc_blocks`. |
| 4 | Snapshot compat | `snapshotVersion` is an outbox high-water, not a native version. | Native per-talk hydration contract. |
| 5 | Channels/data-connectors split | Old surfaces map onto final `connectors` tables. | Single connectors/bindings surface. |
| 6 | Talk tools light-family API | Light families map onto canonical `talk_tools.tool_id`. | Per-tool toggles. |
| 7 | Policy facade | Derived from `talk_agents`; no policy table exists. | Native roster and run settings. |
| 8 | Run-context synthesis | Fabricates legacy manifest with `threadId`. | Native run context without thread fields. |
| 9 | Attachments guard | Routes return `attachments_not_available`. | Future R2-backed chat attachments, if v1 needs them. |

The first duplicate route cleanup is complete: `reorderGreenfieldTalkSidebarRoute` and `getGreenfieldRunContextRoute` now mount only through `mountGreenfieldApiRoutes(app)` in `greenfield-api.ts`. The dead direct `worker-app.ts` registrations were removed in the Phase 5 duplicate Hono deletion lane.

### 3b. Phase 5 De-facade Deletion Ledger

Repeatable audit command: `node scripts/audit-facade-consumers.mjs`. The command prints the exact `rg` commands for five modalities: literal token grep, import/re-export trace, route registration trace, test fixture/assertion trace, and dynamic/string-key/cache-router trace.

Current branch counts below are matching-line counts for those modalities in that order.

| Facade | Counts | Current consumers | Native replacement | Deletion preconditions | Status |
|---|---:|---|---|---|---|
| Synthetic `threadId` | 376 / 64 / 90 / 221 / 569 | Backend snapshot/content compatibility plus frontend Talk snapshot, stream, reducer, URL/cache keys, sidebar/thread surfaces. | Treat Talk as the conversation boundary; native hydration/messages/runs drop thread identity. | Frontend URL/cache/reducer/stream contracts no longer read or emit `threadId`; route tests cover native Talk-only hydration. | Blocked |
| Runs/messages `threadId` DTO fields | 642 / 232 / 100 / 343 / 85 | `TalkMessage`/`TalkRun` DTOs, reducers, stream hook, snapshot and tests still carry `threadId` and response-group compatibility. | Native run/message DTOs keyed by run id, response group, round, and message id. | Client DTO types, stream reducer, snapshot tests, and backend serializers stop exposing `threadId`. | Blocked |
| Run-context fabrication | 44 / 26 / 7 / 18 / 24 | Run context route and UI panel still consume fabricated context snapshots and manifest fields. | Native run-context contract without synthetic thread fields. | UI consumes native context shape; tests assert native fields and no synthetic thread manifest. | Blocked |
| Flat content projections `bodyMarkdown`/`bodyHtml` | 119 / 141 / 59 / 106 / 344 | Content routes, exports, editor surfaces, pending edits, and tests still use flattened markdown/html projections. | Native Documents tabs/blocks/pending edits over `documents`, `doc_tabs`, `doc_blocks`, and `document_edits`. | Documents UI/editor and in-Talk doc pane consume block APIs; export/editor tests cover native blocks. | Blocked |
| `snapshotVersion` compat | 30 / 69 / 11 / 6 / 107 | Snapshot accessor, cache router, outbox delta handling, and frontend snapshot keys still use version compatibility. | Native per-talk hydration and event high-water contract. | Cache/router/hydration tests cover native high-water semantics without `snapshotVersion`. | Blocked |
| Policy facade | 30 / 12 / 24 / 22 / 98 | Talk policy route/payload, settings panels, and tests still map policy onto `talk_agents`. | Native roster/run settings API. | UI uses roster/run settings directly; policy route tests are replaced by native roster tests. | Blocked |
| Tool/connectors facades | 122 / 211 / 53 / 105 / 533 | Settings connectors, workspace channels/data connectors, talk tool-family APIs, cache events, and tests still consume split compatibility surfaces. | Single canonical connectors/bindings/tool toggles surface. | Settings and Talk tools consume canonical connectors/tool ids; cache events and tests stop referencing compatibility families. | Blocked |
| Duplicate Hono mounts | 10 / 7 / 22 / 14 / 21 | Remaining references are native `greenfield-api.ts` route registrations, route handlers, imports, focused mount tests, and expected greenfield module imports. | Single mount path through `mountGreenfieldApiRoutes(app)`. | Direct `worker-app.ts` imports and route registrations are absent; sidebar reorder and run-context still resolve through the native mount. | Deleted |
| `attachments_not_available` guard | 31 / 23 / 18 / 37 / 68 | Attachment routes, storage caps, guards, UI pending attachment state, and tests still reference the unavailable guard. | R2-backed chat attachments, or explicit v1 no-attachments product decision with dead UI removed. | Native attachment implementation exists, or product decision removes attachment affordances and guard tests. | Blocked |

### 3c. Net-new Backends

- Home native read/write routes and the Salon Home UI are live for summary, inbox, recommendations, news, inbox dismiss/snooze, and recommendation dismiss. Remaining lifecycle gaps are inbox mark-read/resolve and news add-to-context/snooze; Home P2 hardening now returns 403 for guest lifecycle writes instead of RLS-shaped 404s.
- Native Documents routes/client methods and the standalone Documents UI now expose list/detail tabs, blocks, pending edits, and accept/reject over `documents`/`doc_tabs`/`doc_blocks`/`document_edits`. The in-Talk doc pane still needs to consume that native path before flat compat content can be deleted.
- Forge tables exist, but runtime and UI are intentionally post-MVP.

### 3d. Provisioned-but-unused Schema

The unused table set is mostly intentional schema waiting for surfaces: Forge, `activity_events`, `audit_events`, `agent_feedback_events`, `talk_reads`, and `doc_tab_coeditors`. Treat this as pending product work, not dead schema, until the MVP line is reset.

---

## 4. Frontend Structure

### 4a. God Files

- `TalkDetailPage.tsx`: 1,429 LOC. Panels, composer, thread view, reducer, stream hook, Talk tab shell/render surface, and page-owned controllers are extracted into focused components/hooks. Async mutation and stream state stay page-owned while controller/view-model bulk lives outside the page.
- `SettingsPage.tsx`: 1,066 LOC. Provider config, connectors, AI agents, Profile, Tools/Google/WebSearch, and provider OAuth state are extracted.
- `TalkLlmSettingsCard.tsx`: deleted after a repo-wide importer grep proved it had zero live consumers.

### 4b. De-facade Consumers

`threadId` still appears across `TalkDetailPage.tsx`, `useTalkRunStream.ts`, `talkRunReducer.ts`, `api.ts`, `useTalkSnapshot.ts`, `talkStream.ts`, and `wsCacheRouter.ts`. Native document blocks are not consumed by the frontend. This work is structural and behavioral, so it should be goal-scoped by facade, not attempted as one large rewrite.

### 4c. Missing Surfaces

- Home is a Salon-native surface over the native Home API; remaining actions are inbox mark-read/resolve and news add-to-context/snooze.
- Standalone Documents index/detail/edit-review is live; the in-Talk doc pane still uses the older compatibility path.
- Registered Agents and standalone agent profile are live; remaining agent work is native facade-consumer cleanup and product polish.
- Archive, New Talk sheet, and command palette are production surfaces; remaining net-new scope is workspace-member management and Forge (post-MVP).

---

## 5. Visual System (Salon)

Salon was a product-defining gap. The **foundation landed in PR #547** (lane S): a CSS-variable system + primitive library under `webapp/src/salon/`, with behavior-preserving proof migrations and a `salon.test.tsx` smoke suite. The remaining Salon work is the broad re-skin of the 7,284 LOC pre-Salon `webapp/src/styles.css`, plus building the net-new surfaces Salon-native from the start.

| Marker in `webapp/src` | Before | After PR #547 |
|---|---|---|
| `--salon-*` tokens | 0 | defined in `salon/salon.css` + `salon/tokens.ts` |
| `#FBF7EF` / `#C8643A` / `#1F1B16` | 0 | canonical palette tokens defined |
| `Newsreader` / `Geist` / `Geist Mono` | 0 | wired via `<link>` in `index.html` |

The webapp uses CSS variables + the existing Vite pipeline (no Tailwind, per §9). The reference prototype (Tailwind CDN + Babel-in-browser) was ported, not copied.

Recommendation: default to CSS variables and the existing Vite CSS pipeline. Add Tailwind only if Joseph explicitly decides speed-to-port matters more than keeping the production stack small.

Salon should be first-class before Home/Documents/Agents, otherwise those surfaces will be built twice.

---

## 6. Remaining Work Breakdown

### W1. Structural Cleanup

- Extract Talk tab shell and controller hooks from `TalkDetailPage.tsx`.
- Settings Profile, Tools/Google/WebSearch, and provider OAuth extraction is complete; only future product settings gaps remain.
- Keep async mutation state page-owned when panels unmount.

### W2. Salon Foundation

- Tokens, fonts, brand mark, primitives, motion, density.
- Re-skin existing shell/Talk/Settings enough that net-new surfaces can be built Salon-native.

### W3. Native Documents

- Native Documents API/client path exists for list/detail tabs+blocks+pending edits and accept/reject.
- Standalone Documents page and native viewer/edit-review console are live.
- Remaining: in-Talk doc pane over native tabs/blocks.
- Pending edit accept/reject UX exists in standalone Documents; full authoring editor remains future work.
- Delete flat content facade after the final consumer moves.

### W4. Home

- Accessors/routes for summary, inbox, recommendations, news, and current lifecycle actions are live.
- Home page is built in Salon.
- Home P2 hardening complete: `open_document_edit` routes to native Documents, optimistic dismiss/snooze keeps summary/curator/hero state coherent, and guest lifecycle writes return 403.
- Remaining: inbox mark-read/resolve, news add-to-context/snooze, and any deeper `job_blocked`/`job_output_ready` product workflows.

### W5. De-facade

- One facade at a time, with a deletion ledger.
- Remove duplicate route registrations as part of the relevant route cleanup.
- Delete tests that only prove compatibility behavior after native tests cover the new shape.

### W6. Eval Gate

- Implemented MVP dry-run: `eval/`, scenario files, deterministic fixtures, grader prompt contracts, harness CLI, thresholds, and `npm run eval`.
- PR CI now runs `npm run eval` as a deterministic dry-run gate after root typecheck.
- Remaining: live Worker/workspace fixture execution, evaluator-model adapter, persisted real-run JSON, and launch threshold policy for provider-backed grading.
- Treat the live gate as launch-blocking before anyone beyond Joseph uses the app.

### W7. Capability Gaps

- Attachments are a known regression. Default is defer for v1 unless chat-upload multimodal becomes launch-critical.
- Jobs `emit_document_append` and `job_output_ready` producer paths are implemented; DB-backed verification and deeper Home product workflows remain.
- Non-Google connector OAuth UI remains incomplete.
- Dark mode and full WCAG pass need explicit goals after light Salon exists.

### Post-MVP. Forge

Keep Forge schema/docs. Build UI/runtime behind a feature flag after the core MVP is complete.

---

## 7. Phasing Review

Current phasing should change from "finish decomposition, then build product" to a parallel lane model:

```text
Docs drift cleanup
        |
        v
Salon foundation --------> Home UI
        |                    ^
        v                    |
Native Documents ------> De-facade
        ^                    |
        |                    v
Structural cleanup ----> Facade deletion

Eval gate runs in parallel once Talk execution is stable enough to drive scenarios.
Forge stays post-MVP.
```

Why: Home/Documents/Agents should not be built pre-Salon and then re-skinned. But structural cleanup and backend facade deletion can run in parallel as long as worktrees do not edit the same files.

---

## 8. Autonomous Execution Improvements

### 8a. Use `/goal` as the Unit of Work

Every Codex and Claude/Opus run begins with one scoped `/goal`. `/goal` is a real Claude Code command: after every turn a fast model checks a completion condition by reading **only the conversation** (it runs no commands and cannot see inside subagents), so the condition must be something the agent **proves in the transcript**. The full protocol — the `/effort ultracode` + auto-mode + `/goal` trifecta, the transcript-checkable Done-when rule, the turn bound, and orchestration — lives in [PHASE5-AUTONOMOUS-PLAN.md §2](PHASE5-AUTONOMOUS-PLAN.md). The packet shape:

```text
/goal
Objective: one concrete outcome.
Scope: the exact files/modules the agent may edit.
Non-goals: nearby work explicitly out of scope.
Done-when (transcript-checkable): ONE end state the after-every-turn evaluator can confirm from the conversation — commands the agent RUNS and whose output it PASTES (typecheck/test/build exit 0, file paths, passing test names, rg counts, `gh run` conclusion). End with "or stop after N turns and hand off." Subjective/visual sign-off is NOT here — it belongs to the milestone human gate.
Orchestration: how to fan out, if at all; single-agent if linear.
Human gate: none, or one named decision needed from Joseph.
Handoff: what to update before marking complete.
```

This prevents drift, makes "done" machine-auditable by the `/goal` evaluator, and lets each agent finish without per-slice approvals.

### 8b. Default Product Calls to Avoid Interrupts

- Salon tooling: CSS variables by default.
- Attachments: defer unless v1 requires multimodal chat upload.
- Forge: post-MVP.
- Dark mode: after light Salon.
- Mobile/accessibility: responsive no-overlap + keyboard basics now; full WCAG later.

### 8c. Add Mechanical Drift Checks

Before finishing any docs/planning PR, run greps for:

- old Talk/Settings LOC counts from pre-PR #541 planning docs.
- stale cutover-era CI-bypass language and old cutover-runbook references.
- archived readiness, handoff, and audit filenames in live orientation docs.
- eval hardening signals: CI-gated dry-run `eval/`, missing live provider/backend adapter, and no launch threshold policy for provider-backed grading.
- facade consumers: `threadId`, flat content fields, duplicate route mounts.

### 8d. Keep Live Docs Small

Current implementation state should live in only three places:

- `REFACTOR-AUDIT.md` for audited state and gaps.
- `roadmap.md` for the current execution sequence.
- `PHASE5-AUTONOMOUS-PLAN.md` for the `/goal` protocol, lane split, and copy/paste Codex + Claude/Opus phase prompts.

Archived handoffs and historical audits should stay archived.

---

## 9. Outstanding Decisions

| Decision | Recommendation |
|---|---|
| Salon tooling | CSS variables unless Joseph overrides. |
| Message attachments | Defer from v1 unless chat uploads are launch-critical. |
| Dark mode | Defer until light Salon exists. |
| Accessibility/mobile | Set a v1 bar now, full WCAG later. |
| Eval ownership | Codex primary, Claude/Opus review. Start before final surface polish. |
| Forge timing | Keep post-MVP. |

---

## 10. Reviewer Checklist

Challenge these points before starting implementation:

1. Is the MVP denominator right: Salon + Home + Documents + de-facade + eval, Forge later?
2. Is CSS-variable Salon acceptable, or should Tailwind be adopted for prototype port speed?
3. Is deferring chat attachments acceptable for v1?
4. Does each facade have a clear native replacement and deletion test?
5. Are the `/goal` packets strict enough to let agents work autonomously without hiding risk?
