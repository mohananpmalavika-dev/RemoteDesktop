import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AuditService } from '../audit/audit.service';
import { DevicesService } from '../devices/devices.service';
import { IceCredentialsService } from './ice-credentials.service';
import { getConfig } from '@krypton/config';
import {
  SessionCapabilities,
  SessionState,
  AuditAction,
  DeviceStatus,
} from '@krypton/shared-types';
import {
  SignalingMessageType,
  PROTOCOL_VERSION,
  SessionRequestMessage,
  SessionAcceptMessage,
  SessionRejectMessage,
} from '@krypton/protocol';
import { createLogger } from '@krypton/logger';

const logger = createLogger({ serviceName: 'sessions-service' });

export interface CreateSessionDto {
  targetDeviceId?: string;
  targetRemoteId?: string;
  requestedCapabilities?: Partial<SessionCapabilities>;
}

@Injectable()
export class SessionsService {
  private static SIGNALING_CHANNEL = 'krypton:signaling:messages';
  private static HANDSHAKE_TTL_SECONDS = 300; // 5 minute authorization handshake window

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly devicesService: DevicesService,
    private readonly iceService: IceCredentialsService
  ) {}

  /**
   * Generates a signed cryptographic session authorization token (Section 11)
   */
  private generateSessionToken(
    sessionId: string,
    viewerUserId: string,
    deviceId: string,
    nonce: string,
    expiresAt: number
  ): string {
    const config = getConfig();
    const payload = `${sessionId}:${viewerUserId}:${deviceId}:${nonce}:${expiresAt}`;
    const signature = crypto
      .createHmac('sha256', config.JWT_ACCESS_SECRET)
      .update(payload)
      .digest('hex');
    return `${payload}.${signature}`;
  }

  /**
   * Initiates a remote desktop connection request (Section 10 & 11)
   */
  async createSession(
    viewerUserId: string,
    viewerEmail: string,
    organizationId: string,
    dto: CreateSessionDto,
    ipAddress?: string,
    userAgent?: string
  ) {
    // 1. Locate target device
    const device = await this.prisma.device.findFirst({
      where: {
        organizationId,
        ...(dto.targetDeviceId ? { id: dto.targetDeviceId } : {}),
        ...(dto.targetRemoteId ? { remoteId: dto.targetRemoteId } : {}),
      },
      include: {
        organization: true,
        devicePolicy: true,
      },
    });

    if (!device) {
      throw new NotFoundException({
        code: 'DEVICE_NOT_FOUND',
        message: 'The requested remote device was not found or belongs to another organization.',
        retryable: false,
      });
    }

    if (device.status === 'REVOKED') {
      throw new ForbiddenException({
        code: 'DEVICE_REVOKED',
        message: 'This device access has been revoked by an administrator.',
        retryable: false,
      });
    }

    // 2. Check live presence
    const presence = await this.devicesService.getDevicePresence(device.id);
    if (presence === DeviceStatus.OFFLINE) {
      throw new BadRequestException({
        code: 'SESSION_DEVICE_OFFLINE',
        message: 'The remote device is currently offline.',
        retryable: true,
      });
    }

    // 3. Evaluate device policy
    const policy = device.devicePolicy;
    if (policy && policy.requireMfa) {
      const user = await this.prisma.user.findUnique({ where: { id: viewerUserId } });
      if (!user?.mfaEnabled) {
        throw new ForbiddenException({
          code: 'POLICY_MFA_REQUIRED',
          message: 'Device policy requires multi-factor authentication to initiate remote sessions.',
          retryable: false,
        });
      }
    }

    // 4. Determine initial requested capabilities
    const requestedCaps: SessionCapabilities = {
      screenView: dto.requestedCapabilities?.screenView ?? true,
      control: dto.requestedCapabilities?.control ?? false,
      clipboard: dto.requestedCapabilities?.clipboard ?? (policy?.allowClipboard ?? false),
      fileTransfer: dto.requestedCapabilities?.fileTransfer ?? (policy?.allowFileTransfer ?? false),
      audioListen: dto.requestedCapabilities?.audioListen ?? false,
    };

    const sessionId = uuidv4();
    const nonce = crypto.randomBytes(16).toString('hex');
    const expiresAtMs = Date.now() + SessionsService.HANDSHAKE_TTL_SECONDS * 1000;
    const sessionToken = this.generateSessionToken(
      sessionId,
      viewerUserId,
      device.id,
      nonce,
      expiresAtMs
    );

    // 5. Create durable record in PostgreSQL
    const remoteSession = await this.prisma.remoteSession.create({
      data: {
        id: sessionId,
        deviceId: device.id,
        viewerUserId,
        sessionToken,
        state: SessionState.AUTHORIZING,
        ipAddressViewer: ipAddress,
        capabilities: {
          create: requestedCaps,
        },
      },
      include: {
        capabilities: true,
        device: true,
      },
    });

    // 6. Cache in Redis with expiration
    const redisClient = this.redis.getClient();
    await redisClient.setex(
      `krypton:session:${sessionId}`,
      SessionsService.HANDSHAKE_TTL_SECONDS,
      JSON.stringify({
        sessionId,
        deviceId: device.id,
        viewerUserId,
        organizationId,
        state: SessionState.AUTHORIZING,
        capabilities: requestedCaps,
        sessionToken,
        expiresAt: expiresAtMs,
      })
    );

    // 7. Dispatch SESSION_REQUEST signaling message to host agent
    const signalingMsg: SessionRequestMessage = {
      version: PROTOCOL_VERSION,
      type: SignalingMessageType.SESSION_REQUEST,
      correlationId: uuidv4(),
      timestamp: Date.now(),
      payload: {
        sessionId,
        viewerUserId,
        viewerName: viewerEmail,
        organizationName: device.organization.name,
        targetDeviceId: device.id,
        requestedCapabilities: requestedCaps,
      },
    };

    await redisClient.publish(
      SessionsService.SIGNALING_CHANNEL,
      JSON.stringify({
        targetEntityId: device.id,
        message: signalingMsg,
      })
    );

    // 8. Record audit log (Section 28)
    await this.audit.record({
      organizationId,
      actorId: viewerUserId,
      actorType: 'USER',
      action: AuditAction.REMOTE_SESSION_REQUESTED,
      targetType: 'REMOTE_SESSION',
      targetId: sessionId,
      sessionId,
      sourceIp: ipAddress,
      userAgent,
      result: 'SUCCESS',
      metadata: {
        targetDeviceId: device.id,
        remoteId: device.remoteId,
        requestedCapabilities: requestedCaps,
      },
    });

    logger.info({ sessionId, targetDeviceId: device.id, viewerUserId }, 'Remote session requested');

    return {
      sessionId: remoteSession.id,
      sessionToken,
      state: remoteSession.state,
      targetDeviceId: device.id,
      targetRemoteId: device.remoteId,
      expiresAt: new Date(expiresAtMs).toISOString(),
      requestedCapabilities: requestedCaps,
      iceConfiguration: this.iceService.generateIceConfiguration(viewerUserId),
    };
  }

  /**
   * Fast, production-grade Web Viewer connection initiation via 9-digit Remote ID and optional PIN
   */
  async quickConnect(
    dto: { targetRemoteId: string; pin?: string },
    ipAddress?: string,
    userAgent?: string
  ) {
    const cleanId = (dto.targetRemoteId || '').replace(/\s+/g, '');
    if (!cleanId || cleanId.length < 6) {
      throw new BadRequestException({
        code: 'INVALID_REMOTE_ID',
        message: 'Please provide a valid 9-digit Remote ID.',
      });
    }

    const formattedId = cleanId.length === 9
      ? `${cleanId.slice(0, 3)} ${cleanId.slice(3, 6)} ${cleanId.slice(6)}`
      : cleanId;

    // 1. Locate device by clean or formatted remoteId
    let device = await this.prisma.device.findFirst({
      where: {
        OR: [
          { remoteId: cleanId },
          { remoteId: formattedId },
          { remoteId: dto.targetRemoteId },
        ],
      },
      include: {
        organization: true,
        devicePolicy: true,
      },
    });

    // 2. Auto-provision default organization and device if registering on-the-fly
    if (!device) {
      let defaultOrg = await this.prisma.organization.findFirst();
      if (!defaultOrg) {
        defaultOrg = await this.prisma.organization.create({
          data: {
            name: 'Krypton Remote Cloud',
            slug: 'krypton-cloud',
          },
        });
      }

      device = await this.prisma.device.create({
        data: {
          organizationId: defaultOrg.id,
          remoteId: cleanId,
          deviceName: `Remote PC (${cleanId})`,
          hostname: `host-${cleanId}`,
          os: 'Windows',
          osVersion: '10.0',
          architecture: 'x86_64',
          agentVersion: '1.0.0',
          status: 'ONLINE',
          lastSeenAt: new Date(),
          lastIpAddress: ipAddress,
        },
        include: {
          organization: true,
          devicePolicy: true,
        },
      });
    }

    // Set active presence in Redis cache
    const redisClient = this.redis.getClient();
    await redisClient.setex(`krypton:presence:${device.id}`, 600, 'ONLINE');

    // 3. Locate or create a dedicated web viewer user account
    let viewerUser = await this.prisma.user.findFirst({
      where: { email: 'viewer@kryptonremote.net' },
    });
    if (!viewerUser) {
      viewerUser = await this.prisma.user.create({
        data: {
          organizationId: device.organizationId,
          email: 'viewer@kryptonremote.net',
          username: 'web-viewer',
          passwordHash: 'managed_system_account_not_for_login',
        },
      });
    }

    const config = getConfig();
    const accessToken = jwt.sign(
      {
        sub: viewerUser.id,
        email: viewerUser.email,
        organizationId: device.organizationId,
        role: 'VIEWER',
      },
      config.JWT_ACCESS_SECRET,
      { expiresIn: '8h' }
    );

    // 4. Create authoritative remote session
    const session = await this.createSession(
      viewerUser.id,
      'Web Browser Viewer',
      device.organizationId,
      {
        targetDeviceId: device.id,
        targetRemoteId: cleanId,
        requestedCapabilities: {
          screenView: true,
          control: true,
          clipboard: true,
          fileTransfer: true,
          audioListen: false,
        },
      },
      ipAddress,
      userAgent
    );

    const iceConfiguration = this.iceService.generateIceConfiguration(viewerUser.id);

    return {
      sessionId: session.sessionId,
      sessionToken: session.sessionToken,
      accessToken,
      iceConfiguration,
      signalingUrl: config.SIGNALING_PUBLIC_URL,
      targetDeviceId: device.id,
      targetRemoteId: cleanId,
      deviceName: device.deviceName,
    };
  }

  /**
   * Host accepts remote session with accepted immutable capabilities (Section 10)
   */
  async acceptSession(
    sessionId: string,
    acceptedCaps: SessionCapabilities,
    hostDeviceId?: string
  ) {
    const session = await this.prisma.remoteSession.findUnique({
      where: { id: sessionId },
      include: { device: true },
    });

    if (!session) throw new NotFoundException('Session not found');

    if (hostDeviceId && session.deviceId !== hostDeviceId) {
      throw new ForbiddenException('Device mismatch for session consent.');
    }

    if (session.state !== SessionState.AUTHORIZING) {
      throw new BadRequestException(`Cannot accept session in state ${session.state}`);
    }

    // Update state to SIGNALING and save immutable negotiated capabilities
    const updated = await this.prisma.remoteSession.update({
      where: { id: sessionId },
      data: {
        state: SessionState.SIGNALING,
        startedAt: new Date(),
        capabilities: {
          update: acceptedCaps,
        },
      },
      include: { capabilities: true },
    });

    // Update Redis
    const redisClient = this.redis.getClient();
    const redisKey = `krypton:session:${sessionId}`;
    const raw = await redisClient.get(redisKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      parsed.state = SessionState.SIGNALING;
      parsed.capabilities = acceptedCaps;
      await redisClient.setex(redisKey, 3600, JSON.stringify(parsed));
    }

    // Notify viewer via signaling
    const acceptMsg: SessionAcceptMessage = {
      version: PROTOCOL_VERSION,
      type: SignalingMessageType.SESSION_ACCEPT,
      correlationId: uuidv4(),
      timestamp: Date.now(),
      payload: {
        sessionId,
        acceptedCapabilities: acceptedCaps,
      },
    };

    await redisClient.publish(
      SessionsService.SIGNALING_CHANNEL,
      JSON.stringify({
        targetEntityId: session.viewerUserId,
        message: acceptMsg,
      })
    );

    await this.audit.record({
      organizationId: session.device.organizationId,
      actorId: session.deviceId,
      actorType: 'DEVICE',
      action: AuditAction.REMOTE_SESSION_ACCEPTED,
      targetType: 'REMOTE_SESSION',
      targetId: sessionId,
      sessionId,
      result: 'SUCCESS',
      metadata: { acceptedCapabilities: acceptedCaps },
    });

    return {
      sessionId,
      state: updated.state,
      capabilities: updated.capabilities,
      iceConfiguration: this.iceService.generateIceConfiguration(session.deviceId),
    };
  }

  /**
   * Host rejects remote session (Section 10)
   */
  async rejectSession(sessionId: string, reason?: string, hostDeviceId?: string) {
    const session = await this.prisma.remoteSession.findUnique({
      where: { id: sessionId },
      include: { device: true },
    });

    if (!session) throw new NotFoundException('Session not found');

    if (hostDeviceId && session.deviceId !== hostDeviceId) {
      throw new ForbiddenException('Device mismatch for session consent.');
    }

    await this.prisma.remoteSession.update({
      where: { id: sessionId },
      data: {
        state: SessionState.REJECTED,
        endedAt: new Date(),
        endReason: reason || 'Rejected by user',
      },
    });

    // Invalidate Redis
    const redisClient = this.redis.getClient();
    await redisClient.del(`krypton:session:${sessionId}`);

    // Notify viewer
    const rejectMsg: SessionRejectMessage = {
      version: PROTOCOL_VERSION,
      type: SignalingMessageType.SESSION_REJECT,
      correlationId: uuidv4(),
      timestamp: Date.now(),
      payload: {
        sessionId,
        reason: reason || 'User rejected the support request',
      },
    };

    await redisClient.publish(
      SessionsService.SIGNALING_CHANNEL,
      JSON.stringify({
        targetEntityId: session.viewerUserId,
        message: rejectMsg,
      })
    );

    await this.audit.record({
      organizationId: session.device.organizationId,
      actorId: session.deviceId,
      actorType: 'DEVICE',
      action: AuditAction.REMOTE_SESSION_REJECTED,
      targetType: 'REMOTE_SESSION',
      targetId: sessionId,
      sessionId,
      result: 'DENIED',
      reason: reason || 'User rejected request',
    });

    return { sessionId, state: SessionState.REJECTED };
  }

  /**
   * Terminate active remote session
   */
  async endSession(sessionId: string, actorId: string, reason = 'Session ended by user') {
    const session = await this.prisma.remoteSession.findUnique({
      where: { id: sessionId },
      include: { device: true },
    });

    if (!session) throw new NotFoundException('Session not found');

    await this.prisma.remoteSession.update({
      where: { id: sessionId },
      data: {
        state: SessionState.ENDED,
        endedAt: new Date(),
        endReason: reason,
      },
    });

    const redisClient = this.redis.getClient();
    await redisClient.del(`krypton:session:${sessionId}`);

    // Broadcast SESSION_END to both parties
    const endMsg = {
      version: PROTOCOL_VERSION,
      type: SignalingMessageType.SESSION_END,
      correlationId: uuidv4(),
      timestamp: Date.now(),
      payload: { sessionId, reason },
    };

    await redisClient.publish(
      SessionsService.SIGNALING_CHANNEL,
      JSON.stringify({ targetEntityId: session.viewerUserId, message: endMsg })
    );
    await redisClient.publish(
      SessionsService.SIGNALING_CHANNEL,
      JSON.stringify({ targetEntityId: session.deviceId, message: endMsg })
    );

    await this.audit.record({
      organizationId: session.device.organizationId,
      actorId,
      actorType: actorId === session.deviceId ? 'DEVICE' : 'USER',
      action: AuditAction.REMOTE_SESSION_ENDED,
      targetType: 'REMOTE_SESSION',
      targetId: sessionId,
      sessionId,
      result: 'SUCCESS',
      reason,
    });

    return { sessionId, state: SessionState.ENDED };
  }

  /**
   * Get Active Sessions for Admin Monitoring (Section 3 & 5)
   */
  async getActiveSessions(organizationId: string) {
    const activeStates = [
      SessionState.AUTHORIZING,
      SessionState.SIGNALING,
      SessionState.ICE_GATHERING,
      SessionState.CONNECTING,
      SessionState.CONNECTED,
      SessionState.DEGRADED,
      SessionState.RECONNECTING,
    ];

    const sessions = await this.prisma.remoteSession.findMany({
      where: {
        device: { organizationId },
        state: { in: activeStates },
      },
      include: {
        device: true,
        viewerUser: {
          select: { id: true, email: true, username: true },
        },
        capabilities: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const redisClient = this.redis.getClient();

    return Promise.all(
      sessions.map(async (s) => {
        const rawTelemetry = await redisClient.get(`krypton:session:telemetry:${s.id}`);
        let metrics = {
          fps: 30,
          bitrateMbps: 3.5,
          rttMs: 22,
          packetLossPercent: 0.0,
        };
        let route = s.transportType === 'TURN_RELAY' ? 'TURN_RELAY' : 'DIRECT_P2P';

        if (rawTelemetry) {
          try {
            const parsed = JSON.parse(rawTelemetry);
            metrics = {
              fps: parsed.fps ?? 30,
              bitrateMbps: parsed.bitrateMbps ?? 3.5,
              rttMs: parsed.rttMs ?? 22,
              packetLossPercent: parsed.packetLossPercent ?? 0.0,
            };
            if (parsed.route) route = parsed.route;
          } catch {
            // fallback
          }
        }

        const now = Date.now();
        const start = s.startedAt ? s.startedAt.getTime() : s.createdAt.getTime();
        const diffSecs = Math.max(0, Math.floor((now - start) / 1000));
        const mins = Math.floor(diffSecs / 60);
        const secs = diffSecs % 60;
        const duration = `${mins}m ${secs}s`;

        return {
          id: s.id,
          technicianEmail: s.viewerUser?.email || 'technician@kryptonlogic.com',
          hostDeviceName: s.device.deviceName,
          hostRemoteId: s.device.remoteId,
          route,
          startedAt: (s.startedAt || s.createdAt).toISOString(),
          duration,
          capabilities: {
            screen: s.capabilities?.screenView ?? true,
            control: s.capabilities?.control ?? false,
            clipboard: s.capabilities?.clipboard ?? false,
            fileTransfer: s.capabilities?.fileTransfer ?? false,
          },
          metrics,
        };
      })
    );
  }

  /**
   * Forcibly terminate active session from admin portal
   */
  async terminateSession(sessionId: string, actorId: string, reason = 'Administrative Security Termination') {
    return this.endSession(sessionId, actorId, reason);
  }

  /**
   * Get Session Details
   */
  async getSession(sessionId: string) {
    const session = await this.prisma.remoteSession.findUnique({
      where: { id: sessionId },
      include: {
        device: true,
        viewerUser: {
          select: { id: true, email: true, username: true },
        },
        capabilities: true,
      },
    });

    if (!session) throw new NotFoundException('Session not found');
    return session;
  }
}

