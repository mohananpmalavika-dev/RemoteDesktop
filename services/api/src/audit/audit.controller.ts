import {
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuditService } from './audit.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermissions } from '../rbac/permissions.decorator';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { KryptonPermission } from '@krypton/shared-types';

@Controller('audit')
@UseGuards(PermissionsGuard)
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get('logs')
  @RequirePermissions(KryptonPermission.AUDIT_VIEW)
  async getAuditLogs(
    @CurrentUser() user: any,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string
  ) {
    const parsedLimit = limit ? parseInt(limit, 10) : 50;
    const parsedOffset = offset ? parseInt(offset, 10) : 0;
    return this.auditService.getOrganizationAuditLogs(
      user.organizationId,
      parsedLimit,
      parsedOffset
    );
  }

  @Get('verify')
  @RequirePermissions(KryptonPermission.AUDIT_VIEW)
  async verifyChain(@CurrentUser() user: any) {
    return this.auditService.verifyChain(user.organizationId);
  }

  @Get('export')
  @RequirePermissions(KryptonPermission.AUDIT_EXPORT)
  async exportLogs(@CurrentUser() user: any) {
    return this.auditService.exportAuditLogs(user.organizationId);
  }
}
