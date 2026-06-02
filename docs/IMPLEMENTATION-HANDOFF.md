# ClawTalk Implementation Handoff

> **Status:** active handoff memory · **Last updated:** 2026-06-02
> Orientation: [REFACTOR-OVERVIEW.md](./REFACTOR-OVERVIEW.md) · readiness: [IMPLEMENTATION-READINESS.md](./IMPLEMENTATION-READINESS.md) · roadmap: [roadmap.md](./roadmap.md)

## Where We Are

Worktree: `/Users/josephkim/.codex/worktrees/381b/clawtalk`

Branch: `codex/clawtalk-greenfield-cutover`

Current state: one large backend/runtime slice is staged and uncommitted. Do not start the next implementation phase until this slice passes its required review gate and is committed.

The staged slice retires the remaining legacy context/runtime execution surface:

- Fresh baseline schema adds `talk_agent_snapshots.provider_id`, `messages.metadata_json`, and private `message_provider_replay`.
- Provider replay blobs are stripped from member-readable message metadata and persisted only in `message_provider_replay`.
- Replay read/write scope is source-agent + frozen snapshot provider/model, with a shared byte budget.
- Runtime events/API identity use frozen `talk_agent_snapshots.provider_id/model_id`.
- Active source refs are raw `context_sources.id::text`; legacy `meta_json.sourceRef` remains only as a compatibility alias.
- `new-executor.ts` keeps shared tool/image helpers and makes `CleanTalkExecutor` fail closed with `LEGACY_EXECUTOR_RETIRED`.
- Scheduled/run-now job snapshot creation skips non-target roster agents whose provider is unavailable, while still blocking if the target provider is unavailable.

## Verification Already Done

After the latest job-snapshot fix:

- `CLAWTALK_ALLOW_UNSUPPORTED_NODE=1 npm run test -- src/clawtalk/web/routes/greenfield-jobs.test.ts`
  - Pass: 28 tests.
- Broad staged-slice suite:
  - Pass: 12 files, 199 tests.
  - Covered provider replay scope/budget, fail-closed retired executor gate, queue consumer provider replay privacy, greenfield executor history/replay behavior, context readiness, schema invariants, and route contracts.
- `npm run typecheck`
  - Pass.
- `npm run build`
  - Pass.
- `git diff --cached --check`
  - Pass.
- Claude Review
  - Clean on compact staged-slice artifact.
- Karpathy diff review
  - Local traceability review clean.
  - Codex CLI-backed attempt could not complete because Codex CLI usage quota was exhausted.
- GStack Review
  - First review found one P2: job snapshot creation could insert a null provider for a disabled non-target roster agent.
  - Finding was fixed and covered with manual run-now + scheduled claim regression tests.
  - Required rerun is blocked by Codex CLI usage quota until 2026-06-07 08:23 America/Los_Angeles.

## What Is Left Before Continuing Implementation

1. Re-run GStack Review on the staged diff after the Codex CLI quota resets.
2. If GStack is clean, commit the staged slice:

   ```bash
   git commit -m "refactor: retire legacy context runtime"
   ```

3. If GStack finds an issue:
   - Patch only that issue.
   - Rerun the focused relevant tests.
   - Rerun `npm run typecheck`, `npm run build`, and `git diff --cached --check`.
   - Rerun Claude Review, Karpathy diff review, and GStack Review.
   - Commit only after the review loop is clean.

After the commit, the next implementation phase should begin the webapp/Talk rewrite against final greenfield APIs. Do not start frontend implementation before the staged backend/runtime slice is committed.

## Resume Prompt

Use this prompt to resume implementation:

```text
Continue the ClawTalk greenfield refactor from /Users/josephkim/.codex/worktrees/381b/clawtalk on branch codex/clawtalk-greenfield-cutover.

First read docs/IMPLEMENTATION-HANDOFF.md, docs/IMPLEMENTATION-READINESS.md, docs/REFACTOR-OVERVIEW.md, and docs/roadmap.md.

Do not start a new implementation slice yet. The current backend/runtime retirement slice is staged and locally verified. Re-run the required GStack Review gate now that Codex CLI quota should be available. Also honor the standing per-slice process: GStack Review, Karpathy diff review, and Claude Review before commit.

If GStack Review is clean, commit the staged slice with:
  git commit -m "refactor: retire legacy context runtime"

If GStack Review finds an issue, patch only that issue, rerun focused tests plus npm run typecheck, npm run build, git diff --cached --check, then rerun GStack Review, Karpathy diff review, and Claude Review. Commit only when clean.

After that commit, continue autonomously into the next implementation phase: webapp/Talk rewrite against final greenfield APIs. Stop only for human verification, destructive external actions, or unresolved product decisions.
```
