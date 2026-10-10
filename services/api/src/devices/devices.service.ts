import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AuditService } from '../audit/audit.service';
import {
  DeviceHeartbeat,
  DeviceStatus,
  AuditAction,
} from '@krypton/shared-types';
import { createLogger } from '@krypton/logger';
import { parseBody, devicePolicySchema, paginationSchema } from '../common/validation';
import { z } from 'zod';

const logger = createLogger({ serviceName: 'devices-service' });

@Injectable()
export class DevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService
  ) {}

  /**
   * Generates a unique, formatted, human-friendly 9-digit Remote ID (Section 7)
   * Format: "XXX XXX XXX" (e.g., "834 951 220")
   */
  private async generateUniqueRemoteId(): Promise<string> {
    for (let attempts = 0; attempts < 10; attempts++) {
      // Generate 9 random digits avoiding leading zeroes for clarity
      const rawNumber = crypto.randomInt(100000000, 1000000000).toString();
      const formatted = `${rawNumber.slice(0, 3)} ${rawNumber.slice(3, 6)} ${rawNumber.slice(6, 9)}`;

      const exists = await this.prisma.device.findUnique({
        where: { remoteId: formatted },
      });

      if (!exists) {
        return formatted;
      }
    }
    throw new Error('Failed to generate collision-free Remote ID after 10 attempts');
  }

  /**
   * Creates a secure single-use enrollment token (Section 6)
   */
  async createEnrollmentToken(
    organizationId: string,
    createdById: string,
    expiresInHours = 24
  ) {
    parseBody(z.number().int().min(1).max(168), expiresInHours);
    const rawToken = 'ket_' + crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);

    const tokenRecord = await this.prisma.deviceEnrollmentToken.create({
      data: {
        organizationId,
        tokenHash,
        createdById,
        expiresAt,
      },
    });

    await this.audit.record({
      organizationId,
      actorId: createdById,
      actorType: 'USER',
      action: 'DEVICE_ENROLLMENT_TOKEN_CREATED',
      targetType: 'DEVICE_ENROLLMENT_TOKEN',
      targetId: tokenRecord.id,
      result: 'SUCCESS',
      metadata: { expiresInHours },
    });

    return {
      token: rawToken,
      expiresAt: tokenRecord.expiresAt,
    };
  }

  /**
   * Enrolls a new remote host agent using an enrollment token (Section 6)
   */
  async enrollDevice(params: {
    rawEnrollmentToken?: string;
    publicKeyBase64: string;
    deviceName: string;
    hostname: string;
    os: string;
    osVersion: string;
    architecture: string;
    agentVersion: string;
    sourceIp?: string;
  }) {
    params = parseBody(z.object({
      rawEnrollmentToken: z.string().min(20).max(200),
      publicKeyBase64: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
      deviceName: z.string().trim().min(1).max(128), hostname: z.string().trim().min(1).max(255),
      os: z.string().min(1).max(64), osVersion: z.string().min(1).max(64),
      architecture: z.string().min(1).max(32), agentVersion: z.string().min(1).max(32), sourceIp: z.string().optional(),
    }).strict(), params);
    // Verify Ed25519 public key length (32 bytes raw, 44 chars in base64)
    const pubKeyBuffer = Buffer.from(params.publicKeyBase64, 'base64');
    if (pubKeyBuffer.length !== 32) {
      throw new BadRequestException('Invalid Ed25519 public key format. Expected 32 raw bytes.');
    }

    const keyFingerprint = crypto
      .createHash('sha256')
      .update(pubKeyBuffer)
      .digest('hex');

    // Check if key fingerprint is already bound to another active device (idempotency)
    const existingKey = await this.prisma.deviceKey.findUnique({
      where: { keyFingerprint },
      include: { device: true },
    });

    let organizationId: string;
    let tokenId: string | null = null;

    if (params.rawEnrollmentToken && params.rawEnrollmentToken.trim() !== '' && params.rawEnrollmentToken !== 'auto') {
      const tokenHash = crypto
        .createHash('sha256')
        .update(params.rawEnrollmentToken.trim())
        .digest('hex');

      const token = await this.prisma.deviceEnrollmentToken.findUnique({
        where: { tokenHash },
      });

      if (!token) {
        throw new BadRequestException('Invalid enrollment token.');
      }

      if (token.isUsed) {
        throw new ForbiddenException('Enrollment token has already been used.');
      }

      if (token.expiresAt < new Date()) {
        throw new ForbiddenException('Enrollment token has expired.');
      }

      organizationId = token.organizationId;
      tokenId = token.id;
    } else {
      throw new ForbiddenException('A single-use enrollment token is required.');
    }
    if (existingKey && (existingKey.device.organizationId !== organizationId || !existingKey.isActive || existingKey.device.status === 'REVOKED')) {
      throw new ForbiddenException('This device identity is revoked or belongs to another organization.');
    }

    const remoteId = await this.generateUniqueRemoteId();

    // Transaction: create device, associate key, create default policy, invalidate enrollment token
    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Invalidate enrollment token if used
      if (tokenId) {
        const claimed = await tx.deviceEnrollmentToken.updateMany({
          where: { id: tokenId, isUsed: false, expiresAt: { gt: new Date() } },
          data: { isUsed: true, usedAt: new Date() },
        });
        if (claimed.count !== 1) throw new ForbiddenException('Enrollment token has already been used or expired.');
      }
      if (existingKey) return existingKey.device;

      // 2. Create device record
      const device = await tx.device.create({
        data: {
          organizationId,
          remoteId,
          deviceName: params.deviceName,
          hostname: params.hostname,
          os: params.os,
          osVersion: params.osVersion,
          architecture: params.architecture,
          agentVersion: params.agentVersion,
          status: 'OFFLINE',
          lastIpAddress: params.sourceIp,
        },
      });

      // 3. Store cryptographic public key
      await tx.deviceKey.create({
        data: {
          deviceId: device.id,
          publicKey: params.publicKeyBase64,
          keyFingerprint,
          algorithm: 'Ed25519',
        },
      });

      // 4. Create default secure device policy (Section 23: AllowUnattendedAccess = false by default)
      await tx.devicePolicy.create({
        data: {
          deviceId: device.id,
          allowUnattendedAccess: false,
          requireMfa: false,
          allowClipboard: true,
          allowFileTransfer: true,
          requireSessionRecording: false,
        },
      });

      return device;
    });

    // Mark as online in Redis presence
    await this.redis.getClient().set(`krypton:device:key:${result.id}`, JSON.stringify({ publicKey: params.publicKeyBase64, organizationId }));

    // Record audit event
    await this.audit.record({
      organizationId,
      actorId: result.id,
      actorType: 'DEVICE',
      action: AuditAction.DEVICE_ENROLLED,
      targetType: 'DEVICE',
      targetId: result.id,
      sourceIp: params.sourceIp,
      result: 'SUCCESS',
      metadata: {
        remoteId: result.remoteId,
        deviceName: result.deviceName,
        hostname: result.hostname,
        keyFingerprint,
      },
    });

    logger.info(
      { deviceId: result.id, remoteId: result.remoteId },
      'Device successfully enrolled with cryptographic identity'
    );

    return {
      deviceId: result.id,
      remoteId: result.remoteId,
      organizationId: result.organizationId,
      enrolledAt: result.createdAt,
    };
  }

  /**
   * Process heartbeat telemetry from agent (Section 22)
   */
  async processHeartbeat(heartbeat: DeviceHeartbeat, sourceIp?: string) {
    const device = await this.prisma.device.findUnique({
      where: { id: heartbeat.deviceId },
    });

    if (!device || device.status === 'REVOKED') {
      throw new NotFoundException('Device not found or access revoked.');
    }

    // Set ephemeral online presence in Redis with 45s TTL (Section 22)
    await this.setDevicePresence(heartbeat.deviceId, 'ONLINE');

    // Cache live runtime telemetry in Redis with 120s TTL
    const client = this.redis.getClient();
    await client.setex(
      `krypton:device:telemetry:${heartbeat.deviceId}`,
      120,
      JSON.stringify({
        cpuPercent: heartbeat.cpuPercent,
        memoryPercent: heartbeat.memoryPercent,
        uptimeSeconds: heartbeat.uptimeSeconds,
        sessionCount: heartbeat.sessionCount,
        agentVersion: heartbeat.agentVersion,
        os: heartbeat.os,
        osVersion: heartbeat.osVersion,
        architecture: heartbeat.architecture,
        lastHeartbeat: new Date().toISOString(),
      })
    );

    // Update durable state in PostgreSQL
    await this.prisma.device.update({
      where: { id: heartbeat.deviceId },
      data: {
        lastSeenAt: new Date(),
        lastIpAddress: sourceIp,
        agentVersion: heartbeat.agentVersion,
        status: 'ONLINE',
      },
    });

    return { acknowledged: true, serverTimestamp: Date.now() };
  }

  /**
   * Redis Presence Management
   */
  private async setDevicePresence(deviceId: string, status: string, ttlSeconds = 45) {
    const client = this.redis.getClient();
    await client.setex(`krypton:presence:${deviceId}`, ttlSeconds, status);
  }

  async getDevicePresence(deviceId: string): Promise<DeviceStatus> {
    const client = this.redis.getClient();
    const presence = await client.get(`krypton:presence:${deviceId}`);


    // Check durable database record for degraded vs offline
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { lastSeenAt: true, status: true },
    });

    if (!device) return DeviceStatus.OFFLINE;
    if (device.status === 'REVOKED') return DeviceStatus.REVOKED;
    if (presence === 'ONLINE') return DeviceStatus.ONLINE;

    if (device.lastSeenAt) {
      const msSinceLastSeen = Date.now() - device.lastSeenAt.getTime();
      if (msSinceLastSeen < 90 * 1000) {
        return DeviceStatus.DEGRADED;
      }
    }


    return DeviceStatus.OFFLINE;
  }

  /**
   * List devices with presence resolution
   */
  async listDevices(organizationId: string, limit = 50, offset = 0) {
    ({ limit, offset } = parseBody(paginationSchema, { limit, offset }));
    const devices = await this.prisma.device.findMany({
      where: { organizationId },
      include: {
        devicePolicy: true,
        deviceKeys: { where: { isActive: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 100),
      skip: offset,
    });

    const client = this.redis.getClient();

    // Enrich with dynamic presence and live runtime telemetry
    const enriched = await Promise.all(
      devices.map(async (d) => {
        const liveStatus = await this.getDevicePresence(d.id);
        const rawTelem = await client.get(`krypton:device:telemetry:${d.id}`);
        let telem: any = null;
        if (rawTelem) {
          try {
            telem = JSON.parse(rawTelem);
          } catch {
            // fallback
          }
        }

        return {
          ...d,
          status: liveStatus,
          liveStatus,
          cpuPercent: telem?.cpuPercent ?? null,
          memoryPercent: telem?.memoryPercent ?? null,
          uptimeSeconds: telem?.uptimeSeconds ?? 0,
          sessionCount: telem?.sessionCount ?? 0,
          lastHeartbeat: telem?.lastHeartbeat ?? (d.lastSeenAt ? d.lastSeenAt.toISOString() : 'Never'),
        };
      })
    );

    return enriched;
  }

  /**
   * Get single device details
   */
  async getDevice(organizationId: string, deviceId: string) {
    const device = await this.prisma.device.findFirst({
      where: { id: deviceId, organizationId },
      include: {
        devicePolicy: true,
        deviceKeys: true,
      },
    });

    if (!device) throw new NotFoundException('Device not found');

    const liveStatus = await this.getDevicePresence(device.id);
    return { ...device, liveStatus };
  }

  /**
   * Update device alias or policy
   */
  async updateDevice(
    organizationId: string,
    deviceId: string,
    updates: { alias?: string; policy?: any },
    actorId: string
  ) {
    updates = parseBody(z.object({ alias: z.string().trim().min(1).max(128).optional(), policy: devicePolicySchema.optional() }).strict(), updates);
    const device = await this.prisma.device.findFirst({
      where: { id: deviceId, organizationId },
    });

    if (!device) throw new NotFoundException('Device not found');

    if (updates.alias !== undefined) {
      await this.prisma.device.update({
        where: { id: deviceId },
        data: { alias: updates.alias },
      });

      await this.audit.record({
        organizationId,
        actorId,
        actorType: 'USER',
        action: AuditAction.DEVICE_RENAMED,
        targetType: 'DEVICE',
        targetId: deviceId,
        metadata: { newAlias: updates.alias },
      });
    }

    if (updates.policy) {
      await this.prisma.devicePolicy.upsert({
        where: { deviceId },
        update: updates.policy,
        create: {
          deviceId,
          ...updates.policy,
        },
      });

      await this.audit.record({
        organizationId,
        actorId,
        actorType: 'USER',
        action: AuditAction.POLICY_CHANGED,
        targetType: 'DEVICE',
        targetId: deviceId,
        metadata: { policyUpdates: updates.policy },
      });
    }

    return this.getDevice(organizationId, deviceId);
  }

  /**
   * Revoke device access
   */
  async revokeDevice(organizationId: string, deviceId: string, actorId: string) {
    const device = await this.prisma.device.findFirst({
      where: { id: deviceId, organizationId },
    });

    if (!device) throw new NotFoundException('Device not found');

    const sessions = await this.prisma.$transaction(async tx => {
      await tx.device.update({ where: { id: deviceId }, data: { status: 'REVOKED', revokedAt: new Date() } });
      await tx.deviceKey.updateMany({ where: { deviceId }, data: { isActive: false } });
      const active = await tx.remoteSession.findMany({ where: { deviceId,
        state: { notIn: ['ENDED', 'REJECTED', 'EXPIRED', 'FAILED'] } } });
      await tx.remoteSession.updateMany({ where: { id: { in: active.map(session => session.id) } },
        data: { state: 'ENDED', endedAt: new Date(), endReason: 'Device access revoked' } });
      return active;
    });

    // Invalidate Redis presence immediately
    const client = this.redis.getClient();
    await client.del(`krypton:presence:${deviceId}`);
    await client.del(`krypton:device:key:${deviceId}`, `krypton:device:${deviceId}`);
    for (const session of sessions) {
      await client.del(`krypton:session:${session.id}`, `krypton:session:telemetry:${session.id}`);
      for (const subject of [deviceId, session.viewerUserId]) {
        await client.publish('krypton:signaling:messages', JSON.stringify({
          targetTenantId: organizationId, targetSubjectId: subject,
          message: { version: '1.0', type: 'SESSION_END', correlationId: crypto.randomUUID(), timestamp: Date.now(),
            payload: { sessionId: session.id, reason: 'Device access revoked' } },
        }));
      }
    }

    await this.audit.record({
      organizationId,
      actorId,
      actorType: 'USER',
      action: AuditAction.DEVICE_REVOKED,
      targetType: 'DEVICE',
      targetId: deviceId,
      result: 'SUCCESS',
    });

    return { message: 'Device revoked successfully' };
  }
}
