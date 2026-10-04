import { SetMetadata } from '@nestjs/common';
import { KryptonPermission } from '@krypton/shared-types';

export const PERMISSIONS_KEY = 'krypton:permissions';
export const RequirePermissions = (...permissions: KryptonPermission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
