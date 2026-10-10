import http from 'http';
import { isIP } from 'net';
import { WebSocketServer, WebSocket } from 'ws';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { AccessClaimsSchema, GuestClaimsSchema } from '@krypton/protocol';
import { authorizeSessionMessage } from './authorization';
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
const prisma = new PrismaClient();
const socketClaims = new Map<WebSocket, any>();

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
const server = http.createServer(async (req, res) => {
  if (req.url === '/health/live') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'UP', timestamp: new Date().toISOString() }));
    return;
  }

  if (req.url === '/health/ready') {
    const isRedisPubReady = pubClient.status === 'ready';
    const isRedisSubReady = subClient.status === 'ready';

    const isDatabaseReady = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
    if (isRedisPubReady && isRedisSubReady && isDatabaseReady) {
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
        error: 'A signaling dependency is unavailable',
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
  const forwarded = typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'].split(',').at(-1)?.trim() : undefined;
  const ip = config.TRUST_PROXY && forwarded && isIP(forwarded) ? forwarded : req.socket.remoteAddress || 'unknown';
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

  let processing = Promise.resolve();
  let queued = 0;
  ws.on('message', (data: Buffer) => {
    if (++queued > 32) { ws.close(4008, 'Too many pending messages'); return; }
    processing = processing.then(async () => {
    if (ws.readyState !== WebSocket.OPEN) return;
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
        if (!challenge || Date.now() - challenge.issuedAt > 15000 || socketContexts.has(ws)) {
          ws.close(4003, 'Challenge expired or missing');
          return;
        }

        const payload = msg.payload;

        if (payload.subjectType === 'USER') {
          // Verify JWT access token
          try {
            const decoded = jwt.verify(payload.accessToken, config.JWT_ACCESS_SECRET, { algorithms: ['HS256'] });
            const access = AccessClaimsSchema.safeParse(decoded);
            const guest = GuestClaimsSchema.safeParse(decoded);
            if (!access.success && !guest.success) throw new Error('Invalid token scope');
            const claims = access.success ? access.data : guest.success ? guest.data : null;
            if (!claims) throw new Error('Invalid claims');
            if (access.success) {
              const user = await prisma.user.findUnique({ where: { id: access.data.userId } });
              const family = await prisma.refreshToken.findFirst({ where: { userId: access.data.userId, familyId: access.data.familyId, isRevoked: false, expiresAt: { gt: new Date() } } });
              if (!user || user.status !== 'ACTIVE' || user.organizationId !== claims.organizationId || !family) throw new Error('Revoked identity');
            } else if (guest.success) {
              const raw = await pubClient.get(`krypton:session:${guest.data.sessionId}`);
              if (!raw || JSON.parse(raw).viewerUserId !== claims.sub) throw new Error('Guest session expired');
            }
            socketClaims.set(ws, { ...claims, exp: (decoded as any).exp });
            clearTimeout(authTimeout);
            pendingChallenges.delete(ws);

            const context: AuthenticatedSocketContext = {
              socketId,
              tenantId: claims.organizationId,
              subjectType: 'USER',
              subjectId: claims.sub,
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

          const device = await prisma.device.findUnique({ where: { id: payload.deviceId }, include: { deviceKeys: { where: { isActive: true } } } });
          const publicKeyBase64 = device && device.status !== 'REVOKED' && device.isEnrolled ? device.deviceKeys[0]?.publicKey : null;
          const organizationId = device?.organizationId;

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

      if (msg.type === SignalingMessageType.REGISTER) {
        ws.close(4003, 'Legacy unauthenticated registration is disabled');
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
        msg.type === SignalingMessageType.SESSION_REQUEST ||
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

        const claims = socketClaims.get(ws);
        if (claims?.exp && claims.exp * 1000 <= Date.now()) { ws.close(4002, 'Token expired'); return; }
        if (authContext.subjectType === 'DEVICE') {
          const device = await prisma.device.findUnique({ where: { id: authContext.subjectId }, include: { deviceKeys: { where: { isActive: true } } } });
          if (!device || device.status === 'REVOKED' || device.deviceKeys.length === 0) { ws.close(4003, 'Device revoked'); return; }
        } else if (claims?.tokenUse === 'access') {
          const user = await prisma.user.findUnique({ where: { id: authContext.subjectId } });
          const live = await prisma.refreshToken.findFirst({ where: { userId: authContext.subjectId, familyId: claims.familyId, isRevoked: false, expiresAt: { gt: new Date() } } });
          if (!user || user.status !== 'ACTIVE' || !live) { ws.close(4003, 'Identity revoked'); return; }
        }
        let side: 'viewer' | 'device';
        try { side = authorizeSessionMessage(authContext, session, msg.type, claims?.sessionId); }
        catch { ws.close(4003, 'Session authorization denied'); return; }
        const isViewer = side === 'viewer';
        if (msg.type === SignalingMessageType.SESSION_REQUEST) {
          const existing = await prisma.remoteSession.findUnique({ where: { id: sessionId }, include: { device: { include: { organization: true } }, viewerUser: true } });
          if (!existing) return;
          const authoritative = { ...msg, payload: { sessionId, viewerUserId: session.viewerUserId,
            viewerName: claims?.tokenUse === 'guest-session' ? 'Guest browser viewer (identity unverified)' : existing.viewerUser.email,
            organizationName: existing.device.organization.name, targetDeviceId: session.deviceId,
            requestedCapabilities: session.capabilities } };
          routeMessage(session.organizationId, session.deviceId, authoritative);
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
      ws.close(4003, 'Invalid signaling message');
    }
    }).finally(() => { queued--; });
  });

  ws.on('close', () => {
    clearTimeout(authTimeout);
    pendingChallenges.delete(ws);
    const context = socketContexts.get(ws);
    if (context) {
      const key = `${context.tenantId}:${context.subjectId}`;
      if (authenticatedSockets.get(key) === ws) authenticatedSockets.delete(key);
      socketClaims.delete(ws);
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

const sweep = setInterval(() => {
  for (const [ip, limit] of rateLimits) if (limit.resetAt <= Date.now()) rateLimits.delete(ip);
  for (const [ws, claims] of socketClaims) if (claims.exp * 1000 <= Date.now()) ws.close(4002, 'Token expired');
}, 30000);
sweep.unref();
async function shutdown() {
  clearInterval(sweep);
  for (const ws of wss.clients) ws.terminate();
  wss.close(); server.close();
  await Promise.all([pubClient.quit(), subClient.quit(), prisma.$disconnect()]);
}
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
