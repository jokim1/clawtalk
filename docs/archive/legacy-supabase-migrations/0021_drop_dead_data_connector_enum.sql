-- 0021_drop_dead_data_connector_enum.sql
--
-- Connectors refactor PR 1 — drop the dead `'data_connector'` value
-- from `talk_resource_bindings.binding_kind`. The chassis purge
-- already wiped the route surface that wrote these rows, but the
-- check constraint still allows the value. Workspace data connectors
-- now live in their own table (0020) with a per-Talk link table, so
-- the `data_connector` value on `talk_resource_bindings` is dead.
--
-- Defensive: delete any stray rows first. The chassis purge never
-- backfilled them, so this should be a no-op on prod — but the delete
-- protects against any environment where a row leaked through before
-- the routes were removed.

-- Belt + suspenders: clear stragglers before the check-constraint
-- swap. Bypasses RLS because migrations run as `postgres`.
delete from public.talk_resource_bindings
where binding_kind = 'data_connector';

alter table public.talk_resource_bindings
  drop constraint if exists talk_resource_bindings_binding_kind_check;

alter table public.talk_resource_bindings
  add constraint talk_resource_bindings_binding_kind_check
  check (binding_kind in (
    'google_drive_folder',
    'google_drive_file',
    'saved_source',
    'message_attachment'
  ));
