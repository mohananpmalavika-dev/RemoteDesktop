import {
  Controller,
  Post,
  Get,
  Body,
  Req,
  BadRequestException,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { RbacService } from '../rbac/rbac.service';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from './public.decorator';
import { CurrentUser } from './current-user.decorator';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly rbacService: RbacService,
    private readonly prisma: PrismaService
  ) {}

  /**
   * Initial Registration / Organization setup
   */
  @Public()
  @Post('register')
  async register(@Body() body: any) {
    const { organizationName, email, username, password } = body;

    if (!organizationName || !email || !username || !password) {
      throw new BadRequestException('organizationName, email, username, and password are required.');
    }

    if (password.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters long.');
    }

    // Check unique constraints
    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ email }, { username }] },
    });
    if (existing) {
      throw new BadRequestException('User with this email or username already exists.');
    }

    const org = await this.prisma.organization.create({
      data: {
        name: organizationName,
        slug: organizationName.toLowerCase().replace(/[^a-z0-9]/g, '-') + '-' + Math.floor(Math.random() * 10000),
      },
    });

    const passwordHash = await this.authService.hashPassword(password);

    const user = await this.prisma.user.create({
      data: {
        organizationId: org.id,
        email,
        username,
        passwordHash,
      },
    });

    // Seed default roles and grant System Administrator to the first user
    const adminRole = await this.rbacService.seedDefaultRolesAndPermissions(org.id);
    await this.prisma.userRole.create({
      data: {
        userId: user.id,
        roleId: adminRole.id,
      },
    });

    return {
      message: 'Organization and user registered successfully.',
      userId: user.id,
      organizationId: org.id,
    };
  }

  @Public()
  @Post('login')
  async login(@Body() body: any, @Req() req: any) {
    const { username, email, password } = body;
    const identifier = username || email;
    if (!identifier || !password) {
      throw new BadRequestException('Identifier and password are required.');
    }

    const ip = req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];

    return this.authService.login(identifier, password, ip, userAgent);
  }

  @Public()
  @Post('mfa/verify')
  async verifyMfa(@Body() body: any, @Req() req: any) {
    const { mfaToken, code } = body;
    if (!mfaToken || !code) {
      throw new BadRequestException('mfaToken and code are required.');
    }

    const ip = req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];

    return this.authService.verifyMfa(mfaToken, code, ip, userAgent);
  }

  @Public()
  @Post('refresh')
  async refresh(@Body() body: any, @Req() req: any) {
    const { refreshToken } = body;
    if (!refreshToken) {
      throw new BadRequestException('refreshToken is required.');
    }

    const ip = req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];

    return this.authService.refreshTokens(refreshToken, ip, userAgent);
  }

  @Post('logout')
  async logout(@Body() body: any) {
    const { refreshToken } = body;
    if (refreshToken) {
      await this.authService.logout(refreshToken);
    }
    return { success: true, message: 'Successfully logged out.' };
  }

  @Post('mfa/setup')
  async setupMfa(@CurrentUser() user: any) {
    return this.authService.generateMfaSecret(user.id);
  }

  @Post('mfa/activate')
  async activateMfa(@CurrentUser() user: any, @Body() body: any) {
    const { secret, code } = body;
    if (!secret || !code) {
      throw new BadRequestException('secret and code are required.');
    }
    return this.authService.activateMfa(user.id, secret, code);
  }

  @Get('me')
  async getMe(@CurrentUser() userPayload: any) {
    const user = await this.prisma.user.findUnique({
      where: { id: userPayload.id },
      include: {
        organization: true,
        userRoles: {
          include: {
            role: true,
          },
        },
      },
    });

    if (!user) {
      throw new BadRequestException('User not found.');
    }

    const permissions = await this.rbacService.getUserPermissions(user.id);

    return {
      id: user.id,
      email: user.email,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      mfaEnabled: user.mfaEnabled,
      status: user.status,
      organization: {
        id: user.organization.id,
        name: user.organization.name,
      },
      roles: user.userRoles.map((ur) => ur.role.name),
      permissions: Array.from(permissions),
    };
  }
}
