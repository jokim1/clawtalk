import {
  getPublicModeConfigErrors,
  getPublicModeDatabaseErrors,
} from './clawtalk/config.js';
import { getOwnerUser, initClawtalkSchema } from './clawtalk/db/index.js';
import { startWebServer } from './clawtalk/web/index.js';
import { initDatabase } from './db.js';
import { logger } from './logger.js';

function assertPublicModeConfigReady(): void {
  const errors = getPublicModeConfigErrors();
  if (errors.length === 0) return;
  logger.fatal({ errors }, 'Public mode startup guard failed before DB init');
  throw new Error(errors.join(' '));
}

function assertPublicModeDatabaseReady(): void {
  const errors = getPublicModeDatabaseErrors(Boolean(getOwnerUser()));
  if (errors.length === 0) return;
  logger.fatal({ errors }, 'Public mode startup guard failed after DB init');
  throw new Error(errors.join(' '));
}

async function main(): Promise<void> {
  let webServer: { stop: () => Promise<void> } | undefined;
  let shutdownPromise: Promise<void> | null = null;

  const gracefulShutdown = (reason: string, exitCode = 0): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      logger.info({ reason, exitCode }, 'Shutting down ClawTalk');
      if (webServer) {
        try {
          await webServer.stop();
        } catch (err) {
          logger.error({ err }, 'Web server stop failed');
        }
      }
      process.exit(exitCode);
    })();
    return shutdownPromise;
  };

  process.once('SIGTERM', () => void gracefulShutdown('SIGTERM'));
  process.once('SIGINT', () => void gracefulShutdown('SIGINT'));

  try {
    assertPublicModeConfigReady();
    initDatabase();
    initClawtalkSchema();
    assertPublicModeDatabaseReady();
    logger.info('Database initialized');

    webServer = await startWebServer();
  } catch (err) {
    logger.fatal({ err }, 'Startup failed');
    await gracefulShutdown('startup_failure', 1);
  }
}

const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start ClawTalk');
    process.exit(1);
  });
}
