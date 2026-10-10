import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import jwt from 'jsonwebtoken';
import { IS_PUBLIC_KEY } from './public.decorator';
import { getConfig } from '@krypton/config';
import { AccessClaimsSchema } from '@krypton/protocol';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    if (typeof authHeader !== 'string' || !/^Bearer \S+$/.test(authHeader)) {
      throw new UnauthorizedException({
        code: 'AUTH_TOKEN_MISSING',
        message: 'Authorization header with Bearer token is required.',
        retryable: false,
      });
    }

    const token = authHeader.slice(7);
    const config = getConfig();

    try {
      const decoded = AccessClaimsSchema.parse(jwt.verify(token, config.JWT_ACCESS_SECRET, { algorithms: ['HS256'] }));
      const user = await this.prisma.user.findUnique({ where: { id: decoded.userId } });
      if (!user || user.status !== 'ACTIVE' || user.organizationId !== decoded.organizationId) throw new Error('Inactive identity');
      const liveFamily = await this.prisma.refreshToken.findFirst({ where: {
        userId: user.id, familyId: decoded.familyId, isRevoked: false, expiresAt: { gt: new Date() }
      } });
      if (!liveFamily) throw new Error('Revoked session');
      request.user = {
        id: decoded.userId,
        organizationId: decoded.organizationId,
        email: decoded.email,
        mfaVerified: decoded.mfaVerified,
      };
      return true;
    } catch {
      throw new UnauthorizedException({
        code: 'AUTH_TOKEN_INVALID',
        message: 'Access token is invalid or expired.',
        retryable: false,
      });
    }
  }
}
