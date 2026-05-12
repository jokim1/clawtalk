import { logger } from '../../logger.js';
import {
  TALK_RUN_MAX_CONCURRENCY,
  TALK_RUN_POLL_MS,
  WEB_HOST,
  WEB_PORT,
} from '../config.js';
import type { TalkExecutor } from '../talks/executor.js';
import { TalkJobWorker } from '../talks/job-worker.js';
import { CleanTalkExecutor } from '../talks/new-executor.js';
import { TalkRunWorker } from '../talks/run-worker.js';

import { createWebServer, WebServerHandle } from './server.js';

export async function startWebServer(): Promise<WebServerHandle> {
  const executor: TalkExecutor = new CleanTalkExecutor();

  logger.info(
    { mode: 'direct_http', executor: 'clean' },
    'Talk executor mode selected',
  );

  const runWorker = new TalkRunWorker({
    executor,
    pollMs: TALK_RUN_POLL_MS,
    maxConcurrency: TALK_RUN_MAX_CONCURRENCY,
  });
  await runWorker.start();

  const jobWorker = new TalkJobWorker({
    pollMs: TALK_RUN_POLL_MS,
    onRunQueued: () => {
      runWorker.wake();
    },
  });
  await jobWorker.start();

  const server = createWebServer({
    host: WEB_HOST,
    port: WEB_PORT,
    runWorker,
    jobWorker,
  });

  let bound: { host: string; port: number };
  try {
    bound = await server.start();
  } catch (error) {
    await jobWorker.stop();
    await runWorker.stop();
    throw error;
  }
  logger.info({ host: bound.host, port: bound.port }, 'Web API server started');

  const originalStop = server.stop.bind(server);
  server.stop = async () => {
    await jobWorker.stop();
    await runWorker.stop();
    await originalStop();
  };
  server.runWorker = runWorker;

  return server;
}
