# ClawTalk Repo Context

See [README.md](README.md) for product overview. This file is the canonical, tool-neutral coding
context for agents working inside the repo. (The local `CLAUDE.md` is a gitignored personal
workspace file — this `AGENTS.md` is the single source of truth that ships in the repo.)

## Current Project Shape

ClawTalk is a web product where users invite different LLM personas into context-bound "Talks" and watch them discuss together.

- **Backend:** Hono worker in `src/worker.ts` (Cloudflare entry) → `src/clawtalk/web/worker-app.ts` (route mounts). Postgres via `src/db.ts` (postgres.js + `withUserContext` for RLS) → Supabase migrations in `supabase/migrations/`.
- **Talk runtime:** `src/clawtalk/talks/` — `/chat` enqueues onto `TALK_RUN_QUEUE`; the queue consumer in `queue-consumer.ts` runs `CleanTalkExecutor` per message and streams events to the per-user `UserEventHub` Durable Object. The cron-triggered `scheduler.ts` fans out due jobs onto the same queue every minute and sweeps stuck runs.
- **Frontend:** Vite + React under `webapp/`, with the Salon design system in `webapp/src/salon/` (CSS-variable tokens + primitives). Pages: Home, Talks list → Talk detail, Documents index/detail, Registered Agents + standalone agent profile, Archive, Settings, plus a ⌘K command palette.
- **Identity:** Google OAuth + device-code auth in `src/clawtalk/identity/`. RBAC (`owner`, `admin`, `member`). HttpOnly access/refresh cookies + double-submit CSRF.

## Parallel-agent discipline

Joseph often has multiple Claude, Codex, and Opus agents running concurrently on this repo. **Always do non-trivial work inside an isolated git worktree** — never in the main `/Users/josephkim/dev/clawtalk` checkout — so concurrent agents do not overwrite each other's edits.

- If the host already placed you in an agent-managed worktree, stay there and create your branch from that checkout.
- If you must create a worktree yourself, use the host's normal root:
  - Claude/Opus: `.claude/worktrees/<short-task-name>`
  - Codex: `.codex/worktrees/<short-task-name>`
- Create manual worktrees from the repo root with `git worktree add <worktree-path> -b <branch-name> main`.
- Use absolute paths under the worktree directory for every Edit / Read / Bash call.
- Commit + push + open the PR from inside the worktree.
- Remove a manual worktree after the PR lands, unless it is needed for follow-up rebases.
- Single-file doc tweaks or one-shot bash commands can stay in the main checkout.

If your edits keep mysteriously reverting between tool calls, you are likely fighting another agent in the main checkout — bail out, create or move to an isolated worktree, and resume there.

## Engineering Defaults

- Prefer long-term stable architecture over backward-compatibility scaffolding.
- Do not preserve legacy APIs, schema shapes, data, or local users by default unless the task explicitly requires it.
- Treat existing local users and stored data as disposable by default — clawtalk has no external users beyond Joseph, so don't write data-preservation code for hypothetical ones.
- If a simpler implementation requires resetting, deleting, or rebuilding local data/users, do that instead of carrying compatibility baggage.
- Within the scope of the requested task, remove dead paths instead of supporting old and new behavior in parallel — don't carry old+new code paths just to be conservative.

## Review Gates

When a task mandates a named review skill, run THAT exact skill — the per-slice gate is `/review` (which bundles the Codex adversarial pass) plus `/karpathy-audit` on the diff. Never substitute a same-model self-review, and never report a gate "met" until the named skill has actually run and you've surfaced its output. Honor Codex blocks.

## Deployment Verification

Push to `main` auto-deploys the Worker + Supabase migrations, but a successful deploy run is not the domain serving the new code. Never say "live on clawtalk.app" until you have fetched the domain and confirmed it serves the new build (a changed response / version marker). Until then, say "pushed, pending deploy verification." Live OAuth / real-API / visual smoke is Joseph's to run.

## Visual/E2E Evaluation

The Playwright visual-fidelity loop (`webapp/playwright/home-fidelity.spec.ts`) is necessary, not sufficient. It has two known blind spots: it only scores the populated mock at one viewport, so it misses (a) states that differ from that mock (empty/zero-data) and (b) structure / section naming / IA — not just visual styling. Run it at the production viewport, include the empty state, and assert section titles + ordering + column counts before trusting a green result.

## Handoff Summaries

When finishing autonomous work, lead the handoff with an explicit "What you're approving": the PR number, the user-visible change, and what was verified vs. still pending. End with a "STILL UNVERIFIED:" line for anything (OAuth, visual, real-API) you could not prove yourself.

## Key Files

| File                                                                                          | Purpose                                                            |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `src/worker.ts`                                                                               | Cloudflare Worker entry — boots `getWorkerApp(env)`                |
| `src/db.ts`                                                                                   | postgres.js connection + `withUserContext` / Hyperdrive on Workers |
| `src/clawtalk/config.ts`                                                                      | Auth + provider env config                                         |
| `supabase/migrations/*.sql`                                                                   | Postgres schema + RLS policies + grants                            |
| `src/clawtalk/db/core-accessors.ts`, `agent-accessors.ts`, `home-accessors.ts`, etc.          | Typed async pg accessors (tagged-template SQL, RLS-scoped)         |
| `src/clawtalk/talks/new-executor.ts`                                                          | CleanTalkExecutor — orchestrates a single Talk run                 |
| `src/clawtalk/talks/queue-consumer.ts`, `queue-producer.ts`, `scheduler.ts`                   | Queue dispatch: per-message run executor, run-id producer, cron tick |
| `src/clawtalk/talks/user-event-hub.ts`                                                        | Per-user Durable Object — WebSocket Hibernation event hub          |
| `src/clawtalk/agents/agent-registry.ts`, `agent-router.ts`                                    | Multi-agent registry + per-Talk routing                            |
| `src/clawtalk/llm/`                                                                           | Provider catalog, secret store, LLM client                         |
| `src/clawtalk/web/worker-app.ts`                                                              | Hono app + route registration for the Worker bundle                |
| `webapp/src/pages/TalkDetailPage.tsx`                                                         | Talk UI (agent targeting + streaming)                              |
| `webapp/src/salon/`                                                                           | Salon design system — `--salon-*` tokens, fonts, primitives        |

## Development Commands

```bash
npm run db:start              # supabase local stack on ports 54430–54439
npm run dev:worker            # wrangler dev on :8788 (Worker + DO + Hyperdrive)
npm run dev:web               # webapp on :5173 (proxies /api/* to :8788)
npm run typecheck             # backend tsc --noEmit
npm run test                  # backend vitest run
npm --prefix webapp run typecheck
npm --prefix webapp run test
npm --prefix webapp run build
```

## Roadmap

See `docs/roadmap.md` for in-flight + shipped work and active TODOs.
