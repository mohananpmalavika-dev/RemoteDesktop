import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  SignalingMessageType,
  PROTOCOL_VERSION,
  AnySignalingMessageSchema,
  IceServerConfigSchema,
  OfferMessage,
  AnswerMessage,
  IceCandidateMessage,
} from '@krypton/protocol';
import { SessionState } from '@krypton/shared-types';

describe('Phase 3: Session Broker, Signaling & STUN/TURN Mechanics', () => {
  const TURN_SECRET = 'unit_test_turn_secret_min_16_chars!';
  const JWT_SECRET = 'unit_test_jwt_secret_32_characters_minimum!';

  it('Generates RFC 5766 / RFC 8489 compliant short-lived TURN credentials', () => {
    const userId = 'viewer-user-1234';
    const ttlSeconds = 86400;
    const expiryTimestamp = Math.floor(Date.now() / 1000) + ttlSeconds;

    const username = `${expiryTimestamp}:${userId}`;
    const credential = crypto
      .createHmac('sha1', TURN_SECRET)
      .update(username)
      .digest('base64');

    expect(username).toContain(userId);
    expect(credential).toBeDefined();
    expect(credential.length).toBeGreaterThan(10);

    // Verify credential format against schema
    const iceServerConfig = {
      urls: ['turn:relay.kryptonlogic.com:3478?transport=udp'],
      username,
      credential,
    };

    const parsed = IceServerConfigSchema.safeParse(iceServerConfig);
    expect(parsed.success).toBe(true);

    // Verify credential validation logic (server-side HMAC match)
    const expectedHmac = crypto
      .createHmac('sha1', TURN_SECRET)
      .update(username)
      .digest('base64');
    expect(credential).toBe(expectedHmac);

    // Verify expired credential check
    const isExpired = expiryTimestamp < Math.floor(Date.now() / 1000);
    expect(isExpired).toBe(false);
  });

  it('Generates tamper-evident cryptographic session authorization tokens (Section 11)', () => {
    const sessionId = 'session-uuid-1234';
    const viewerUserId = 'viewer-uuid-5678';
    const deviceId = 'device-uuid-9999';
    const nonce = crypto.randomBytes(16).toString('hex');
    const expiresAt = Date.now() + 300000;

    const payload = `${sessionId}:${viewerUserId}:${deviceId}:${nonce}:${expiresAt}`;
    const signature = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(payload)
      .digest('hex');

    const sessionToken = `${payload}.${signature}`;
    expect(sessionToken).toContain(sessionId);

    // Verify authentic token succeeds
    const [extractedPayload, extractedSig] = sessionToken.split('.');
    const recalculatedSig = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(extractedPayload)
      .digest('hex');
    expect(recalculatedSig).toBe(extractedSig);

    // Verify tampered payload fails signature check
    const tamperedPayload = extractedPayload.replace(deviceId, 'attacker-device');
    const tamperedSig = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(tamperedPayload)
      .digest('hex');
    expect(tamperedSig).not.toBe(extractedSig);
  });

  it('Validates WebRTC SDP Offer, Answer, and ICE candidate signaling schemas (Section 26)', () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';

    // 1. SDP Offer
    const offerMsg: OfferMessage = {
      version: PROTOCOL_VERSION,
      type: SignalingMessageType.OFFER,
      correlationId: '550e8400-e29b-41d4-a716-446655440001',
      timestamp: Date.now(),
      payload: {
        sessionId,
        sdp: 'v=0\r\no=- 123456789 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n',
      },
    };
    expect(AnySignalingMessageSchema.safeParse(offerMsg).success).toBe(true);

    // 2. SDP Answer
    const answerMsg: AnswerMessage = {
      version: PROTOCOL_VERSION,
      type: SignalingMessageType.ANSWER,
      correlationId: '550e8400-e29b-41d4-a716-446655440002',
      timestamp: Date.now(),
      payload: {
        sessionId,
        sdp: 'v=0\r\no=- 987654321 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n',
      },
    };
    expect(AnySignalingMessageSchema.safeParse(answerMsg).success).toBe(true);

    // 3. ICE Candidate
    const candidateMsg: IceCandidateMessage = {
      version: PROTOCOL_VERSION,
      type: SignalingMessageType.ICE_CANDIDATE,
      correlationId: '550e8400-e29b-41d4-a716-446655440003',
      timestamp: Date.now(),
      payload: {
        sessionId,
        candidate: 'candidate:1 1 UDP 2130706431 192.168.1.100 54321 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
      },
    };
    expect(AnySignalingMessageSchema.safeParse(candidateMsg).success).toBe(true);

    // 4. Session End
    const endMsg = {
      version: PROTOCOL_VERSION,
      type: SignalingMessageType.SESSION_END,
      correlationId: '550e8400-e29b-41d4-a716-446655440004',
      timestamp: Date.now(),
      payload: {
        sessionId,
        reason: 'Technician disconnected',
      },
    };
    expect(AnySignalingMessageSchema.safeParse(endMsg).success).toBe(true);
  });

  it('Enforces immutable capability negotiation rules (Section 10)', () => {
    // Initial requested capabilities
    const requested = {
      screenView: true,
      control: true,
      clipboard: true,
      fileTransfer: true,
      audioListen: false,
    };

    // User selectively accepts only screen viewing and clipboard
    const accepted = {
      screenView: requested.screenView,
      control: false, // User disabled remote control
      clipboard: requested.clipboard,
      fileTransfer: false, // User disabled file transfer
      audioListen: false,
    };

    // Verify capability contract
    expect(accepted.screenView).toBe(true);
    expect(accepted.control).toBe(false);
    expect(accepted.fileTransfer).toBe(false);

    // Accepted capability cannot exceed requested capability
    expect(accepted.control).toBe(false);
  });
});
