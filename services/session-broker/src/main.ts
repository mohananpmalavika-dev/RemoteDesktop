import http from 'http';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { getConfig } from '@krypton/config';
import { createLogger } from '@krypton/logger';
import {
  SessionState,
  SessionCapabilities,
} from '@krypton/shared-types';

const logger = createLogger({ serviceName: 'krypton-session-broker' });
const config = getConfig();

const redis = new Redis(config.REDIS_URL);

export interface ActiveSessionRecord {
  sessionId: string;
  viewerUserId: string;
  targetDeviceId: string;
  organizationId: string;
  state: SessionState;
  capabilities: SessionCapabilities;
  sessionToken: string;
  createdAt: number;
  expiresAt: number;
}

export class SessionBroker {
  private static SESSION_TTL_SECONDS = 300; // 5 minute authorization validity window

  /**
   * Authorize and create a new session negotiation record
   */
  static async createSessionRequest(
    viewerUserId: string,
    targetDeviceId: string,
    organizationId: string,
    requestedCapabilities: SessionCapabilities
  ): Promise<ActiveSessionRecord> {
    const sessionId = uuidv4();
    const sessionToken = uuidv4();
    const now = Date.now();

    const record: ActiveSessionRecord = {
      sessionId,
      viewerUserId,
      targetDeviceId,
      organizationId,
      state: SessionState.AUTHORIZING,
      capabilities: requestedCapabilities,
      sessionToken,
      createdAt: now,
      expiresAt: now + this.SESSION_TTL_SECONDS * 1000,
    };

    await redis.setex(
      `krypton:session:${sessionId}`,
      this.SESSION_TTL_SECONDS,
      JSON.stringify(record)
    );

    logger.info({ sessionId, targetDeviceId, viewerUserId }, 'Created session request');
    return record;
  }

  /**
   * Update state upon host consent acceptance
   */
  static async acceptSession(
    sessionId: string,
    finalCapabilities: SessionCapabilities
  ): Promise<ActiveSessionRecord | null> {
    const key = `krypton:session:${sessionId}`;
    const raw = await redis.get(key);
    if (!raw) return null;

    const record: ActiveSessionRecord = JSON.parse(raw);
    record.state = SessionState.SIGNALING;
    record.capabilities = finalCapabilities;

    await redis.setex(key, this.SESSION_TTL_SECONDS, JSON.stringify(record));
    logger.info({ sessionId }, 'Session accepted by host');
    return record;
  }

  /**
   * Reject session
   */
  static async rejectSession(sessionId: string, reason?: string): Promise<void> {
    const key = `krypton:session:${sessionId}`;
    const raw = await redis.get(key);
    if (raw) {
      const record: ActiveSessionRecord = JSON.parse(raw);
      record.state = SessionState.REJECTED;
      await redis.setex(key, 60, JSON.stringify(record));
    }
    logger.warn({ sessionId, reason }, 'Session rejected');
  }
}

// Health check server
const server = http.createServer(async (req, res) => {
  if (req.url === '/health/live') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'UP', timestamp: new Date().toISOString() }));
    return;
  }

  if (req.url === '/health/ready') {
    const isRedisReady = redis.status === 'ready';
    if (isRedisReady) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'UP', timestamp: new Date().toISOString() }));
    } else {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'DOWN', error: 'Redis connection unavailable' }));
    }
    return;
  }

  res.writeHead(404);
  res.end();
});

const BROKER_PORT = Number(process.env.SESSION_BROKER_PORT) || 4002;
server.listen(BROKER_PORT, '0.0.0.0', () => {
  logger.info(`Krypton Session Broker health server running on port ${BROKER_PORT}`);
});
