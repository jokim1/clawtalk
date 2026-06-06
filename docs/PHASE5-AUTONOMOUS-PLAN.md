# Phase 5 Autonomous Completion Plan

> **Status:** current execution protocol · **Last updated:** 2026-06-06
> Scope: finish the current roadmap work packages with parallel Codex + Claude/Opus runs. Forge remains post-MVP unless Joseph explicitly pulls it forward. Orientation: [roadmap.md](./roadmap.md) · audit: [REFACTOR-AUDIT.md](./REFACTOR-AUDIT.md).

## 1. Purpose

The refactor is now less about backend cutover and more about finishing the product surface: Salon, Documents, Home, de-facade, structural cleanup, and the eval gate.

The operating goal is to minimize human-in-the-loop work without letting agents wander. The unit of work is a scoped `/goal` in each tool, not an informal "continue the refactor" prompt.

For Claude/Opus runs, prefer dynamic workflows when the work naturally branches. The workflow can discover sub-slices, reorder low-risk tasks, and adapt implementation details, but it must still stay inside the parent goal's scope, preserve the human gate rules, and finish with the review gate below.

## 2. Goal Protocol

Every Codex and Claude/Opus workstream starts with a goal packet:

```text
/goal
Objective: one concrete outcome
Scope: files/modules the agent may edit
Non-goals: nearby work explicitly out of scope
Acceptance: behavior, deletion criteria, and docs status
Verify: exact commands, tests, and browser checks
Human gate: none, or one named decision needed from Joseph
Handoff: what to update before marking complete
```

Rules:

- One goal equals one workstream. If scope expands, close the current goal with a handoff and start a new one.
- Claude/Opus may use a dynamic workflow inside the goal to create sub-goals or revise sequencing as it learns more. The dynamic workflow must record the chosen sub-slices in the handoff and cannot silently expand the parent goal.
- The goal is not complete until implementation, verification, and doc/status updates are done.
- A code goal that touches UI needs a browser or screenshot check when the surface can be run locally.
- A deletion goal needs both a consumer grep and a test/build gate.
- No admin merge past known-red CI. Backend CI is green again after the legacy cleanup, so red checks are blockers unless the failing job is unrelated and explicitly justified.

## 3. Required Review Gate

After every autonomous development slice, run three reviews before landing or marking the goal complete:

1. **gstack PR review** — use the gstack PR review feature for a structural PR-style review.
2. **Karpathy audit diff** — run the Karpathy audit diff skill/workflow and address blocking findings.
3. **Adversarial cross-model review** — if Codex implemented the slice, run `/claude review`; if Claude/Opus implemented the slice, run `/codex review`.

The slice is not done until blocking findings are fixed or explicitly documented as false positives/out of scope. Include the three review outcomes in the goal handoff.

## 4. Parallel Lanes

Use separate worktrees for simultaneous runs. Keep ownership boundaries sharp.

| Lane | Primary owner | Work | Reviewer |
|---|---|---|---|
| S | Claude/Opus | Salon tokens, primitive library, visual implementation of new surfaces | Codex review |
| C | Codex | Structural cleanup, orphan deletion, route/facade cleanup, backend/API work | Claude/Opus review |
| D | Claude/Opus | Native Documents UI and editor interactions | Codex review |
| H | Split | Home backend in Codex, Home UI in Claude/Opus after Salon foundation | Cross-review both ways |
| E | Codex | Eval harness, scenarios, graders, `npm run eval` | Claude/Opus review |

Avoid editing the same files across lanes. If two lanes need the same primitive or API type, land the shared foundation first.

## 5. Default Decisions

These defaults are chosen to reduce Joseph interrupts. Override only when code reality disproves them or Joseph gives a different call.

| Decision | Default |
|---|---|
| Salon tooling | Use CSS variables + existing Vite/React CSS pipeline. Do not add Tailwind unless Joseph explicitly chooses speed-to-port over stack simplicity. |
| Salon sequencing | Build the foundation before Home/Documents/Agents so net-new surfaces are Salon-native. |
| Message attachments | Defer chat attachments from v1 unless multimodal chat upload becomes a launch requirement. Keep context file/PDF ingestion as the supported source-material path. |
| Forge | Post-MVP. Keep schema and docs, do not block v1 surface completion on Forge. |
| Dark mode | Post-light-Salon. Do not invent a dark palette while the light system is unimplemented. |
| Mobile/accessibility | v1 bar: no overlapping text, responsive layout for phone/tablet widths, keyboard operability for command surfaces, semantic buttons/labels. Full WCAG pass is a separate goal. |
| Human visual gates | Milestone-level only: after Salon foundation, after native Documents, after Home, before launch. |

## 6. Work Packages

### G0. Docs Drift

- Archive stale audits/runbooks/plans.
- Update root docs and live docs to point at `REFACTOR-AUDIT.md`, `roadmap.md`, and this file.
- Run stale-reference grep before finishing.

### G1. Salon Foundation

- Add tokens, font loading, brand mark, primitives, and migration notes.
- Verify no one-off palette dominates the app and no text overlaps at desktop/mobile widths.
- Gate: webapp typecheck, tests/build, browser screenshot checks.

### G2. Structural Cleanup

- `TalkDetailPage.tsx`: extract the Talk tab shell and page-owned controller hooks until the file is near the 2.5k LOC target.
- `SettingsPage.tsx`: extract Profile, Tools/Google/WebSearch, and OAuth state.
- Delete orphaned `TalkLlmSettingsCard.tsx` after a repo-wide importer grep.
- Gate: targeted component tests, webapp typecheck/test/build.

### G3. Native Documents

- Add native Documents page/editor and in-Talk doc pane over `documents`/`doc_tabs`/`doc_blocks`/`document_edits`.
- Delete the content markdown/html compatibility facade only after the final consumer moves.
- Gate: document edit accept/reject tests, API tests, webapp tests/build, browser check.

### G4. Home

- Implement read/write accessors and routes for deterministic Inbox, recommendations, news, and lifecycle actions.
- Build Home in Salon from the start.
- Gate: backend tests for item lifecycle/idempotency, webapp tests/build, browser check.

### G5. De-facade

- Maintain a deletion ledger: facade, current consumers, native replacement, deletion test.
- Remove synthetic `threadId`, native run context fabrication, policy/tool/connectors facades, duplicate Hono mounts, and flat content projections as consumers leave.
- Gate: grep proves no consumers, route tests removed or rewritten, full relevant test suites green.

### G6. Product Surface Completion

- Standalone Agents page/profile, Archive, New Talk sheet, command palette, Settings API key/workspace-member gaps.
- Gate: interaction tests and browser smoke for each user-facing flow.

### G7. Eval Gate

- Create `eval/` with scenario JSON, grader prompts, harness CLI, report output, and thresholds.
- Add `npm run eval`.
- Gate: eval dry run on a local seeded workspace and documented pass/fail semantics.

## 7. Phased Prompt Pack

Use these as copy/paste starting prompts. Replace bracketed placeholders with the branch/worktree name and any file findings from the first repo scan. Do not run two implementation goals against the same files at the same time. Every prompt inherits the review gate in §3.

### Phase 0. Launch Prep

Run this once before parallel implementation if the docs or local checkout may have drifted.

Codex:

```text
/goal
Objective: Prepare the current main branch for autonomous Phase 5 implementation.
Scope: docs/README.md, docs/roadmap.md, docs/REFACTOR-AUDIT.md, docs/PHASE5-AUTONOMOUS-PLAN.md, TODOS.md only.
Non-goals: Product code changes, visual redesign, feature implementation, or reopening archived planning docs.
Acceptance: Live docs point to the current audit/roadmap/phase plan; stale root docs are archived or clearly marked historical; TODOs contain only current actionable work.
Verify: git diff --check; grep docs for stale T-new root references, old cutover bypass language, old LOC counts, archived readiness/handoff docs from live orientation paths.
Human gate: none unless two live docs give contradictory current-state claims that cannot be resolved from code.
Handoff: List archived/updated docs, unresolved documentation risks, and the next implementation phase to launch.
```

Claude/Opus:

```text
/goal
Objective: Independently audit the Phase 5 execution docs for ambiguity before autonomous implementation starts.
Scope: docs/REFACTOR-AUDIT.md, docs/roadmap.md, docs/PHASE5-AUTONOMOUS-PLAN.md, docs/DECISIONS.md.
Non-goals: Editing product code or expanding MVP scope.
Acceptance: Any ambiguity that would cause agent drift is either fixed in docs or captured as an explicit Joseph decision.
Verify: Read the live docs, compare work-package ordering and gates, and produce a concise findings/handoff note.
Human gate: only for product scope conflicts, not wording or sequencing fixes.
Handoff: Include recommended launch order and any prompt edits made.
Dynamic workflow: Use sub-slices for scope audit, verification audit, and prompt audit; keep them inside this docs-only goal.
```

### Phase 1. Salon Foundation

Start here before Home/Documents/Agents UI work. Claude/Opus owns visual implementation; Codex reviews and may take structural test/build fixes after the Opus branch exists.

Claude/Opus:

```text
/goal
Objective: Build the Salon visual foundation for ClawTalk without changing product behavior.
Scope: webapp styling, font loading, brand mark, Salon primitives, and small call-site migrations needed to prove the primitives.
Non-goals: Home implementation, native Documents implementation, dark mode, Forge, broad TalkDetailPage refactors, or Tailwind unless Joseph explicitly overrides the CSS-variable default.
Acceptance: Salon tokens exist; brand/font setup is wired; core primitives exist for RunPill, Chip, Kbd, Modal, Sheet, Popover, AgentAvatar, and shared buttons/inputs; migrated examples render without text overlap at desktop and mobile widths.
Verify: npm --prefix webapp run typecheck; npm --prefix webapp run test; npm --prefix webapp run build; browser screenshots for representative existing screens at desktop and mobile widths.
Human gate: only if CSS variables cannot support the implementation and a Tailwind decision is required.
Handoff: Update docs/roadmap.md and docs/REFACTOR-AUDIT.md if status changes; list primitives shipped, files touched, screenshots taken, tests run, and review outcomes.
Dynamic workflow: Split internally into tokens/fonts, primitives, call-site proof, and responsive QA. Reorder those sub-slices as needed, but do not implement net-new product surfaces.
```

Codex:

```text
/goal
Objective: Review and harden the Salon foundation branch for integration correctness.
Scope: The Salon branch diff, related tests, and docs touched by the implementation branch.
Non-goals: Redesigning the visual direction, adding net-new surfaces, or expanding beyond defects found in review.
Acceptance: Blocking build/type/test issues are fixed; risky abstractions or duplicated primitives are reduced; visual concerns are documented for Joseph only when they require taste decisions.
Verify: npm --prefix webapp run typecheck; npm --prefix webapp run test; npm --prefix webapp run build; browser smoke if fixes affect rendered UI.
Human gate: only for subjective visual direction calls.
Handoff: Include fixed issues, residual risks, and the three required review results.
```

### Phase 2. Structural Cleanup

Run in parallel with Salon only if it avoids Salon-owned files. Codex owns implementation.

Codex:

```text
/goal
Objective: Reduce TalkDetailPage and SettingsPage structural risk without changing behavior.
Scope: TalkDetailPage tab shell/controller extraction, SettingsPage Profile/Tools/OAuth extraction, orphan deletion candidates, targeted tests.
Non-goals: Visual redesign, Home/Documents feature work, backend schema changes, or changing chat/runtime behavior.
Acceptance: TalkDetailPage moves materially toward the 2.5k LOC target through behavior-preserving components/hooks; SettingsPage sections are extracted; TalkLlmSettingsCard is deleted only if importer grep proves it is orphaned; tests cover extracted behavior.
Verify: importer grep for deleted files; npm --prefix webapp run typecheck; targeted webapp tests; npm --prefix webapp run test; npm --prefix webapp run build.
Human gate: none unless extraction exposes contradictory behavior that needs product direction.
Handoff: Update roadmap/audit LOC and deletion ledger; list tests, grep results, and review outcomes.
```

Claude/Opus:

```text
/goal
Objective: Adversarially review the structural cleanup branch for behavior drift and UI regressions.
Scope: The cleanup branch diff and affected Talk/Settings flows.
Non-goals: Rewriting the extraction strategy unless a concrete bug requires it.
Acceptance: Identify blocking behavior drift, missing tests, stale imports, or UI regressions; verify fixes or mark findings false positive/out of scope.
Verify: Review diff against main; inspect affected components; run targeted tests when needed.
Human gate: none.
Handoff: Findings with file/line references and pass/fail recommendation.
Dynamic workflow: Split review by Talk, Settings, deletion safety, and test coverage.
```

### Phase 3. Native Documents

Codex should build/verify API and data paths when needed; Claude/Opus owns the Salon-native UI/editor.

Codex:

```text
/goal
Objective: Implement or harden the native Documents API/data path needed by the Documents UI.
Scope: documents/doc_tabs/doc_blocks/document_edits accessors, routes, tests, and compatibility-facade deletion only when consumers have moved.
Non-goals: Large visual editor design, Forge, Home recommendations, or unrelated runtime cleanup.
Acceptance: Native document read/write/edit review flows use greenfield tables; accept/reject paths enforce CAS/version rules; content markdown/html facade has a deletion ledger and is deleted only after consumer grep passes.
Verify: targeted backend/API tests for document read, edit proposal, accept, reject, conflict, and permissions; npm run typecheck; relevant npm run test subset.
Human gate: only for unresolved editor product semantics not specified in docs.
Handoff: Document API shapes changed, facade deletion status, tests, and review outcomes.
```

Claude/Opus:

```text
/goal
Objective: Build the Salon-native Documents page/editor and in-Talk document pane on the native Documents API.
Scope: Documents route/page, editor shell, tab/block rendering, pending edit review UI, in-Talk doc pane, related webapp tests.
Non-goals: Reintroducing markdown/html content facades, Forge winner gallery, broad Salon token redesign, or backend schema invention.
Acceptance: Users can open Documents, view tabs/blocks, see pending edits, accept/reject edits, and use the in-Talk document pane; UI is responsive and Salon-native.
Verify: npm --prefix webapp run typecheck; targeted document UI tests; npm --prefix webapp run test; npm --prefix webapp run build; browser screenshots for Documents and in-Talk pane at desktop/mobile widths.
Human gate: only for editor interaction choices not covered by docs.
Handoff: Update roadmap/audit; list flows verified, screenshots, tests, and review outcomes.
Dynamic workflow: Split into route shell, editor rendering, pending edit interactions, in-Talk pane, and responsive QA.
```

### Phase 4. Home

Codex owns backend/accessors; Claude/Opus owns Salon UI after the foundation branch lands.

Codex:

```text
/goal
Objective: Implement Home backend routes/accessors over native home_* data without frontend facade shortcuts.
Scope: home item accessors, routes, lifecycle actions, recommendation/news/inbox read models, tests, and docs status.
Non-goals: Salon UI implementation, Forge, unrelated scheduler rewrites, or new recommendation algorithms beyond the current deterministic contract.
Acceptance: Home API exposes inbox, recommendations, news, and lifecycle actions with idempotent behavior and permissions; job_blocked/job_output_ready can surface where specified.
Verify: targeted backend tests for read models, lifecycle idempotency, permissions, and job-related items; npm run typecheck; relevant npm run test subset.
Human gate: only if docs conflict on Home ranking/action semantics.
Handoff: API contract changes, tests, unresolved product questions, and review outcomes.
```

Claude/Opus:

```text
/goal
Objective: Build the Salon-native Home page on the native Home API.
Scope: Home route/page, inbox/recommendation/news surfaces, action lifecycle UI, empty/loading/error states, related webapp tests.
Non-goals: Backend algorithm changes, Forge, broad navigation redesign beyond what Home needs, or dark mode.
Acceptance: Home renders useful current workspace state, supports item lifecycle actions, handles empty/loading/error states, and is responsive at desktop/mobile widths.
Verify: npm --prefix webapp run typecheck; targeted Home UI tests; npm --prefix webapp run test; npm --prefix webapp run build; browser screenshots for populated and empty states.
Human gate: only for subjective ranking/content-density decisions.
Handoff: Update roadmap/audit; list tested states, screenshots, and review outcomes.
Dynamic workflow: Split into route shell, data integration, card/action states, responsive QA, and polish.
```

### Phase 5. De-facade

Run after native consumers exist. Codex owns deletion work.

Codex:

```text
/goal
Objective: Delete remaining compatibility facades after native consumers have moved.
Scope: synthetic threadId consumers, native run-context fabrication, flat content markdown/html projections, snapshot compat, policy/tool/connectors facades, duplicate Hono mounts, tests, and deletion ledger.
Non-goals: New product surfaces, broad visual work, schema churn without a deletion need, or deleting a facade with live consumers.
Acceptance: Each deleted facade has a native replacement, consumer grep, removed/rewritten tests, and no runtime fallback path still depending on the old shape.
Verify: targeted rg checks for each facade token; backend/API tests for replaced routes/accessors; npm run typecheck; npm run test where shared runtime changed; webapp gates if frontend consumers changed.
Human gate: only if a facade still has a real product consumer and the replacement behavior is unspecified.
Handoff: Update docs/REFACTOR-AUDIT.md deletion ledger and roadmap; include grep commands, tests, and review outcomes.
```

Claude/Opus:

```text
/goal
Objective: Adversarially review the de-facade branch for hidden consumers and user-visible regressions.
Scope: The de-facade diff, route/API changes, and affected frontend flows.
Non-goals: Re-adding compatibility layers unless deletion is proven unsafe.
Acceptance: Find missed consumers, broken API assumptions, missing migration tests, or user-flow regressions; verify fixes or document false positives.
Verify: Diff review, targeted rg checks, and targeted tests where needed.
Human gate: none.
Handoff: Findings with file/line references and pass/fail recommendation.
Dynamic workflow: Review by facade family: thread/run, content, snapshot, policy/tool/connectors, route mounts.
```

### Phase 6. Product Surface Completion

Split by file ownership after Salon, Documents, and Home are stable.

Codex:

```text
/goal
Objective: Fill remaining non-visual product/API gaps needed for MVP surfaces.
Scope: Agents/Profile APIs, Archive data paths, New Talk creation flow backend, command palette action plumbing, Settings API-key/workspace-member gaps, targeted tests.
Non-goals: Reworking completed Home/Documents architecture, Forge, or broad visual polish.
Acceptance: Remaining MVP surfaces have native data paths, permissions, and tests; no new facade dependency is introduced.
Verify: targeted backend/API tests; npm run typecheck; relevant npm run test subset; webapp gates for touched client action plumbing.
Human gate: only for workspace-member/admin product semantics not specified in docs.
Handoff: Update roadmap/audit; list shipped gaps, tests, and review outcomes.
```

Claude/Opus:

```text
/goal
Objective: Build or polish remaining Salon-native MVP surfaces.
Scope: standalone Agents page/profile, Archive UI, New Talk sheet, command palette UI, Settings surface gaps, responsive/browser QA.
Non-goals: Backend schema invention, Forge, dark mode, or redesigning completed Home/Documents flows.
Acceptance: Each surface is usable, responsive, keyboard-operable for primary actions, and has empty/loading/error states where applicable.
Verify: npm --prefix webapp run typecheck; targeted UI tests; npm --prefix webapp run test; npm --prefix webapp run build; browser screenshots/smoke for each surface.
Human gate: milestone-level visual review only unless a missing product decision blocks implementation.
Handoff: Update roadmap/audit; list surfaces, screenshots, tests, and review outcomes.
Dynamic workflow: Create sub-slices per surface and execute low-coupling surfaces in the safest order.
```

### Phase 7. Eval Gate

Codex owns the harness. Claude/Opus reviews scenario quality and failure usefulness.

Codex:

```text
/goal
Objective: Implement the MVP eval gate for ClawTalk.
Scope: eval/ scenarios, grader prompts, harness CLI, report output, npm script wiring, docs/eval-suite.md updates, and CI/docs notes if needed.
Non-goals: Replacing unit/integration tests, broad product refactors, or building Forge evals beyond post-MVP placeholders.
Acceptance: npm run eval exists; scenarios cover core Talk execution, Documents edit flows, Jobs output, Home surfacing, and critical permissions; report output has pass/fail semantics and thresholds.
Verify: npm run eval on a local seeded workspace or documented dry-run fixture; npm run typecheck; targeted harness tests if present.
Human gate: only for threshold choices that materially affect launch/no-launch.
Handoff: Update roadmap/audit and docs/eval-suite.md; include scenarios, thresholds, run output, and review outcomes.
```

Claude/Opus:

```text
/goal
Objective: Review the eval gate for product coverage and actionable failure reports.
Scope: eval scenarios, grader prompts, report format, docs/eval-suite.md, and any changed harness code.
Non-goals: Rewriting the harness unless a concrete coverage or correctness issue requires it.
Acceptance: Eval scenarios map to MVP launch risks; grader prompts are specific and non-generic; failures identify the user-visible behavior to fix.
Verify: Read scenarios/prompts, inspect dry-run output, and run npm run eval if locally available.
Human gate: only for launch-threshold product calls.
Handoff: Findings, recommended scenario additions/removals, and pass/fail recommendation.
Dynamic workflow: Review by launch risk: Talk, Documents, Jobs, Home, permissions, and report quality.
```

### Review Prompt Templates

Use these after each implementation slice, in addition to gstack PR review and Karpathy audit diff.

Codex implemented, Claude/Opus reviews:

```text
/claude review
Review [branch] against main adversarially. Focus on behavioral regressions, hidden coupling, missed tests, deletion safety, and user-visible breakage. Do not suggest broad refactors unless they block correctness. Return findings ordered by severity with file/line references, then a pass/fail recommendation.
```

Claude/Opus implemented, Codex reviews:

```text
/codex review
Review [branch] against main adversarially. Focus on correctness, architecture drift, test gaps, stale imports/consumers, API contract violations, and whether the implementation stayed inside its /goal scope. Return findings ordered by severity with file/line references, then a pass/fail recommendation.
```

Review handoff:

```text
Review gate:
- gstack PR review: PASS/FAIL, summary, blocking findings fixed or deferred.
- Karpathy audit diff: PASS/FAIL, summary, blocking findings fixed or deferred.
- Cross-model adversarial review: PASS/FAIL, reviewer, blocking findings fixed or deferred.
- Residual risks:
- Docs updated:
```

## 8. Verification Matrix

| Change type | Required verification |
|---|---|
| Backend/API | `npm run typecheck`, targeted backend tests, broader `npm run test` when shared runtime changes. |
| Webapp structure | `npm --prefix webapp run typecheck`, targeted tests, `npm --prefix webapp run test`, `npm --prefix webapp run build`. |
| Visual/UI | Webapp gates plus browser screenshots at desktop and mobile widths. |
| Facade deletion | Consumer grep, route/accessor tests updated, backend + webapp gates if API shapes changed. |
| Any autonomous development slice | Relevant tests plus the required review gate: gstack PR review, Karpathy audit diff, and adversarial cross-model review. |
| Docs only | `git diff --check` plus stale-reference grep. |

## 9. Handoff Standard

Every goal finishes by updating:

- `docs/roadmap.md` if a state or gate changed.
- `docs/REFACTOR-AUDIT.md` if an audited gap closed or a new gap appeared.
- The relevant canonical spec doc only when target behavior changed.
- Goal handoff notes with: tests run, gstack PR review result, Karpathy audit diff result, adversarial cross-model review result, and any deferred non-blockers.

Do not create new worktree-specific handoff docs. Use the active goal summary and the live roadmap instead.
