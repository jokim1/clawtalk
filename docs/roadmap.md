> **Status:** live implementation tracker · **Last updated:** 2026-06-08
> Orientation: [REFACTOR-OVERVIEW.md](./REFACTOR-OVERVIEW.md) · current audit: [REFACTOR-AUDIT.md](./REFACTOR-AUDIT.md) · execution protocol: [PHASE5-AUTONOMOUS-PLAN.md](./PHASE5-AUTONOMOUS-PLAN.md)

# ClawTalk Roadmap

This file is the short operational tracker for the greenfield refactor. It is not the product spec. Use `01` through `12` for target behavior, `REFACTOR-AUDIT.md` for the completion audit, and this file for what to run next.

## Current State

| Area | State | Notes |
|---|---|---|
| Backend / data cutover | ✅ Done | Greenfield runtime is live. Legacy runtime/accessors were retired, backend CI is a real signal again, and the fresh baseline is `supabase/migrations/0001_clawtalk_greenfield.sql`. |
| Frontend structure | ✅ Phase 2 structural cleanup complete | `TalkDetailPage.tsx` is 1,429 LOC, below the roughly 2,500 target. `SettingsPage.tsx` is 1,066 LOC. Talk shell/render surface, page-owned controllers, panels, composer, thread view, reducer, stream hook, and Settings Profile/Tools/OAuth panels are extracted; the orphaned `TalkLlmSettingsCard.tsx` component has been deleted. Remaining frontend work is Salon, native consumers, and net-new product surfaces. |
| De-facade | 🔄 First deletion landed | The duplicate `worker-app.ts` Hono mounts for sidebar reorder and run-context were removed; those routes now resolve through `mountGreenfieldApiRoutes`. Synthetic threads, runs-with-`threadId`, flat content markdown/html, snapshot compat, policy/tool/connectors facades, run-context synthesis, and the attachments guard still need native consumers or product decisions before deletion; readiness ledger: [DE-FACADE-READINESS.md](./DE-FACADE-READINESS.md). |
| Salon visual system | 🔄 Foundation shipped (PR #547); surface re-skins in progress (PR #550) | `webapp/src/salon/*` ships CSS-variable tokens (`--salon-*`), fonts (Newsreader/Geist/Geist Mono), brand mark, and primitives (CTMark, CTIcon, Avatar/AgentAvatar, RunPill, Chip, Kbd, Button, Input/Textarea, Modal, Sheet, Popover) with proof migrations + a `salon.test.tsx` smoke suite. **Re-skinned to Salon (PR #550):** Home, Archive, Registered Agents panel + standalone agent profile, the Talks list page, and the sign-in surface — each off its legacy classes with dead `styles.css` rules trimmed + a mocked-backend Playwright responsive spec (390 + 1280). **App shell shipped (PR #550):** the prototype 3-column icon-rail (`webapp/src/components/shell/`: `IconRail` + `SecondaryList` + `RailProfileMenu`) replacing `ClawTalkSidebar`/`WorkspaceSwitcher`/`SidebarProfileMenu` + the `App.tsx` header; talk CRUD/DnD/⌘K preserved, desktop collapse + mobile drawer, ~550 LOC dead CSS removed. **Contrast fixed:** `--salon-accent-strong` `#b05530` (≈ 5.0:1 on white) backs text-bearing primary buttons; `#c8643a` stays the brand/decorative accent. Remaining: `TalkDetailPage`/`SettingsPage`-owned CSS. |
| Jobs | 🔄 Mostly functional, not complete | Jobs backend and Talk Jobs panel cover CRUD, pause/resume, run-now, archive/delete; PR #552 added `emit_document_append` + `job_output_ready` inbox/outbox production. Remaining gap: Home UI surfacing and DB-backed verification once the local/CI database is available. |
| Net-new surfaces | 🔄 Home + Documents + New Talk sheet + ⌘K palette + Agents + Archive shipped | Built Salon-native in PR #550: Home (inbox dismiss/snooze + recommendation dismiss wired to the Home write API; mark-read/resolve + news add-to-context pending), the New Talk sheet (name-before-create over `createTalk`), the ⌘K command palette (nav + Settings tabs + Talks quick switcher), the Registered Agents panel (full CRUD on Salon primitives), the standalone agent profile (`/app/agents/:agentId` over `getRegisteredAgent`), and Archive (unarchive API + Salon Archive page). The native Documents UI shipped (PR #557 — `/app/documents` index + `/app/documents/:id` native tab/block viewer + a pending-edit accept/reject console over `documents`/`doc_tabs`/`doc_blocks`/`document_edits`, no markdown/html facade; IconRail + ⌘K wired; in-Talk doc pane deferred behind the Codex TalkDetail refactor #549). Native Documents backend routes/client methods exist (PR #552). Remaining: settings gaps (Codex-owned decomp) and Forge (post-MVP). |
| Eval gate | 🔄 MVP dry-run CI gate | `eval/` now contains launch-critical scenario contracts, deterministic fixtures, grader prompt contracts, tests, and `npm run eval`; PR CI runs the dry-run gate, while live provider/backend grading remains unwired. |

## Active Sequence

These are the current work packages after PR #541. Run each as a scoped `/goal` in Codex and Claude/Opus, with separate worktrees when two agents can run in parallel.

| Order | Work package | Primary gate |
|---|---|---|
| 0 | Docs drift cleanup | Live docs point to current audit/roadmap; archived docs are clearly marked historical. |
| 1 | Salon foundation decision + primitives | Default to CSS variables unless Joseph explicitly chooses Tailwind. Ship tokens, fonts, brand mark, RunPill/Chip/Kbd/Modal/Sheet/Popover/AgentAvatar primitives. |
| 2 | Structural cleanup | Phase 2 structural cleanup is complete: `TalkDetailPage.tsx` is below target after shell/controller extraction, `SettingsPage.tsx` has Profile/Tools/OAuth extracted, and `TalkLlmSettingsCard.tsx` orphan deletion is complete. |
| 3 | Native Documents | ✅ Standalone Documents page + viewer/edit-review console shipped (PR #557) over `documents`/`doc_tabs`/`doc_blocks`/`document_edits`. Remaining: in-Talk doc pane (deferred behind TalkDetail refactor #549); content markdown/html facade deletion after the in-Talk consumer moves. |
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
