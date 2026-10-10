import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
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
import { parseBody } from '../common/validation';
import { z } from 'zod';
import { tenantPolicySchema } from '../policies/policies.service';
import { RbacService } from '../rbac/rbac.service';
import { KryptonPermission } from '@krypton/shared-types';

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
    private readonly iceService: IceCredentialsService,
    private readonly rbac: RbacService
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
    userAgent?: string,
    mfaVerified = false,
    guest = false
  ) {
    dto = parseBody(z.object({
      targetDeviceId: z.string().uuid().optional(),
      targetRemoteId: z.string().regex(/^\d{3}[\s-]?\d{3}[\s-]?\d{3}$/).optional(),
      requestedCapabilities: z.object({ screenView: z.boolean().optional(), control: z.boolean().optional(),
        clipboard: z.boolean().optional(), fileTransfer: z.boolean().optional(), audioListen: z.literal(false).optional() }).strict().optional(),
    }).strict().refine(v => !!v.targetDeviceId || !!v.targetRemoteId, 'A target device is required.'), dto);
    const cleanId = dto.targetRemoteId?.replace(/[\s-]+/g, '');
    const formattedId = cleanId ? `${cleanId.slice(0, 3)} ${cleanId.slice(3, 6)} ${cleanId.slice(6)}` : undefined;
    const device = await this.prisma.device.findFirst({
      where: { organizationId, ...(dto.targetDeviceId ? { id: dto.targetDeviceId } : { OR: [{ remoteId: cleanId }, { remoteId: formattedId }] }) },
      include: { organization: true, devicePolicy: true },
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
    if (presence !== DeviceStatus.ONLINE) {
      throw new BadRequestException({
        code: 'SESSION_DEVICE_OFFLINE',
        message: 'The remote device is currently offline.',
        retryable: true,
      });
    }

    const policy = device.devicePolicy;
    const tenantPolicy = tenantPolicySchema.parse({ ...tenantPolicySchema.parse({}), ...(device.organization.policy as object) });
    if ((policy?.requireMfa || tenantPolicy.requireMfa) && !mfaVerified) {
      throw new ForbiddenException({ code: 'POLICY_MFA_REQUIRED', message: 'This device requires an authenticated MFA login.' });
    }
    if (policy?.requireSessionRecording || tenantPolicy.sessionRecording) {
      throw new ForbiddenException('Recording-required sessions are unavailable until a recording backend is configured.');
    }
    const requestedCaps: SessionCapabilities = {
      screenView: dto.requestedCapabilities?.screenView ?? true,
      control: dto.requestedCapabilities?.control ?? false,
      clipboard: (dto.requestedCapabilities?.clipboard ?? false) && !!policy?.allowClipboard && tenantPolicy.clipboardPolicy !== 'DISABLED',
      fileTransfer: (dto.requestedCapabilities?.fileTransfer ?? false) && !!policy?.allowFileTransfer && tenantPolicy.maxFileMb > 0,
      audioListen: false,
    };
    if (!guest) {
      const permissions = await this.rbac.getUserPermissions(viewerUserId);
      const checks: [boolean, KryptonPermission][] = [
        [requestedCaps.screenView, KryptonPermission.REMOTE_SCREEN_VIEW], [requestedCaps.control, KryptonPermission.REMOTE_CONTROL],
        [requestedCaps.clipboard, KryptonPermission.REMOTE_CLIPBOARD_WRITE], [requestedCaps.fileTransfer, KryptonPermission.REMOTE_FILE_UPLOAD],
      ];
      if (checks.some(([enabled, permission]) => enabled && !permissions.has(permission))) throw new ForbiddenException('Requested capability is not permitted by your role.');
    }

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
    const remoteSession = await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`session:${device.id}`}))::text`;
      const pending = await tx.remoteSession.count({ where: { deviceId: device.id, state: 'AUTHORIZING', createdAt: { gt: new Date(Date.now() - 300_000) } } });
      if (pending >= 3) throw new BadRequestException('This host already has pending requests. Try again later.');
      return tx.remoteSession.create({
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
        organizationId: device.organizationId,
        state: SessionState.AUTHORIZING,
        capabilities: requestedCaps,
        sessionToken,
        expiresAt: expiresAtMs,
        policy: tenantPolicy,
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
        targetTenantId: device.organizationId,
        targetSubjectId: device.id,
        message: signalingMsg,
      })
    );

    // 8. Record audit log (Section 28)
    await this.audit.record({
      organizationId: device.organizationId,
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
      signalingUrl: getConfig().SIGNALING_PUBLIC_URL,
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
    dto = parseBody(z.object({ targetRemoteId: z.string().regex(/^\d{3}[\s-]?\d{3}[\s-]?\d{3}$/), pin: z.string().max(32).optional() }).strict(), dto);
    if (dto.pin) throw new BadRequestException('PIN access is unavailable. Request host approval instead.');
    const cleanId = dto.targetRemoteId.replace(/[\s-]+/g, '');
    const formattedId = `${cleanId.slice(0, 3)} ${cleanId.slice(3, 6)} ${cleanId.slice(6)}`;
    const device = await this.prisma.device.findFirst({ where: { OR: [{ remoteId: cleanId }, { remoteId: formattedId }] } });
    if (!device || device.status === 'REVOKED') throw new NotFoundException('Device is unavailable.');
    // Each guest has a distinct identity and a token bound to this one session.
    // DEACTIVATED accounts can never log in or access the administration API.
    const guestId = uuidv4();
    const viewer = await this.prisma.user.create({ data: {
      id: guestId, organizationId: device.organizationId, email: `guest-${guestId}@guest.invalid`,
      username: `guest-${guestId}`, passwordHash: 'DISABLED', status: 'DEACTIVATED',
    } });
    let session;
    try {
      session = await this.createSession(viewer.id, 'Guest browser viewer (identity unverified)', device.organizationId,
        { targetDeviceId: device.id, requestedCapabilities: { screenView: true, control: true, clipboard: true, fileTransfer: true } },
        ipAddress, userAgent, false, true);
    } catch (error) {
      await this.prisma.user.delete({ where: { id: viewer.id } });
      throw error;
    }
    const config = getConfig();
    const accessToken = jwt.sign({ sub: viewer.id, organizationId: device.organizationId,
      tokenUse: 'guest-session', sessionId: session.sessionId }, config.JWT_ACCESS_SECRET, { expiresIn: '1h' });
    return { ...session, accessToken, signalingUrl: config.SIGNALING_PUBLIC_URL, deviceName: device.deviceName };
  }

  /**
   * Host accepts remote session with accepted immutable capabilities (Section 10)
   */
  async acceptSession(
    sessionId: string,
    acceptedCaps: SessionCapabilities,
    hostDeviceId: string
  ) {
    const session = await this.prisma.remoteSession.findUnique({
      where: { id: sessionId },
      include: { device: true, capabilities: true },
    });

    if (!session) throw new NotFoundException('Session not found');

    if (!hostDeviceId || session.deviceId !== hostDeviceId) {
      throw new ForbiddenException('Device mismatch for session consent.');
    }

    if (session.state !== SessionState.AUTHORIZING) {
      throw new BadRequestException(`Cannot accept session in state ${session.state}`);
    }

    acceptedCaps = parseBody(z.object({ screenView: z.boolean(), control: z.boolean(), clipboard: z.boolean(), fileTransfer: z.boolean(), audioListen: z.literal(false) }).strict(), acceptedCaps);
    if (Object.entries(acceptedCaps).some(([key, enabled]) => enabled && !(session.capabilities as any)?.[key])) {
      throw new ForbiddenException('Accepted capabilities cannot exceed requested capabilities.');
    }
    if (session.createdAt.getTime() + 300_000 <= Date.now()) throw new BadRequestException('Session request has expired.');
    const redisClient = this.redis.getClient();
    const redisKey = `krypton:session:${sessionId}`;
    const raw = await redisClient.get(redisKey);
    if (!raw) throw new BadRequestException('Session request has expired.');
    // Update state to SIGNALING and save immutable negotiated capabilities
    const updated = await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`session:${session.deviceId}`}))::text`;
      const active = await tx.remoteSession.count({ where: { deviceId: session.deviceId,
        state: { in: ['SIGNALING', 'ICE_GATHERING', 'CONNECTING', 'CONNECTED', 'DEGRADED', 'RECONNECTING'] } } });
      if (active > 0) throw new BadRequestException('Host already has an active session.');
      return tx.remoteSession.update({
      where: { id: sessionId, state: SessionState.AUTHORIZING },
      data: {
        state: SessionState.SIGNALING,
        startedAt: new Date(),
        capabilities: {
          update: acceptedCaps,
        },
      },
      include: { capabilities: true },
      });
    });

    const parsed = JSON.parse(raw);
    parsed.state = SessionState.SIGNALING;
    parsed.capabilities = acceptedCaps;
    const cached = await redisClient.eval(`if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2], 'EX', 3600); return 1 end; return 0`,
      1, redisKey, raw, JSON.stringify(parsed));
    if (Number(cached) !== 1) {
      await this.prisma.remoteSession.updateMany({ where: { id: sessionId, state: 'SIGNALING' },
        data: { state: 'ENDED', endedAt: new Date(), endReason: 'Consent authorization was invalidated' } });
      throw new BadRequestException('Session authorization was invalidated.');
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
        targetTenantId: session.device.organizationId,
        targetSubjectId: session.viewerUserId,
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
      policy: parsed.policy,
    };
  }

  /**
   * Host rejects remote session (Section 10)
   */
  async rejectSession(sessionId: string, reason: string | undefined, hostDeviceId: string) {
    reason = parseBody(z.string().trim().max(256).optional(), reason);
    const session = await this.prisma.remoteSession.findUnique({
      where: { id: sessionId },
      include: { device: true, capabilities: true },
    });

    if (!session) throw new NotFoundException('Session not found');

    if (!hostDeviceId || session.deviceId !== hostDeviceId) {
      throw new ForbiddenException('Device mismatch for session consent.');
    }

    if (session.state !== SessionState.AUTHORIZING) throw new BadRequestException('Only pending requests can be rejected.');
    await this.prisma.remoteSession.update({
      where: { id: sessionId, state: SessionState.AUTHORIZING },
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
        targetTenantId: session.device.organizationId,
        targetSubjectId: session.viewerUserId,
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
  async endSession(sessionId: string, actorId: string, organizationId: string, reason = 'Session ended by user') {
    reason = parseBody(z.string().trim().max(256), reason);
    const session = await this.prisma.remoteSession.findUnique({
      where: { id: sessionId },
      include: { device: true, capabilities: true },
    });

    if (!session) throw new NotFoundException('Session not found');

    if (!organizationId || session.device.organizationId !== organizationId) throw new NotFoundException('Session not found');
    if (session.viewerUserId !== actorId && session.deviceId !== actorId &&
        !(await this.rbac.getUserPermissions(actorId)).has(KryptonPermission.REMOTE_SESSION_TERMINATE)) {
      throw new ForbiddenException('Session belongs to another viewer.');
    }
    if (['ENDED', 'REJECTED', 'EXPIRED', 'FAILED'].includes(session.state)) return { sessionId, state: session.state };
    await this.prisma.remoteSession.update({
      where: { id: sessionId },
      data: {
        state: SessionState.ENDED,
        endedAt: new Date(),
        endReason: reason,
      },
    });

    const redisClient = this.redis.getClient();
    await redisClient.del(`krypton:session:${sessionId}`, `krypton:session:telemetry:${sessionId}`);

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
      JSON.stringify({ targetTenantId: session.device.organizationId,
        targetSubjectId: session.viewerUserId, message: endMsg })
    );
    await redisClient.publish(
      SessionsService.SIGNALING_CHANNEL,
      JSON.stringify({ targetTenantId: session.device.organizationId, targetSubjectId: session.deviceId, message: endMsg })
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
    await this.prisma.remoteSession.updateMany({ where: { device: { organizationId }, state: 'AUTHORIZING', createdAt: { lte: new Date(Date.now() - 300_000) } },
      data: { state: 'EXPIRED', endedAt: new Date(), endReason: 'Host consent timed out' } });
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
          fps: null as number | null,
          bitrateMbps: null as number | null,
          rttMs: null as number | null,
          packetLossPercent: null as number | null,
        };
        let route = s.transportType === 'TURN_RELAY' ? 'TURN_RELAY' : 'DIRECT_P2P';

        if (rawTelemetry) {
          try {
            const parsed = JSON.parse(rawTelemetry);
            metrics = {
              fps: parsed.fps ?? null,
              bitrateMbps: parsed.bitrateMbps ?? null,
              rttMs: parsed.rttMs ?? null,
              packetLossPercent: parsed.packetLossPercent ?? null,
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
          technicianEmail: s.viewerUser?.email || 'Unknown viewer',
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
  async terminateSession(sessionId: string, actorId: string, organizationId: string, reason = 'Administrative Security Termination') {
    return this.endSession(sessionId, actorId, organizationId, reason);
  }

  /**
   * Get Session Details
   */
  async getSession(sessionId: string, organizationId: string) {
    const session = await this.prisma.remoteSession.findUnique({
      where: { id: sessionId, device: { organizationId } },
      include: {
        device: true,
        viewerUser: {
          select: { id: true, email: true, username: true },
        },
        capabilities: true,
      },
    });

    if (!session) throw new NotFoundException('Session not found');
    const { sessionToken, ...safeSession } = session;
    return safeSession;
  }

  async endGuestSession(sessionId: string, token: string) {
    let claims: any;
    try { claims = jwt.verify(token, getConfig().JWT_ACCESS_SECRET, { algorithms: ['HS256'] }); }
    catch { throw new UnauthorizedException('Invalid or expired session token.'); }
    if (claims.tokenUse !== 'guest-session' || claims.sessionId !== sessionId || typeof claims.sub !== 'string') throw new ForbiddenException('Invalid guest session scope.');
    return this.endSession(sessionId, claims.sub, claims.organizationId, 'Viewer disconnected');
  }

  async updateHostState(sessionId: string, deviceId: string, body: unknown) {
    const dto = parseBody(z.object({ state: z.enum(['CONNECTED', 'DEGRADED', 'ENDED']), reason: z.string().max(256).optional(),
      metrics: z.object({ fps: z.number().min(0).max(120).nullable(), bitrateMbps: z.number().min(0).max(1000).nullable(),
        rttMs: z.number().min(0).max(60000).nullable(), packetLossPercent: z.number().min(0).max(100).nullable(),
        route: z.enum(['DIRECT_P2P', 'TURN_RELAY']) }).strict().optional(),
    }).strict(), body);
    const session = await this.prisma.remoteSession.findUnique({ where: { id: sessionId }, include: { device: true } });
    if (!session || session.deviceId !== deviceId) throw new NotFoundException('Session not found');
    if (dto.state === 'ENDED') return this.endSession(sessionId, deviceId, session.device.organizationId, dto.reason);
    if (!['SIGNALING', 'CONNECTING', 'CONNECTED', 'DEGRADED'].includes(session.state)) throw new BadRequestException('Session is not accepted.');
    const client = this.redis.getClient();
    const key = `krypton:session:${sessionId}`;
    const raw = await client.get(key);
    if (!raw) throw new BadRequestException('Session has expired');
    await this.prisma.remoteSession.update({ where: { id: sessionId, state: { in: ['SIGNALING', 'CONNECTING', 'CONNECTED', 'DEGRADED'] } }, data: { state: dto.state,
      ...(dto.metrics ? { transportType: dto.metrics.route } : {}) } });
    const refreshed = await client.eval(`if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2], 'EX', 3600); return 1 end; return 0`,
      1, key, raw, JSON.stringify({ ...JSON.parse(raw), state: dto.state }));
    if (Number(refreshed) !== 1) throw new BadRequestException('Session authorization changed.');
    if (dto.metrics) await client.setex(`krypton:session:telemetry:${sessionId}`, 30, JSON.stringify(dto.metrics));
    return { acknowledged: true };
  }
}

