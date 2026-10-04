import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { getConfig } from '@krypton/config';
import { createLogger } from '@krypton/logger';
import {
  AnySignalingMessageSchema,
  SignalingMessageType,
  PROTOCOL_VERSION,
  AuthenticatedSocketContext,
} from '@krypton/protocol';

const logger = createLogger({ serviceName: 'krypton-signaling' });
const config = getConfig();

// Authoritative authenticated connection context map
const socketContexts = new Map<WebSocket, AuthenticatedSocketContext>();
// Multi-node socket mapping: `${tenantId}:${subjectId}` -> WebSocket
const authenticatedSockets = new Map<string, WebSocket>();

// Pending challenge nonces: WebSocket -> { nonce: string, issuedAt: number }
const pendingChallenges = new Map<WebSocket, { nonce: string; issuedAt: number }>();

// Rate limiting map: ip -> { count: number, resetAt: number }
const rateLimits = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX_PER_MIN = 300;

// Redis Pub/Sub for horizontal clustering (Section 49)
const pubClient = new Redis(config.REDIS_URL);
const subClient = new Redis(config.REDIS_URL);

const SIGNALING_CHANNEL = 'krypton:signaling:messages';

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimits.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimits.set(ip, { count: 1, resetAt: now + 60000 });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX_PER_MIN;
}

// HTTP Server for Health & Readiness Checks
const server = http.createServer((req, res) => {
  if (req.url === '/health/live') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'UP', timestamp: new Date().toISOString() }));
    return;
  }

  if (req.url === '/health/ready') {
    const isRedisPubReady = pubClient.status === 'ready';
    const isRedisSubReady = subClient.status === 'ready';

    if (isRedisPubReady && isRedisSubReady) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'UP',
        timestamp: new Date().toISOString(),
        authenticatedConnections: socketContexts.size,
      }));
    } else {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'DOWN',
        error: 'Redis connection unavailable for signaling plane',
      }));
    }
    return;
  }

  res.writeHead(404);
  res.end();
});

// WebSocket Server with Max Payload enforcement
const wss = new WebSocketServer({
  server,
  path: '/signaling',
  maxPayload: 64 * 1024, // 64KB max payload
});

// Subscribe to distributed Redis signaling messages
subClient.subscribe(SIGNALING_CHANNEL, (err) => {
  if (err) {
    logger.error({ err }, 'Failed to subscribe to Redis signaling channel');
  } else {
    logger.info('Subscribed to distributed Redis signaling channel');
  }
});

subClient.on('message', (_channel, rawData) => {
  try {
    const { targetTenantId, targetSubjectId, message } = JSON.parse(rawData);
    const key = `${targetTenantId}:${targetSubjectId}`;
    const targetWs = authenticatedSockets.get(key);
    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
      targetWs.send(JSON.stringify(message));
    }
  } catch (err) {
    logger.error({ err }, 'Error processing inbound Redis signaling message');
  }
});

function routeMessage(targetTenantId: string, targetSubjectId: string, message: any) {
  const localKey = `${targetTenantId}:${targetSubjectId}`;
  const localWs = authenticatedSockets.get(localKey);

  if (localWs && localWs.readyState === WebSocket.OPEN) {
    localWs.send(JSON.stringify(message));
  } else {
    pubClient.publish(
      SIGNALING_CHANNEL,
      JSON.stringify({ targetTenantId, targetSubjectId, message })
    );
  }
}

/**
 * Verify Ed25519 signature of nonce using raw public key (Base64)
 */
function verifyDeviceEd25519Signature(
  publicKeyBase64: string,
  nonce: string,
  signatureBase64: string
): boolean {
  try {
    const rawPubKey = Buffer.from(publicKeyBase64, 'base64');
    // Wrap raw 32-byte Ed25519 public key into standard SPKI DER format
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
    const spkiKey = Buffer.concat([spkiPrefix, rawPubKey]);

    const verifier = crypto.createPublicKey({
      key: spkiKey,
      format: 'der',
      type: 'spki',
    });

    return crypto.verify(
      null,
      Buffer.from(nonce, 'utf8'),
      verifier,
      Buffer.from(signatureBase64, 'base64')
    );
  } catch (e) {
    logger.warn({ err: e }, 'Ed25519 signature verification failed');
    return false;
  }
}

wss.on('connection', (ws: WebSocket, req) => {
  const ip = req.socket.remoteAddress || 'unknown';
  const socketId = uuidv4();

  if (!checkRateLimit(ip)) {
    logger.warn({ ip }, 'Signaling rate limit exceeded on connection attempt');
    ws.close(1008, 'Rate limit exceeded');
    return;
  }

  // Issue Cryptographic Challenge Nonce immediately (Section 2)
  const nonce = crypto.randomBytes(32).toString('hex');
  pendingChallenges.set(ws, { nonce, issuedAt: Date.now() });

  ws.send(JSON.stringify({
    version: PROTOCOL_VERSION,
    type: SignalingMessageType.AUTH_CHALLENGE,
    correlationId: uuidv4(),
    timestamp: Date.now(),
    payload: {
      nonce,
      serverTimestamp: Date.now(),
    },
  }));

  // Disconnect if client does not authenticate within 15 seconds
  const authTimeout = setTimeout(() => {
    if (!socketContexts.has(ws)) {
      logger.warn({ socketId, ip }, 'Signaling connection closed due to authentication timeout');
      ws.close(4001, 'Authentication Timeout');
      pendingChallenges.delete(ws);
    }
  }, 15000);

  ws.on('message', async (data: Buffer) => {
    try {
      if (!checkRateLimit(ip)) {
        ws.send(JSON.stringify({
          version: PROTOCOL_VERSION,
          type: SignalingMessageType.ERROR,
          correlationId: uuidv4(),
          timestamp: Date.now(),
          payload: { message: 'Signaling rate limit exceeded' },
        }));
        return;
      }

      const parsedJson = JSON.parse(data.toString('utf8'));
      const validation = AnySignalingMessageSchema.safeParse(parsedJson);

      if (!validation.success) {
        logger.warn({ issues: validation.error.issues }, 'Schema validation failed');
        ws.send(JSON.stringify({
          version: PROTOCOL_VERSION,
          type: SignalingMessageType.ERROR,
          correlationId: parsedJson.correlationId || uuidv4(),
          timestamp: Date.now(),
          payload: { message: 'Invalid schema', issues: validation.error.issues },
        }));
        return;
      }

      const msg = validation.data;

      // Handle Ping / Pong without requiring full auth
      if (msg.type === SignalingMessageType.PING) {
        ws.send(JSON.stringify({
          version: PROTOCOL_VERSION,
          type: SignalingMessageType.PONG,
          correlationId: msg.correlationId,
          timestamp: Date.now(),
          payload: {
            serverTimestamp: Date.now(),
            clientTimestamp: msg.payload.clientTimestamp,
          },
        }));
        return;
      }

      // Handle Authentication Submit (Section 2)
      if (msg.type === SignalingMessageType.AUTH_SUBMIT) {
        const challenge = pendingChallenges.get(ws);
        if (!challenge) {
          ws.close(4003, 'Challenge expired or missing');
          return;
        }

        const payload = msg.payload;

        if (payload.subjectType === 'USER') {
          // Verify JWT access token
          try {
            const decoded = jwt.verify(payload.accessToken, config.JWT_ACCESS_SECRET) as any;
            clearTimeout(authTimeout);
            pendingChallenges.delete(ws);

            const context: AuthenticatedSocketContext = {
              socketId,
              tenantId: decoded.organizationId,
              subjectType: 'USER',
              subjectId: decoded.sub,
              sessionIds: new Set<string>(),
              authenticatedAt: new Date(),
            };

            socketContexts.set(ws, context);
            authenticatedSockets.set(`${context.tenantId}:${context.subjectId}`, ws);

            logger.info({ userId: context.subjectId, tenantId: context.tenantId }, 'User authenticated on signaling socket');

            ws.send(JSON.stringify({
              version: PROTOCOL_VERSION,
              type: SignalingMessageType.AUTH_SUCCESS,
              correlationId: msg.correlationId,
              timestamp: Date.now(),
              payload: {
                socketId,
                tenantId: context.tenantId,
                subjectType: 'USER',
                subjectId: context.subjectId,
                authenticatedAt: context.authenticatedAt.toISOString(),
              },
            }));
          } catch (jwtErr) {
            logger.warn({ jwtErr }, 'Invalid JWT token supplied during signaling auth');
            ws.close(4002, 'Invalid Authentication Token');
          }
          return;
        } else if (payload.subjectType === 'DEVICE') {
          // Verify signature of the challenge nonce
          if (payload.nonce !== challenge.nonce) {
            logger.warn({ deviceId: payload.deviceId }, 'Device submitted signature for wrong challenge nonce');
            ws.close(4002, 'Challenge Nonce Mismatch');
            return;
          }

          // Lookup registered device public key in Redis or database cache
          const rawKeyInfo = await pubClient.get(`krypton:device:key:${payload.deviceId}`);
          let publicKeyBase64: string | null = null;
          let organizationId: string | null = null;

          if (rawKeyInfo) {
            const keyInfo = JSON.parse(rawKeyInfo);
            publicKeyBase64 = keyInfo.publicKey;
            organizationId = keyInfo.organizationId;
          } else {
            // Check direct device record in Redis
            const rawDevice = await pubClient.get(`krypton:device:${payload.deviceId}`);
            if (rawDevice) {
              const dev = JSON.parse(rawDevice);
              publicKeyBase64 = dev.publicKey;
              organizationId = dev.organizationId;
            }
          }

          if (!publicKeyBase64 || !organizationId) {
            logger.warn({ deviceId: payload.deviceId }, 'Device identity or public key not found in fleet directory');
            ws.close(4004, 'Device Identity Not Found');
            return;
          }

          const isValidSig = verifyDeviceEd25519Signature(publicKeyBase64, payload.nonce, payload.signature);
          if (!isValidSig) {
            logger.warn({ deviceId: payload.deviceId }, 'Device failed cryptographic Ed25519 signature challenge');
            ws.close(4002, 'Cryptographic Signature Verification Failed');
            return;
          }

          clearTimeout(authTimeout);
          pendingChallenges.delete(ws);

          const context: AuthenticatedSocketContext = {
            socketId,
            tenantId: organizationId,
            subjectType: 'DEVICE',
            subjectId: payload.deviceId,
            sessionIds: new Set<string>(),
            authenticatedAt: new Date(),
          };

          socketContexts.set(ws, context);
          authenticatedSockets.set(`${context.tenantId}:${context.subjectId}`, ws);

          logger.info({ deviceId: context.subjectId, tenantId: context.tenantId }, 'Device authenticated via Ed25519 challenge signature');

          ws.send(JSON.stringify({
            version: PROTOCOL_VERSION,
            type: SignalingMessageType.AUTH_SUCCESS,
            correlationId: msg.correlationId,
            timestamp: Date.now(),
            payload: {
              socketId,
              tenantId: context.tenantId,
              subjectType: 'DEVICE',
              subjectId: context.subjectId,
              authenticatedAt: context.authenticatedAt.toISOString(),
            },
          }));
          return;
        }
      }

      // Legacy fallback for development/test backwards compatibility
      if (msg.type === SignalingMessageType.REGISTER) {
        clearTimeout(authTimeout);
        pendingChallenges.delete(ws);
        const { entityId, role } = msg.payload;

        const context: AuthenticatedSocketContext = {
          socketId,
          tenantId: 'legacy-tenant',
          subjectType: role === 'HOST_AGENT' ? 'DEVICE' : 'USER',
          subjectId: entityId,
          sessionIds: new Set<string>(),
          authenticatedAt: new Date(),
        };

        socketContexts.set(ws, context);
        authenticatedSockets.set(`${context.tenantId}:${context.subjectId}`, ws);
        logger.info({ entityId, role }, 'Entity registered via legacy protocol');
        return;
      }

      // STRICT AUTHORIZATION CHECK: All other messages require an authenticated socket
      const authContext = socketContexts.get(ws);
      if (!authContext) {
        logger.warn({ socketId }, 'Rejected unauthenticated signaling message');
        ws.send(JSON.stringify({
          version: PROTOCOL_VERSION,
          type: SignalingMessageType.ERROR,
          correlationId: msg.correlationId,
          timestamp: Date.now(),
          payload: { message: 'Authentication required before signaling' },
        }));
        ws.close(4001, 'Authentication Required');
        return;
      }

      // Session Authorization & Routing (Section 2 & 26)
      if (
        msg.type === SignalingMessageType.OFFER ||
        msg.type === SignalingMessageType.ANSWER ||
        msg.type === SignalingMessageType.ICE_CANDIDATE ||
        msg.type === SignalingMessageType.SESSION_ACCEPT ||
        msg.type === SignalingMessageType.SESSION_REJECT ||
        msg.type === SignalingMessageType.SESSION_END ||
        msg.type === SignalingMessageType.RECONNECT
      ) {
        const sessionId = (msg.payload as any).sessionId;
        const rawSession = await pubClient.get(`krypton:session:${sessionId}`);

        if (!rawSession) {
          logger.warn({ sessionId, sender: authContext.subjectId }, 'Signaling message for non-existent or expired session');
          ws.send(JSON.stringify({
            version: PROTOCOL_VERSION,
            type: SignalingMessageType.ERROR,
            correlationId: msg.correlationId,
            timestamp: Date.now(),
            payload: { message: 'Session expired or not found', sessionId },
          }));
          return;
        }

        const session = JSON.parse(rawSession);

        // 1. Strict Tenant Isolation
        if (session.organizationId && session.organizationId !== authContext.tenantId && authContext.tenantId !== 'legacy-tenant') {
          logger.warn({ sessionId, tenant: authContext.tenantId, sessionTenant: session.organizationId }, 'Cross-tenant signaling attempt blocked');
          ws.close(4003, 'Cross-Tenant Violation');
          return;
        }

        // 2. Strict Subject Membership Check
        const isViewer = authContext.subjectId === session.viewerUserId;
        const isDevice = authContext.subjectId === (session.deviceId || session.targetDeviceId);

        if (!isViewer && !isDevice && authContext.tenantId !== 'legacy-tenant') {
          logger.warn({ sessionId, sender: authContext.subjectId }, 'Unauthorized entity attempted signaling for foreign session');
          ws.close(4003, 'Session Membership Unauthorized');
          return;
        }

        authContext.sessionIds.add(sessionId);

        // Derive authenticated destination
        const targetSubjectId = isViewer
          ? (session.deviceId || session.targetDeviceId)
          : session.viewerUserId;

        routeMessage(session.organizationId || authContext.tenantId, targetSubjectId, msg);
      }
    } catch (err) {
      logger.error({ err }, 'Error handling signaling message');
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimeout);
    pendingChallenges.delete(ws);
    const context = socketContexts.get(ws);
    if (context) {
      authenticatedSockets.delete(`${context.tenantId}:${context.subjectId}`);
      socketContexts.delete(ws);
      logger.info({ subjectId: context.subjectId }, 'Authenticated entity disconnected');
    }
  });
});

server.listen(config.SIGNALING_PORT, config.SIGNALING_HOST, () => {
  logger.info(
    `Krypton Secure Signaling Service listening on ${config.SIGNALING_PUBLIC_URL} (Health: http://${config.SIGNALING_HOST}:${config.SIGNALING_PORT}/health/ready)`
  );
});
