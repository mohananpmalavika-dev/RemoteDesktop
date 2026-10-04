import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { AuditModule } from './audit/audit.module';
import { RbacModule } from './rbac/rbac.module';
import { AuthModule } from './auth/auth.module';
import { DevicesModule } from './devices/devices.module';
import { SessionsModule } from './sessions/sessions.module';
import { PoliciesModule } from './policies/policies.module';
import { PrismaService } from './prisma/prisma.service';
import { RedisService } from './redis/redis.service';

@Module({
  imports: [
    HealthModule,
    AuditModule,
    RbacModule,
    AuthModule,
    DevicesModule,
    SessionsModule,
    PoliciesModule,
  ],
  providers: [PrismaService, RedisService],
  exports: [PrismaService, RedisService],
})
export class AppModule {}
