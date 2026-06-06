# Phase 5 Autonomous Completion Plan

> **Status:** current execution protocol · **Last updated:** 2026-06-06
> Scope: finish roadmap steps 5-9 with parallel Codex + Claude/Opus runs. Forge remains post-MVP unless Joseph explicitly pulls it forward. Orientation: [roadmap.md](./roadmap.md) · audit: [REFACTOR-AUDIT.md](./REFACTOR-AUDIT.md).

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

## 7. Verification Matrix

| Change type | Required verification |
|---|---|
| Backend/API | `npm run typecheck`, targeted backend tests, broader `npm run test` when shared runtime changes. |
| Webapp structure | `npm --prefix webapp run typecheck`, targeted tests, `npm --prefix webapp run test`, `npm --prefix webapp run build`. |
| Visual/UI | Webapp gates plus browser screenshots at desktop and mobile widths. |
| Facade deletion | Consumer grep, route/accessor tests updated, backend + webapp gates if API shapes changed. |
| Any autonomous development slice | Relevant tests plus the required review gate: gstack PR review, Karpathy audit diff, and adversarial cross-model review. |
| Docs only | `git diff --check` plus stale-reference grep. |

## 8. Handoff Standard

Every goal finishes by updating:

- `docs/roadmap.md` if a state or gate changed.
- `docs/REFACTOR-AUDIT.md` if an audited gap closed or a new gap appeared.
- The relevant canonical spec doc only when target behavior changed.
- Goal handoff notes with: tests run, gstack PR review result, Karpathy audit diff result, adversarial cross-model review result, and any deferred non-blockers.

Do not create new worktree-specific handoff docs. Use the active goal summary and the live roadmap instead.
