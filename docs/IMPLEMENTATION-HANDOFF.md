# ClawTalk Implementation Handoff

> **Status:** active handoff memory · **Last updated:** 2026-06-02
> Orientation: [REFACTOR-OVERVIEW.md](./REFACTOR-OVERVIEW.md) · readiness: [IMPLEMENTATION-READINESS.md](./IMPLEMENTATION-READINESS.md) · roadmap: [roadmap.md](./roadmap.md)

## Where We Are

Worktree: `/Users/josephkim/.codex/worktrees/381b/clawtalk`

Branch: `codex/clawtalk-greenfield-cutover` (22 commits ahead of `main`).

**The backend/runtime cutover is committed.** The legacy context/runtime execution surface is retired, disabled models fail closed at chat enqueue, and the webapp shell now drives the greenfield per-request workspace model. We are in **Phase 5 (frontend rewrite)**: the workspace switcher has landed; the large remaining piece is decomposing `webapp/src/pages/TalkDetailPage.tsx` (~9.5k LOC on this branch) into greenfield feature modules.

There is **no staged/uncommitted slice**. Each slice below was committed only after passing the review gate.

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

## Next steps (in order)

1. **Backend cleanup nits** (own slice, autonomous): dedupe the `PDF_ATTACHMENT_MIME_TYPE` constant (declared in both `new-executor.ts` and `greenfield-executor.ts`), delete the now-dead `prependImageBlocks` helper + its test (greenfield uses `prependGreenfieldPdfPageImages`), and align `context_sources_prompt_lookup_idx` to the live executor query (see Open follow-ups).
2. **Human visual verification of the shell** (blocking before more frontend). Joseph runs the dev stack and confirms the shell renders and the workspace name shows top-left. Exercising the *switcher* needs a second workspace; bootstrap creates a single workspace and there is intentionally **no create-workspace flow** (it would only exist to demo the switcher — out of scope for a solo dogfooder).
3. **Decompose `TalkDetailPage.tsx`** — one isolated extraction at a time (context/sources panel or composer first), each verified visually, with per-resource React Query keys. Do **not** big-bang it; the switcher slice ballooned to 6 Codex review rounds.

## Open follow-ups

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
