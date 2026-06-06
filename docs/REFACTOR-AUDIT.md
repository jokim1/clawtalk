# ClawTalk Refactor — Full Completion Audit

> **Status:** audit snapshot at commit `96489dc` (merged PR #539), 2026-06-06. Read-only audit; no code changed.
> **Purpose:** answer "how comprehensive is the refactor, what's done, what's left — including visuals?" against the full V2 product, not just the active decomposition plan.
> **Method:** four parallel read-only auditors (V2 scope / backend+facades / frontend structure / visual system), each verifying claims against code in a clean `origin/main` worktree. Findings below are evidence-cited (file:line / LOC / grep counts).

---

## 0. TL;DR

**The concern is justified.** "The refactor" as actively tracked (the `PHASE5-AUTONOMOUS-PLAN.md` decomposition + de-facade) is a **subset** of finishing V2. The honest state by layer:

| Layer | Done | Evidence |
|---|---|---|
| **Backend / data cutover** | **~90%** ✅ | Greenfield is the only live runtime; legacy retired (PR #530, −15k LOC). Steps 1–4 + backend halves of 6/7/8 complete. Remaining backend work = deleting compat facades + building net-new surface backends (Home, Forge). |
| **Frontend structural decomposition** | **~50%** 🔄 | `TalkDetailPage.tsx` 5347 LOC (target ≤2.5k, ~2× over); `SettingsPage.tsx` 2147. 5 of 6 Talk tabs extracted; the controller bulk + the `talk` tab remain. |
| **De-facade (native greenfield reads)** | **~0%** ⛔ | All 9 compat facades still live and consumed; not one frontend consumer migrated. |
| **Visual system (Salon)** | **0%** ⛔ | 0 Salon tokens, 0 Salon fonts in `webapp/src`. The live app is cool-blue + IBM Plex (and ships no web fonts at all). Salon exists only as spec + a CDN prototype. |
| **Net-new product surfaces** | **~5%** ⛔ | Live app = **3 of ~22** specced surfaces (Talk list, Talk detail, Settings). Home, Documents, Agents-page, Archive, ⌘K, New-Talk sheet, Forge: unbuilt. |
| **Launch-blocking eval gate** | **~5%** ⛔ | Only the harness contract exists; no `eval/`, no `npm run eval`, no scenarios/graders. v1 cannot ship without it. |

**One-line:** the *plumbing* (backend, data model, execution) is essentially finished; the *product* (the V2 screens and the editorial "Salon" identity that defines the app) is mostly not built yet, and several pieces of it aren't on the active plan at all.

**Biggest unbuilt blocks (in rough priority):** Salon visual system (the product's identity) · Home surface (step 9) · Documents UI (step 6) · de-facade migration · agent eval gate (launch-blocking) · Agents-as-a-page · Forge (post-MVP).

---

## 1. What "fully refactored" means (the denominator)

V2 is defined by the canonical spec corpus (`docs/01`–`12`) + the **Salon** visual system (`docs/02-visual-system.md`) + its reference prototype (`prototype/*.jsx`, `ClawTalk Salon.html`), all on the greenfield data model (`supabase/migrations/0001_clawtalk_greenfield.sql`, 68 tables). The full V2 is roughly:

- **~22 user-reachable surfaces** (per `01 §4` + `08` IA): Sign-in, Home, Talk list/sidebar, Talk detail, Talk+doc pane, Agents, Agent profile, Documents, Document editor, Settings (Profile / API-keys / AI-agents / Tools / Connectors), Archive, Workspace switcher, New-Talk sheet, ⌘K palette, dialogs, Forge (post-MVP), Admin console.
- **~12 feature areas:** agents/personas, talks/multi-agent rounds, documents/editing, jobs/scheduler, home feed (inbox/recommendations/news), connectors, tools, context sources, settings/BYOK, workspaces/identity, forge (post-MVP).
- **~11 cross-cutting mandates:** the Salon visual system, density modes, the **launch-blocking agent eval gate**, workspace-membership RLS, performance targets (no component >1000 LOC; Talk open <250ms p50), provider abstraction, rate limiting, audit/analytics, accessibility (under-specified), dark mode (under-specified), mobile (unspecified).

The **refactor roadmap** (`docs/roadmap.md`) sequences this as 10 steps; steps 1–9 are MVP, **step 10 (Forge) is explicitly post-MVP** but its schema ships now so the model isn't redesigned twice.

---

## 2. Status by roadmap step

| Step | Title | Gate | Status |
|---|---|---|---|
| 1 | Cutover foundation (0001 schema, seed, bootstrap) | invariant tests pass | ✅ DONE |
| 2 | Greenfield route/accessor spine | core/detail/chat route tests pass | ✅ DONE |
| 3 | Execution backend (queue/executor/scheduler) | atomic outbox/state, ordered/parallel, sweeps, DLQ | ✅ DONE |
| 4 | API shell cleanup / legacy retirement | legacy data+route layer deleted | ✅ DONE (PR #530) |
| 5 | Frontend shell + Talk rewrite | TalkDetailPage decomposed; shell native | 🔄 ~50% (decomposition mid-flight; shell pre-Salon; de-facade unstarted) |
| 6 | Documents | block model + tabs + pending-edit + PDF path | 🔄 backend DONE; **frontend UI NOT built** |
| 7 | Agents, tools, connectors, context | greenfield native end-to-end | 🔄 backend DONE behind facades; **frontend still on facades; de-facade unstarted; Agents page not built** |
| 8 | Jobs | passes `12-jobs.md` verification | 🔄 backend mostly done; **Jobs UI + `emit_document_append` + inbox emit pending** |
| 9 | Home, Settings, polish, eval gate | Home deterministic-first; **eval gate passes** | ⛔ Settings decomposed; **Home not built; eval gate not built; polish/Salon not started** |
| 10 | Forge | post-MVP flag | ⛔ schema only (intentional) |

---

## 3. Backend / data layer — DONE, with a facade debt + net-new gaps

The greenfield cutover is genuinely comprehensive. The live runtime is 100% greenfield (`queue-consumer.ts:35` → `GreenfieldTalkExecutor`; the legacy `CleanTalkExecutor` throws `LEGACY_EXECUTOR_RETIRED`, `new-executor.ts:351`). Backend halves of Documents, Agents/Tools/Connectors/Context, and Jobs are all implemented.

### 3a. Compat-facade inventory (the de-facade scope, roadmap step 7)

The backend serves 9 legacy-shaped surfaces so the un-rewritten webapp keeps working. Each is deleted only after its frontend consumer goes native.

| # | Facade | Routes | Native replacement |
|---|---|---|---|
| 1 | **Synthetic threads** (`syntheticThreadId(talkId)===talkId`; no `threads` table exists) | `…/talks/:id/threads` (CRUD, all rejected); `threadId` on every message/run | Frontend drops thread model; talk *is* the conversation. `greenfield-detail.ts:201-269` |
| 2 | **runs-with-threadId** (synthetic `threadId` on run/message DTOs; `awaiting`→`awaiting_confirmation`) | `…/runs`, `…/messages`, `…/snapshot` | Native run shape (use `responseGroupId`). `greenfield-detail.ts:340-424` |
| 3 | **content markdown/html** (native = `documents`+`doc_tabs`+`doc_blocks`; flattened to `bodyMarkdown` on read, parsed on write) | `…/content`, `…/contents/:id`, edit accept/reject | Native block editor on `doc_blocks`. `greenfield-detail.ts:527-619`, `greenfield-api.ts:774-930` |
| 4 | **snapshot compat** (`snapshotVersion` = outbox high-water, not a real version) | `…/talks/:id/snapshot` | Native per-talk hydration. `greenfield-detail.ts:1647-1718` |
| 5 | **channels / data-connectors split** (two frontend surfaces → one `connectors` table) | `…/workspace/channels`, `…/data-connectors`, `…/talks/:id/connectors` | Single native connectors surface. `db/connectors-accessors.ts:1` |
| 6 | **talk_tools light-family API** (families → per-tool rows) | `…/talks/:id/tools` | Native per-tool toggles. `db/talk-tools-accessors.ts:1` |
| 7 | **policy facade** (derived from `talk_agents`, no policy table) | `…/talks/:id/policy` | Native roster surface. `greenfield-core.ts:1313` |
| 8 | **run-context snapshot synthesis** (fabricates v1 manifest w/ `threadId`) | `…/runs/:runId/context` | Drops synthetic threadId. `greenfield-detail.ts:476-525` |
| 9 | **attachments 501 guard** (returns `attachments_not_available`) | `…/talks/:id/attachments` | Real attachment storage — **not built** (see §7) |

### 3b. Net-new surface backends

- **Home: NOT built.** No `home*.ts` route/accessor. The only production touch of the 13 `home_*` tables is a single **write** (`greenfield-job-accessors.ts:1132`, job-blocked inbox row) that **nothing reads**.
- **Documents: backend DONE** (full block-model accessors, `greenfield-detail-accessors.ts:428-1404`); only the frontend consumes the flat compat shape.

### 3c. Provisioned-but-dead schema

**~26 of 68 tables (38%)** have no production read/write — entirely the Home cluster (12), Forge cluster (9: `forge_*`, `ssr_connections`, `improvement_*`, `document_versions`), plus `activity_events`, `audit_events`, `agent_feedback_events`, `talk_reads`, `doc_tab_coeditors`. This is deliberate ("schema waiting for a surface"), matching steps 9–10.

---

## 4. Frontend structure — ~half decomposed

### 4a. God-files

- **`TalkDetailPage.tsx` — 5347 LOC** (DoD ≤ ~2.5k → ~2× over). ~3661 LOC of hooks/state/handlers *before* the JSX return (116 `useState/useRef/useReducer`, 52 `useCallback`, 39 `useEffect`, 51 handlers). **5 of 6 tabs extracted** into panels (`TalkAgentsPanel/ContextPanel/ToolsPanel/ConnectorsPanel/JobsPanel/RunsPanel`, plus `TalkComposer`, `TalkThreadView`, reducer→`lib/talkRunReducer.ts`, stream→`hooks/useTalkRunStream.ts`). **Remaining:** the `talk` tab body (~580 inline JSX LOC: thread rail + doc-pane shell) and, dominating the gap, the **page-owned controller logic** — reaching ≤2.5k requires extracting ~2.2k LOC of state into custom hooks, the harder ~20% that's left.
- **`SettingsPage.tsx` — 2147 LOC.** `ProviderConfigPanel` (985), `ConnectorsSettingsPanel` (679), `AiAgentsSettingsPanel` (113) extracted; `ProfileTab`, `ToolsTab`+`GoogleAccountSection`, and the Anthropic/Codex OAuth state (~1.3k LOC) still inline. Further along than TalkDetailPage.
- **`TalkListPage.tsx` — 64 LOC.** Not a god-file.

### 4b. De-facade (frontend) — 0% started

All three named facades are 100% live in the webapp. Consumer counts for `threadId` alone: `TalkDetailPage.tsx` (66), `useTalkRunStream.ts` (32), `talkRunReducer.ts` (29), `api.ts` (29), `useTalkSnapshot.ts` (16), `talkStream.ts` (15), `wsCacheRouter.ts` (14). Content is read only via the flat `{contentFormat, bodyMarkdown, bodyHtml}` projection — the native `doc_blocks`/`doc_tabs` model is **never consumed**. (Note: PR #539 "track-b-completion" was the *Settings* structural cleanup, **not** de-facade.)

### 4c. Missing surfaces (sidebar lies)

- **Home: missing.** Sidebar "Home" → `/app/talks` (the Talk list), `ClawTalkSidebar.tsx:786`. No `/app/home`, no page.
- **Documents: missing.** Sidebar "Content" → in-talk deep links (`…?doc=1`), `ClawTalkSidebar.tsx:891`. No `/app/documents`, no `DocumentsPage`.
- **Agents page:** intentionally folded into Settings (`/app/agents`→Settings); the standalone Agents/Agent-profile screen + Team-compositions UI are unbuilt.
- Only **3 real routes** exist (`App.tsx:835`).

### 4d. Dead code

- **`TalkLlmSettingsCard.tsx` — 1290 LOC, ZERO importers.** Largest component in the tree, fully orphaned. Pure deletion win, not on any plan.
- **`GREENFIELD_MESSAGE_ATTACHMENTS_ENABLED = false`** (`TalkDetailPage.tsx:199`) gates ~58 dead attachment branches.

---

## 5. Visual system (Salon) — 0% implemented

The single biggest unbuilt cross-cutting item. The webapp shares **nothing** with Salon.

### 5a. Gap (grep counts in `webapp/src`)

| Salon marker | Count |
|---|---|
| `--salon-*` tokens | **0** |
| `#FBF7EF` / `#C8643A` / `#1F1B16` (paper/accent/ink) | **0** |
| `Newsreader` / `Geist` / `Geist Mono` fonts | **0** |

The webapp uses **`styles.css` — 7,278 LOC of hand-rolled semantic CSS** (1,098 classes; `talk-*` ×231, `clawtalk-*` ×108…), **no Tailwind, no PostCSS**. Palette is cool blue-grey (`#1d2433` ink, blue-tinted page gradient); font is `IBM Plex Sans` declared but **no web font is actually shipped** (`index.html` has a bare `<head>`, no `@font-face`) → renders OS default sans. Salon mandates warm terracotta-on-cream + Newsreader serif and **bans** Inter/Roboto/Arial.

### 5b. Reference prototype

A **Tailwind-Play-CDN + Babel-standalone throwaway** (~7,398 LOC across `prototype/*.jsx` + `ClawTalk Salon.html`). It is **not buildable as-is** (CDN Tailwind, in-browser transpile, `window.*` globals, no ESM/TS) — every file needs ESM-ization + typing to enter the Vite/TS app. Surface map: `shell.jsx`→app shell/sidebar/atoms; `screens.jsx`→screens; `talk-dialogs.jsx`→Talk modals; `agents.jsx`→Agents; `documents.jsx`→Documents; `home-shared.jsx`+`home-focus.jsx`→Home; `tools.jsx`→tools popover; `forge-*.jsx`→Forge; `shared/data.jsx`→icons+brand marks.

### 5c. Component-catalog gap (§4)

| Salon component | Production status |
|---|---|
| RunPill, Chip, Popover, Modal | **exist, pre-Salon** (hand-rolled, blue tokens — re-skin targets) |
| Brand mark (`CTMarkSalon`) | **wrong mark** (`ClawTalkMark.tsx` is a generic single-path glyph) |
| AgentAvatar, Kbd, StatCard, RecommendationCard, NewsCard, Sheet, CTIcon set | **prototype-only** (don't exist in webapp; webapp uses `lucide-react` icons, which Salon bans) |

**Every built surface is pre-Salon; every Salon-distinctive surface (Home, Documents, Forge, standalone Agents) is unbuilt.**

### 5d. Tooling fork (a required decision)

The prototype is 100% Tailwind utilities; the webapp is 100% hand-CSS. To adopt Salon:
- **Option A — adopt Tailwind:** fastest port (prototype JSX copies near-1:1) but adds build tooling the project deliberately lacks, and forces a hybrid until all 7.4k LOC of legacy CSS retires.
- **Option B — translate to CSS variables:** no new tooling (fits the stated "stable architecture over scaffolding" default; the team already uses CSS-var token sets), incremental, but prototype JSX must be hand-translated and is slower for the Salon-heavy net-new surfaces.

The visual auditor recommends **B** on architectural-fit grounds; A wins only if speed-to-pixels dominates and a permanent Tailwind dependency is acceptable. **This decision gates the whole Salon workstream and is unresolved.**

---

## 6. What's left — the full remaining-work breakdown

Organized as workstreams (W1–W6 are MVP; Forge is post-MVP).

**W1 — Structural decomposition (finish step 5).**
- `TalkDetailPage.tsx` 5347 → ≤2.5k: extract the `talk` tab (~580 LOC) + move ~2.2k LOC of controller state into custom hooks (the hard part). [In flight: A4b-2 next.]
- `SettingsPage.tsx`: extract ProfileTab, Tools/Google/WebSearch, OAuth state (~1.3k LOC).
- Delete dead code: `TalkLlmSettingsCard.tsx` (1290), disabled-attachment branches (~58).

**W2 — De-facade (step 7, ~0% done).** Migrate frontend to native greenfield shapes, then delete each backend facade (§3a, 9 facades): synthetic threads, runs-with-threadId, content md/html, snapshot compat, channels/data-connectors, talk_tools families, policy, run-context, + the duplicate-route cleanup.

**W3 — Net-new product surfaces.**
- **Home (step 9):** backend routes/accessors over `home_*` (H1, in flight) + HomePage (inbox/recommendations/news/curator/stat-strip/FTUE). Largest single surface.
- **Documents (step 6):** DocumentsPage table + full-bleed editor (doc tabs, blocks, co-editor avatars, pending-edit Accept/Reject banner) on the native model.
- **Agents page (step 7):** standalone roster + Agent profile + Team-compositions + Discover.
- **Archive view**, **New-Talk sheet (⌘N)**, **⌘K palette**, **workspace-switcher UI** (verify built vs minimal), **Settings API-keys + Tools panels** (net-new).

**W4 — Visual system (Salon).**
- Phase 0 foundation: tokens + the 4 Google fonts (build a web-font pipeline — none exists) + primitive library (RunPill/AgentAvatar/Chip/Kbd/Modal/Sheet/Popover/CTIcon/correct brand mark) + motion + density + strip Tweaks. **Decide Option A vs B first.**
- Phase 1: re-skin built surfaces (shell, Talk, Settings, Talk list, Sign-in).
- Phase 2: build Salon-only surfaces in Salon from the start (Home, Documents, Agents) — **this is why Home UI was paused** (build once, in Salon).

**W5 — Cross-cutting.**
- **Agent eval gate (LAUNCH-BLOCKING):** build `eval/` scenarios + grader prompts + `npm run eval`; v1 cannot ship without a pass. Currently contract-only.
- Density modes (cozy/compact) as a real preference; dark mode (under-specified — needs a dark palette decision); accessibility/WCAG (no spec exists); performance targets (component-size, Talk-open latency); mobile/responsive (unspecified).

**W6 — Capability gaps / partial features.**
- **Message attachments — capability REGRESSION:** `…/attachments` is a hard 501 (`worker-app.ts:1362`); chat attachments worked pre-greenfield. Decide whether to rebuild (R2 rows + composer upload + vision) or formally defer. (Saved-source + PDF-page rasterization *do* work.)
- **Jobs (step 8):** Jobs UI (create/edit/pause/resume/archive/run-now/block_reason), `emit_document_append` output path, `job_output_ready`/`job_blocked` inbox emit.
- Connectors OAuth UI for non-Google services; News-monitor tool; `notion-read` spec drift; `document_versions`/`doc_tab_coeditors` (multi-editor) unbuilt.

**Post-MVP — Forge (step 10):** entire surface (page + Document Forge tab) + runtime (improvement runs, SSR scoring, audiences, gallery, winner→pending edits) + author the placeholder `forge_rewriter`/`forge_critic` prompts. Schema ships now; build behind a flag later.

---

## 7. Magnitude estimate

There is no single honest percentage; by layer:

- **Backend / data:** ~90% (cutover done; remaining = facade deletion + Home/Forge backends).
- **Frontend structural decomposition:** ~50%.
- **De-facade:** ~0%.
- **Visual (Salon):** ~0%.
- **Product surfaces:** ~3 of ~22 (~15%).
- **Eval gate:** ~5%.

**Weighted view:** the *infrastructure* half is ~done; the *user-facing product* (surfaces + Salon + eval gate) is roughly **20–30% done**. The work remaining is dominated by net-new frontend (Home, Documents, Agents) + the entire Salon re-skin + de-facade + the launch-blocking eval gate — all of which are larger than the decomposition done so far.

---

## 8. Outstanding decisions (need a human call)

1. **Salon tooling: Tailwind (A) vs CSS-variables (B).** Gates the entire visual workstream. (Auditor leans B.)
2. **Salon sequencing:** foundation early so net-new surfaces (Home, Documents) are built Salon-native (chosen direction — Home UI already paused), vs build pre-Salon then re-skin.
3. **Message attachments:** rebuild (was a pre-greenfield capability) or formally drop for v1?
4. **Dark mode:** in scope? (prototype hints at it; no dark palette specced.)
5. **Accessibility + mobile:** both unspecified in the corpus — decide the v1 bar.
6. **Forge timing:** confirm post-MVP (schema-only now).
7. **Eval-gate ownership/timing:** it's launch-blocking and unbuilt — who builds it and when in the sequence.

---

## 9. Corrections / doc drift surfaced by this audit

- `docs/02-visual-system.md` (the Salon spec) was **overlooked in earlier planning**; it is the canonical new UI and is **0% implemented**. Its referenced paths are wrong: `ClawTalk Salon.html` + `shared/data.jsx` live at the **repo root**, not under `prototype/`; the referenced `salon.jsx` **does not exist** (atoms are in `prototype/shell.jsx`); CTIcon count drift (spec lists 28, prototype defines 26).
- **`CLAUDE.md` "Key Files" is stale:** it lists `new-executor.ts` as "CleanTalkExecutor — orchestrates a single Talk run," but that is the *retired* stub; the live orchestrator is `talks/greenfield-executor.ts`.
- **Sidebar labels mislead:** "Home" → Talk list, "Content" → in-talk doc deep links (neither surface exists).
- **`roadmap.md` self-reports `TalkDetailPage` at ~5719 LOC**; actual is **5347** (slightly further along).
- **Duplicate route registrations:** `reorderGreenfieldTalkSidebarRoute` + `getGreenfieldRunContextRoute` are mounted in both `worker-app.ts` and `greenfield-api.ts` (first-match wins; the latter copies are dead).
- **`home_inbox_items` is written but never read** (latent dead-write until Home ships).

---

## 10. For reviewers

This doc was synthesized from four parallel auditors at `96489dc`. Please verify / challenge:
1. The **denominator** (§1) — is the ~22-surface / ~12-feature V2 scope right, or is some of it already cut?
2. The **facade inventory** (§3a) — is each facade real and is the native replacement correct?
3. The **magnitude** (§7) — are the per-layer percentages defensible?
4. The **outstanding decisions** (§8) — especially Salon tooling (A vs B) and the message-attachments call.
5. Anything **still overlooked** — the explicit goal of this audit is comprehensiveness; the auditors flagged a11y, mobile, dark mode, and the eval gate as under-specified. What else is missing?
