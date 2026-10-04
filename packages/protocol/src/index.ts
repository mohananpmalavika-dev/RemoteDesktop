import { z } from 'zod';

export const PROTOCOL_VERSION = '1.0';

/**
 * Signaling Message Types (Section 2 & 26)
 */
export enum SignalingMessageType {
  // Cryptographic Authentication Handshake (Section 2)
  AUTH_CHALLENGE = 'AUTH_CHALLENGE',
  AUTH_SUBMIT = 'AUTH_SUBMIT',
  AUTH_SUCCESS = 'AUTH_SUCCESS',

  REGISTER = 'REGISTER', // Legacy compatibility
  SESSION_REQUEST = 'SESSION_REQUEST',
  SESSION_ACCEPT = 'SESSION_ACCEPT',
  SESSION_REJECT = 'SESSION_REJECT',
  OFFER = 'OFFER',
  ANSWER = 'ANSWER',
  ICE_CANDIDATE = 'ICE_CANDIDATE',
  SESSION_END = 'SESSION_END',
  RECONNECT = 'RECONNECT',
  CAPABILITY_UPDATE = 'CAPABILITY_UPDATE',
  PING = 'PING',
  PONG = 'PONG',
  ERROR = 'ERROR',
}

export const CapabilitiesSchema = z.object({
  screenView: z.boolean().default(true),
  control: z.boolean().default(false),
  clipboard: z.boolean().default(false),
  fileTransfer: z.boolean().default(false),
  audioListen: z.boolean().default(false),
});

export const BaseSignalingMessageSchema = z.object({
  version: z.literal(PROTOCOL_VERSION).default(PROTOCOL_VERSION),
  type: z.nativeEnum(SignalingMessageType),
  correlationId: z.string().uuid(),
  timestamp: z.number().int().nonnegative(),
});

// 1. Auth Challenge: Server -> Client
export const AuthChallengeMessageSchema = BaseSignalingMessageSchema.extend({
  type: z.literal(SignalingMessageType.AUTH_CHALLENGE),
  payload: z.object({
    nonce: z.string().min(16),
    serverTimestamp: z.number(),
  }),
});

// 2. Auth Submit: Client -> Server
export const AuthSubmitMessageSchema = BaseSignalingMessageSchema.extend({
  type: z.literal(SignalingMessageType.AUTH_SUBMIT),
  payload: z.discriminatedUnion('subjectType', [
    z.object({
      subjectType: z.literal('USER'),
      accessToken: z.string().min(10), // Signed JWT
    }),
    z.object({
      subjectType: z.literal('DEVICE'),
      deviceId: z.string(),
      nonce: z.string().min(16),
      signature: z.string().min(10), // Base64 signature of nonce by Ed25519
      timestamp: z.number(),
    }),
  ]),
});

// 3. Auth Success: Server -> Client
export const AuthSuccessMessageSchema = BaseSignalingMessageSchema.extend({
  type: z.literal(SignalingMessageType.AUTH_SUCCESS),
  payload: z.object({
    socketId: z.string(),
    tenantId: z.string(),
    subjectType: z.enum(['USER', 'DEVICE']),
    subjectId: z.string(),
    authenticatedAt: z.string(),
  }),
});

// Legacy Register
export const RegisterMessageSchema = BaseSignalingMessageSchema.extend({
  type: z.literal(SignalingMessageType.REGISTER),
  payload: z.object({
    role: z.enum(['HOST_AGENT', 'VIEWER']),
    entityId: z.string(),
    token: z.string(),
  }),
});

// Session Request
export const SessionRequestMessageSchema = BaseSignalingMessageSchema.extend({
  type: z.literal(SignalingMessageType.SESSION_REQUEST),
  payload: z.object({
    sessionId: z.string().uuid(),
    viewerUserId: z.string(),
    viewerName: z.string(),
    organizationName: z.string(),
    targetDeviceId: z.string(),
    requestedCapabilities: CapabilitiesSchema,
  }),
});

// Session Accept
export const SessionAcceptMessageSchema = BaseSignalingMessageSchema.extend({
  type: z.literal(SignalingMessageType.SESSION_ACCEPT),
  payload: z.object({
    sessionId: z.string().uuid(),
    acceptedCapabilities: CapabilitiesSchema,
  }),
});

// Session Reject
export const SessionRejectMessageSchema = BaseSignalingMessageSchema.extend({
  type: z.literal(SignalingMessageType.SESSION_REJECT),
  payload: z.object({
    sessionId: z.string().uuid(),
    reason: z.string().optional(),
  }),
});

// SDP Offer
export const OfferMessageSchema = BaseSignalingMessageSchema.extend({
  type: z.literal(SignalingMessageType.OFFER),
  payload: z.object({
    sessionId: z.string().uuid(),
    sdp: z.string(),
  }),
});

// SDP Answer
export const AnswerMessageSchema = BaseSignalingMessageSchema.extend({
  type: z.literal(SignalingMessageType.ANSWER),
  payload: z.object({
    sessionId: z.string().uuid(),
    sdp: z.string(),
  }),
});

// ICE Candidate
export const IceCandidateMessageSchema = BaseSignalingMessageSchema.extend({
  type: z.literal(SignalingMessageType.ICE_CANDIDATE),
  payload: z.object({
    sessionId: z.string().uuid(),
    candidate: z.string(),
    sdpMid: z.string().nullable().optional(),
    sdpMLineIndex: z.number().int().nullable().optional(),
  }),
});

// Session End
export const SessionEndMessageSchema = BaseSignalingMessageSchema.extend({
  type: z.literal(SignalingMessageType.SESSION_END),
  payload: z.object({
    sessionId: z.string().uuid(),
    reason: z.string(),
  }),
});

// Reconnect
export const ReconnectMessageSchema = BaseSignalingMessageSchema.extend({
  type: z.literal(SignalingMessageType.RECONNECT),
  payload: z.object({
    sessionId: z.string().uuid(),
    reconnectToken: z.string(),
  }),
});

// Heartbeat Ping / Pong
export const PingMessageSchema = BaseSignalingMessageSchema.extend({
  type: z.literal(SignalingMessageType.PING),
  payload: z.object({
    clientTimestamp: z.number(),
  }),
});

export const PongMessageSchema = BaseSignalingMessageSchema.extend({
  type: z.literal(SignalingMessageType.PONG),
  payload: z.object({
    serverTimestamp: z.number(),
    clientTimestamp: z.number(),
  }),
});

export const AnySignalingMessageSchema = z.discriminatedUnion('type', [
  AuthChallengeMessageSchema,
  AuthSubmitMessageSchema,
  AuthSuccessMessageSchema,
  RegisterMessageSchema,
  SessionRequestMessageSchema,
  SessionAcceptMessageSchema,
  SessionRejectMessageSchema,
  OfferMessageSchema,
  AnswerMessageSchema,
  IceCandidateMessageSchema,
  SessionEndMessageSchema,
  ReconnectMessageSchema,
  PingMessageSchema,
  PongMessageSchema,
]);

export type AnySignalingMessage = z.infer<typeof AnySignalingMessageSchema>;
export type AuthChallengeMessage = z.infer<typeof AuthChallengeMessageSchema>;
export type AuthSubmitMessage = z.infer<typeof AuthSubmitMessageSchema>;
export type AuthSuccessMessage = z.infer<typeof AuthSuccessMessageSchema>;
export type SessionRequestMessage = z.infer<typeof SessionRequestMessageSchema>;
export type SessionAcceptMessage = z.infer<typeof SessionAcceptMessageSchema>;
export type SessionRejectMessage = z.infer<typeof SessionRejectMessageSchema>;
export type OfferMessage = z.infer<typeof OfferMessageSchema>;
export type AnswerMessage = z.infer<typeof AnswerMessageSchema>;
export type IceCandidateMessage = z.infer<typeof IceCandidateMessageSchema>;
export type ReconnectMessage = z.infer<typeof ReconnectMessageSchema>;

/**
 * Authoritative Server-Side Connection Context (Section 2)
 */
export interface AuthenticatedSocketContext {
  socketId: string;
  tenantId: string;
  subjectType: 'USER' | 'DEVICE';
  subjectId: string;
  sessionIds: Set<string>;
  authenticatedAt: Date;
}

/**
 * STUN / TURN ICE Server Configuration (RFC 5766 / RFC 8489)
 */
export const IceServerConfigSchema = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});

export type IceServerConfig = z.infer<typeof IceServerConfigSchema>;

export const IceConfigurationSchema = z.object({
  iceServers: z.array(IceServerConfigSchema),
  iceTransportPolicy: z.enum(['all', 'relay']).default('all'),
});

export type IceConfiguration = z.infer<typeof IceConfigurationSchema>;

/**
 * DataChannel Binary Message Headers (Section 15, 17, 18)
 */
export enum DataChannelOpcode {
  INPUT_MOUSE = 0x01,
  INPUT_KEYBOARD = 0x02,
  CLIPBOARD_TEXT = 0x10,
  FILE_TRANSFER_CHUNK = 0x20,
  FILE_TRANSFER_ACK = 0x21,
  LATENCY_PROBE = 0x30,
}
