-- 0016_talks_is_system_main_channel.sql
--
-- Rebuild the "Main" channel as a regular Talk with a system flag.
--
-- The old Nanoclaw-era main_threads / main_thread_summaries tables are
-- dropped — the /api/v1/main/* routes that backed them were removed
-- during the Phase 5 cloud port and the sidebar "Main" link has been
-- a dead route since. The new Main is a normal entry in public.talks
-- with is_system = true, hidden from the regular sidebar list and
-- accessed via /app/main (which redirects to the user's system Talk).
--
-- A partial unique index enforces one system Talk per owner — the
-- bootstrap path treats this as the lock that makes ensureMainTalkForUser
-- safe to call from every /session/me probe.

alter table public.talks
  add column if not exists is_system boolean not null default false;

create unique index if not exists talks_owner_system_uidx
  on public.talks (owner_id)
  where is_system = true;

drop table if exists public.main_thread_summaries;
drop table if exists public.main_threads;
