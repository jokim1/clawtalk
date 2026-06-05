# TODOs

- [ ] If the OpenAI Codex OAuth poll API expands beyond the current `pending | authorized` frontend contract, update the SettingsPage poll loop to stop on terminal non-authorized statuses, such as expired or denied, and continue polling with backoff for recoverable responses such as slow_down. Today `webapp/src/lib/api.ts` only exposes `pending | authorized`, and backend provider poll errors are returned as API errors.
