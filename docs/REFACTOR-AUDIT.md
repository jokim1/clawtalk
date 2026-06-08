# ClawTalk Refactor — Full Completion Audit

> **Status:** live audit snapshot updated 2026-06-08 for the Phase 5 native Documents API unblocker and MVP dry-run CI eval gate.
> **Purpose:** answer how much of the greenfield refactor is actually complete, what remains, and how to improve the plan so Codex + Claude/Opus can execute with minimal human interruption.
> **Method:** second-pass audit against current main after PR #541, with later Phase 5 backend/eval evidence folded into the live status rows.

---

## 0. TL;DR

The backend/data cutover is real. The product refactor is not done.

| Layer | Done | Evidence |
|---|---|---|
| Backend / data cutover | ~90% ✅ | Greenfield is the only live runtime. Legacy runtime/accessors were retired, and backend CI is a signal again. Remaining backend work is mainly facade deletion plus Home/Forge backends. |
| Frontend structural decomposition | ~50% 🔄 | `TalkDetailPage.tsx` is 5,429 LOC and `SettingsPage.tsx` is 2,147 LOC. Talk panels, composer, thread view, reducer, and stream hook are extracted; the page-owned controller bulk remains. |
| De-facade | ~0% ⛔ | Compat facades still serve the webapp: synthetic threads, runs-with-`threadId`, flat content markdown/html, snapshot compat, policy/tool/connectors facades, and run-context synthesis. |
| Visual system (Salon) | Foundation in review 🔄 | Salon foundation shipped in PR #547: `webapp/src/salon/*` CSS-variable tokens (`--salon-*`), fonts (Newsreader/Geist/Geist Mono), brand mark, and the primitive library (CTMark/CTIcon/Avatar/AgentAvatar/RunPill/Chip/Kbd/Button/Input/Modal/Sheet/Popover) with behavior-preserving proof migrations + a smoke suite. Remaining: broad re-skin of the 7,284 LOC pre-Salon `webapp/src/styles.css`. |
| Net-new product surfaces | ~5% ⛔ | Live app covers Talk list, Talk detail, and Settings. Home, native Documents UI/editor, standalone Agents, Archive, command palette, New Talk sheet, and Forge are unbuilt or skeletal. Native Documents backend routes/client methods now exist for the UI lane. |
| Eval gate | ~40% 🔄 | `eval/` exists with six launch-critical dry-run scenarios, deterministic fixtures, grader prompt contracts, harness tests, and `npm run eval`; PR CI now runs the deterministic dry-run gate, while live backend/provider grading is still unwired. |

The biggest missing work is Salon, native Documents, Home, de-facade, live eval hardening, and final surface completion. Forge remains post-MVP.

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
| 5 | Frontend shell + Talk rewrite | 🔄 Mid-flight. Structure improved, but Talk controller bulk and Salon remain. |
| 6 | Documents | 🔄 Native backend API/client path exists for list/detail tabs+blocks+pending edits and edit accept/reject; native Documents UI/editor not built. |
| 7 | Agents/tools/connectors/context | 🔄 Backend mostly greenfield behind facades; frontend still consumes compat shapes; standalone Agents page not built. |
| 8 | Jobs | 🔄 Backend and Talk Jobs panel mostly usable. This branch adds `emit_document_append` and `job_output_ready` inbox/outbox production; Home UI surfacing and DB-backed verification remain. |
| 9 | Home, Settings, polish, eval gate | 🔄 Eval dry-run harness exists; Home/Salon are still not built, and Settings still has inline Profile/Tools/OAuth state. |
| 10 | Forge | ⛔ Schema/docs only, intentionally post-MVP. |

---

## 3. Backend / Data Layer

The cutover is comprehensive enough to build on:

- `queue-consumer.ts` runs the greenfield executor.
- The retired executor path fails closed with `LEGACY_EXECUTOR_RETIRED`.
- Core routes, chat enqueue, scheduler, context compatibility, connector/tool compatibility, and jobs compatibility are on greenfield tables.

### 3a. Compat-facade Inventory

Each facade should get a deletion ticket with owner, consumers, native replacement, and deletion test.

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

Duplicate route registrations also need cleanup: `reorderGreenfieldTalkSidebarRoute` and `getGreenfieldRunContextRoute` are mounted in both `worker-app.ts` and `greenfield-api.ts`; first match wins, leaving dead duplicate mounts.

### 3b. Net-new Backends

- Home has schema and `job_blocked` writes, but no real read surface.
- Native Documents routes/client methods now expose list/detail tabs, blocks, pending edits, and accept/reject over `documents`/`doc_tabs`/`doc_blocks`/`document_edits`. The frontend Documents UI still needs to consume that native path instead of flat compat content.
- Forge tables exist, but runtime and UI are intentionally post-MVP.

### 3c. Provisioned-but-unused Schema

The unused table set is mostly intentional schema waiting for surfaces: Home, Forge, `activity_events`, `audit_events`, `agent_feedback_events`, `talk_reads`, and `doc_tab_coeditors`. Treat this as pending product work, not dead schema, until the MVP line is reset.

---

## 4. Frontend Structure

### 4a. God Files

- `TalkDetailPage.tsx`: 5,429 LOC. Panels, composer, thread view, reducer, and stream hook are extracted. Remaining work is the Talk tab shell and page-owned controller state, which is the harder part because async mutations must stay page-owned across tab unmounts.
- `SettingsPage.tsx`: 2,147 LOC. Provider config, connectors, and AI agents panels are extracted. Profile, Tools/Google/WebSearch, and OAuth state are still inline.
- `TalkLlmSettingsCard.tsx`: 1,290 LOC and zero importers. This is a deletion candidate after one final grep.

### 4b. De-facade Consumers

`threadId` still appears across `TalkDetailPage.tsx`, `useTalkRunStream.ts`, `talkRunReducer.ts`, `api.ts`, `useTalkSnapshot.ts`, `talkStream.ts`, and `wsCacheRouter.ts`. Native document blocks are not consumed by the frontend. This work is structural and behavioral, so it should be goal-scoped by facade, not attempted as one large rewrite.

### 4c. Missing Surfaces

- Home currently routes to Talk list, not a Home page.
- Documents sidebar entry links into the in-Talk doc pane, not a standalone Documents surface.
- Agents are folded into Settings; standalone Agents and Agent profile are unbuilt.
- Archive, New Talk sheet, and command palette are not production-complete.

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
- Extract Settings Profile, Tools/Google/WebSearch, and OAuth state.
- Delete orphaned `TalkLlmSettingsCard.tsx`.
- Keep async mutation state page-owned when panels unmount.

### W2. Salon Foundation

- Tokens, fonts, brand mark, primitives, motion, density.
- Re-skin existing shell/Talk/Settings enough that net-new surfaces can be built Salon-native.

### W3. Native Documents

- Native Documents API/client path exists for list/detail tabs+blocks+pending edits and accept/reject.
- Documents page and full editor.
- In-Talk doc pane over native tabs/blocks.
- Pending edit accept/reject UX.
- Delete flat content facade after the final consumer moves.

### W4. Home

- Accessors/routes for inbox, recommendations, news, lifecycle actions.
- Home page built in Salon.
- Read and resolve `job_blocked`/`job_output_ready` items.

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
- Jobs `emit_document_append` and `job_output_ready` producer paths are implemented on the current Phase 5 backend branch; Home UI surfacing and DB-backed verification remain.
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
