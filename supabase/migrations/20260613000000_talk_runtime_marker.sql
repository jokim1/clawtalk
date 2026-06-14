-- Talk Runtime v2, Wave 2 PR-B: dispatch-runtime marker on runs.
--
-- docs/13-talk-runtime-v2.md §6.1/§6.3 (reconciliation cron, 9A). The
-- reconciliation pass must be PATH-AWARE: during the flag-OFF soak (and any
-- partial rollout) the queue path and the TalkRunner DO path coexist, and a
-- queue-path run has NO DO state. Flagging "PG running but DO has no record"
-- as divergent would false-alarm every queue-path run. This column records
-- which runtime a run was dispatched to, so reconciliation can scope itself to
-- `runtime = 'do'` and leave queue-path runs to the existing scheduler sweeps.
--
-- The marker is set in the chat acceptance transaction from the resolved
-- per-account dispatch flag (default 'queue' / flag OFF). PR-C flips the flag,
-- which makes new runs 'do' and brings them under reconciliation automatically.
--
-- Additive + backward-compatible (docs/13 §6.4: "No schema migrations required
-- in Postgres (additive only, if any), so revert is clean").
--
-- Revert: drop index runs_runtime_do_active_idx; alter table public.runs drop
-- column runtime;  (no data migration — the column defaults safely on revert
-- restore, and only reconciliation reads it.)

alter table public.runs
  add column if not exists runtime text not null default 'queue'
    check (runtime in ('queue', 'do'));

-- The reconciliation cron scans only non-terminal do-path runs once a minute.
-- A partial index keeps that query off the queue-path hot path entirely (it
-- matches no rows while the flag is OFF) and bounded as the do-path rolls out.
create index if not exists runs_runtime_do_active_idx
  on public.runs (created_at)
  where runtime = 'do' and status in ('queued', 'running');

-- RLS/grants: `runtime` is a new column on the already-protected public.runs
-- table; it inherits the existing row policies and the `authenticated` grants
-- (no new policy or grant required). Only the scheduler cron (service-scoped,
-- like the existing run sweeps) reads it cross-workspace.
