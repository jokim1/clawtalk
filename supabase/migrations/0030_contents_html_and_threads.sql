-- 0030_contents_html_and_threads.sql
--
-- Hybrid markdown + HTML content (plan: good-pushback-having-said-virtual-harbor.md).
-- PR A, Lane A1. Two concerns ship together because the HTML format
-- column makes no sense without the thread-scoped binding (a Talk's
-- thread can hold an HTML doc OR a markdown doc; 1 per thread).
--
-- 1. Move `contents` binding down to `talk_threads.id` (each Talk's
--    default thread gets the existing doc; new threads can host new
--    docs going forward).
-- 2. Add `body_html` + relax `content_format` CHECK to allow
--    'html' alongside 'markdown'. Both columns may coexist so future
--    MD↔HTML conversion works without a schema change.
-- 3. Add `content_edits.new_html` for the AI-edit log (PR B will
--    actually populate it; this migration just makes the column +
--    constraint shape live).
-- 4. Update RLS policies to key on `thread_id → talk_threads.owner_id`
--    instead of `talk_id → talks.owner_id`. Keep `owner_id = auth.uid()`
--    as a belt-and-suspenders predicate for the cheap denorm path.
-- 5. Rewrite the ownership-integrity trigger to pin to the thread's
--    owner (which in turn is pinned to the talk's owner).

-- ── Pre-check: every contents row must resolve to exactly one default
-- thread for its talk. Joseph is sole user — this is a defense-in-depth
-- guard against unexpected dev-DB drift, not a real-world data path.
do $$
declare
  bad_id uuid;
begin
  select c.id
    into bad_id
    from public.contents c
    where (
      select count(*)
        from public.talk_threads tt
        where tt.talk_id = c.talk_id
          and tt.is_default = true
    ) <> 1
    limit 1;
  if bad_id is not null then
    raise exception
      'contents.id % does not resolve to exactly one default thread for its talk',
      bad_id;
  end if;
end$$;

-- ── 1. Add thread_id column (nullable for backfill) ──────────────────
alter table public.contents add column thread_id uuid;

update public.contents
  set thread_id = (
    select tt.id
      from public.talk_threads tt
      where tt.talk_id = public.contents.talk_id
        and tt.is_default = true
      limit 1
  );

-- Post-backfill assertion: no NULLs allowed before we tighten.
do $$
declare
  missing_count int;
begin
  select count(*) into missing_count
    from public.contents
    where thread_id is null;
  if missing_count > 0 then
    raise exception
      'contents backfill incomplete: % rows have null thread_id',
      missing_count;
  end if;
end$$;

alter table public.contents alter column thread_id set not null;
alter table public.contents
  add constraint contents_thread_id_fk
  foreign key (thread_id)
  references public.talk_threads(id)
  on delete cascade;

-- Swap unique index from talk_id to thread_id (1 doc per thread).
drop index public.contents_talk_id_uidx;
create unique index contents_thread_id_uidx
  on public.contents (thread_id);

-- ── 2. body_html + relaxed format check ───────────────────────────
alter table public.contents add column body_html text;

-- Drop the original format CHECK (constraint name confirmed via pg_catalog
-- on the live dev DB: `contents_content_format_check`). The PL/pgSQL
-- block keeps the migration resilient if a future DB rename lands.
do $$
declare
  cname text;
begin
  select conname into cname
    from pg_constraint
    where conrelid = 'public.contents'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%content_format%';
  if cname is not null then
    execute format('alter table public.contents drop constraint %I', cname);
  end if;
end$$;

alter table public.contents
  add constraint contents_content_format_check
  check (content_format in ('markdown', 'html'));

-- body_markdown has a default '' so it is never NULL for markdown docs.
-- For HTML docs the writer sets body_html to a non-null string ('' is
-- allowed and counts as "present"). The check enforces "the matching
-- body column is set for the chosen format".
alter table public.contents
  add constraint contents_body_matches_format_check
  check (
    case
      when content_format = 'html' then body_html is not null
      else body_markdown is not null
    end
  );

-- ── 3. content_edits.new_html + payload-shape check ───────────────
alter table public.content_edits add column new_html text;

-- Exactly one of new_markdown / new_html is non-null per row, except
-- for kind='delete' where both must be null (existing semantics).
alter table public.content_edits
  add constraint content_edits_payload_shape_check
  check (
    (kind = 'delete' and new_markdown is null and new_html is null)
    or (
      kind <> 'delete'
      and (
        (new_markdown is not null and new_html is null)
        or (new_markdown is null and new_html is not null)
      )
    )
  );

-- ── 4. RLS — re-key contents + content_edits to thread → talk_threads
-- The previous policies gated on contents.owner_id = auth.uid() (and
-- the content_edits one joined contents). The new policies still check
-- owner_id (cheap path), AND additionally require the thread owner to
-- match auth.uid() (authoritative ownership now lives on the thread).
drop policy if exists contents_owner on public.contents;
create policy contents_owner
  on public.contents
  for all to authenticated
  using (
    owner_id = auth.uid()
    and exists (
      select 1 from public.talk_threads tt
      where tt.id = contents.thread_id
        and tt.owner_id = auth.uid()
    )
  )
  with check (
    owner_id = auth.uid()
    and exists (
      select 1 from public.talk_threads tt
      where tt.id = contents.thread_id
        and tt.owner_id = auth.uid()
    )
  );

drop policy if exists content_edits_owner on public.content_edits;
create policy content_edits_owner
  on public.content_edits
  for all to authenticated
  using (
    exists (
      select 1
        from public.contents c
        join public.talk_threads tt on tt.id = c.thread_id
        where c.id = content_edits.content_id
          and tt.owner_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
        from public.contents c
        join public.talk_threads tt on tt.id = c.thread_id
        where c.id = content_edits.content_id
          and tt.owner_id = auth.uid()
    )
  );

-- ── 5. Ownership-integrity trigger — pin to thread owner ─────────
-- Replace contents_assert_owner_matches_talk with a thread-keyed
-- version. The old function looked up `talks.owner_id` via talk_id;
-- the new one looks up `talk_threads.owner_id` via thread_id (which
-- is the new authoritative binding). Keeps SECURITY DEFINER + the
-- existing trigger wiring intact.
create or replace function public.contents_assert_owner_matches_talk()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  expected_owner uuid;
begin
  select tt.owner_id into expected_owner
    from public.talk_threads tt
    where tt.id = new.thread_id;

  if expected_owner is null then
    raise exception
      'contents.thread_id % does not reference an existing thread',
      new.thread_id;
  end if;
  if expected_owner <> new.owner_id then
    raise exception
      'contents.owner_id % does not match talk_threads.owner_id %',
      new.owner_id, expected_owner;
  end if;
  return new;
end;
$$;

-- Bump body_version on every existing content so any browser holding
-- a cached snapshot refetches on next mutation (mirrors 0028's sweep).
update public.contents set body_version = body_version + 1;
