import pino from 'pino';

// Redacted key paths for security & compliance (Section 28 & 35)
const REDACTED_KEYS = [
  'password',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'jwt',
  'secret',
  'privateKey',
  'clipboardContent',
  'mfaSecret',
  'authorization',
  'cookie',
  '*.password',
  '*.token',
  '*.secret',
  '*.clipboardContent',
];

export interface LoggerOptions {
  serviceName: string;
  logLevel?: string;
}

export function createLogger(options: LoggerOptions) {
  const isDev = process.env.NODE_ENV !== 'production';

  return pino({
    name: options.serviceName,
    level: options.logLevel || process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
    formatters: {
      level: (label) => ({ level: label.toUpperCase() }),
    },
    redact: {
      paths: REDACTED_KEYS,
      censor: '[REDACTED]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    base: {
      pid: process.pid,
      service: options.serviceName,
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
export default createLogger({ serviceName: 'krypton-default' });
