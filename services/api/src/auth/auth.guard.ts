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

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException({
        code: 'AUTH_TOKEN_MISSING',
        message: 'Authorization header with Bearer token is required.',
        retryable: false,
      });
    }

    const token = authHeader.split(' ')[1];
    const config = getConfig();

    try {
      const decoded = jwt.verify(token, config.JWT_ACCESS_SECRET) as any;
      request.user = {
        id: decoded.userId,
        organizationId: decoded.organizationId,
        email: decoded.email,
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
