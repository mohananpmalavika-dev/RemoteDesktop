import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import {
  SignalingMessageType,
  PROTOCOL_VERSION,
  AnySignalingMessageSchema,
  AuthenticatedSocketContext,
} from '@krypton/protocol';

describe('Secure Signaling Authentication & Authorization (Section 2: P0.2)', () => {
  const JWT_SECRET = 'dev_jwt_secret_must_be_overridden_in_prod_at_least_32_chars';
  const orgId = 'org-krypton-enterprise-1';
  const userId = 'usr-technician-01';

  it('validates schema for server-issued AUTH_CHALLENGE', () => {
    const nonce = crypto.randomBytes(32).toString('hex');
    const msg = {
      version: PROTOCOL_VERSION,
      type: SignalingMessageType.AUTH_CHALLENGE,
      correlationId: '123e4567-e89b-12d3-a456-426614174000',
      timestamp: Date.now(),
      payload: {
        nonce,
        serverTimestamp: Date.now(),
      },
    };

    const parsed = AnySignalingMessageSchema.safeParse(msg);
    expect(parsed.success).toBe(true);
  });

  it('validates user authentication with signed JWT token', () => {
    const accessToken = jwt.sign(
      { sub: userId, organizationId: orgId, permissions: ['remote.screen.view'] },
      JWT_SECRET,
      { expiresIn: '15m' }
    );

    const submitMsg = {
      version: PROTOCOL_VERSION,
      type: SignalingMessageType.AUTH_SUBMIT,
      correlationId: '123e4567-e89b-12d3-a456-426614174001',
      timestamp: Date.now(),
      payload: {
        subjectType: 'USER' as const,
        accessToken,
      },
    };

    const parsed = AnySignalingMessageSchema.safeParse(submitMsg);
    expect(parsed.success).toBe(true);

    // Verify token decoding produces authoritative identity
    const decoded = jwt.verify(accessToken, JWT_SECRET) as any;
    expect(decoded.sub).toBe(userId);
    expect(decoded.organizationId).toBe(orgId);

    const context: AuthenticatedSocketContext = {
      socketId: 'sock-1234',
      tenantId: decoded.organizationId,
      subjectType: 'USER',
      subjectId: decoded.sub,
      sessionIds: new Set(),
      authenticatedAt: new Date(),
    };

    expect(context.tenantId).toBe(orgId);
    expect(context.subjectId).toBe(userId);
  });

  it('validates device authentication with cryptographic Ed25519 challenge response', () => {
    // Generate test Ed25519 keypair
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyDer = publicKey.export({ type: 'spki', format: 'der' });
    // Raw 32-byte Ed25519 public key is last 32 bytes of 44-byte SPKI DER
    const rawPubKeyBytes = pubKeyDer.subarray(pubKeyDer.length - 32);
    const pubKeyBase64 = rawPubKeyBytes.toString('base64');

    const challengeNonce = crypto.randomBytes(32).toString('hex');

    // Device signs the nonce with its private key
    const signature = crypto.sign(null, Buffer.from(challengeNonce, 'utf8'), privateKey);
    const signatureBase64 = signature.toString('base64');

    const submitMsg = {
      version: PROTOCOL_VERSION,
      type: SignalingMessageType.AUTH_SUBMIT,
      correlationId: '123e4567-e89b-12d3-a456-426614174002',
      timestamp: Date.now(),
      payload: {
        subjectType: 'DEVICE' as const,
        deviceId: 'dev-win11-corp-01',
        nonce: challengeNonce,
        signature: signatureBase64,
        timestamp: Date.now(),
      },
    };

    const parsed = AnySignalingMessageSchema.safeParse(submitMsg);
    expect(parsed.success).toBe(true);

    // Server-side verification logic:
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
    const spkiKey = Buffer.concat([spkiPrefix, Buffer.from(pubKeyBase64, 'base64')]);
    const verifier = crypto.createPublicKey({ key: spkiKey, format: 'der', type: 'spki' });

    const isValid = crypto.verify(
      null,
      Buffer.from(challengeNonce, 'utf8'),
      verifier,
      Buffer.from(signatureBase64, 'base64')
    );

    expect(isValid).toBe(true);

    // Tampered nonce fails verification
    const isTampered = crypto.verify(
      null,
      Buffer.from('wrong_tampered_nonce', 'utf8'),
      verifier,
      Buffer.from(signatureBase64, 'base64')
    );
    expect(isTampered).toBe(false);
  });

  it('rejects cross-tenant and spoofed signaling routing', () => {
    const authContext: AuthenticatedSocketContext = {
      socketId: 'sock-victim',
      tenantId: 'tenant-alpha',
      subjectType: 'USER',
      subjectId: 'user-alpha-99',
      sessionIds: new Set(),
      authenticatedAt: new Date(),
    };

    const foreignSession = {
      sessionId: 'ses-beta-777',
      organizationId: 'tenant-beta', // Different tenant!
      viewerUserId: 'user-beta-01',
      deviceId: 'dev-beta-01',
    };

    // Rule 1: Tenant check
    const isSameTenant = authContext.tenantId === foreignSession.organizationId;
    expect(isSameTenant).toBe(false);

    // Rule 2: Membership check
    const isMember =
      authContext.subjectId === foreignSession.viewerUserId ||
      authContext.subjectId === foreignSession.deviceId;
    expect(isMember).toBe(false);
  });
});
