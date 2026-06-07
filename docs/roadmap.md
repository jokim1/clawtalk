> **Status:** live implementation tracker · **Last updated:** 2026-06-06
> Orientation: [REFACTOR-OVERVIEW.md](./REFACTOR-OVERVIEW.md) · current audit: [REFACTOR-AUDIT.md](./REFACTOR-AUDIT.md) · execution protocol: [PHASE5-AUTONOMOUS-PLAN.md](./PHASE5-AUTONOMOUS-PLAN.md)

# ClawTalk Roadmap

This file is the short operational tracker for the greenfield refactor. It is not the product spec. Use `01` through `12` for target behavior, `REFACTOR-AUDIT.md` for the completion audit, and this file for what to run next.

## Current State

| Area | State | Notes |
|---|---|---|
| Backend / data cutover | ✅ Done | Greenfield runtime is live. Legacy runtime/accessors were retired, backend CI is a real signal again, and the fresh baseline is `supabase/migrations/0001_clawtalk_greenfield.sql`. |
| Frontend structure | 🔄 Mid-flight | `TalkDetailPage.tsx` is 5,429 LOC, target roughly 2,500. `SettingsPage.tsx` is 2,147 LOC. Talk panels, composer, thread view, reducer, and stream hook are extracted; the Talk tab shell and page-owned controller state remain. |
| De-facade | ⛔ Not started | Synthetic threads, runs-with-`threadId`, flat content markdown/html, snapshot compat, policy/tool/connectors facades, and duplicate route mounts still need native consumers and deletion. |
| Salon visual system | 🔄 Foundation in review (PR #547) | `webapp/src/salon/*` ships CSS-variable tokens (`--salon-*`), fonts (Newsreader/Geist/Geist Mono), brand mark, and primitives (CTMark, CTIcon, Avatar/AgentAvatar, RunPill, Chip, Kbd, Button, Input/Textarea, Modal, Sheet, Popover) with proof migrations + a `salon.test.tsx` smoke suite. Remaining: broad re-skin of the 7,284 LOC pre-Salon `webapp/src/styles.css`. |
| Jobs | 🔄 Mostly functional, not complete | Jobs backend and Talk Jobs panel cover CRUD, pause/resume, run-now, and archive/delete. Remaining gaps: `emit_document_append`, `job_output_ready`, and a Home read surface for `job_blocked`/`job_output_ready`. |
| Net-new surfaces | 🔄 Home UI shipped read-first | Home page built Salon-native on the read-only Home API (PR #550): curator, stats, recommendations, inbox, news — navigation actions wired; lifecycle write actions disabled pending the Home write API. Native Documents page/editor, standalone Agents page, Archive, command palette, New Talk sheet, and Forge remain unbuilt. |
| Eval gate | ⛔ Contract only | `docs/eval-suite.md` specifies the shape, but there is no `eval/` implementation and no `npm run eval`. |

## Active Sequence

These are the current work packages after PR #541. Run each as a scoped `/goal` in Codex and Claude/Opus, with separate worktrees when two agents can run in parallel.

| Order | Work package | Primary gate |
|---|---|---|
| 0 | Docs drift cleanup | Live docs point to current audit/roadmap; archived docs are clearly marked historical. |
| 1 | Salon foundation decision + primitives | Default to CSS variables unless Joseph explicitly chooses Tailwind. Ship tokens, fonts, brand mark, RunPill/Chip/Kbd/Modal/Sheet/Popover/AgentAvatar primitives. |
| 2 | Structural cleanup | `TalkDetailPage.tsx` and `SettingsPage.tsx` shrink through behavior-preserving hooks/components; delete `TalkLlmSettingsCard.tsx` if still orphaned. |
| 3 | Native Documents | Documents page/editor and in-Talk doc pane consume `documents`/`doc_tabs`/`doc_blocks`/`document_edits`; content markdown/html facade can be deleted. |
| 4 | Home | Backend read API + Salon Home UI shipped read-first (PR #550 — curator/stats/recommendations/inbox/news, nav actions wired, loading/error/empty states). Remaining: Home **write** API (mark-read/resolve/dismiss/snooze, recommendation + news status) and wiring the currently-disabled lifecycle actions to it. |
| 5 | Remaining de-facade | Migrate frontend off synthetic threads/run-context/snapshot/tool/policy/connectors facades; delete each backend facade with tests. |
| 6 | Product surface completion | Standalone Agents page/profile, Archive, New Talk sheet, command palette, settings gaps, workspace-member management. |
| 7 | Eval gate | Implement `eval/`, scenarios, graders, `npm run eval`, and launch thresholds. |
| 8 | Forge | Post-MVP flag: SSR connection, audiences, improvement runs, gallery, winner to `document_edits`. |

## Autonomy Gate

Each autonomous run must start with a goal packet in that tool:

```text
/goal
Objective: ...
Scope: files/modules allowed
Non-goals: ...
Acceptance: user-visible behavior + deletion criteria
Verify: exact commands and browser checks
Human gate: none, or the specific decision that cannot be inferred
Handoff: docs/tests/status to update before marking complete
```

Completion requires implementation, tests, doc update if behavior/status changed, and the full review gate: gstack PR review, Karpathy audit diff, and adversarial cross-model review. If Codex implemented the slice, run `/claude review`; if Claude/Opus implemented it, run `/codex review`. Claude/Opus should use dynamic workflows inside the goal when useful, while staying inside the parent goal. Default decisions and copy/paste phase prompts are recorded in [PHASE5-AUTONOMOUS-PLAN.md](./PHASE5-AUTONOMOUS-PLAN.md).

## Drift Controls

- Keep the live docs set small: `REFACTOR-AUDIT.md`, `roadmap.md`, `PHASE5-AUTONOMOUS-PLAN.md`, `REFACTOR-OVERVIEW.md`, and the canonical spec docs.
- Archive worktree-specific handoffs and old audits instead of updating them.
- After each work package, update this roadmap and the relevant audit section.
- Before landing docs, run a stale-reference grep for old LOC counts, archived docs, obsolete CI-bypass language, and cutover-era notes.
