import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Req,
  Query,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { DevicesService } from './devices.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { Public } from '../auth/public.decorator';
import { RequirePermissions } from '../rbac/permissions.decorator';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { KryptonPermission, DeviceHeartbeat } from '@krypton/shared-types';

@Controller('devices')
@UseGuards(PermissionsGuard)
export class DevicesController {
  constructor(private readonly devicesService: DevicesService) {}

  @Post('enrollment-tokens')
  @RequirePermissions(KryptonPermission.DEVICE_ENROLL)
  async createEnrollmentToken(
    @CurrentUser() user: any,
    @Body('expiresInHours') expiresInHours?: number
  ) {
    return this.devicesService.createEnrollmentToken(
      user.organizationId,
      user.id,
      expiresInHours || 24
    );
  }

  @Public()
  @Post('enroll')
  async enrollDevice(@Body() body: any, @Req() req: any) {
    const {
      enrollmentToken,
      publicKeyBase64,
      deviceName,
      hostname,
      os,
      osVersion,
      architecture,
      agentVersion,
    } = body;

    if (!publicKeyBase64 || !deviceName || !hostname) {
      throw new BadRequestException(
        'publicKeyBase64, deviceName, and hostname are required.'
      );
    }

    const ip = req.ip || req.socket.remoteAddress;

    return this.devicesService.enrollDevice({
      rawEnrollmentToken: enrollmentToken,
      publicKeyBase64,
      deviceName,
      hostname,
      os: os || 'Windows',
      osVersion: osVersion || '11',
      architecture: architecture || 'x86_64',
      agentVersion: agentVersion || '1.0.0',
      sourceIp: ip,
    });
  }

  @Public()
  @Post(':id/heartbeat')
  async heartbeat(
    @Param('id') deviceId: string,
    @Body() body: Partial<DeviceHeartbeat>,
    @Req() req: any
  ) {
    const ip = req.ip || req.socket.remoteAddress;

    const heartbeatPayload: DeviceHeartbeat = {
      deviceId,
      timestamp: new Date().toISOString(),
      agentVersion: body.agentVersion || '1.0.0',
      os: body.os || 'Windows',
      osVersion: body.osVersion || '11',
      architecture: body.architecture || 'x86_64',
      sessionCount: body.sessionCount || 0,
      cpuPercent: body.cpuPercent || 0,
      memoryPercent: body.memoryPercent || 0,
      uptimeSeconds: body.uptimeSeconds || 0,
    };

    return this.devicesService.processHeartbeat(heartbeatPayload, ip);
  }

  @Get()
  @RequirePermissions(KryptonPermission.DEVICE_VIEW)
  async listDevices(
    @CurrentUser() user: any,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string
  ) {
    return this.devicesService.listDevices(
      user.organizationId,
      limit ? parseInt(limit, 10) : 50,
      offset ? parseInt(offset, 10) : 0
    );
  }

  @Get(':id')
  @RequirePermissions(KryptonPermission.DEVICE_VIEW)
  async getDevice(@CurrentUser() user: any, @Param('id') deviceId: string) {
    return this.devicesService.getDevice(user.organizationId, deviceId);
  }

  @Patch(':id')
  @RequirePermissions(KryptonPermission.DEVICE_RENAME)
  async updateDevice(
    @CurrentUser() user: any,
    @Param('id') deviceId: string,
    @Body() body: any
  ) {
    return this.devicesService.updateDevice(
      user.organizationId,
      deviceId,
      body,
      user.id
    );
  }

  @Post(':id/revoke')
  @RequirePermissions(KryptonPermission.DEVICE_REVOKE)
  async revokeDevice(@CurrentUser() user: any, @Param('id') deviceId: string) {
    return this.devicesService.revokeDevice(user.organizationId, deviceId, user.id);
  }
}
