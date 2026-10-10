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
import { DeviceAuthGuard } from '../auth/device-auth.guard';
import { parseBody } from '../common/validation';
import { z } from 'zod';
import { getConfig } from '@krypton/config';

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
      expiresInHours ?? 24
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
  @UseGuards(DeviceAuthGuard)
  async heartbeat(
    @Param('id') deviceId: string,
    @Body() body: Partial<DeviceHeartbeat>,
    @Req() req: any
  ) {
    body = parseBody(z.object({
      agentVersion: z.string().min(1).max(32), os: z.string().min(1).max(64),
      osVersion: z.string().min(1).max(64), architecture: z.string().min(1).max(32),
      sessionCount: z.number().int().min(0).max(100), cpuPercent: z.number().min(0).max(100),
      memoryPercent: z.number().min(0).max(100), uptimeSeconds: z.number().int().nonnegative(),
    }).strict(), body);
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

  @Public()
  @Post(':id/runtime-config')
  @UseGuards(DeviceAuthGuard)
  async getRuntimeConfig(@Req() req: any) {
    return { deviceId: req.device.id, signalingUrl: getConfig().SIGNALING_PUBLIC_URL };
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
  @RequirePermissions(KryptonPermission.DEVICE_RENAME, KryptonPermission.POLICY_MANAGE)
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
