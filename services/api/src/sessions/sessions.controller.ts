import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SessionsService, CreateSessionDto } from './sessions.service';
import { IceCredentialsService } from './ice-credentials.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { Public } from '../auth/public.decorator';
import { RequirePermissions } from '../rbac/permissions.decorator';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { KryptonPermission, SessionCapabilities } from '@krypton/shared-types';

@Controller('sessions')
@UseGuards(PermissionsGuard)
export class SessionsController {
  constructor(
    private readonly sessionsService: SessionsService,
    private readonly iceService: IceCredentialsService
  ) {}

  @Post()
  @RequirePermissions(KryptonPermission.REMOTE_SESSION_CREATE)
  async createSession(
    @CurrentUser() user: any,
    @Body() dto: CreateSessionDto,
    @Req() req: any
  ) {
    const ip = req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];

    return this.sessionsService.createSession(
      user.id,
      user.email,
      user.organizationId,
      dto,
      ip,
      userAgent
    );
  }

  @Get('active')
  @RequirePermissions(KryptonPermission.REMOTE_SCREEN_VIEW)
  async getActiveSessions(@CurrentUser() user: any) {
    return this.sessionsService.getActiveSessions(user.organizationId);
  }

  @Get(':id')
  @RequirePermissions(KryptonPermission.REMOTE_SCREEN_VIEW)
  async getSession(@Param('id') sessionId: string) {
    return this.sessionsService.getSession(sessionId);
  }

  @Post(':id/terminate')
  @RequirePermissions(KryptonPermission.REMOTE_SESSION_TERMINATE)
  async terminateSession(
    @CurrentUser() user: any,
    @Param('id') sessionId: string,
    @Body('reason') reason?: string
  ) {
    return this.sessionsService.terminateSession(sessionId, user.id, reason);
  }

  @Public()
  @Post(':id/accept')
  async acceptSession(
    @Param('id') sessionId: string,
    @Body('capabilities') capabilities: SessionCapabilities,
    @Body('deviceId') deviceId?: string
  ) {
    return this.sessionsService.acceptSession(sessionId, capabilities, deviceId);
  }

  @Public()
  @Post(':id/reject')
  async rejectSession(
    @Param('id') sessionId: string,
    @Body('reason') reason?: string,
    @Body('deviceId') deviceId?: string
  ) {
    return this.sessionsService.rejectSession(sessionId, reason, deviceId);
  }

  @Post(':id/end')
  async endSession(
    @CurrentUser() user: any,
    @Param('id') sessionId: string,
    @Body('reason') reason?: string
  ) {
    return this.sessionsService.endSession(sessionId, user.id, reason);
  }

  @Get(':id/ice-servers')
  @RequirePermissions(KryptonPermission.REMOTE_SESSION_CREATE)
  async getIceServers(@CurrentUser() user: any) {
    return this.iceService.generateIceConfiguration(user.id);
  }
}
