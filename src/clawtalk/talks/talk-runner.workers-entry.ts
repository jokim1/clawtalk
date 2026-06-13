// Workers-test entry (Talk Runtime v2 PR-A1). vitest.workers.config.ts points
// the worker `main` here so @cloudflare/vitest-pool-workers constructs the
// REAL TalkRunner DO in workerd with SQLite storage. This is NOT a production
// entry — production exports TalkRunner from src/worker.ts.
import { TalkRunner } from './talk-runner.js';

export { TalkRunner };

export default {
  fetch(): Response {
    return new Response('talk-runner workers-test entry', { status: 200 });
  },
};
