# ClawTalk Implementation Handoff

> **Status:** active handoff memory · **Last updated:** 2026-06-02
> Orientation: [REFACTOR-OVERVIEW.md](./REFACTOR-OVERVIEW.md) · readiness: [IMPLEMENTATION-READINESS.md](./IMPLEMENTATION-READINESS.md) · roadmap: [roadmap.md](./roadmap.md)

## Where We Are

Worktree: `/Users/josephkim/.codex/worktrees/381b/clawtalk`

Branch: `codex/clawtalk-greenfield-cutover` (29 commits ahead of `main`).

**The backend/runtime cutover is committed.** The legacy context/runtime execution surface is retired, disabled models fail closed at chat enqueue, and the webapp shell now drives the greenfield per-request workspace model. We are in **Phase 5 (frontend rewrite)**: the workspace switcher has landed, the **fresh-project cutover runbook** is written (`docs/CUTOVER-RUNBOOK.md`), and `TalkDetailPage.tsx` decomposition has started (State card deleted: 9538→9367 LOC). **The shell + Slice 1 were visually verified in the local dev stack on 2026-06-03** (workspace name top-left; a Talk's Context tab renders Goal / Rules / Saved Sources / Bound Drive Resources with no State card).

There is **no staged/uncommitted slice**. Each slice below was committed only after passing the review gate.

**Review-gate mechanics in this worktree (important).** The gstack `/review` and `/karpathy-audit` skills `git diff` the **cwd**, which is the *main* checkout, not this worktree — so invoking them via the Skill tool reviews the wrong tree. The working substitute for the cross-model adversarial pass is **`codex exec review --uncommitted`** run from inside the worktree (it reviewed Slice 1's staged diff and returned a clean verdict). Apply Karpathy's four principles to the diff by inspection. `codex` is at `~/.bun/bin/codex` (v0.125.0).

## Review Gate (per slice)

Exactly two passes, run against the staged diff (`git diff --cached`):

1. **gstack `/review`** — bundles a Claude adversarial subagent **and** a Codex (cross-model) adversarial pass. Honor a Codex `block`: adjudicate it (real? in-scope? introduced by this slice?), don't dismiss. The Codex pass repeatedly catches behavioral defects Claude's pass misses (e.g. the in-flight cross-workspace last-write-wins race on the switcher slice).
2. **`/karpathy-audit diff`** — Karpathy's four principles on the diff (style/traceability).

No third standalone "Claude review" — `/review` already contains it. Commit only when both gates are clean or findings are fixed/justified. (Set by Joseph 2026-06-02.)

## Slices committed this session

| Commit    | Slice                                                                                                                                                                                                                                |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `951ab34` | **refactor: retire legacy context runtime.** Fresh-baseline `talk_agent_snapshots.provider_id` / `messages.metadata_json` / private `message_provider_replay`; replay blobs stripped from member-readable metadata and persisted only in `message_provider_replay` with source-agent + frozen-snapshot scope and a shared byte budget; runtime/API identity reads frozen snapshot `provider_id`/`model_id`; active source refs are raw `context_sources.id::text`; `CleanTalkExecutor` fails closed with `LEGACY_EXECUTOR_RETIRED` (`new-executor.ts` keeps only the shared tool/image helpers); job snapshot creation skips non-target roster agents whose provider is unavailable while still blocking if the target provider is unavailable. |
| `6c40fb7` | **fix: gate disabled models at chat enqueue (fail closed like jobs).** Chat roster resolution filters `llm_provider_models.enabled = true`, so a disabled/retired model yields a null `provider_id` and the existing guard returns `agent_model_not_found` — matching the job path's `loadRoster`. Gated at snapshot creation (not the executor) to preserve frozen identity. |
| `5bb6712` | **feat(webapp): workspace switcher + per-request workspace scoping.** Sidebar switcher backed by the greenfield per-request model: no persisted active workspace; the client tracks it in a localStorage marker and sends `x-workspace-id` on every workspace-scoped request (without overriding an explicit `?workspaceId=`). Switching validates via POST, records the marker, and does a clean reload that discards in-flight old-workspace requests. Persist buster is workspace-scoped; `getSessionMe` self-heals a stale marker (`workspace_forbidden` → clear + retry); sign-out clears it. |
| `464e1d7` | **fix(dev): point webapp proxy + wrangler dev at :8788.** `vite.config.ts` proxy target stale `3210`→`8788` + pinned `wrangler dev` to `:8788` via `[dev] port` (bare wrangler defaults to 8787). Dev-only. |
| `decf546` | **docs: fresh-project cutover runbook** (`docs/CUTOVER-RUNBOOK.md`). Ordered, copy-pasteable; from-zero `db reset` re-validated locally. Surfaces the silent W7-gate no-op + the password-less `clawtalk_event_hub` role / `DB_EVENT_HUB_URL` gotcha. |
| `563e17f` | **refactor(webapp): delete retired Context State card** (first `TalkDetailPage.tsx` decomposition slice; 9538→9367 LOC). Removed `TalkStateCard` + `getTalkState`/`deleteTalkStateEntry` + `TalkStateEntry` + state/effect/render + dead `.talk-state-*` CSS + 7 tests + mock wiring. `resyncTalkState` (unrelated) left intact. `codex exec review` clean. |

## Next steps (in order)

1. ✅ **DONE (2026-06-03) — visual verification of the shell + Slice 1.** Confirmed live in the local dev stack: workspace name top-left; a Talk's Context tab renders Goal / Rules / Saved Sources / Bound Drive Resources with **no State card**. The local-login 403 fix (`CLAWTALK_ALLOWED_ORIGINS` incl. `http://localhost:5173`) is now in the worktree's gitignored `.dev.vars`, so future local-dev login works after `npm run db:start` + `dev:worker` + `dev:web`. **Slice 2 (below) is the next actionable step.** (Exercising the *switcher* would need a second workspace; there is intentionally **no create-workspace flow**.)
2. **Slice 2 — extract `TalkContextPanel` (Context Goal + Rules)** → new `webapp/src/components/TalkContextPanel.tsx` (house pattern: panels live in `components/`). **Move with it (verified context-only):** `sortRulesByOrder`, `buildRuleDraftMap`, `reorderRules`, `RuleRow` (TalkDetailPage `~1754-1845`). **Panel owns:** `goalDraft`, `newRuleText`, `ruleDrafts`, `ruleSensors`, a mutation status, and the 6 handlers (`handleSaveGoal`/`handleAddRule`/`handleToggleRule`/`handleSaveRuleText`/`handleDeleteRule`/`handleRuleReorder`). **Props:** `talkId, goal, rules, setGoal(=setContextGoal), setRules(=setContextRules), canEdit, onUnauthorized`; render `key={talkId}` for clean draft reset. **Page keeps:** `contextGoal`/`contextRules` (the **`activeRuleCount` tab badge at ~6866 reads `contextRules`, so it must stay page-owned**), `contextSources` (composer-coupled — do NOT touch), `contextLoaded`, `refreshContext`, and the loading/error gate; render gate → `<TalkContextPanel/>` → `<SavedSourcesPanel/>` → `<TalkToolsPanel/>`.
   - **TRAP 1 — `ruleDrafts` hydration.** `refreshContext` rebuilds `ruleDrafts` unconditionally on every load/poll (`~3319`), but the mutation handlers update `ruleDrafts` **surgically** and never rebuild-all. A naive `useEffect(() => setRuleDrafts(buildRuleDraftMap(rules)), [rules])` would clobber other rows' in-progress edits on every `setRules` (save/add/delete/poll) — a regression. Hydrate on mount (keyed by `talkId`) + surgically in handlers; do **not** reactively rebuild from the `rules` prop.
   - **TRAP 2 — `contextStatus` is shared.** One status serves the load gate (loading/error, top), the `'saving'` disables, **and** the success message rendered at the TAB BOTTOM (`~7518`, after SavedSources/TalkTools). Either (a) split page load-status from panel mutation-status and move the success message into the panel (minor, arguably-better UX), or (b) keep one status in the page and thread `status`+`setStatus` to preserve exact message position. Pick (a) for cleaner decoupling; note the UX delta.
   - `goalDraft` hydrates once on mount from `goal` (panel renders only after the load gate, so `goal` is populated); do not re-hydrate on `goal` changes (matches the current `hydrateGoalDraft`-only-on-initial-load).
   - Verify: webapp typecheck + test (the Context goal/rules tests should pass unchanged if behavior is preserved) + build + `codex exec review --uncommitted`.
3. **Iterate other low-coupling seams.** The composer is last (30+ tangled deps). `SavedSourcesPanel` stays pinned to lifted `contextSources` until the composer/sources untangle (which is also when `['talk-context', talkId]` React-Query ownership can be introduced cleanly — the bundled `getTalkContext` returns sources, which the composer reads, so an RQ key can't be added without touching the composer).

## Open follow-ups

- **Orphaned backend `/state` compat routes.** After Slice 1 (`563e17f`) deleted the frontend State card, `GET /api/v1/talks/:talkId/state` (empty stub) + `DELETE /api/v1/talks/:talkId/state/:key` in `greenfield-api.ts` (~1105/1117) + `getGreenfieldTalkStateRoute` have no remaining caller. Removable in a backend-cleanup slice (left out of the frontend slice to avoid pulling in the red-by-design legacy backend test suite).
- **webapp raw-UUID source refs.** `SavedSourcesPanel.tsx` (~553) and `SourceMentionPicker.tsx` (~172) now render raw UUIDs because `sourceRef = context_sources.id`. Needs a human-readable display.
- **`selectProviderReplayMessageIds` budget/break unit test.** The shared byte-budget walk lacks a focused unit test for the budget-exceeded break.
- **Provider-level disablement.** Neither chat enqueue nor the job path checks `llm_providers.enabled` (only `llm_provider_models.enabled`). Gate at both roster joins **only if** provider-level disablement becomes real.
- **Dead legacy context loader.** `context-loader.ts`'s `loadTalkContext` / `fetchSources` / `buildContextTools` are now referenced only by tests — the live runtime uses `greenfield-executor.ts`'s `loadGreenfieldContextSources` / `loadGreenfieldContextSourceForRead`. Candidate for a dedicated retirement slice (large file + two big test files; not a drive-by).

## Resume Prompt

```text
Continue the ClawTalk greenfield cutover from /Users/josephkim/.codex/worktrees/381b/clawtalk on branch
codex/clawtalk-greenfield-cutover — NOT the main checkout.

First read memory [[greenfield-cutover-active]] + [[two-gate-review-process]], then docs/REFACTOR-OVERVIEW.md,
docs/IMPLEMENTATION-HANDOFF.md, docs/roadmap.md. Verify doc claims against `git log` before trusting them.

The backend/runtime cutover is committed (legacy context runtime retired, disabled-model fail-closed enqueue,
workspace switcher). No staged slice. Per-slice gate = gstack /review (bundles Codex adversarial — honor block
verdicts) + /karpathy-audit diff. Commit only when both are clean or findings fixed/justified.

Current phase is the frontend rewrite (Phase 5). Before building more frontend, get Joseph's visual verification
of the shell. Then decompose webapp/src/pages/TalkDetailPage.tsx ONE isolated extraction at a time, each verified
visually. Do NOT big-bang it and do NOT build a create-workspace flow.

Backend slices: prettier pre-commit runs format:fix on src/ + scripts/ only — run `npm run format:fix && git add -u`
before commit. Backend tests: `CLAWTALK_ALLOW_UNSUPPORTED_NODE=1 npm run test -- <file>` (local node is v22).
```
