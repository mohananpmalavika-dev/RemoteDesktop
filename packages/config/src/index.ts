import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

// Load environment variables from process.env or .env file
loadDotenv();

const EnvironmentSchema = z.enum(['development', 'test', 'production']);

const ConfigSchema = z.object({
  NODE_ENV: EnvironmentSchema.default('development'),
  
  // App branding
  APP_NAME: z.string().default('KryptonRemote'),
  COMPANY_NAME: z.string().default('KryptonLogic'),
  SUPPORT_URL: z.string().url().default('https://support.kryptonlogic.com'),

  // Networking & Bindings
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_HOST: z.string().default('0.0.0.0'),
  API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
  CORS_ORIGINS: z.string().default(''),
  TRUST_PROXY: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),

  SIGNALING_PORT: z.coerce.number().int().min(1).max(65535).default(4001),
  SIGNALING_HOST: z.string().default('0.0.0.0'),
  SIGNALING_PUBLIC_URL: z.string().url().default('ws://localhost:4001/signaling'),

  ADMIN_PORT: z.coerce.number().int().positive().default(3000),

  // Persistence & Cache
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  // Security & JWT
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_ACCESS_EXPIRATION: z.string().regex(/^[1-9]\d*(s|m|h|d)$/).default('15m'),
  JWT_REFRESH_EXPIRATION: z.string().regex(/^[1-9]\d*(s|m|h|d)$/).default('7d'),

  DEVICE_ENROLLMENT_SIGNING_KEY: z.string().min(32, 'DEVICE_ENROLLMENT_SIGNING_KEY must be at least 32 characters'),

  // STUN / TURN
  STUN_URLS: z.string().default('stun:localhost:3478'),
  TURN_URLS: z.string().default('turn:localhost:3478?transport=udp,turn:localhost:3478?transport=tcp'),
  TURN_SECRET: z.string().min(16, 'TURN_SECRET must be at least 16 characters'),
  TURN_REALM: z.string().default('kryptonremote.net'),
  TURN_CREDENTIAL_TTL_SECONDS: z.coerce.number().int().positive().default(86400),

  // Observability
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),

  // Rate Limiting
  RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_LOGIN_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_SESSION_CREATE_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_SESSION_CREATE_TTL_SECONDS: z.coerce.number().int().positive().default(60),
});

export type KryptonConfig = z.infer<typeof ConfigSchema>;

/**
 * Validates and returns the loaded configuration.
 * In production mode, strictly validates against localhost and placeholder credentials.
 */
export function loadConfig(): KryptonConfig {
  const parsed = ConfigSchema.safeParse(process.env);

  if (!parsed.success) {
    const errorDetails = parsed.error.issues
      .map((issue) => `  - [${issue.path.join('.')}]: ${issue.message}`)
      .join('\n');
    throw new Error(`[KryptonConfig] Invalid environment configuration:\n${errorDetails}`);
  }

  const config = parsed.data;

  // Strict production assertions per Section 0 & 37:
  // "Do not silently fall back to localhost when production configuration is missing. Production configuration must fail fast."
  if (config.NODE_ENV === 'production') {
    const forbiddenLocalSubstrings = ['localhost', '127.0.0.1', '::1'];

    if (forbiddenLocalSubstrings.some((host) => config.DATABASE_URL.includes(host))) {
      throw new Error('[KryptonConfig] FATAL: Production DATABASE_URL cannot reference localhost or loopback address.');
    }

    if (forbiddenLocalSubstrings.some((host) => config.REDIS_URL.includes(host))) {
      throw new Error('[KryptonConfig] FATAL: Production REDIS_URL cannot reference localhost or loopback address.');
    }

    if (forbiddenLocalSubstrings.some((host) => config.API_PUBLIC_URL.includes(host))) {
      throw new Error('[KryptonConfig] FATAL: Production API_PUBLIC_URL cannot reference localhost.');
    }

    if (config.JWT_ACCESS_SECRET.includes('dev_') || config.JWT_REFRESH_SECRET.includes('dev_')) {
      throw new Error('[KryptonConfig] FATAL: Development JWT secrets detected in production environment.');
    }

    if (config.TURN_SECRET.includes('dev_')) {
      throw new Error('[KryptonConfig] FATAL: Development TURN secret detected in production environment.');
    }
    for (const [name, value] of Object.entries({ API_PUBLIC_URL: config.API_PUBLIC_URL, SIGNALING_PUBLIC_URL: config.SIGNALING_PUBLIC_URL })) {
      const url = new URL(value);
      if (url.protocol !== (name === 'API_PUBLIC_URL' ? 'https:' : 'wss:') ||
          forbiddenLocalSubstrings.some(host => url.hostname.includes(host)) || url.username || url.password) {
        throw new Error(`[KryptonConfig] FATAL: Production ${name} must use a public secure URL.`);
      }
    }
    for (const origin of config.CORS_ORIGINS.split(',').filter(Boolean)) {
      const url = new URL(origin.trim());
      if (url.protocol !== 'https:' || url.origin !== origin.trim()) throw new Error('[KryptonConfig] Invalid production CORS origin.');
    }
    if (/dev_|krypton_(prod|production|device)|change.?me|placeholder/i.test(config.DEVICE_ENROLLMENT_SIGNING_KEY + config.JWT_ACCESS_SECRET + config.JWT_REFRESH_SECRET + config.TURN_SECRET)) {
      throw new Error('[KryptonConfig] FATAL: Placeholder production secrets detected.');
    }
    if (config.JWT_ACCESS_SECRET === config.JWT_REFRESH_SECRET) throw new Error('[KryptonConfig] JWT secrets must be distinct.');
    for (const value of [...config.STUN_URLS.split(','), ...config.TURN_URLS.split(',')]) {
      if (!/^(stun|stuns|turn|turns):[^\s/?]+(?::\d+)?(?:\?transport=(udp|tcp))?$/.test(value.trim()) ||
          /localhost|127\.0\.0\.1|\[::1\]/i.test(value)) throw new Error('[KryptonConfig] Production ICE URLs must reference a configured public STUN/TURN server.');
    }
  }

  return config;
}

// Cached singleton instance
let cachedConfig: KryptonConfig | null = null;

export function getConfig(): KryptonConfig {
  if (!cachedConfig) {
    cachedConfig = loadConfig();
  }
  return cachedConfig;
}
