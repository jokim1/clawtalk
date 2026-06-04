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
  // TEMP cutover-debug instrumentation — remove after diagnosis.
  const r = reason as { message?: unknown; stack?: unknown; code?: unknown };
  console.error(
    '[REJECT-DEBUG]',
    String(reason),
    JSON.stringify({ code: r?.code, message: r?.message }),
    r?.stack,
  );
  logger.error({ err: reason }, 'Unhandled rejection');
});
