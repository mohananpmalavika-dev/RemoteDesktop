import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { APP_GUARD } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RbacService } from '../rbac/rbac.service';
import { RedisService } from '../redis/redis.service';
import { RateLimitGuard } from './rate-limit.guard';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    PrismaService,
    AuditService,
    RbacService,
    RedisService,
    { provide: APP_GUARD, useClass: RateLimitGuard },
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
  ],
  exports: [AuthService],
})
export class AuthModule {}
