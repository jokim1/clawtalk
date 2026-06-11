## ClawTalk

ClawTalk is a web product where users invite different LLM personas into "Talks", context-bound rooms, and watch them discuss together.

**Status:** the greenfield backend/runtime cutover and the Phase 5 refactor train are merged: Salon visual system across the shell, Home, Talk, Documents, Agents, Archive, and Settings; native Documents; Home read/write surfaces; full de-facade (readiness scout counts at zero); and an MVP dry-run eval CI gate. Current work: final Talk visual polish against the Salon prototype (`docs/prototypes/`), eval live capture + provider-backed grading, and post-MVP surfaces (Forge, email invitations). Deploy target: `clawtalk.app` on Cloudflare Workers + Supabase Postgres.

## What's inside

```text
src/
  worker.ts                  Cloudflare Worker entry
  db.ts, config.ts           postgres.js connection + global config

  clawtalk/
    talks/                   Greenfield Talk runtime, executor, queue consumer,
                             scheduler, jobs, context/source ingestion
    agents/                  Agent registry, router, execution resolver
    documents/               Native Documents accessors + edit locks
    llm/                     Provider catalog, secret store, direct-HTTP
                             streaming dispatcher
    db/                      Postgres/RLS helpers and shared accessors
    workspaces/              Workspace bootstrap + member management
    connectors/              Slack OAuth + channel/source connectors
    identity/                Google OAuth, device auth, sessions
    web/                     Hono worker app + greenfield route modules
    web-search/              Web-search provider adapters
    eval/, schema/, r2/      Eval harness types, schema tests, R2 image helpers
    secrets/, security/      Keychain bridge, hashing

webapp/
  src/                       Vite + React app — Salon design system in src/salon/;
                             pages: Home, Talks, Talk detail, Documents, Agents,
                             Archive, Settings

eval/
  scenarios/, fixtures/,     Launch-critical dry-run eval gate (npm run eval),
  graders/, run.ts           wired into PR CI

supabase/
  migrations/                0001_clawtalk_greenfield.sql baseline + follow-ups
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

## Vision

A Talk is a room defined by:

- the agents in it, each with a role, model, persona, focus, and method
- the context attached to it, such as files, links, rules, and supporting docs
- the conversation history and run state
- an optional primary Document that captures the outcome

Start with [docs/README.md](docs/README.md). For current refactor status, read [docs/REFACTOR-AUDIT.md](docs/REFACTOR-AUDIT.md), [docs/roadmap.md](docs/roadmap.md), and [docs/PHASE5-AUTONOMOUS-PLAN.md](docs/PHASE5-AUTONOMOUS-PLAN.md).
