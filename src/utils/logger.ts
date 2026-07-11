import pino from 'pino';
import type { LoggingConfig } from '../config/config.js';
import { sanitizeLogValue } from '../security/log-safety.js';

const safeHooks: pino.LoggerOptions['hooks'] = {
  logMethod(args, method) {
    const sanitized = args.map(arg => (
      typeof arg === 'string' || (arg && typeof arg === 'object')
        ? sanitizeLogValue(arg)
        : arg
    ));
    method.apply(this, sanitized as Parameters<typeof method>);
  },
};

export function createLogger(config: LoggingConfig): pino.Logger {
  // Use pino-pretty only in development (when available)
  const isDev = process.env.NODE_ENV !== 'production';

  if (isDev) {
    try {
      // Check if pino-pretty is available
      require.resolve('pino-pretty');
      return pino({
        level: config.level,
        hooks: safeHooks,
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        },
      });
    } catch {
      // pino-pretty not available, fall through to JSON logging
    }
  }

  // Production: use JSON logging (no pino-pretty needed)
  return pino({
    level: config.level,
    hooks: safeHooks,
  });
}
