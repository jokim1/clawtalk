-- canonical-greenfield-migration.sql
--
-- Historical schema draft only. Do not execute this file.
--
-- The canonical executable greenfield Supabase baseline is:
--
--   supabase/migrations/0001_clawtalk_greenfield.sql
--
-- This file exists so older docs/PR links keep resolving, but it is no longer
-- a schema source of truth. Keeping a second runnable SQL copy is unsafe: it
-- can drift from the active reset baseline and silently drop runtime/security
-- pieces such as event_outbox grants/revokes, provider OAuth state, and
-- workspace-scoped provider secret policies.
--
-- For schema design, read docs/11-data-model.md. For the exact reset DDL, read
-- supabase/migrations/0001_clawtalk_greenfield.sql.

do $$
begin
  raise exception
    'docs/canonical-greenfield-migration.sql is historical; run supabase/migrations/0001_clawtalk_greenfield.sql on an empty/reset database instead'
    using errcode = 'CT901';
end;
$$;
