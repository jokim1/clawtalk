> **Status:** live implementation tracker · **Last updated:** 2026-06-08
> Orientation: [REFACTOR-OVERVIEW.md](./REFACTOR-OVERVIEW.md) · current audit: [REFACTOR-AUDIT.md](./REFACTOR-AUDIT.md) · execution protocol: [PHASE5-AUTONOMOUS-PLAN.md](./PHASE5-AUTONOMOUS-PLAN.md)

# ClawTalk Roadmap

This file is the short operational tracker for the greenfield refactor. It is not the product spec. Use `01` through `12` for target behavior, `REFACTOR-AUDIT.md` for the completion audit, and this file for what to run next.

## Current State

| Area | State | Notes |
|---|---|---|
| Backend / data cutover | ✅ Done | Greenfield runtime is live. Legacy runtime/accessors were retired, backend CI is a real signal again, and the fresh baseline is `supabase/migrations/0001_clawtalk_greenfield.sql`. |
| Frontend structure | 🔄 Mid-flight | `TalkDetailPage.tsx` is 5,429 LOC, target roughly 2,500. `SettingsPage.tsx` is 2,147 LOC. Talk panels, composer, thread view, reducer, and stream hook are extracted; the Talk tab shell and page-owned controller state remain. |
| De-facade | 🔄 First deletion landed | The duplicate `worker-app.ts` Hono mounts for sidebar reorder and run-context were removed; those routes now resolve through `mountGreenfieldApiRoutes`. Synthetic threads, runs-with-`threadId`, flat content markdown/html, snapshot compat, policy/tool/connectors facades, run-context synthesis, and the attachments guard still need native consumers or product decisions before deletion; readiness ledger: [DE-FACADE-READINESS.md](./DE-FACADE-READINESS.md). |
| Salon visual system | 🔄 Foundation shipped (PR #547); surface re-skins in progress (PR #550) | `webapp/src/salon/*` ships CSS-variable tokens (`--salon-*`), fonts (Newsreader/Geist/Geist Mono), brand mark, and primitives (CTMark, CTIcon, Avatar/AgentAvatar, RunPill, Chip, Kbd, Button, Input/Textarea, Modal, Sheet, Popover) with proof migrations + a `salon.test.tsx` smoke suite. **Re-skinned to Salon (PR #550):** Home, Archive, Registered Agents panel + standalone agent profile, the Talks list page, and the sign-in surface — each off its legacy classes with dead `styles.css` rules trimmed + a mocked-backend Playwright responsive spec (390 + 1280). **App shell shipped (PR #550):** the prototype 3-column icon-rail (`webapp/src/components/shell/`: `IconRail` + `SecondaryList` + `RailProfileMenu`) replacing `ClawTalkSidebar`/`WorkspaceSwitcher`/`SidebarProfileMenu` + the `App.tsx` header; talk CRUD/DnD/⌘K preserved, desktop collapse + mobile drawer, ~550 LOC dead CSS removed. **Contrast fixed:** `--salon-accent-strong` `#b05530` (≈ 5.0:1 on white) backs text-bearing primary buttons; `#c8643a` stays the brand/decorative accent. Remaining: `TalkDetailPage`/`SettingsPage`-owned CSS. |
| Jobs | 🔄 Mostly functional, not complete | Jobs backend and Talk Jobs panel cover CRUD, pause/resume, run-now, archive/delete; PR #552 added `emit_document_append` + `job_output_ready` inbox/outbox production. Remaining gap: Home UI surfacing and DB-backed verification once the local/CI database is available. |
| Net-new surfaces | 🔄 Home + New Talk sheet + ⌘K palette + Agents + Archive shipped | Built Salon-native in PR #550: Home (inbox dismiss/snooze + recommendation dismiss wired to the Home write API; mark-read/resolve + news add-to-context pending), the New Talk sheet (name-before-create over `createTalk`), the ⌘K command palette (nav + Settings tabs + Talks quick switcher), the Registered Agents panel (full CRUD on Salon primitives), the standalone agent profile (`/app/agents/:agentId` over `getRegisteredAgent`), and Archive (unarchive API + Salon Archive page). Native Documents backend routes/client methods now exist (PR #552); native Documents UI is in PR #557. Remaining: settings gaps (Codex-owned decomp) and Forge (post-MVP). |
| Eval gate | 🔄 MVP dry-run CI gate | `eval/` now contains launch-critical scenario contracts, deterministic fixtures, grader prompt contracts, tests, and `npm run eval`; PR CI runs the dry-run gate, while live provider/backend grading remains unwired. |

## Active Sequence

These are the current work packages after PR #541. Run each as a scoped `/goal` in Codex and Claude/Opus, with separate worktrees when two agents can run in parallel.

| Order | Work package | Primary gate |
|---|---|---|
| 0 | Docs drift cleanup | Live docs point to current audit/roadmap; archived docs are clearly marked historical. |
| 1 | Salon foundation decision + primitives | Default to CSS variables unless Joseph explicitly chooses Tailwind. Ship tokens, fonts, brand mark, RunPill/Chip/Kbd/Modal/Sheet/Popover/AgentAvatar primitives. |
| 2 | Structural cleanup | `TalkDetailPage.tsx` and `SettingsPage.tsx` shrink through behavior-preserving hooks/components; delete `TalkLlmSettingsCard.tsx` if still orphaned. |
| 3 | Native Documents | Backend native Documents API/client path is in place for list/detail tabs+blocks+pending edits and accept/reject. Next: Documents page/editor and in-Talk doc pane consume `documents`/`doc_tabs`/`doc_blocks`/`document_edits`; content markdown/html facade can be deleted only after consumer grep passes. |
| 4 | Home | Backend read API + Salon Home UI shipped (PR #550). Home **write** API shipped for inbox dismiss/snooze + recommendation dismiss. Remaining: inbox mark-read/resolve and news add-to-context/snooze. |
| 5 | Remaining de-facade | Duplicate Hono mounts are deleted. Next, migrate frontend off synthetic threads/run-context/snapshot/tool/policy/connectors/content facades; delete each backend facade only after the audit script proves zero live consumers and native tests pass. |
| 6 | Product surface completion | ✅ New Talk sheet + ⌘K palette + Salon-native Registered Agents panel + standalone agent profile + Archive shipped (PR #550). Remaining: settings gaps (Codex-owned decomp), workspace-member management. |
| 7 | Eval gate | Harden the CI-gated MVP dry-run gate into live backend/provider grading once native consumers and test fixtures are ready. |
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
