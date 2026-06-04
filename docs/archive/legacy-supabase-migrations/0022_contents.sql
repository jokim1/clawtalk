-- 0022_contents.sql
--
-- Content feature PR 1 — long-form documents that 1:1 attach to a Talk
-- and accrete from the conversation. Two tables, owner-only RLS, and
-- ownership-integrity triggers that pin contents/content_proposals to
-- the parent Talk's owner.
--
-- Shape mirrors `talk_outputs` (0001) for the CAS-versioned column +
-- denormalized owner_id, plus an anchor_map_json sidecar that indexes
-- block-level anchor IDs persisted in `body_markdown` as HTML comments.
-- The `proposals` audit row stores `base_anchor_content_hash` so the
-- accept path can detect semantic drift (the anchored block's content
-- changed between proposal time and accept time).
--
-- v1 limits the proposal `kind` check to 'append'. v2 may add 'replace'
-- once the surface has been used; we keep the column + check tight here
-- so the executor can't synthesize a state we don't know how to apply.

-- ── contents (1:1 with a talk) ──────────────────────────────────────
create table public.contents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.users(id) on delete cascade,
  talk_id uuid not null references public.talks(id) on delete cascade,
  title text not null,
  content_kind text not null default 'document'
    check (content_kind in ('document')),
  content_format text not null default 'markdown'
    check (content_format in ('markdown')),
  body_markdown text not null default '',
  body_version integer not null default 1,
  -- { anchorId: { kind, sort_order, preview, content_hash } }
  anchor_map_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by_user_id uuid references public.users(id) on delete set null,
  updated_by_user_id uuid references public.users(id) on delete set null,
  updated_by_run_id uuid references public.talk_runs(id) on delete set null
);
-- 1:1 with talk
create unique index contents_talk_id_uidx
  on public.contents (talk_id);
create index contents_owner_updated_idx
  on public.contents (owner_id, updated_at desc, id);
alter table public.contents enable row level security;

create policy contents_owner
  on public.contents
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

grant select, insert, update, delete
  on public.contents
  to authenticated;

-- Ownership-integrity: pin contents.owner_id to talks.owner_id so a
-- buggy code path that inserts a mismatched owner_id can't drift the
-- two apart. SECURITY DEFINER so the trigger reads `talks` even when
-- the caller's RLS hides rows it would otherwise see (it won't, since
-- the caller is the owner — but the trigger is the last line of
-- defense, not the first).
create or replace function public.contents_assert_owner_matches_talk()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  expected_owner uuid;
begin
  select owner_id into expected_owner
  from public.talks
  where id = new.talk_id;

  if expected_owner is null then
    raise exception 'contents.talk_id % does not reference an existing talk',
      new.talk_id;
  end if;
  if expected_owner <> new.owner_id then
    raise exception 'contents.owner_id % does not match talks.owner_id %',
      new.owner_id, expected_owner;
  end if;
  return new;
end;
$$;

create trigger contents_owner_integrity
  before insert or update on public.contents
  for each row execute function public.contents_assert_owner_matches_talk();

-- ── content_proposals (agent edit proposals) ────────────────────────
create table public.content_proposals (
  id uuid primary key default gen_random_uuid(),
  content_id uuid not null
    references public.contents(id) on delete cascade,
  owner_id uuid not null references public.users(id) on delete cascade,
  proposed_by_run_id uuid
    references public.talk_runs(id) on delete set null,
  proposed_by_agent_id uuid
    references public.registered_agents(id) on delete set null,
  proposed_by_message_id uuid
    references public.talk_messages(id) on delete cascade,
  -- v1: append only. v2 will widen the check to include 'replace'.
  kind text not null check (kind in ('append')),
  -- null => insert at top of document
  after_anchor_id text,
  inserted_markdown text not null,
  rationale text,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'rejected', 'stale')),
  status_reason text,
  -- version of contents.body_version the proposal was generated against
  base_content_version integer not null,
  -- SHA-256 of after_anchor_id block's plain-text content at proposal
  -- time. Accept path compares to current hash; mismatch => drift.
  base_anchor_content_hash text,
  -- anchors created by the accept path's insert (empty until accepted)
  applied_anchor_ids text[] not null default '{}'::text[],
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by_user_id uuid references public.users(id) on delete set null
);
create index content_proposals_content_status_idx
  on public.content_proposals (content_id, status, created_at);
create index content_proposals_message_idx
  on public.content_proposals (proposed_by_message_id);
alter table public.content_proposals enable row level security;

create policy content_proposals_owner
  on public.content_proposals
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

grant select, insert, update, delete
  on public.content_proposals
  to authenticated;

-- Ownership-integrity: pin content_proposals.owner_id to the parent
-- contents.owner_id (which itself is pinned to talks.owner_id by the
-- trigger above). Same SECURITY DEFINER pattern.
create or replace function public.content_proposals_assert_owner_matches_content()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  expected_owner uuid;
begin
  select owner_id into expected_owner
  from public.contents
  where id = new.content_id;

  if expected_owner is null then
    raise exception 'content_proposals.content_id % does not reference an existing content',
      new.content_id;
  end if;
  if expected_owner <> new.owner_id then
    raise exception 'content_proposals.owner_id % does not match contents.owner_id %',
      new.owner_id, expected_owner;
  end if;
  return new;
end;
$$;

create trigger content_proposals_owner_integrity
  before insert or update on public.content_proposals
  for each row execute function public.content_proposals_assert_owner_matches_content();
