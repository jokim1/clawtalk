-- 0025_content_proposals_replace.sql
--
-- Content feature v2 — propose_content_replace.
--
-- Widens content_proposals.kind from 'append'-only to also accept
-- 'replace'. Replace proposals target an existing block by anchor
-- (target_anchor_id) and substitute its contents with new markdown.
-- Append rows keep after_anchor_id (where to insert); replace rows
-- use target_anchor_id (which block to overwrite). Pairing constraint
-- enforces the two semantics don't mix.
--
-- drift_detected is persisted on the row so the amber "your edit was
-- overwritten" pill survives a reload — accept response already
-- returns this but the client lost it on refetch.
--
-- target_anchor_baseline_json snapshots the full Tiptap-JSON shape of
-- the target block at proposal time so the accept path can detect
-- *structural* drift (heading-level changes, list-marker changes,
-- mark changes) the plain-text content_hash misses.

alter table public.content_proposals
  drop constraint content_proposals_kind_check;

alter table public.content_proposals
  add constraint content_proposals_kind_check
  check (kind in ('append', 'replace'));

alter table public.content_proposals
  add column target_anchor_id text;

alter table public.content_proposals
  add column drift_detected boolean not null default false;

alter table public.content_proposals
  add column target_anchor_baseline_json jsonb;

alter table public.content_proposals
  add constraint content_proposals_kind_anchors_check
  check (
    (kind = 'append' and target_anchor_id is null)
    or (kind = 'replace'
        and target_anchor_id is not null
        and after_anchor_id is null)
  );
