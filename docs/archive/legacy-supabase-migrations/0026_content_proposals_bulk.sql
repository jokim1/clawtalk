-- 0026_content_proposals_bulk.sql
--
-- Content feature v3 — propose_content_bulk.
--
-- Widens content_proposals.kind from ('append', 'replace') to also accept
-- 'bulk'. Bulk proposals replace the entire document body in a single
-- move; they don't target an anchor. The agent uses bulk when the edit
-- spans ≥3 blocks or rewrites a whole section so the user can approve
-- the change once instead of accepting a stream of per-block cards.

alter table public.content_proposals
  drop constraint content_proposals_kind_check;

alter table public.content_proposals
  add constraint content_proposals_kind_check
  check (kind in ('append', 'replace', 'bulk'));

-- Pairing constraint covers all three kinds:
-- - append:  target_anchor_id IS NULL                     (after_anchor_id may be set)
-- - replace: target_anchor_id IS NOT NULL AND after_anchor_id IS NULL
-- - bulk:    both anchors IS NULL                         (whole-doc replace)
alter table public.content_proposals
  drop constraint content_proposals_kind_anchors_check;

alter table public.content_proposals
  add constraint content_proposals_kind_anchors_check
  check (
    (kind = 'append' and target_anchor_id is null)
    or (kind = 'replace'
        and target_anchor_id is not null
        and after_anchor_id is null)
    or (kind = 'bulk'
        and target_anchor_id is null
        and after_anchor_id is null)
  );
