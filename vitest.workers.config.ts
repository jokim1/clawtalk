import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Workers test pool for Durable Objects that need real workerd semantics —
// SQLite storage, blockConcurrencyWhile, and (in A2) alarms. Kept SEPARATE
// from the Node suite (vitest.config.ts, pool: 'forks'): the two pools are
// mutually exclusive, and `npm test` forces --pool=forks via run-vitest.mjs.
// Run with `npm run test:workers`.
//
// vitest-pool-workers 0.16.x (the vitest-v4 line) registers the pool as the
// `cloudflareTest` vite plugin rather than the old `defineWorkersProject`
// helper. A dedicated minimal entry (talk-runner.workers-entry.ts) is the
// worker `main` so the test bundle is just the DO and its imports — not the
// full Hono app, queues, assets, and Hyperdrive bindings that wrangler.toml
// declares for production.
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './src/clawtalk/talks/talk-runner.workers-entry.ts',
      miniflare: {
        compatibilityDate: '2026-05-12',
        compatibilityFlags: ['nodejs_compat'],
        durableObjects: {
          // useSQLite enables state.storage.sql (the step log lives there).
          TALK_RUNNER: { className: 'TalkRunner', useSQLite: true },
        },
      },
    }),
  ],
  test: {
    include: ['src/**/*.workers.test.ts'],
  },
});
