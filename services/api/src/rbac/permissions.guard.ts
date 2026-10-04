import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from './permissions.decorator';
import { RbacService } from './rbac.service';
import { KryptonPermission } from '@krypton/shared-types';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly rbacService: RbacService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPermissions = this.reflector.getAllAndOverride<KryptonPermission[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()]
    );

    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user || !user.id) {
      throw new ForbiddenException({
        code: 'AUTH_REQUIRED',
        message: 'Authentication required to verify permissions.',
        retryable: false,
      });
    }

    const grantedPermissions = await this.rbacService.getUserPermissions(user.id);

    const hasAll = requiredPermissions.every((perm) =>
      grantedPermissions.has(perm)
    );

    if (!hasAll) {
      const missing = requiredPermissions.filter(
        (perm) => !grantedPermissions.has(perm)
      );
      throw new ForbiddenException({
        code: 'PERMISSION_DENIED',
        message: `Missing required permission(s): ${missing.join(', ')}`,
        retryable: false,
        details: { missingPermissions: missing },
      });
    }

    return true;
  }
}
