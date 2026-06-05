# Phase 5 Autonomous Completion Plan — Opus 4.8 × Codex 5.5

> Goal-oriented plan to finish the greenfield frontend rewrite (roadmap steps 5–9) with
> two models running as autonomously as possible. Backend cutover (steps 1–4) is done + live.
> Forge (step 10) is out of scope. Orientation: [roadmap.md](./roadmap.md) ·
> [IMPLEMENTATION-HANDOFF.md](./IMPLEMENTATION-HANDOFF.md).

## 1. Goal & Definition of Done

The refactor is **done** when:

- `TalkDetailPage.tsx` (now 7830 LOC) is decomposed to **≤ ~2.5k LOC**, with every major surface
  (composer, thread+streaming, agents/connectors/runs/jobs/context tabs, documents) in a
  **presentational component or hook** — page-owned state, props in (the proven Slice 2/4 shape).
- `SettingsPage.tsx` (3243 LOC) is decomposed the same way (provider config, AiAgents, registered agents).
- The frontend reads **native greenfield shapes**, not the backend compat facades
  (synthetic threads, runs-with-threadId, content-md/html), wherever a surface has been rewritten.
- **Documents UI** (step 6) runs on `documents`/`doc_tabs`/`doc_blocks`/`document_edits`.
- Every slice: characterization tests green + full webapp suite green + **codex-clean** + Karpathy pass.
- `docs/roadmap.md` step 5–9 gates flip to ✅.

Measurable burn-down: **LOC of the two god-files** + **count of compat-facade reads remaining** + **roadmap step gates**.

## 2. The split (conflict-free, both models always busy)

Two big files that share no code → two parallel worktrees, no edit collisions.

| Track | Owner | Surface | Reviewer |
| --- | --- | --- | --- |
| **A — critical path** | **Opus 4.8** (Claude Code) | `TalkDetailPage.tsx` + its panels | Codex (`codex exec review`) |
| **B — parallel** | **Codex 5.5** (`codex exec`) | `SettingsPage.tsx` + small follow-ups | Opus (review pass) |

Rule: **Track A never touches `SettingsPage.tsx`; Track B never touches `TalkDetailPage.tsx`.** Each is a
separate worktree off `codex/clawtalk-greenfield-cutover`. Land Track A first when a slice touches shared
components (rare) — otherwise they merge independently.

## 3. The autonomous per-slice loop (the engine — both tracks)

0. **Orient** (once per session): read this file + [IMPLEMENTATION-HANDOFF.md](./IMPLEMENTATION-HANDOFF.md)
   §"Review Gate" + the Slice 2/4 lessons + memory `[[greenfield-cutover-active]]`,
   `[[two-gate-review-process]]`. **Verify every claim against code before trusting it** (the handoff/memory
   have been wrong — e.g. "context-loader = 3 dead fns" was actually a whole dead file).
1. **Characterize** — before a risky extraction, *add* webapp tests that pin the behaviors the slice could
   break (send flow, streaming reducer transitions, @-mention, guardrail block, tab-switch persistence).
   These tests are the autonomy lever — they replace the per-slice human eyeball.
2. **Extract** — presentational component/hook. **All state an async mutation writes stays page-owned and
   is threaded in as props** (the panel unmounts on tab switch; panel-local mutation state orphans on a
   late-resolving save/run — codex caught this 3× already). Self-fetch only pure read-only data nothing mutates.
3. **Gate**: `npm run typecheck` + `npm --prefix webapp run typecheck` + targeted/full webapp tests +
   `npm --prefix webapp run build`, all green.
4. **Cross-model review**: Track A → `~/.bun/bin/codex exec review --uncommitted` from the worktree.
   Track B → an Opus review pass on the PR. Honor blocks: adjudicate (real? in-scope? introduced here?), fix or justify.
5. **Karpathy** four principles by inspection.
6. **Ship**: `npm run format:fix` → `git add -u` → commit → push → `gh pr create --base main` →
   `gh pr merge <#> --admin --merge` → watch `deploy.yml`.
7. **Record**: update IMPLEMENTATION-HANDOFF.md slice table + roadmap gate + memory.
8. **Loop** to the next slice. Only stop for §6 milestone checks or a genuine *novel* design fork.

## 4. Track A queue (Opus — ordered)

1. **A1 · Characterization net** for the talk tab: thread timeline render, send→queue→stream→settle, @-mention
   typeahead, guardrail block, tab-switch state persistence. (Foundation for A3/A4.)
2. **A2 · Easy tab panels**: extract `agents` (~6166–6480), `connectors` (~6480), `runs` (~6514) inline tabs →
   presentational panels (proven pattern; quick LOC + risk reduction).
3. **A3 · Composer** → `TalkComposer` (presentational; page owns draft, attachments, @-mention index, send +
   guardrail state). Untangles `SavedSourcesPanel` ↔ `contextSources`.
4. **A4 · Thread + streaming** → `TalkThread` + `useTalkRunStream` hook (extract the message-list render + the
   ~500-line `talkReducer` at L819). Biggest chunk; A1 tests de-risk it.
5. **A5 · Documents UI** (step 6) → rewrite the content/editor surface onto `documents`/`doc_tabs`/`doc_blocks`;
   drop the content-md/html facade. (Design pass first — this changes a data contract, not just structure.)
6. **A6 · De-facade** → replace synthetic-thread / runs-with-threadId reads with native greenfield shapes,
   surface by surface, deleting each backend facade as its last consumer goes native.

## 5. Track B queue (Codex — ordered, independent)

1. **B1 · Settings decomposition**: extract provider-config, AiAgents, and registered-agents sections of
   `SettingsPage.tsx` (3243 LOC) into presentational panels (same rule as Track A).
2. **B2 · Small follow-ups** (from IMPLEMENTATION-HANDOFF §Open follow-ups): human-readable display for raw-UUID
   source refs (`SavedSourcesPanel`, `SourceMentionPicker`); a `selectProviderReplayMessageIds` budget/break unit
   test; provider-level disablement audit (gate at both roster joins **only if** it's a real gap).
3. **B3 · Test backfill**: characterization tests for any surface Track A hasn't reached yet.

## 6. Autonomy levers & where the human stays in the loop

**Levers (these remove Joseph from the loop):** pre-baked design rules (§3 step 2) → no design questions;
characterization tests → behavior verified by CI, not eyes; `codex exec review` → automated adversarial gate;
admin-merge-past-red-CI → no green-CI wait; behavior-preserving slices → tiny decision surface.

**Human stays in the loop only for:** (a) **milestone visual spot-checks** on clawtalk.app — after A3 (composer),
after A4 (thread), after A5 (documents), and after each Track-B Settings batch — because jsdom can't see CSS /
focus / scroll / real streaming, and a browser smoke needs Google OAuth (Joseph's hands); (b) a **genuine novel
design fork** not covered by the playbook. Everything else loops autonomously. Target: **milestone-touch, not per-slice.**

## 7. Hard rules (proven gotchas — do not relearn)

- **Worktrees**: Track A and Track B each in their own `.claude/worktrees/<name>` (or `.codex/...`) off
  `codex/clawtalk-greenfield-cutover`; absolute worktree paths on every tool call. Never edit the main checkout.
- **Review gate is `codex exec review --uncommitted` from inside the worktree** — gstack `/review` diffs the main
  checkout and can't see the worktree.
- **Shell**: one line per command, never backslash line-continuations.
- **Commit**: pre-commit `format:fix` doesn't re-stage → `npm run format:fix` then `git add -u` before commit;
  `npx prettier --write` any edited webapp file (webapp isn't in the root pre-commit).
- **Tests need Node 24**; if only Node 22 is present, prefix with `CLAWTALK_ALLOW_UNSUPPORTED_NODE=1`. This
  worktree's `node_modules` are real dirs (not symlinks), so `npm install` is safe here.
- **Deploy**: merge to main → `deploy.yml` (~1 min). Backend full suite is **red by design** (legacy tests hit
  dropped tables) → admin-merge; gate on typecheck + targeted greenfield/webapp tests, not full CI.
- **Presentational + page-owned state** is non-negotiable for tab-mounted panels (§3 step 2).
