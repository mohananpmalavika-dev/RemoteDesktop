import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Req,
  UseGuards,
  UnauthorizedException,
} from '@nestjs/common';
import { SessionsService, CreateSessionDto } from './sessions.service';
import { IceCredentialsService } from './ice-credentials.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { Public } from '../auth/public.decorator';
import { RequirePermissions } from '../rbac/permissions.decorator';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { KryptonPermission, SessionCapabilities } from '@krypton/shared-types';
import { DeviceAuthGuard } from '../auth/device-auth.guard';

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
      userAgent,
      user.mfaVerified
    );
  }

  @Get('active')
  @RequirePermissions(KryptonPermission.REMOTE_SCREEN_VIEW)
  async getActiveSessions(@CurrentUser() user: any) {
    return this.sessionsService.getActiveSessions(user.organizationId);
  }

  @Get(':id')
  @RequirePermissions(KryptonPermission.REMOTE_SCREEN_VIEW)
  async getSession(@CurrentUser() user: any, @Param('id') sessionId: string) {
    return this.sessionsService.getSession(sessionId, user.organizationId);
  }

  @Post(':id/terminate')
  @RequirePermissions(KryptonPermission.REMOTE_SESSION_TERMINATE)
  async terminateSession(
    @CurrentUser() user: any,
    @Param('id') sessionId: string,
    @Body('reason') reason?: string
  ) {
    return this.sessionsService.terminateSession(sessionId, user.id, user.organizationId, reason);
  }

  @Public()
  @Post(':id/accept')
  @UseGuards(DeviceAuthGuard)
  async acceptSession(
    @Param('id') sessionId: string,
    @Body('capabilities') capabilities: SessionCapabilities,
    @Req() req: any
  ) {
    return this.sessionsService.acceptSession(sessionId, capabilities, req.device.id);
  }

  @Public()
  @Post(':id/reject')
  @UseGuards(DeviceAuthGuard)
  async rejectSession(
    @Param('id') sessionId: string,
    @Body('reason') reason: string | undefined,
    @Req() req: any
  ) {
    return this.sessionsService.rejectSession(sessionId, reason, req.device.id);
  }

  @Post(':id/end')
  async endSession(
    @CurrentUser() user: any,
    @Param('id') sessionId: string,
    @Body('reason') reason?: string
  ) {
    return this.sessionsService.endSession(sessionId, user.id, user.organizationId, reason);
  }

  @Get(':id/ice-servers')
  @RequirePermissions(KryptonPermission.REMOTE_SESSION_CREATE)
  async getIceServers(@CurrentUser() user: any, @Param('id') sessionId: string) {
    await this.sessionsService.getSession(sessionId, user.organizationId);
    return this.iceService.generateIceConfiguration(user.id);
  }

  @Public()
  @Post('quick-connect')
  async quickConnect(
    @Body() dto: { targetRemoteId: string; pin?: string },
    @Req() req: any
  ) {
    const ip = req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    return this.sessionsService.quickConnect(dto, ip, userAgent);
  }

  @RequirePermissions(KryptonPermission.REMOTE_SESSION_CREATE)
  @Get('public/ice-servers')
  async getPublicIceServers() {
    return this.iceService.generateIceConfiguration('web-guest');
  }

  @Public()
  @Post(':id/host-state')
  @UseGuards(DeviceAuthGuard)
  async updateHostState(@Param('id') id: string, @Body() body: unknown, @Req() req: any) {
    return this.sessionsService.updateHostState(id, req.device.id, body);
  }

  @Public()
  @Post(':id/guest-end')
  async endGuestSession(@Param('id') id: string, @Req() req: any) {
    const auth = req.headers.authorization;
    if (typeof auth !== 'string' || !/^Bearer \S+$/.test(auth)) throw new UnauthorizedException('Session token is required');
    return this.sessionsService.endGuestSession(id, auth.slice(7));
  }
}
