import { defaultExclude, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The backend test suite uses postgres.js + Supabase (after phase-5 PR 2
    // cutover). Tests run serially in forked workers — slower, but stable for
    // shared-DB fixtures and native modules.
    include: [
      'src/**/*.test.ts',
      'setup/**/*.test.ts',
      'skills-engine/**/*.test.ts',
      'eval/**/*.test.ts',
    ],
    // *.workers.test.ts run in the workerd pool (vitest.workers.config.ts);
    // they import `cloudflare:test` and would fail in this Node forks pool.
    exclude: [...defaultExclude, '**/*.workers.test.ts'],
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
  },
});
