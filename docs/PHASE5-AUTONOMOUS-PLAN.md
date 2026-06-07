# Phase 5 Autonomous Completion Plan

> **Status:** current execution protocol · **Last updated:** 2026-06-06
> Scope: finish the current roadmap work packages with parallel Codex + Claude/Opus runs. Forge remains post-MVP unless Joseph explicitly pulls it forward. Orientation: [roadmap.md](./roadmap.md) · audit: [REFACTOR-AUDIT.md](./REFACTOR-AUDIT.md).

## 1. Purpose

The refactor is now less about backend cutover and more about finishing the product surface: Salon, Documents, Home, de-facade, structural cleanup, and the eval gate.

The operating goal is to minimize human-in-the-loop work without letting agents wander. The unit of work is a scoped `/goal` in each tool, not an informal "continue the refactor" prompt.

For Claude/Opus runs on branchy lanes, the agent runs under `/effort ultracode` so it auto-orchestrates a dynamic workflow (parallel subagents) per substantial slice — see §2.0 and §2.3. The workflow may discover sub-slices and reorder low-risk tasks, but it must stay inside the parent goal’s scope, preserve the human-gate rules, echo its subagent evidence into the transcript, and finish with the review gate (§3). The bare word "workflow" no longer triggers anything.

## 2. Goal Protocol

Every Codex and Claude/Opus workstream is one scoped `/goal`, not an informal "continue the refactor" prompt. This section is the contract every prompt in §7 inherits.

### 2.0 Session setup (do this once, before the first `/goal`)

A `/goal` runs unattended only if the session is configured for it. For a Claude/Opus implementation lane, set the **unattended trifecta** before pasting the goal:

1. **Auto mode / auto-accept** — tool calls within a turn run without a per-call prompt. Without this, every command pauses for Joseph.
2. **`/effort ultracode`** — sends xhigh reasoning effort AND makes Claude auto-orchestrate a dynamic workflow (parallel subagents) for each *substantial* slice, instead of waiting to be asked. Run this for branching surface lanes (Salon, Documents, Home, de-facade hunt, surface completion). **Skip it for linear single-file or docs-only slices** (e.g. the Phase 0 docs-drift fix, deleting the zero-importer `TalkLlmSettingsCard.tsx`) — there a single high-effort agent is cheaper and the transcript stays clean.
3. **`/goal <condition>`** — paste the packet (below). Setting the goal **starts the first turn immediately**; there is no separate kickoff prompt.

Together: high-effort, self-orchestrating, fully unattended turns that stop only when the evaluator confirms the completion condition. **This trifecta IS the minimize-human-in-the-loop mechanism** named in §1.

**Codex lanes:** there is no `/effort`/ultracode/dynamic-workflow concept in Codex (it is Claude-Code-only). Use auto/unattended mode + the same transcript-checkable, turn-bounded `/goal` packet, and omit the Orchestration line below.

How `/goal` actually works (Claude Code v2.1.139+): after **every turn**, a fast model reads **only this conversation** and judges the condition — it does **not** run commands, read files, view images, or look inside subagents. "no" → Claude takes another turn using the evaluator's reason as guidance; "yes" → the goal clears. So a condition is checkable **only if Claude's own output in the transcript demonstrates it**. One goal is active per session — a new `/goal` replaces the prior one and resets its counters; a bare `/goal` only prints status; `/goal clear` (or `/clear`) clears it.

### 2.1 Goal packet format

```text
/goal
Objective: one concrete outcome.
Scope: the exact files/modules the agent may edit.
Non-goals: nearby work explicitly out of scope.
Done-when (transcript-checkable): ONE measurable end state the after-every-turn
  evaluator can confirm from THIS conversation, expressed as commands the agent
  RUNS and whose output it PASTES — e.g. "`npm --prefix webapp run typecheck`,
  `npm --prefix webapp run test`, and `npm --prefix webapp run build` all exit 0
  with their output shown above; the changed files are listed; `git status` is
  clean." Add the concrete artifacts that prove the work (file paths created,
  passing test names, grep/`rg` before/after counts, an empty queue). End with a
  bound: "or stop after N turns, reporting each turn what changed, which gate ran,
  and its exit code, and on the final turn summarize what still blocks completion."
Orchestration: how to fan out, if at all (see 2.3). Single-agent if linear.
Human gate: none, or one named decision Joseph must make (defaults in §5 settle most).
Handoff: docs/status to update before marking complete (see §9).
```

Paste the **entire block as one message**. Setting the goal starts the first turn; do not send a separate "begin" prompt, and do not send a bare `/goal` first (that only prints status).

### 2.2 Writing the Done-when condition

This is the part the plan previously got wrong, so it is non-optional:

- **One end state, proven in the transcript.** The evaluator confirms only what Claude has surfaced. Phrase every criterion as a result Claude demonstrates by running a check and pasting its output: a test/build exit code, a file or LOC count, an empty `rg`, a `gh run` conclusion. Never a subjective or visual judgement.
- **A goal whose Done-when is subjective never finishes.** "Looks good", "is Salon-native", "risky abstractions reduced", "renders useful state", "no text overlap" cannot be confirmed from text and will loop to the bound or be gamed by an agent that merely asserts them. **Subjective and visual sign-off belongs to the milestone human gate (§5 'Human visual gates'), not the `/goal` condition.** Where a visual property must gate auto-completion, replace it with a transcript-provable proxy — e.g. an `rg --salon-*` count proving tokens are applied, plus a screenshot saved to a named path and *described in words* (the evaluator reads the description, never the image).
- **Always bound the loop.** Every Done-when ends with "or stop after N turns and hand off". Right-size N: docs/review ~10, structural/Salon ~25, de-facade ~20. The bound turns an unverifiable condition into a clean handoff instead of an infinite loop. If a goal hits its bound unmet, resume with `--continue` (the condition carries, the counter resets) after a quick skim of the handoff — do not rewrite the prompt. For a fully hands-off slice, launch headless: `claude -p "/goal <packet>"` runs to completion.
- **Reviews fold into Done-when.** Per §3, the *implementing* agent self-invokes the review gate and surfaces each PASS/FAIL into the transcript; the Done-when is not met until they are surfaced PASS (or blocking findings fixed / documented false-positive). Joseph is not in that loop.
- **A review/audit goal's Done-when is the surfaced note.** A review produces no green command, so its only transcript-verifiable end state is the written artifact: "a severity-ordered findings note with file/line refs and an explicit PASS or FAIL recommendation has been posted in this conversation." These are single-agent tasks — no orchestration.

### 2.3 Orchestration (Claude/Opus only)

- Under `/effort ultracode`, Claude **auto-plans a dynamic workflow for each substantial slice** — you do not need a per-prompt cue. Do **not** write the bare word "workflow" as a trigger; it was renamed to "ultracode" and now fires nothing. For a one-off risky slice inside an otherwise-linear session, invoke one explicitly with the **`ultracode`** keyword in the Objective, or write "Orchestration: fan out subagents".
- **Echo evidence into the main transcript.** The `/goal` evaluator cannot see inside subagents — only the workflow's returned result reaches the main session. So when a workflow runs, the orchestrator MUST echo each subagent's verification evidence (commands run, exit codes, `rg` hit counts, verdicts, screenshot paths) into this conversation before the turn ends, or the Done-when can never see it. Model: `/goal` is the outer turn loop; a dynamic workflow is inner parallel depth within one turn; the orchestrator surfaces the inner evidence outward.
- **Name the pattern and bound it.** State which pattern applies and cap it: *fan-out* (independent finders by modality), *pipeline* (one stage per disjoint surface), *adversarial-verify* (N=2 skeptics per ambiguous candidate, kill on majority-refute), *loop-until-dry* (discover consumers until a pass returns clean), *completeness-critic* (confirm every scope item has typecheck+test evidence before completing).
- **Be honest where orchestration is NOT warranted.** Linear single-file authoring (a Salon token file, one eval scenario), docs-only audits, and small-diff reviews are single-agent — say so in the Orchestration line and do not wrap them in a workflow. Reserve fan-out for genuinely branchy lanes (the de-facade hidden-consumer hunt, multi-surface completion).

### 2.4 Rules

- **One goal equals one workstream, one session, one worktree.** Only one `/goal` is active per session; setting a new one replaces the prior and clears its progress, so never drive two lanes from one session. If scope expands, close the current goal with a handoff and start a new one.
- The goal is not complete until implementation, the transcript-checkable verification, the §3 reviews (surfaced PASS), and doc/status updates (§9) are all done.
- A code goal that touches UI surfaces a transcript-checkable proof (typecheck/test/build exit 0, plus `npm --prefix webapp run test:e2e` where a flow can be driven headless). Screenshots feed the **milestone human gate (§5)** only — they are never part of a Done-when, because the evaluator does not view images.
- A deletion goal needs an enumerated consumer `rg` (paste before/after counts) plus a test/build gate; for a facade with more than one candidate consumer or any dynamic/registration-indirect access, run an adversarial-verify sweep and echo each verdict (see §2.3).
- **No admin merge past known-red CI.** Backend CI is green again after the legacy cleanup, so red checks are blockers unless the failing job is unrelated and explicitly justified. Make this checkable: paste `gh run list --branch <branch> --limit 1 --json conclusion,status` showing `conclusion=success` in the handoff.

### 2.5 Worked example (a real Phase 2 slice)

```text
/goal
Objective: Delete the orphaned TalkLlmSettingsCard.tsx (1,290 LOC, zero importers) from the webapp.
Scope: webapp/src — remove the component file and any now-dead local references it leaves behind.
Non-goals: TalkDetailPage/SettingsPage extraction, Salon work, behavior changes to any live surface.
Done-when (transcript-checkable):
  `rg -l TalkLlmSettingsCard webapp/src` returns ONLY the file being deleted before
  removal (output pasted), and returns nothing after; the file is deleted;
  `npm --prefix webapp run typecheck` exits 0, `npm --prefix webapp run test` shows
  the same-or-higher pass count with none skipped, and `npm --prefix webapp run build`
  exits 0 — all three outputs shown above; `git status` lists only the deletion;
  `gh run list --branch <branch> --limit 1 --json conclusion,status` shows
  conclusion=success; and the §3 reviews are surfaced PASS in this conversation.
  Or stop after 10 turns, reporting each turn what ran and its exit code, and on the
  final turn name the consumer or red gate that blocks deletion.
Orchestration: single-agent. One importer grep proves this orphan dead — no workflow.
Human gate: none.
Handoff: update docs/REFACTOR-AUDIT.md §4a (drop the orphan row) and the deletion ledger; list grep counts, gate outputs, CI conclusion, and the three review results.
```

(That slice is linear, so it runs without `/effort ultracode`. A branchy slice — e.g. the Phase 5 de-facade hunt where `threadId` lives in 16 frontend files — runs under `/effort ultracode`, fans out hidden-consumer finders by modality, and echoes each finder's `rg` evidence into the transcript so the Done-when can confirm "every modality reported dry".)

## 3. Required Review Gate

The review gate is **self-invoked by the implementing agent and folded into its `/goal` done-when** — the goal does not complete until the required review verdicts are surfaced PASS in **this** conversation (or every blocking finding is fixed / documented as a false positive). **Joseph is not in this loop.** The `/goal` evaluator reads only the main transcript and runs nothing, so the agent MUST run each review skill and paste its PASS/FAIL line and blocking findings inline; a verdict recorded only in the handoff file does not count.

The depth of the gate scales with slice risk. Do not run the heavy gate on a trivial slice, and never skip the heavy gate on a risky one.

### 3a. Tier the slice first

Classify the slice before choosing the gate:

- **Trivial** — single-file or docs-only, no deletion, no schema, no behavior-preserving extraction (e.g. one Salon token, a one-importer-proven orphan delete, a copy fix). Runs single-agent.
- **Risky** — facade/route deletion, schema/migration, behavior-preserving extraction from a god file (`TalkDetailPage.tsx` / `SettingsPage.tsx`), or any change with non-obvious hidden consumers. Runs the implementer's `/goal` under `/effort ultracode`; the cross-model review plus a failure-mode skeptic sweep run as orchestrated verify steps, not separate human-run passes.

### 3b. Gate by tier (fold these clauses into the implementation `/goal` done-when)

**Trivial slice — light gate:**

1. `/code-review --effort high` on the working tree; paste the verdict and any blocking findings inline.
2. `/karpathy-audit diff` on the current diff; paste blocking findings inline.

The done-when clause: *"…and `/code-review --effort high` and `/karpathy-audit diff` are both surfaced PASS in this conversation (or each blocking finding is fixed, diff shown, or marked false-positive with reason)."*

**Risky slice — heavy gate, run inside the implementer's dynamic workflow:**

1. **Structural / behavior review** — gstack `/review` (bundles a Codex adversarial pass) for the PR-style structural read.
2. **Style review** — `/karpathy-audit diff` on the diff.
3. **Cross-model review (real, different-model skill)** — run `/codex review` from a Claude session (or `/claude review` from a Codex session); a genuinely different model reviews and its PASS/FAIL + findings are surfaced inline. A same-model skeptic pass cannot replace this.
4. **Failure-mode skeptic sweep (deletion / behavior-preserving extraction only, orchestrated)** — as a verify stage of the slice's dynamic workflow, fan out skeptic subagents that hunt the slice's specific failure mode (hidden consumers for a deletion; behavior drift across a tab unmount for an extraction; CAS/version violations for an edit path), then **echo each skeptic's command, output, and verdict into the main transcript** — the `/goal` evaluator cannot see inside subagents, so an un-echoed verdict is invisible to the loop.

The done-when clause: *"…and gstack `/review`, `/karpathy-audit diff`, the cross-model `/codex review` (or `/claude review`), and—for a deletion/extraction—the failure-mode skeptic sweep are all surfaced PASS in this conversation, with any subagent evidence echoed inline; every blocking finding is fixed (diff shown) or marked false-positive with reason; and the run is bounded — stop after the slice's turn bound and hand off the open findings if any review still blocks."*

### 3c. Rules

- **No standalone reviewer session for routine slices.** The implementer self-invokes its own gate. Spin up a dedicated second session only for the **milestone `ultra` pass** (`/code-review --effort ultra`, multi-agent cloud review of the branch) at the §5 milestone boundaries — not per slice. This keeps the §4 lane table for file-ownership only; it does not mean a second live agent babysits every slice.
- **Codex lanes** keep the same gate semantics: a Codex-implemented slice runs `/claude review` (the Codex-side skill that launches Claude Code to review) for its cross-model pass, surfaces the verdict in its own transcript, and folds it into its `/goal` done-when.
- **The cross-model pass is a real installed skill on both sides — run it from the *implementer's* session so the *other* model reviews:** in a Claude/Opus session, `/codex review` (the gstack `/codex` wrapper → launches Codex); in a Codex session, `/claude review` (→ launches Claude Code). This is distinct from `/code-review`, which is the same model reviewing its own diff.
- A blocking finding the agent cannot fix in-scope does not silently pass: it is named in the handoff and the goal completes only via the turn bound, flagging the unresolved review as the blocker.

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
```

### Phase 1. Salon Foundation

Start here before Home/Documents/Agents UI work. Claude/Opus owns visual implementation; Codex reviews and may take structural test/build fixes after the Opus branch exists.

Run mode (set once, before pasting the goal): enable auto tool-approval, then run `/effort ultracode` so substantial sub-slices auto-orchestrate dynamic workflows (xhigh effort + parallel subagents). Paste the whole `/goal` block below as a single message — setting the goal starts the first turn immediately; do not send a separate kickoff prompt and do not send a bare `/goal` (that only prints status).

Claude/Opus:

```text
/goal
Objective: Build the Salon visual foundation for ClawTalk without changing product behavior.
Scope: webapp styling (webapp/src/styles.css token block + new webapp/src/salon/** primitive files), font loading (Newsreader, Geist, Geist Mono), brand mark, Salon primitives, and the small call-site migrations needed to prove the primitives. New worktree only: .claude/worktrees/<branch>.
Non-goals: Home implementation, native Documents implementation, dark mode, Forge, broad TalkDetailPage/SettingsPage refactors, the de-facade work, or Tailwind unless Joseph explicitly overrides the CSS-variable default (docs/REFACTOR-AUDIT.md §5, PHASE5 §5).
Done-when (transcript-checkable — the evaluator reads ONLY this conversation, runs nothing, and views no images; every criterion below is an end state I prove by running a command and pasting its output here):
  1. I have pasted the output of `npm --prefix webapp run typecheck` (0 errors), `npm --prefix webapp run test` (0 failures, pass count >= the count on main, no test deleted/skipped to go green), and `npm --prefix webapp run build` (exit 0).
  2. I have pasted a primitive inventory: for RunPill, Chip, Kbd, Modal, Sheet, Popover, AgentAvatar, and the shared button/input, the file path under webapp/src/salon/** and one `rg` line proving its real call-site in a migrated existing screen.
  3. I have pasted `rg -n "\-\-salon-(paper|ink|accent)" webapp/src/styles.css` showing the canonical tokens (--salon-paper #FBF7EF, --salon-ink #1F1B16, --salon-accent #C8643A per docs/02-visual-system.md) are defined, and `rg -c "Newsreader|Geist" webapp/src` showing the font wiring landed.
  4. I have pasted `npm --prefix webapp run test:e2e` output (Playwright, headless — its result is text in this transcript) for the migrated screens, OR, if no e2e spec covers them, an explicit textual responsive-QA report I produced: per migrated screen, the measured rendered width at 390px and 1280px viewports and "overlap=none" (state the element pairs I checked). Screenshots are saved to listed paths for Joseph's milestone gate but are NOT the completion evidence (the evaluator cannot read them).
  5. I have pasted the PASS line from each required review (PHASE5 §3, heavy gate): gstack `/review` (bundles a Codex adversarial pass), `/karpathy-audit diff`, and the cross-model `/codex review` (gstack `/codex` → launches Codex to review this Claude-built branch) — with every blocking finding either fixed (diff shown) or marked false-positive with a reason.
  6. I have pasted `gh run list --branch <branch> --limit 1 --json conclusion,status` showing conclusion=success.
  Bound: report progress each turn (what shipped, which gate ran, exit code); stop and hand off after 25 turns or 60 minutes even if unmet, naming the red gate / remaining primitives. If I hit the bound, Joseph resumes with --continue (the condition carries, the turn counter resets) — do not rewrite the prompt.
Human gate: only if CSS variables genuinely cannot support a primitive and a Tailwind decision is required (PHASE5 §5). Visual taste / "Salon-native" sign-off is NOT in this condition — it is the milestone human visual gate after the Salon foundation (PHASE5 §5 'Human visual gates').
Orchestration: ultracode. This slice branches, so orchestrate it — but only where parallel depth pays: (a) fan-out to author the independent primitives in parallel (one subagent per primitive, since RunPill/Chip/Kbd/Modal/Sheet/Popover/AgentAvatar touch disjoint files); (b) fan-out the responsive-QA across the migrated screens at the two viewports; (c) an adversarial-verify pass with N=2 skeptic subagents that, per new primitive, check "does this duplicate an existing component (grep the old styles)?" and "does swapping it into its call-site break that screen?" and kill any primitive a skeptic refutes. Keep the linear token/font-file authoring (the styles.css token block, font @imports, brand mark) SINGLE-AGENT — fanning that out is pure ceremony. The /goal evaluator cannot see inside subagents, so the orchestrator MUST echo each subagent's evidence (commands run, exit codes, rg counts, measured widths, skeptic verdicts) back into THIS main conversation before turn end, or criteria 1-4 above will not be visible to the evaluator.
Handoff: Update docs/roadmap.md and docs/REFACTOR-AUDIT.md §0/§5 if status changed; list primitives shipped (path + call-site), files touched, screenshot paths, tests run, the three review outcomes, and the `gh run` conclusion. Use the live roadmap and goal summary — do not create a worktree-specific handoff doc.
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
```

### Phase 3. Native Documents

Codex should build/verify API and data paths when needed; Claude/Opus owns the Salon-native UI/editor.

Status update, 2026-06-07: the Codex backend unblocker branch adds native `/api/v1/documents` routes and typed `webapp/src/lib/api.ts` methods for list/detail tabs+blocks+pending edits plus edit/run/all accept/reject. Remaining Phase 3 product work is the Salon-native Documents page/editor and in-Talk doc pane consuming this native path; do not extend the `bodyMarkdown`/`bodyHtml` facade for that UI.

> **Run mode (Claude/Opus, set once before pasting the goal):** put the session in unattended mode — (1) enable auto / auto-accept so tool calls within a turn run without per-call prompts; (2) run `/effort ultracode` so Claude sends xhigh reasoning effort and **auto-orchestrates a dynamic workflow for each substantial slice** of this lane. This is the most net-new, branchy build in Phase 5, so run the whole Documents (D) lane under `/effort ultracode` rather than per-prompt keywords. Then paste the block below as a single message — setting the goal starts the first turn immediately; do not send a separate kickoff prompt and do not send a bare `/goal` (that only prints status). The bare word "workflow" no longer triggers anything; orchestration comes from `/effort ultracode` (or the literal keyword `ultracode` for a one-off slice).

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
Objective: Build the Salon-native Documents page/editor and in-Talk document pane on the native Documents API (documents/doc_tabs/doc_blocks/document_edits), without reintroducing markdown/html content facades.
Scope: Documents route/page, editor shell, tab/block rendering, pending-edit review UI (view/accept/reject honoring the document_edits CAS/version-bump rules), in-Talk doc pane, and related webapp tests. Reference docs/02-visual-system.md and docs/prototypes/ClawTalk Salon.html for Salon tokens/primitives.
Non-goals: Reintroducing markdown/html content facades, Forge winner gallery, broad Salon token redesign, backend schema invention, or editing TalkDetailPage controller bulk beyond mounting the in-Talk pane.

Orchestration (this session is /effort ultracode): orchestrate this build as a dynamic-workflow PIPELINE of slices — (1) Documents route/page shell, (2) tab/block editor rendering, (3) pending-edit accept/reject interactions, (4) in-Talk doc pane, (5) responsive QA — discovering sub-slices within each stage as needed. Per stage, run an adversarial-verify pass (a skeptic subagent that re-reads the diff for missed states / broken CAS handling) and, before completion, a completeness critic that confirms every Flow-checklist item below has a passing test and every required element is present in a DOM snapshot. Stay inside this goal's scope. ECHO each subagent's evidence back into THIS main conversation — the exact commands run, their exit codes, the names of the tests that passed, and the saved screenshot paths — because the after-every-turn evaluator reads ONLY this transcript and runs nothing; it cannot see inside subagents.

Done-when (transcript-checkable — the evaluator runs nothing and views no images, so prove each item by surfacing output here):
  - I have pasted output showing `npm --prefix webapp run typecheck` (0 errors), `npm --prefix webapp run test` (0 failures; pass count >= the pre-work count, no test deleted or skipped to go green), and `npm --prefix webapp run build` (exit 0).
  - I have pasted `npm --prefix webapp run test:e2e` (Playwright, headless) output, or the targeted Documents UI test names, covering this Flow checklist — each item asserted by a passing test whose name I list here:
      [ ] open the Documents page and render its tab list and blocks from native tables
      [ ] open the in-Talk document pane and render the same native content (no markdown/html facade read)
      [ ] view a pending edit (document_edits row) in the review UI
      [ ] accept a pending edit -> block/tab version bumps per CAS rule; stale-version accept is rejected (conflict path asserted)
      [ ] reject a pending edit -> edit clears, block content unchanged
  - I have pasted the file paths of the new route/page, editor shell, and in-Talk pane components, and run `rg "bodyMarkdown|bodyHtml" webapp/src` over the Documents surface and shown it returns no NEW facade reads (state before/after counts).
  - I have saved desktop (1280px) and mobile (390px) screenshots of the Documents page and in-Talk pane to listed paths and described them in one line each for Joseph's milestone visual gate. (Salon-native styling and visual responsiveness are JUDGED at that milestone human gate (§5), NOT by this condition — here I only prove the screenshots exist and that the new components reference `--salon-*` tokens via `rg "--salon-" <new component files>`.)
  - The required review gate is surfaced PASS in this conversation: gstack `/review`, `/karpathy-audit diff`, and the cross-model `/codex review` (gstack `/codex` → launches Codex to review this Claude-built branch) — each with its PASS/FAIL line and every blocking finding either fixed (diff shown) or marked false-positive with reason.
  - `gh run list --branch [branch] --limit 1 --json conclusion,status` shows conclusion=success (output pasted).
Bound: report progress each turn (what changed, which gate/stage ran, exit codes). Stop and hand off after 25 turns or 60 minutes even if unmet, summarizing the remaining Flow-checklist items and what blocks them. If a turn bound is hit with work remaining, resume with --continue (the condition carries; the counter resets) — do not rewrite the prompt.

Human gate: only for an editor interaction choice not covered by docs/02-visual-system.md, docs/prototypes/ClawTalk Salon.html, or the canonical Documents spec; otherwise pick the simplest accept/reject UX matching the prototype and note the choice in the handoff — do not stop to ask.
Handoff: Update docs/roadmap.md and docs/REFACTOR-AUDIT.md if status changed; list the Flow-checklist items verified with their test names, screenshot paths, facade-read grep before/after, the three review outcomes, and the CI conclusion.
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
Status note: the current Phase 5 backend branch adds job `emit_document_append` and `job_output_ready` inbox/outbox producers; Home UI surfacing is still separate from this backend note.
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
Objective: Adversarially prove the de-facade branch deleted no facade that still has a live consumer, then post a severity-ordered findings note with an explicit PASS or FAIL. This is the load-bearing safety review for facade deletion: a single sequential read misses consumers reached by dynamic key, route registration, or test-only path, so run it as an orchestrated multi-modality hunt, not a manual pass.
Scope: Read/grep across the whole webapp/src and src trees plus the de-facade diff and the deletion ledger; run backend (`npm run typecheck`, `npm run test`) and webapp (`npm --prefix webapp run typecheck`, `npm --prefix webapp run test`, `npm --prefix webapp run build`) gates; make fixes ONLY if a deletion is proven unsafe and the fix is a one-line restore/migrate inside the Codex branch's scope. Do not author new product surfaces or re-skin anything.
Non-goals: Re-adding compatibility layers unless deletion is proven unsafe; rewriting the deletion strategy; visual/Salon work; expanding scope beyond the facade tokens in the ledger.
Facade tokens to clear (from §3a / G5): synthetic threadId, runs/messages-with-threadId DTO fields, native run-context fabrication, flat content markdown/html projections (bodyMarkdown/bodyHtml), snapshotVersion compat, policy/tool/connectors facades, and the duplicate Hono mounts reorderGreenfieldTalkSidebarRoute + getGreenfieldRunContextRoute.

Orchestration (run this slice with the keyword "ultracode" so Claude auto-orchestrates a dynamic workflow; do NOT run it as one sequential pass — the bare word "workflow" triggers nothing): fan out independent hidden-consumer FINDER subagents, one per detection MODALITY, over every facade token still referenced in the diff or ledger:
  1. literal token grep (rg the exact identifiers across webapp/src and src),
  2. import-trace (who imports the moved/deleted module or its re-exports),
  3. route-registration trace (every Hono mount of the affected handler — dump the route table, do NOT trust grep, because first-match-wins duplicate mounts hide live ones; threadId-adjacent example: reorderGreenfieldTalkSidebarRoute and getGreenfieldRunContextRoute are mounted in BOTH worker-app.ts and greenfield-api.ts (defined in greenfield-core.ts / greenfield-detail.ts)),
  4. test-reference trace (test fixtures/asserts that read the old shape — e.g. ClawTalkSidebar.test.tsx, LiveResponsePanel.test.tsx, api.test.ts, threadScroll.test.ts on the webapp side),
  5. dynamic/string-key trace (string-built field access, DTO key reads, cache routers — wsCacheRouter.ts is a known INDIRECT threadId consumer that a grep on the "moved" files alone will miss).
Dedup the union of candidate consumers across modalities. Then ADVERSARIAL-VERIFY: spawn N=2 skeptic subagents ONLY for AMBIGUOUS candidates (dynamic-key, route-registration, or test-only hits) to confirm/refute each is a live runtime consumer — a single rg already proves the literal-grep hits, so do not burn skeptics on those. Loop the finders UNTIL DRY: re-run a modality if a skeptic surfaces a new reference, and clear a facade only when every modality reports zero live consumers and skeptics agree. A completeness critic confirms every ledger facade has been run through all five modalities before you stop.
ECHO REQUIREMENT: the /goal evaluator reads ONLY this main transcript and never sees inside subagents, so the orchestrator MUST paste back into THIS conversation, per facade token: the exact rg command(s) and their hit counts, the route-table dump for any mounted handler, and each skeptic's verdict. Workflow-internal evidence that is not echoed does not count.

Done-when (transcript-checkable; the evaluator runs nothing and judges only what is pasted here):
  - For every facade token above, the echoed grep/route-table/skeptic evidence in this transcript shows zero non-test consumers (any remaining hit is inside a deletion-ledger comment or a test that was rewritten/removed in this branch), AND for the duplicate mounts a route-table dump confirms exactly one live mount each; AND
  - The pasted output of `npm run typecheck`, `npm run test`, `npm --prefix webapp run typecheck`, `npm --prefix webapp run test`, and `npm --prefix webapp run build` all show exit 0 / no failures (no test deleted or skipped to make them pass); AND
  - The review gate is surfaced PASS in this transcript: gstack `/review` (bundles a Codex adversarial pass) and `/karpathy-audit diff` — and because the de-facade branch was Codex-built, this Claude/Opus pass IS the cross-model adversarial review (the mirror of `/claude review` on the Codex side) — with any blocking finding either fixed (diff shown) or marked false-positive with reason; AND
  - A severity-ordered findings note has been posted in THIS conversation listing each facade, its modality evidence, any missed consumer found, and an explicit overall PASS or FAIL recommendation.
  Bound: report progress each turn (which facade cleared, which modality ran, exit codes); stop and hand off after 20 turns or 45 minutes even if unmet, posting the partial findings note and naming exactly which facade/modality is unproven and why.

Human gate: none — only stop for Joseph if a facade still has a real product-surface consumer with no specified native replacement.
Handoff: Post the findings note inline (do not write a new handoff doc); update docs/REFACTOR-AUDIT.md §3a deletion ledger only if a facade's consumer status changed; include the echoed grep commands, route-table dumps, gate outputs, and the three review outcomes per §3.
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
```

### Review Prompt Templates

The implementer pastes these as the **verify turns of its own `/goal`**, not as a separate human-run step. They surface the verdicts the done-when checks for.

Light gate (trivial slice — paste both, surface verdicts inline):

```text
/code-review --effort high
```

```text
/karpathy-audit diff
```

Heavy gate (risky slice — structural + style + cross-model, plus a deep skeptic sweep for deletions/extractions):

```text
/review
```

```text
/karpathy-audit diff
```

```text
/codex review
```

(From a Codex session this is `/claude review` — a real, different-model review. Paste its PASS/FAIL and findings inline. For deletions/extractions, also run the deep skeptic sweep below.)

```text
ultracode: As the verify stage of this slice (deletion or behavior-preserving extraction only), adversarially review [branch] against main for the slice's specific failure mode. For a deletion: fan out skeptic subagents by consumer-discovery MODALITY (literal token grep, import-trace, route-registration trace, test-reference trace, dynamic/string-key trace) and clear the facade only when every modality reports dry. For a behavior-preserving extraction: assert that an in-flight mutation resolving AFTER a tab switch still lands in page-owned state, and that the existing characterization suite passes with an unchanged pass count. Echo each subagent's commands, exit codes, grep counts, and verdict into THIS conversation. Then return findings ordered by severity with file/line references and an explicit PASS or FAIL.
```

Milestone-only ultra pass (dedicated reviewer session at §5 boundaries, not per slice):

```text
/code-review --effort ultra
```

Review handoff:

```text
Review gate (tier: trivial|risky):
- /code-review (or gstack /review for risky): PASS/FAIL, summary, blocking findings fixed or deferred.
- /karpathy-audit diff: PASS/FAIL, summary, blocking findings fixed or deferred.
- Cross-model review (`/codex review` from Claude, or `/claude review` from Codex): PASS/FAIL, blocking findings fixed or deferred.
- Failure-mode skeptic sweep (deletion/extraction only): PASS/FAIL, skeptic evidence echoed, blocking findings fixed or deferred.
- Milestone /code-review --effort ultra (milestone boundaries only): PASS/FAIL, reviewer session, blocking findings.
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
