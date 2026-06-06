# TODOs

- [ ] If the OpenAI Codex OAuth poll API expands beyond the current `pending | authorized` frontend contract, update the SettingsPage poll loop to stop on terminal non-authorized statuses, such as expired or denied, and continue polling with backoff for recoverable responses such as slow_down. Today `webapp/src/lib/api.ts` only exposes `pending | authorized`, and backend provider poll errors are returned as API errors.
- [ ] Home read pagination currently uses offset cursors over score-ordered Inbox/News queries. Before adding heavy infinite-scroll behavior, switch those cursors to a stable keyset/as-of contract so rows cannot skip or repeat when fallback recency scores or active row sets change between page fetches.
