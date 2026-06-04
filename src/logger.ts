import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

// Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  // postgres.js's socket read-loop on Workers rejects its in-flight read
  // with "Stream was cancelled" when `withRequestScopedDb` closes the
  // per-request connection (`sql.end`, src/db.ts). The request has already
  // resolved successfully — this is benign connection-teardown noise, not a
  // failure — but the rejection floats, so it would otherwise log `{err:{}}`
  // once per request. Drop it; surface everything else.
  if (isBenignStreamCancellation(reason)) return;
  logger.error({ err: reason }, 'Unhandled rejection');
});

function isBenignStreamCancellation(reason: unknown): boolean {
  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === 'string'
        ? reason
        : reason && typeof reason === 'object' && 'message' in reason
          ? String((reason as { message: unknown }).message)
          : '';
  return message.includes('Stream was cancelled');
}
