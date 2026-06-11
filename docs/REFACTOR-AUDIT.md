# ClawTalk Refactor — Full Completion Audit

> **Status:** live audit snapshot updated 2026-06-11 for the Phase 5 native Documents API unblocker, MVP dry-run CI eval gate, duplicate-route de-facade deletion, flat-content route/projection deletion, Home lifecycle completion, workspace-member management v1, Documents accept/proposal race hardening, run-context native contract migration, thread REST endpoint deletion, tool-family fallback retirement, connector route retirement, no-attachments v1 cleanup, and the Talk Salon pilot + Talk/Settings/shell Salon polish lanes (PRs #586–#591).
> **Purpose:** answer how much of the greenfield refactor is actually complete, what remains, and how to improve the plan so Codex + Claude/Opus can execute with minimal human interruption.
> **Method:** second-pass audit against current main after PR #541, with later Phase 5 backend/eval evidence folded into the live status rows.

---

## 0. TL;DR

The backend/data cutover is real. The product refactor is not done.

| Layer                             | Done                          | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend / data cutover            | ~90% ✅                       | Greenfield is the only live runtime. Legacy runtime/accessors were retired, and backend CI is a signal again. Remaining backend work is mainly live eval hardening, pending invitation/mail semantics, deeper Home job workflows, and Forge.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Frontend structural decomposition | ~70% ✅                       | `TalkDetailPage.tsx` is 1,300 LOC and `SettingsPage.tsx` is 1,102 LOC. Talk shell/render surface and page-owned controllers are extracted alongside Settings Profile/Tools/OAuth panels; remaining frontend work is product surfaces, Salon migration, and native facade consumers, not god-file decomposition.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| De-facade                         | Tracked ledger retired ✅     | The dead duplicate `worker-app.ts` Hono mounts for sidebar reorder and run-context were deleted; native block export/copy shipped (PR #561); the in-Talk flat-content split-editor was migrated to native blocks (PR #562); final webapp export/DTO compatibility remnants were removed; definition-only retired legacy `contents`/`content_edits` DB helpers were deleted; the old executor flat-content fallback was retired in favor of the native `document_edits` tool path; Talk doc-pane creation now uses native `POST /api/v1/documents`; old flat-content HTTP route mounts/helpers for `/talks/:talkId/content`, `/threads/:threadId/content`, and `/contents/:contentId[...]` were deleted; snapshot body projection was replaced with native `primaryDocument` metadata; `snapshotVersion` and the legacy policy route were retired; run-context now returns native context details or `null` instead of fabricated manifest fields; the old thread REST endpoints/wrappers for `/talks/:talkId/threads[...]` were deleted; the Talk URL/cache/request layer no longer uses `?thread=`, last-thread storage, thread-keyed snapshot cache, or thread ids in snapshot/messages/chat/cancel/document-create requests; native document create no longer accepts `threadId`; run/message/search snapshot DTOs and stream events no longer expose `threadId`; executor/storage TypeScript contracts no longer expose the synthetic thread alias; connector route compatibility is retired; and tool execution no longer reads legacy tool-family storage fallbacks. `de-facade-readiness.sh` now reports `synthetic-thread-id`, `flat-content-projection`, `snapshot-compat-version`, `policy-facade-route`, `run-context-fabrication`, `tool-family-compat`, `connector-channel-compat`, and `attachments-not-available` live counts at 0. Future chat-message attachments must ship as a native product slice. |
| Visual system (Salon)             | Foundation + Talk pilot shipped 🔄 | Salon foundation shipped in PR #547: `webapp/src/salon/*` CSS-variable tokens (`--salon-*`), fonts (Newsreader/Geist/Geist Mono), brand mark, and the primitive library (CTMark/CTIcon/Avatar/AgentAvatar/RunPill/Chip/Kbd/Button/Input/Modal/Sheet/Popover) with behavior-preserving proof migrations + a smoke suite. Surfaces re-skinned (PR #550): Home, Archive, Registered Agents + agent profile, Talks list, sign-in, and the 3-column app shell. The Talk Salon pilot adds a mocked fidelity loop for populated/empty/active states at 1280 and 390 widths, then moves the Talk conversation surface to Salon timeline/messages, sanitized markdown rendering, avatars, byline metadata, round dividers, composer chips, and hidden conversation rail; details live in `docs/talk-salon-pilot-report.md`. Contrast fixed: `--salon-accent-strong` `#b05530` (≈ 5.0:1 on white) backs text-bearing primary buttons. Post-pilot polish (PRs #587–#591) Salon-styled the address chips, user-message identity, Talk sidebar, profile menu, and Settings pages. Remaining: final Talk top-pill semantics/overflow + breadcrumb row and exact Talk visual polish vs the prototype (`docs/talk-salon-pilot-report.md` remaining gaps).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Net-new product surfaces          | ~25% 🔄                       | Live app covers Talk list, Talk detail, Settings, and Salon-native Home, New Talk sheet, ⌘K command palette, Registered Agents panel + standalone agent profile, and Archive (Salon surfaces shipped in PR #550), plus native Documents UI — `/app/documents` index + `/app/documents/:id` viewer + pending-edit accept/reject console (PR #557) and the in-Talk native Documents pane (PR #560). Home P2/lifecycle hardening routes `open_document_edit` to native Documents, keeps optimistic summary/curator/hero/news state coherent, supports inbox dismiss/snooze/mark-read/resolve, recommendation dismiss, news add-to-context/not-relevant/snooze, and returns 403 for guest lifecycle writes. Native Documents backend routes/client methods exist (PR #552), and accept resolution is serialized with executor proposal inserts so a concurrent same-block proposal is not silently superseded during accept. Forge remains post-MVP.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Eval gate                         | ~50% 🔄                       | `eval/` exists with six launch-critical dry-run scenarios, deterministic fixtures, grader prompt contracts, harness tests, and `npm run eval`; PR CI now runs the deterministic dry-run gate. The harness can also score persisted live Worker/workspace observations with `--mode=live --live-root=<dir>` and `source: "live"`, while live capture and provider-backed evaluator-model grading are still unwired.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

The biggest missing work is final Talk Salon polish (top-pill semantics/overflow, breadcrumb row, exact spacing/type), live eval hardening, pending invitation/mail semantics, deeper Home job workflows, and final surface completion. Forge remains post-MVP.

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

| Step | Title                                 | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Cutover foundation                    | ✅ Done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2    | Greenfield route/accessor spine       | ✅ Done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 3    | Execution backend                     | ✅ Done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 4    | API shell cleanup / legacy retirement | ✅ Done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 5    | Frontend shell + Talk rewrite         | ✅ Structural target met. TalkDetailPage shell/render surface and page-owned controllers are extracted below the roadmap LOC target; Salon migration and product-surface work remain separate lanes.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 6    | Documents                             | ✅ Native backend API/client path exists for list/detail tabs+blocks+pending edits and edit accept/reject; standalone Documents UI (index + viewer + edit-review console) shipped (PR #557), the in-Talk doc pane consumes the same native tabs/blocks path (PR #560), native block export/copy shipped (PR #561), the legacy in-Talk split-editor pane is now migrated to that native read+review surface (PR #562), final webapp export/DTO flat-content remnants are gone, old flat-content HTTP routes/helpers are deleted, and Talk snapshots now carry native primary-document metadata instead of flat body projections. |
| 7    | Agents/tools/connectors/context       | ✅ Backend greenfield with native connector and tool contracts (compat routes/fallbacks retired); Salon-native Registered Agents panel + standalone agent profile shipped (PR #550).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 8    | Jobs                                  | 🔄 Backend and Talk Jobs panel mostly usable. PR #552 added `emit_document_append` and `job_output_ready` inbox/outbox production; DB-backed verification remains.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 9    | Home, Settings, polish, eval gate     | 🔄 Eval dry-run harness + CI gate shipped (PR #553); Salon foundation + shell + Home shipped (PR #547/#550); Home P2/lifecycle hardening fixed native Documents deep links, optimistic curator sync, inbox/recommendation/news lifecycle writes, and guest-writer 403s; Settings structural extraction complete for Profile, Tools/Google/WebSearch, and provider OAuth (PR #548), and Settings pages are Salon-styled (PR #591); product gaps remain.                                                                                                                                                                                                                         |
| 10   | Forge                                 | ⛔ Schema/docs only, intentionally post-MVP.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

---

## 3. Backend / Data Layer

The cutover is comprehensive enough to build on:

- `queue-consumer.ts` runs the greenfield executor.
- The retired executor path fails closed with `LEGACY_EXECUTOR_RETIRED`.
- Core routes, chat enqueue, scheduler, context compatibility, connector/tool compatibility, and jobs compatibility are on greenfield tables.

### 3a. Compat-facade Inventory

Each facade should get a deletion ticket with owner, consumers, native replacement, and deletion test.
The current readiness ledger and grep script live in [DE-FACADE-READINESS.md](DE-FACADE-READINESS.md) and `scripts/de-facade-readiness.sh`.

| #   | Facade                        | Current role                                                                                                                                                                                                                                                                                                                                                  | Native replacement                                                                             |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | Synthetic threads             | Retired: old `/talks/:talkId/threads[...]` REST endpoints are deleted; Talk URL/cache/request contracts are Talk-level; snapshot/run/message/search DTOs and stream events no longer carry `threadId`, the snapshot single-conversation list is named `conversations`, and executor/storage TypeScript contracts no longer expose the synthetic thread alias. | Frontend treats Talk as the conversation; no synthetic thread identity remains in live code.   |
| 2   | Runs/messages with `threadId` | Retired from live DTO/event contracts; dynamic client reads of `run.threadId`, `message.threadId`, `event.threadId`, `payload.threadId`, and `threadIds` are zero. Broad audit rows still include native `TalkRun`/`TalkMessage` names and `responseGroupId`, not live thread compatibility.                                                                  | Native run/message DTOs using `responseGroupId`, `sequenceIndex`, message ids, and run ids.    |
| 3   | Content markdown/html         | Retired: native document blocks are no longer projected into flat body fields.                                                                                                                                                                                                                                                                                | Block editor on `documents`/`doc_tabs`/`doc_blocks`.                                           |
| 4   | Snapshot compat               | Retired: `snapshotVersion` was renamed to native `eventHighWater`.                                                                                                                                                                                                                                                                                            | Native per-talk hydration contract.                                                            |
| 5   | Connector route compatibility | Retired: old `/workspace/channels`, `/workspace/data-connectors`, and per-Talk `/connectors[...]` API paths are deleted from live code and covered by retired-route tests.                                                                                                                                                                                    | Native connector channels, connector sources, and connector bindings routes.                   |
| 6   | Talk tools light-family API   | Retired for execution/readiness: legacy `active_tool_families_json` and `tool_families` fallbacks are gone; broader tool UI still uses grouped labels over native `talk_tools`.                                                                                                                                                                               | Per-tool toggles.                                                                              |
| 7   | Policy facade                 | Retired: legacy `/policy` route/handlers are gone.                                                                                                                                                                                                                                                                                                            | Native roster and run settings.                                                                |
| 8   | Run-context synthesis         | Retired: route returns native run context details or `null`, without fabricated manifest/default fields.                                                                                                                                                                                                                                                      | Native run context without thread fields.                                                      |
| 9   | Attachments guard             | Retired by the no-attachments v1 decision: chat-message attachment routes, unavailable responses, payload fields, composer UI, message DTO/rendering, and executor `read_attachment` branches are gone.                                                                                                                                                       | Future R2-backed chat attachments, if v1 needs them, must ship as a full native product slice. |

The first duplicate route cleanup is complete: `reorderGreenfieldTalkSidebarRoute` and `getGreenfieldRunContextRoute` now mount only through `mountGreenfieldApiRoutes(app)` in `greenfield-api.ts`. The dead direct `worker-app.ts` registrations were removed in the Phase 5 duplicate Hono deletion lane.

### 3b. Phase 5 De-facade Deletion Ledger

Repeatable audit command: `node scripts/audit-facade-consumers.mjs`. The command prints the exact `rg` commands for five modalities: literal token grep, import/re-export trace, route registration trace, test fixture/assertion trace, and dynamic/string-key/cache-router trace.

Current branch counts below are matching-line counts for those modalities in that order.

| Facade                              |                   Counts | Current consumers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Native replacement                                                                                                                             | Deletion preconditions                                                                                                                                          | Status                  |
| ----------------------------------- | -----------------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Synthetic `threadId`                |        0 / 0 / 0 / 5 / 0 | Old thread REST endpoints and webapp wrappers are deleted. Talk navigation/cache/request contracts are Talk-level: no `?thread=`, no last-thread localStorage helper, no thread-keyed snapshot cache, and no thread ids in snapshot/messages/chat/cancel/document-create requests. Backend snapshot/message/run/search serializers, frontend DTOs, stream events, reducer, queue retry visibility, executor input, and runtime storage accessors no longer expose `threadId`; the snapshot single-conversation list is named `conversations`; native document create requires `talkId`.                                                                                                                                                                                                            | Treat Talk as the conversation boundary; native hydration/messages/runs drop thread identity.                                                  | Keep `threadId`, `thread_id`, synthetic thread helpers, old thread route paths, and `?thread=` grep-clean in live code.                                         | Retired                 |
| Runs/messages `threadId` DTO fields | 317 / 235 / 11 / 143 / 0 | Live DTO/event compatibility is retired: `TalkMessage`, `TalkRun`, snapshot messages/runs/search, stream events, reducer actions, retry visibility, and executor input no longer carry `threadId`. The dynamic client-consumer bucket is zero; remaining broad counts are native type names, `responseGroupId`, and tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Native run/message DTOs keyed by run id, response group, sequence index, and message id.                                                       | Keep dynamic thread-id reads at zero; do not reintroduce thread identity in DTO/event/request contracts.                                                        | Retired from DTO/events |
| Run-context fabrication             |        0 / 0 / 0 / 0 / 0 | Retired fabricated `contextSnapshot`, `context_manifest_json`, legacy source manifest, synthetic thread, and default manifest fields; the route now returns native `context` details or `null`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Native run-context contract with real persona role, prompt presence/token estimate, context runtime tools, trigger message id, and turn count. | Keep fabricated run-context symbols grep-clean; backend and Talk UI tests continue covering present and missing native context states.                          | Retired                 |
| Flat content body projection        |     0 / 31 / 0 / 0 / 101 | Native Documents export/copy moved to block serialization (PR #561), the in-Talk split-editor migrated to native blocks (PR #562), final webapp export/DTO compatibility remnants are removed, definition-only retired legacy `contents`/`content_edits` DB helpers were deleted, the old executor fallback now fails closed while production `apply_content_edit` uses native `document_edits`, Talk doc-pane creation now uses native `POST /api/v1/documents`, old flat-content HTTP routes/helpers were deleted, and the Talk snapshot now exposes native `primaryDocument` metadata instead of flat body fields. Exact `bodyMarkdown`/`bodyHtml` literal, route-registration, and test-fixture traces are zero; remaining broad audit counts are non-facade `Content`/rendering lexical hits. | Native Documents tabs/blocks/pending edits over `documents`, `doc_tabs`, `doc_blocks`, and `document_edits`.                                   | Keep `scripts/de-facade-readiness.sh` at `flat-content-projection live_consumer_count: 0`; do not reintroduce flat body fields or compatibility content routes. | Retired                 |
| `snapshotVersion` compat            |       0 / 81 / 0 / 0 / 0 | Retired `snapshotVersion` and `getTalkSnapshotVersion` symbols are grep-clean; the remaining import-count bucket is native snapshot/cache machinery.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Native per-talk hydration and event high-water contract.                                                                                       | Keep `snapshotVersion`/`getTalkSnapshotVersion` grep-clean; preserve event-high-water snapshot/cache tests.                                                     | Retired                 |
| Policy facade                       |        0 / 0 / 0 / 0 / 0 | Legacy `/api/v1/talks/:talkId/policy` mounts, handlers, client wrappers, and tests are gone; native `/agents` routes own roster behavior.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Native roster/run settings API.                                                                                                                | Keep route/client-wrapper grep-clean; native roster tests continue covering read/write behavior.                                                                | Retired                 |
| Connector route compatibility       |       0 / 0 / 0 / 15 / 0 | Old connector API route namespaces are grep-clean in live code. Remaining matches are retired-route test assertions proving the old paths fall through.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Native connector channel/source/binding routes.                                                                                                | Keep old connector route paths grep-clean in live code; retired-route tests should remain as deletion proof.                                                    | Retired                 |
| Duplicate Hono mounts               |     9 / 7 / 23 / 15 / 22 | Remaining references are native `greenfield-api.ts` route registrations, route handlers, imports, focused mount tests, and expected greenfield module imports.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Single mount path through `mountGreenfieldApiRoutes(app)`.                                                                                     | Direct `worker-app.ts` imports and route registrations are absent; sidebar reorder and run-context still resolve through the native mount.                      | Deleted                 |
| `attachments_not_available` guard   |        0 / 0 / 0 / 0 / 0 | Chat-message attachment routes, unavailable responses, `attachmentIds` chat payloads, upload/delete client stubs, pending composer state/UI, message attachment DTO/rendering, and executor `read_attachment` branches are gone. Context-source file uploads still use R2-backed storage helpers, but that is native source ingestion rather than the retired chat attachment facade.                                                                                                                                                                                                                                                                                                                                                                                                              | No chat-message attachments in v1; context file uploads remain the supported source-ingestion path.                                            | Keep chat attachment routes, payload fields, unavailable codes, and `read_attachment` grep-clean in live code.                                                  | Retired                 |

### 3c. Net-new Backends

- Home native read/write routes and the Salon Home UI are live for summary, inbox, recommendations, news, inbox dismiss/snooze/mark-read/resolve, recommendation dismiss, and news add-to-context/not-relevant/snooze. Home P2 hardening returns 403 for guest lifecycle writes instead of RLS-shaped 404s.
- Native Documents routes/client methods and the standalone Documents UI now expose list/detail tabs, blocks, pending edits, accept/reject, and Talk primary-document create over `documents`/`doc_tabs`/`doc_blocks`/`document_edits`. Accept resolution is serialized with executor proposal inserts to close the preflight-to-apply supersede race. The in-Talk doc pane now consumes the native path too (PR #560, a `documents` tab on the Talk surface that reuses `DocumentBlocks`/`PendingEditList` via the shared `useNativeDocumentReview` hook), native export/copy serializes block data directly (PR #561), and the legacy in-Talk split-editor pane was migrated onto the same native read+review surface (PR #562: the `talk` tab renders `TalkDocPane` → `TalkDocumentView`; the RichTextEditor/HtmlSourceEditor/PendingEditDocSurface stack was deleted). Final webapp export/DTO flat-content remnants are gone, definition-only retired legacy `contents`/`content_edits` DB helpers have been deleted, the old executor flat-content fallback has been retired, and the old flat-content HTTP routes/helpers have been deleted. Talk doc-pane creation no longer calls the old flat-content create routes, and snapshot hydration now returns native `primaryDocument` metadata instead of flat body projections.
- Forge tables exist, but runtime and UI are intentionally post-MVP.

### 3d. Provisioned-but-unused Schema

The unused table set is mostly intentional schema waiting for surfaces: Forge, `activity_events`, `audit_events`, `agent_feedback_events`, `talk_reads`, and `doc_tab_coeditors`. Treat this as pending product work, not dead schema, until the MVP line is reset.

---

## 4. Frontend Structure

### 4a. God Files

- `TalkDetailPage.tsx`: 1,300 LOC. Panels, composer, thread view, reducer, stream hook, Talk tab shell/render surface, and page-owned controllers are extracted into focused components/hooks. Async mutation and stream state stay page-owned while controller/view-model bulk lives outside the page.
- `SettingsPage.tsx`: 1,102 LOC. Provider config, connectors, AI agents, Profile, Tools/Google/WebSearch, and provider OAuth state are extracted; Settings pages are Salon-styled (PR #591).
- `TalkLlmSettingsCard.tsx`: deleted after a repo-wide importer grep proved it had zero live consumers.

### 4b. De-facade Consumers

`threadId` is gone from live Talk run/message/search snapshot DTOs, stream events, reducer actions, retry visibility, executor input, storage accessors, and native document-create requests; the Talk snapshot's single-conversation list is now named `conversations`. Native document blocks are consumed by the standalone Documents UI, the in-Talk Documents tab, the native export/copy path, and the in-Talk split pane (the `talk` tab reads native blocks via `TalkDocPane`). Production webapp and backend route greps for flat body fields and synthetic thread ids are empty. Remaining de-facade work is structural and behavioral, so it should be goal-scoped by facade, not attempted as one large rewrite.

### 4c. Missing Surfaces

- Home is a Salon-native surface over the native Home API, including per-match news snooze over `home_news_matches.snoozed_until`.
- Standalone Documents index/detail/edit-review, native export/copy, the in-Talk Documents pane, and the in-Talk split pane are live over native tabs/blocks; flat content body projection is retired.
- Registered Agents and standalone agent profile are live; remaining agent work is native facade-consumer cleanup and product polish.
- Archive, New Talk sheet, command palette, and Workspace Members v1 are production surfaces; remaining net-new scope is pending external invitations and Forge (post-MVP).

---

## 5. Visual System (Salon)

Salon was a product-defining gap. The **foundation landed in PR #547** (lane S): a CSS-variable system + primitive library under `webapp/src/salon/`, with behavior-preserving proof migrations and a `salon.test.tsx` smoke suite. The remaining Salon work is the broad re-skin of the 7,284 LOC pre-Salon `webapp/src/styles.css`, plus building the net-new surfaces Salon-native from the start.

| Marker in `webapp/src`                | Before | After PR #547                                    |
| ------------------------------------- | ------ | ------------------------------------------------ |
| `--salon-*` tokens                    | 0      | defined in `salon/salon.css` + `salon/tokens.ts` |
| `#FBF7EF` / `#C8643A` / `#1F1B16`     | 0      | canonical palette tokens defined                 |
| `Newsreader` / `Geist` / `Geist Mono` | 0      | wired via `<link>` in `index.html`               |

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
- Native `POST /api/v1/documents` creates the primary document for a Talk/thread and is used by the Talk doc-pane create flow.
- Standalone Documents page and native viewer/edit-review console are live.
- Accept resolution now serializes with executor proposal inserts so a competing same-block proposal cannot be silently superseded during the accept window.
- In-Talk doc pane over native tabs/blocks is live (#560): a `documents` tab on the Talk surface that reuses `DocumentBlocks`/`PendingEditList` through the shared `useNativeDocumentReview` hook (which `DocumentDetailPage` also adopted).
- Pending edit accept/reject UX exists in standalone Documents, the in-Talk Documents tab, and the in-Talk split pane; full authoring editor remains future work.
- The legacy in-Talk split-editor (RichTextEditor/HtmlSourceEditor/PendingEditDocSurface over `bodyMarkdown`/`bodyHtml`) was deleted; the `talk` tab doc pane now renders `TalkDocPane` → `TalkDocumentView` over native blocks, with a `docReloadSignal` bridge so agent edit-run stream events trigger a quiet native reload.
- Keep the flat content body-projection, run-context fabrication, synthetic thread, connector route, tool-family, and attachments readiness scouts at zero. Future chat-message attachments should be introduced only as a full native product slice.

### W4. Home

- Accessors/routes for summary, inbox, recommendations, news, and current lifecycle actions are live.
- Home page is built in Salon.
- Home P2/lifecycle hardening complete: `open_document_edit` routes to native Documents, optimistic inbox/recommendation/news writes keep summary/curator/hero state coherent, news snooze uses a native per-match wake-up timestamp, and guest lifecycle writes return 403.
- Remaining: any deeper `job_blocked`/`job_output_ready` product workflows.

### W5. De-facade

- One facade at a time, with a deletion ledger.
- Remove duplicate route registrations as part of the relevant route cleanup.
- Delete tests that only prove compatibility behavior after native tests cover the new shape.

### W6. Eval Gate

- Implemented MVP dry-run: `eval/`, scenario files, deterministic fixtures, grader prompt contracts, harness CLI, thresholds, and `npm run eval`.
- PR CI now runs `npm run eval` as a deterministic dry-run gate after root typecheck.
- Persisted live observation scoring is available with `npm run eval -- --mode=live --live-root=<dir>`; live files must use the scenario `fixture` filenames, `source: "live"`, and nested observation signals.
- Remaining: live Worker/workspace capture, evaluator-model adapter, and launch threshold policy for provider-backed grading.
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
- facade consumers: old attachment guard tokens, old flat content fields, old thread route/query symbols, and duplicate route mounts.

### 8d. Keep Live Docs Small

Current implementation state should live in only three places:

- `REFACTOR-AUDIT.md` for audited state and gaps.
- `roadmap.md` for the current execution sequence.
- `PHASE5-AUTONOMOUS-PLAN.md` for the `/goal` protocol, lane split, and copy/paste Codex + Claude/Opus phase prompts.

Archived handoffs and historical audits should stay archived.

---

## 9. Outstanding Decisions

| Decision             | Recommendation                                                        |
| -------------------- | --------------------------------------------------------------------- |
| Salon tooling        | CSS variables unless Joseph overrides.                                |
| Message attachments  | Defer from v1 unless chat uploads are launch-critical.                |
| Dark mode            | Defer until light Salon exists.                                       |
| Accessibility/mobile | Set a v1 bar now, full WCAG later.                                    |
| Eval ownership       | Codex primary, Claude/Opus review. Start before final surface polish. |
| Forge timing         | Keep post-MVP.                                                        |

---

## 10. Reviewer Checklist

Challenge these points before starting implementation:

1. Is the MVP denominator right: Salon + Home + Documents + de-facade + eval, Forge later?
2. Is CSS-variable Salon acceptable, or should Tailwind be adopted for prototype port speed?
3. Is deferring chat attachments acceptable for v1?
4. Does each facade have a clear native replacement and deletion test?
5. Are the `/goal` packets strict enough to let agents work autonomously without hiding risk?
