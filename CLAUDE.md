# ClawTalk Repo Context

See [README.md](README.md) for product overview. This file is the short coding context for agents working inside the repo.

## Current Project Shape

ClawTalk is a web product where users invite different LLM personas into context-bound "Talks" and watch them discuss together.

- **Backend:** Hono server in `src/server.ts` (entry) → `src/clawtalk/web/index.ts` (web bootstrap) → `src/clawtalk/web/server.ts` (route registration). SQLite store via `src/db.ts` + `src/clawtalk/db/init.ts`.
- **Talk runtime:** `src/clawtalk/talks/` — TalkRunWorker + TalkJobWorker + CleanTalkExecutor stream multi-agent responses via direct HTTP to LLM providers (Anthropic / OpenAI / etc.).
- **Frontend:** Vite + React under `webapp/`. TalkList → TalkDetail flow, AiAgents page for provider/agent config, Settings, Profile.
- **Identity:** Google OAuth + device-code auth in `src/clawtalk/identity/`. RBAC (`owner`, `admin`, `member`). HttpOnly access/refresh cookies + double-submit CSRF.

## Engineering Defaults

- Prefer long-term stable architecture over backward-compatibility scaffolding.
- Do not preserve legacy APIs, schema shapes, data, or local users by default unless the task explicitly requires it.
- Treat existing local users and stored data as disposable by default at this stage of the project.
- If a simpler implementation requires resetting, deleting, or rebuilding local data/users, do that instead of carrying compatibility baggage.
- Remove dead paths instead of supporting old and new behavior in parallel.

## Key Files

| File                                                                                          | Purpose                                                            |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `src/server.ts`                                                                               | Top-level entry: init DB → start web server → SIGINT/SIGTERM       |
| `src/db.ts`                                                                                   | better-sqlite3 connection (`getDb`, `initDatabase`)                |
| `src/clawtalk/config.ts`                                                                      | Server + auth + provider env config                                |
| `src/clawtalk/db/init.ts`                                                                     | SQLite schema for Talks/agents/sessions/etc.                       |
| `src/clawtalk/db/accessors.ts`, `agent-accessors.ts`, etc.                                    | Typed DB accessors                                                 |
| `src/clawtalk/identity/auth-service.ts`                                                       | Google OAuth + device-code + session lifecycle                     |
| `src/clawtalk/talks/new-executor.ts`                                                          | CleanTalkExecutor — orchestrates a single Talk run                 |
| `src/clawtalk/talks/run-worker.ts`, `job-worker.ts`                                           | Talk run + job dispatch                                            |
| `src/clawtalk/agents/agent-registry.ts`, `agent-router.ts`                                    | Multi-agent registry + per-Talk routing                            |
| `src/clawtalk/llm/`                                                                           | Provider catalog, secret store, LLM client                         |
| `src/clawtalk/web/server.ts`                                                                  | Hono app + route registration (monolithic; carve in a future PR)   |
| `webapp/src/pages/TalkDetailPage.tsx`                                                         | Talk UI (agent targeting + streaming)                              |

## Chassis-removed shims (transient)

`src/clawtalk/web/routes/{agent-management,executor-settings,main-channel,browser,data-connectors,talk-tools,channels}.ts` and `_chassis-removed.ts` are tiny stub modules whose route handlers return HTTP 410 Gone. They exist only so `web/server.ts` still compiles after the chassis purge without ripping out hundreds of route registrations in one PR. Delete them and their referencing route registrations in `web/server.ts` as a follow-up cleanup PR.

Similarly, `new-executor.ts`, `context-loader.ts`, `agents/agent-router.ts`, and `db/accessors.ts` have inline `// Chassis-removal stubs` blocks near the imports. Same deal — they keep the type-checker green; remove them when the rest of the chassis surface comes out.

## Development Commands

```bash
npm run dev                   # backend on :3210 (tsx src/server.ts)
npm run dev:web               # webapp on :5173 (proxies /api/* to :3210)
npm run typecheck             # backend tsc --noEmit
npm run test                  # backend vitest run
npm --prefix webapp run typecheck
npm --prefix webapp run test
npm --prefix webapp run build
```

## What's Next (Phase 2+)

1. **AI Persona system** — extend agents with `role` + `system_prompt_template`. Persona CRUD page. Talk-invite picks a persona.
2. **Talk-level context** — `talk_context` table (files/links/notes). Context plumbed into LLM-call prompt assembly. Context tab on TalkDetailPage.
3. **Projects** — new top-level entity (deliverable). Talk → Project spinoff. Rich editor (port back from `editorial-room-archive-2026-05` tag).
4. **Cloud port** — clawtalk.app on Cloudflare Workers + Supabase Postgres. Public signup, multi-tenant data.
