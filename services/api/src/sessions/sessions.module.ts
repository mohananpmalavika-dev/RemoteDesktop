import { Module } from '@nestjs/common';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { IceCredentialsService } from './ice-credentials.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AuditService } from '../audit/audit.service';
import { DevicesService } from '../devices/devices.service';
import { RbacService } from '../rbac/rbac.service';

@Module({
  controllers: [SessionsController],
  providers: [
    SessionsService,
    IceCredentialsService,
    PrismaService,
    RedisService,
    AuditService,
    DevicesService,
    RbacService,
  ],
  exports: [SessionsService, IceCredentialsService],
})
export class SessionsModule {}
