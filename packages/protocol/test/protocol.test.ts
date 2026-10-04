import { describe, it, expect } from 'vitest';
import {
  AnySignalingMessageSchema,
  SignalingMessageType,
  PROTOCOL_VERSION,
} from '../src/index';

describe('Signaling Protocol Schema Validation (Section 26)', () => {
  it('validates a legitimate REGISTER message', () => {
    const raw = {
      version: PROTOCOL_VERSION,
      type: SignalingMessageType.REGISTER,
      correlationId: '123e4567-e89b-12d3-a456-426614174000',
      timestamp: Date.now(),
      payload: {
        role: 'HOST_AGENT',
        entityId: 'device-uuid-1234',
        token: 'device_session_token_xyz',
      },
    };

    const parsed = AnySignalingMessageSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
  });

  it('validates a SESSION_REQUEST message with capabilities', () => {
    const raw = {
      version: PROTOCOL_VERSION,
      type: SignalingMessageType.SESSION_REQUEST,
      correlationId: '123e4567-e89b-12d3-a456-426614174000',
      timestamp: Date.now(),
      payload: {
        sessionId: '123e4567-e89b-12d3-a456-426614174001',
        viewerUserId: 'user-id-5678',
        viewerName: 'Support Tech Alpha',
        organizationName: 'KryptonLogic Corp',
        targetDeviceId: 'device-uuid-1234',
        requestedCapabilities: {
          screenView: true,
          control: true,
          clipboard: true,
          fileTransfer: false,
          audioListen: false,
        },
      },
    };

    const parsed = AnySignalingMessageSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
  });

  it('rejects an invalid signaling message missing correlationId', () => {
    const raw = {
      version: PROTOCOL_VERSION,
      type: SignalingMessageType.PING,
      timestamp: Date.now(),
      payload: {
        clientTimestamp: Date.now(),
      },
    };

    const parsed = AnySignalingMessageSchema.safeParse(raw);
    expect(parsed.success).toBe(false);
  });
});
