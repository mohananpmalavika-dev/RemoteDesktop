import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/index';

describe('Config Loader & Fail-Fast Validator (Section 0 & 37)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('successfully parses valid development configuration', () => {
    process.env.NODE_ENV = 'development';
    process.env.DATABASE_URL = 'postgresql://krypton:secret@localhost:5432/db';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.JWT_ACCESS_SECRET = 'a_very_long_secure_jwt_access_secret_32_chars!';
    process.env.JWT_REFRESH_SECRET = 'a_very_long_secure_jwt_refresh_secret_32_chars!';
    process.env.DEVICE_ENROLLMENT_SIGNING_KEY = 'a_very_long_secure_device_signing_key_32_chars!';
    process.env.TURN_SECRET = 'dev_turn_shared_secret_min_16_chars';

    const config = loadConfig();
    expect(config.NODE_ENV).toBe('development');
    expect(config.API_PORT).toBe(4000);
  });

  it('fails fast in production when DATABASE_URL references localhost', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://krypton:secret@localhost:5432/db';
    process.env.REDIS_URL = 'redis://prod-redis.internal:6379';
    process.env.API_PUBLIC_URL = 'https://remote.kryptonlogic.com';
    process.env.JWT_ACCESS_SECRET = 'real_production_jwt_access_secret_32_chars!';
    process.env.JWT_REFRESH_SECRET = 'real_production_jwt_refresh_secret_32_chars!';
    process.env.DEVICE_ENROLLMENT_SIGNING_KEY = 'real_production_device_signing_key_32_chars!';
    process.env.TURN_SECRET = 'real_production_turn_secret_16_chars!';

    expect(() => loadConfig()).toThrow(/cannot reference localhost/);
  });

  it('fails fast in production when dev JWT secret is used', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://krypton:secret@postgres.internal:5432/db';
    process.env.REDIS_URL = 'redis://prod-redis.internal:6379';
    process.env.API_PUBLIC_URL = 'https://remote.kryptonlogic.com';
    process.env.JWT_ACCESS_SECRET = 'dev_jwt_access_secret_do_not_use_in_production!';
    process.env.JWT_REFRESH_SECRET = 'real_production_jwt_refresh_secret_32_chars!';
    process.env.DEVICE_ENROLLMENT_SIGNING_KEY = 'real_production_device_signing_key_32_chars!';
    process.env.TURN_SECRET = 'real_production_turn_secret_16_chars!';

    expect(() => loadConfig()).toThrow(/Development JWT secrets detected in production/);
  });
});
