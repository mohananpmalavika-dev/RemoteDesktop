import { Module } from '@nestjs/common';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AuditService } from '../audit/audit.service';
import { RbacService } from '../rbac/rbac.service';

@Module({
  controllers: [DevicesController],
  providers: [
    DevicesService,
    PrismaService,
    RedisService,
    AuditService,
    RbacService,
  ],
  exports: [DevicesService],
})
export class DevicesModule {}
