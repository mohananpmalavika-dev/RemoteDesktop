import { Module, Global } from '@nestjs/common';
import { RbacService } from './rbac.service';
import { PermissionsGuard } from './permissions.guard';
import { PrismaService } from '../prisma/prisma.service';

@Global()
@Module({
  providers: [RbacService, PermissionsGuard, PrismaService],
  exports: [RbacService, PermissionsGuard],
})
export class RbacModule {}
