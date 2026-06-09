alter table public.home_news_matches
  add column if not exists snoozed_until timestamptz;

create index if not exists home_news_matches_snoozed_until_idx
  on public.home_news_matches (workspace_id, status, snoozed_until, score desc);
