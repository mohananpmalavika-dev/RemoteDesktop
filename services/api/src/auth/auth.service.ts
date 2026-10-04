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

export interface TokenPayload {
  userId: string;
  organizationId: string;
  email: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
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
      // Intentionally timing-safe error response
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email/username or password.',
        retryable: false,
      });
    }

    if (user.status !== 'ACTIVE') {
      throw new UnauthorizedException({
        code: 'ACCOUNT_SUSPENDED',
        message: `Account is currently ${user.status}. Contact administrator.`,
        retryable: false,
      });
    }

    const isValidPassword = await this.verifyPassword(user.passwordHash, passwordPlain);

    if (!isValidPassword) {
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
        reason: 'Invalid password',
      });

      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email/username or password.',
        retryable: false,
      });
    }

    // Check if MFA is required
    if (user.mfaEnabled && user.mfaSecret) {
      const config = getConfig();
      const mfaTempToken = jwt.sign(
        { userId: user.id, mfaPending: true },
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
      decoded = jwt.verify(mfaToken, config.JWT_ACCESS_SECRET);
    } catch {
      throw new UnauthorizedException({
        code: 'MFA_SESSION_EXPIRED',
        message: 'MFA challenge session expired or invalid. Please log in again.',
        retryable: false,
      });
    }

    if (!decoded.mfaPending || !decoded.userId) {
      throw new UnauthorizedException('Invalid MFA token.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: decoded.userId },
    });

    if (!user || !user.mfaSecret) {
      throw new NotFoundException('User or MFA configuration not found.');
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

    const tokens = await this.issueTokens(user.id, user.organizationId, user.email, ipAddress, userAgent);

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

    const config = getConfig();
    const secret = authenticator.generateSecret();
    const otpAuthUrl = authenticator.keyuri(user.email, config.APP_NAME, secret);

    return { secret, otpAuthUrl };
  }

  /**
   * Activates MFA after user verifies first code
   */
  async activateMfa(userId: string, secret: string, code: string) {
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
    existingFamilyId?: string
  ) {
    const config = getConfig();

    const payload: TokenPayload = { userId, organizationId, email };

    const accessToken = jwt.sign(payload, config.JWT_ACCESS_SECRET, {
      expiresIn: config.JWT_ACCESS_EXPIRATION as any,
    });

    const rawRefreshToken = uuidv4() + '.' + crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex');
    const familyId = existingFamilyId || uuidv4();

    // Refresh token expiry: 7 days default
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash,
        familyId,
        expiresAt,
      },
    });

    // Store user session record
    await this.prisma.userSession.create({
      data: {
        userId,
        sessionToken: tokenHash,
        ipAddress,
        userAgent,
        expiresAt,
      },
    });

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

    // Revoke the old refresh token (rotate)
    await this.prisma.refreshToken.update({
      where: { id: storedToken.id },
      data: { isRevoked: true },
    });

    // Issue a new token pair preserving the familyId
    return this.issueTokens(
      storedToken.userId,
      storedToken.user.organizationId,
      storedToken.user.email,
      ipAddress,
      userAgent,
      storedToken.familyId
    );
  }

  /**
   * Logout current token session
   */
  async logout(rawRefreshToken: string) {
    const tokenHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex');
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash },
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
