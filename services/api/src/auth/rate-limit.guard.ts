import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { getConfig } from '@krypton/config';
import crypto from 'crypto';

const COUNTER = `local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end; return n`;

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(private readonly redis: RedisService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    if (req.method !== 'POST') return true;
    const route = req.path.toLowerCase().replace(/\/+$/, '');
    const authRoute = /\/auth\/(login|register|mfa\/verify|refresh)$/.test(route);
    const sessionRoute = /\/sessions(?:\/quick-connect)?$/.test(route);
    const enrollRoute = /\/devices\/enroll$/.test(route);
    if (!authRoute && !sessionRoute && !enrollRoute) return true;
    const config = getConfig();
    const max = sessionRoute ? config.RATE_LIMIT_SESSION_CREATE_MAX : config.RATE_LIMIT_LOGIN_MAX;
    const ttl = sessionRoute ? config.RATE_LIMIT_SESSION_CREATE_TTL_SECONDS : config.RATE_LIMIT_LOGIN_TTL_SECONDS;
    const scope = crypto.createHash('sha256').update(`${req.ip}:${route}`).digest('hex');
    const count = Number(await this.redis.getClient().eval(COUNTER, 1, `krypton:rate:${scope}`, ttl));
    if (count > max) {
      context.switchToHttp().getResponse().setHeader('Retry-After', ttl);
      throw new HttpException({ code: 'RATE_LIMIT_EXCEEDED', message: 'Too many attempts. Please try again later.', retryable: true }, 429);
    }
    return true;
  }
}
