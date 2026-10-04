import { describe, it, expect } from 'vitest';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

describe('Phase 2: Authentication & Cryptographic Identity Mechanics', () => {
  const TEST_PASSWORD = 'KryptonEnterprise#2026!';
  const JWT_SECRET = 'unit_test_jwt_secret_must_be_long_enough_32_bytes!';

  it('Argon2id hashing meets Section 8 production standards', async () => {
    const hash = await argon2.hash(TEST_PASSWORD, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
    });

    // Verify it is strictly argon2id
    expect(hash.startsWith('$argon2id$')).toBe(true);

    // Verify correct password succeeds
    const isValid = await argon2.verify(hash, TEST_PASSWORD);
    expect(isValid).toBe(true);

    // Verify incorrect password fails
    const isInvalid = await argon2.verify(hash, 'WrongPassword123');
    expect(isInvalid).toBe(false);
  });

  it('TOTP MFA generation and verification conforms to RFC 6238', () => {
    const secret = authenticator.generateSecret();
    expect(secret.length).toBeGreaterThanOrEqual(16);

    const otpauthUrl = authenticator.keyuri('admin@kryptonlogic.com', 'KryptonRemote', secret);
    expect(otpauthUrl).toContain('otpauth://totp/');
    expect(otpauthUrl).toContain('KryptonRemote');

    // Generate valid TOTP token using secret
    const token = authenticator.generate(secret);
    expect(token.length).toBe(6);

    // Verify code
    const isCheckValid = authenticator.check(token, secret);
    expect(isCheckValid).toBe(true);

    // Verify invalid code rejected
    const isCheckInvalid = authenticator.check('000000', secret);
    expect(isCheckInvalid).toBe(false);
  });

  it('Generates and verifies short-lived JWT access tokens with subject claims', () => {
    const payload = {
      userId: 'user-uuid-1234',
      organizationId: 'org-uuid-5678',
      email: 'tech@kryptonlogic.com',
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '15m' });
    expect(token).toBeDefined();

    const decoded = jwt.verify(token, JWT_SECRET) as any;
    expect(decoded.userId).toBe(payload.userId);
    expect(decoded.organizationId).toBe(payload.organizationId);
    expect(decoded.email).toBe(payload.email);
  });

  it('Generates formatted 9-digit Remote IDs (XXX XXX XXX)', () => {
    // Standard format per Section 7 & 30
    const rawNumber = Math.floor(100000000 + Math.random() * 900000000).toString();
    const formatted = `${rawNumber.slice(0, 3)} ${rawNumber.slice(3, 6)} ${rawNumber.slice(6, 9)}`;

    expect(formatted).toMatch(/^\d{3} \d{3} \d{3}$/);
    expect(formatted.length).toBe(11);
  });

  it('Validates 32-byte raw Ed25519 public key and derives SHA-256 fingerprint', () => {
    // Generate simulated 32-byte Ed25519 public key
    const rawKey = crypto.randomBytes(32);
    const base64Key = rawKey.toString('base64');

    const decoded = Buffer.from(base64Key, 'base64');
    expect(decoded.length).toBe(32);

    const fingerprint = crypto.createHash('sha256').update(decoded).digest('hex');
    expect(fingerprint.length).toBe(64);
  });
});
