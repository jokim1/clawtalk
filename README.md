## ClawTalk

ClawTalk is a web product where users invite different LLM personas into "Talks", context-bound rooms, and watch them discuss together.

**Status:** greenfield backend/runtime cutover is merged. The current work is frontend/product completion: Salon visual system, native Documents, Home, de-facade, eval gate, and remaining surfaces. Deploy target: `clawtalk.app` on Cloudflare Workers + Supabase Postgres.

## What's inside

```text
src/
  worker.ts                  Cloudflare Worker entry
  db.ts, config.ts           postgres.js connection + global config

  clawtalk/
    talks/                   Greenfield Talk runtime, executor, queue consumer,
                             scheduler, jobs, context/source ingestion
    agents/                  Agent registry, router, execution resolver
    llm/                     Provider catalog, secret store, direct-HTTP
                             streaming dispatcher
    db/                      Postgres/RLS helpers and shared accessors
    identity/                Google OAuth, device auth, sessions
    web/                     Hono worker app + greenfield route modules
    secrets/, security/      Keychain bridge, hashing

webapp/
  src/                       Vite + React app

supabase/
  migrations/0001_clawtalk_greenfield.sql
```

## Quick Start

```bash
npm run install:all
npm run db:start
npm run dev:worker
npm run dev:web
```

Then open `http://localhost:5173`. Sign in via Google OAuth configured in the local Supabase project.

## Development Commands

```bash
npm run typecheck
npm run test
npm --prefix webapp run typecheck
npm --prefix webapp run test
npm --prefix webapp run build
npm run build
```

If you're on Node < 24 locally, set `CLAWTALK_ALLOW_UNSUPPORTED_NODE=1` to bypass the vitest version guard.

## Vision

A Talk is a room defined by:

- the agents in it, each with a role, model, persona, focus, and method
- the context attached to it, such as files, links, rules, and supporting docs
- the conversation history and run state
- an optional primary Document that captures the outcome

Start with [docs/README.md](docs/README.md). For current refactor status, read [docs/REFACTOR-AUDIT.md](docs/REFACTOR-AUDIT.md), [docs/roadmap.md](docs/roadmap.md), and [docs/PHASE5-AUTONOMOUS-PLAN.md](docs/PHASE5-AUTONOMOUS-PLAN.md).
