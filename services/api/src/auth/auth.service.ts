import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { authenticator } from 'otplib';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { getConfig } from '@krypton/config';
import { AuditAction } from '@krypton/shared-types';
import { RedisService } from '../redis/redis.service';
import { Prisma } from '@prisma/client';

export interface TokenPayload {
  userId: string;
  organizationId: string;
  email: string;
}

@Injectable()
export class AuthService {
  private dummyPasswordHash?: Promise<string>;
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly redis: RedisService
  ) {}

  /**
   * Hash password using Argon2id with strict parameters (Section 8)
   */
  async hashPassword(password: string): Promise<string> {
    return argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65536, // 64 MB
      timeCost: 3,
      parallelism: 4,
    });
  }

  async verifyPassword(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      return false;
    }
  }

  /**
   * Primary Login: verifies credentials using Argon2id.
   * If MFA is enabled, returns temporary mfaToken; otherwise issues full token pair.
   */
  async login(emailOrUsername: string, passwordPlain: string, ipAddress?: string, userAgent?: string) {
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: emailOrUsername }, { username: emailOrUsername }],
      },
    });

    if (!user) {
      this.dummyPasswordHash ??= this.hashPassword(crypto.randomBytes(32).toString('hex'));
      await this.verifyPassword(await this.dummyPasswordHash, passwordPlain);
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email/username or password.',
        retryable: false,
      });
    }

    const isValidPassword = await this.verifyPassword(user.passwordHash, passwordPlain);

    if (!isValidPassword || user.status !== 'ACTIVE') {
      await this.audit.record({
        organizationId: user.organizationId,
        actorId: user.id,
        actorType: 'USER',
        action: AuditAction.USER_LOGIN_FAILED,
        targetType: 'USER',
        targetId: user.id,
        sourceIp: ipAddress,
        userAgent,
        result: 'FAILURE',
      reason: 'Invalid credentials or inactive account',
      });

      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email/username or password.',
        retryable: false,
      });
    }

    // Check if MFA is required
    if (user.mfaEnabled) {
      if (!user.mfaSecret) throw new UnauthorizedException('MFA configuration is unavailable. Contact administrator.');
      const config = getConfig();
      const challengeId = uuidv4();
      await this.redis.getClient().setex(`krypton:mfa:challenge:${challengeId}`, 300, user.id);
      const mfaTempToken = jwt.sign(
        { userId: user.id, mfaPending: true, tokenUse: 'mfa', jti: challengeId },
        config.JWT_ACCESS_SECRET,
        { expiresIn: '5m' }
      );

      return {
        mfaRequired: true,
        mfaToken: mfaTempToken,
      };
    }

    // MFA not required or disabled: issue tokens directly
    const tokens = await this.issueTokens(user.id, user.organizationId, user.email, ipAddress, userAgent);

    await this.audit.record({
      organizationId: user.organizationId,
      actorId: user.id,
      actorType: 'USER',
      action: AuditAction.USER_LOGIN,
      targetType: 'USER',
      targetId: user.id,
      sourceIp: ipAddress,
      userAgent,
      result: 'SUCCESS',
    });

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return {
      mfaRequired: false,
      ...tokens,
    };
  }

  /**
   * Verify TOTP code for MFA login
   */
  async verifyMfa(mfaToken: string, code: string, ipAddress?: string, userAgent?: string) {
    const config = getConfig();
    let decoded: any;
    try {
      decoded = jwt.verify(mfaToken, config.JWT_ACCESS_SECRET, { algorithms: ['HS256'] });
    } catch {
      throw new UnauthorizedException({
        code: 'MFA_SESSION_EXPIRED',
        message: 'MFA challenge session expired or invalid. Please log in again.',
        retryable: false,
      });
    }

    if (!decoded.mfaPending || decoded.tokenUse !== 'mfa' || typeof decoded.userId !== 'string' || typeof decoded.jti !== 'string') {
      throw new UnauthorizedException('Invalid MFA token.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: decoded.userId },
    });

    if (!user || user.status !== 'ACTIVE' || !user.mfaEnabled || !user.mfaSecret ||
        await this.redis.getClient().get(`krypton:mfa:challenge:${decoded.jti}`) !== user.id) {
      throw new UnauthorizedException('User or MFA challenge is unavailable.');
    }

    const isCodeValid = authenticator.check(code, user.mfaSecret);

    if (!isCodeValid) {
      await this.audit.record({
        organizationId: user.organizationId,
        actorId: user.id,
        actorType: 'USER',
        action: AuditAction.MFA_FAILED,
        targetType: 'USER',
        targetId: user.id,
        sourceIp: ipAddress,
        userAgent,
        result: 'FAILURE',
        reason: 'Incorrect TOTP code',
      });

      throw new UnauthorizedException({
        code: 'INVALID_MFA_CODE',
        message: 'The submitted MFA verification code is invalid.',
        retryable: true,
      });
    }

    // MFA Validated successfully
    const consumed = await this.redis.getClient().eval(
      `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end; return 0`,
      1, `krypton:mfa:challenge:${decoded.jti}`, user.id);
    if (Number(consumed) !== 1) throw new UnauthorizedException('MFA challenge was already used.');
    await this.audit.record({
      organizationId: user.organizationId,
      actorId: user.id,
      actorType: 'USER',
      action: AuditAction.MFA_SUCCESS,
      targetType: 'USER',
      targetId: user.id,
      sourceIp: ipAddress,
      userAgent,
      result: 'SUCCESS',
    });

    const tokens = await this.issueTokens(user.id, user.organizationId, user.email, ipAddress, userAgent, undefined, true);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return tokens;
  }

  /**
   * Generates a new MFA Secret and OTPAuth URL for enrolling MFA
   */
  async generateMfaSecret(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (user.mfaEnabled) throw new BadRequestException('MFA is already enabled.');

    const config = getConfig();
    const secret = authenticator.generateSecret();
    const otpAuthUrl = authenticator.keyuri(user.email, config.APP_NAME, secret);
    await this.redis.getClient().setex(`krypton:mfa:setup:${userId}`, 600, secret);

    return { secret, otpAuthUrl };
  }

  /**
   * Activates MFA after user verifies first code
   */
  async activateMfa(userId: string, secret: string, code: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.mfaEnabled || await this.redis.getClient().get(`krypton:mfa:setup:${userId}`) !== secret) {
      throw new BadRequestException('MFA setup is expired, invalid, or already enabled.');
    }
    const isValid = authenticator.check(code, secret);
    if (!isValid) {
      throw new BadRequestException('MFA confirmation code is invalid.');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        mfaEnabled: true,
        mfaSecret: secret,
      },
    });

    await this.redis.getClient().del(`krypton:mfa:setup:${userId}`);
    await this.logoutAllDevices(userId);
    return { success: true };
  }

  /**
   * Issue access and rotating refresh token family
   */
  private async issueTokens(
    userId: string,
    organizationId: string,
    email: string,
    ipAddress?: string,
    userAgent?: string,
    existingFamilyId?: string,
    mfaVerified = false,
    database: Prisma.TransactionClient = this.prisma
  ) {
    const config = getConfig();

    const familyId = existingFamilyId || uuidv4();
    const payload = { userId, sub: userId, organizationId, email, tokenUse: 'access', mfaVerified, familyId };

    const accessToken = jwt.sign(payload, config.JWT_ACCESS_SECRET, {
      expiresIn: config.JWT_ACCESS_EXPIRATION as any,
    });

    const rawRefreshToken = uuidv4() + '.' + crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex');

    // Refresh token expiry: 7 days default
    const duration = config.JWT_REFRESH_EXPIRATION;
    const unitMs: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    const expiresAt = new Date(Date.now() + Number(duration.slice(0, -1)) * unitMs[duration.slice(-1)]!);

    const persistTokens = async (tx: Prisma.TransactionClient) => {
    await tx.refreshToken.create({
      data: {
        userId,
        tokenHash,
        familyId,
        expiresAt,
        mfaVerified,
      },
    });

    // Store user session record
    await tx.userSession.create({
      data: {
        userId,
        sessionToken: tokenHash,
        ipAddress,
        userAgent,
        expiresAt,
      },
    });
    };
    if (database === this.prisma) await this.prisma.$transaction(persistTokens);
    else await persistTokens(database);

    return {
      accessToken,
      refreshToken: rawRefreshToken,
      tokenType: 'Bearer',
      expiresIn: config.JWT_ACCESS_EXPIRATION,
    };
  }

  /**
   * Rotating Refresh Token with Reuse Detection (Section 8)
   */
  async refreshTokens(rawRefreshToken: string, ipAddress?: string, userAgent?: string) {
    const tokenHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex');

    const storedToken = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!storedToken) {
      throw new UnauthorizedException({
        code: 'INVALID_REFRESH_TOKEN',
        message: 'Invalid or expired refresh token.',
        retryable: false,
      });
    }

    // Token reuse detection: if already revoked, compromise detected! Revoke whole family!
    if (storedToken.isRevoked || storedToken.expiresAt < new Date()) {
      await this.prisma.refreshToken.updateMany({
        where: { familyId: storedToken.familyId },
        data: { isRevoked: true },
      });

      throw new UnauthorizedException({
        code: 'REFRESH_TOKEN_REUSE_DETECTED',
        message: 'Security violation: Refresh token reuse detected. All sessions in family revoked.',
        retryable: false,
      });
    }

    if (storedToken.user.status !== 'ACTIVE') throw new UnauthorizedException('Account is not active.');
    const rotated = await this.prisma.$transaction(async tx => {
      const claimed = await tx.refreshToken.updateMany({
        where: { id: storedToken.id, isRevoked: false, expiresAt: { gt: new Date() } },
        data: { isRevoked: true },
      });
      if (claimed.count !== 1) return null;
      await tx.userSession.deleteMany({ where: { sessionToken: tokenHash } });
      return this.issueTokens(storedToken.userId, storedToken.user.organizationId,
        storedToken.user.email, ipAddress, userAgent, storedToken.familyId, storedToken.mfaVerified, tx);
    });
    if (!rotated) {
      await this.prisma.refreshToken.updateMany({ where: { familyId: storedToken.familyId }, data: { isRevoked: true } });
      throw new UnauthorizedException('Refresh token was already used. Log in again.');
    }
    return rotated;
  }

  /**
   * Logout current token session
   */
  async logout(rawRefreshToken: string) {
    const tokenHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex');
    const token = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    await this.prisma.refreshToken.updateMany({
      where: token ? { familyId: token.familyId } : { tokenHash },
      data: { isRevoked: true },
    });
    await this.prisma.userSession.deleteMany({
      where: { sessionToken: tokenHash },
    });
    return { success: true };
  }

  /**
   * Logout all sessions across all devices for a user
   */
  async logoutAllDevices(userId: string) {
    await this.prisma.refreshToken.updateMany({
      where: { userId },
      data: { isRevoked: true },
    });
    await this.prisma.userSession.deleteMany({
      where: { userId },
    });
    return { success: true };
  }
}
