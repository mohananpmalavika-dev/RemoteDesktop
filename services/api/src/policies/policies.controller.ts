import {
  Controller,
  Get,
  Put,
  Body,
  UseGuards,
} from '@nestjs/common';
import { PoliciesService, TenantPolicyDto } from './policies.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermissions } from '../rbac/permissions.decorator';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { KryptonPermission } from '@krypton/shared-types';

@Controller('policies')
@UseGuards(PermissionsGuard)
export class PoliciesController {
  constructor(private readonly policiesService: PoliciesService) {}

  @Get()
  @RequirePermissions(KryptonPermission.DEVICE_VIEW)
  async getPolicy(@CurrentUser() user: any) {
    return this.policiesService.getPolicy(user.organizationId);
  }

  @Put()
  @RequirePermissions(KryptonPermission.POLICY_MANAGE)
  async updatePolicy(
    @CurrentUser() user: any,
    @Body() dto: TenantPolicyDto
  ) {
    return this.policiesService.updatePolicy(user.organizationId, dto, user.id);
  }
}
