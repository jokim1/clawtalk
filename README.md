## ClawTalk

ClawTalk is a web product where users invite different LLM personas into "Talks" — context-bound rooms — and watch them discuss together.

**Status:** Phase 1 (chassis purge complete). Talk runtime is live; persona, context, and projects layers are next. Cloud deploy target: clawtalk.app on Cloudflare + Supabase Postgres (not yet wired).

## What's inside

```
src/
  server.ts                  Bootstrap (init DB → start Hono web server)
  db.ts, config.ts           SQLite connection + global config

  clawtalk/
    talks/                   Multi-agent Talk runtime (executor, run-worker,
                             job-worker, attachments, source ingestion)
    agents/                  Agent registry, router, execution resolver
    llm/                     Provider catalog, secret store, direct-HTTP
                             streaming dispatcher
    db/                      SQLite schema + accessors
    identity/                Auth + sessions
    web/                     Hono server + route modules
    secrets/, security/      Keychain bridge, hashing

webapp/
  src/pages/                 TalkList, TalkDetail, AiAgents, Settings,
                             Profile (React + Vite)
```

## Quick start

```bash
npm run install:all          # root + webapp deps
npm run dev                  # tsx src/server.ts on :3210
npm run dev:web              # vite on :5173, proxies /api/* to :3210
```

Then open `http://localhost:5173`. For local dev, use the dev-login form on the sign-in page.

## Development commands

```bash
npm run typecheck                  # backend tsc --noEmit
npm run test                       # backend vitest run
npm --prefix webapp run typecheck
npm --prefix webapp run test
npm --prefix webapp run build
npm run build                      # backend tsc → dist/
```

If you're on Node < 24 locally, set `CLAWTALK_ALLOW_UNSUPPORTED_NODE=1` to bypass the vitest version guard.

## Vision

A Talk is a room defined by:
- **The agents in it** — each LLM has a role + system prompt template (persona).
- **The context attached to it** — files, links, notes scoped to that Talk.
- **The history of the conversation** — persistent across sessions.

Projects (deliverables — blog posts, podcast scripts, books) are spun off from Talks and co-edited with the agents in the room.

See `docs/` for the current architecture and pending design work.
