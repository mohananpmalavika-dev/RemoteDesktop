import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { KryptonPermission, SystemRole } from '@krypton/shared-types';
import { Prisma } from '@prisma/client';

@Injectable()
export class RbacService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns all granted permission strings for a given user
   */
  async getUserPermissions(userId: string): Promise<Set<string>> {
    const userRoles = await this.prisma.userRole.findMany({
      where: { userId },
      include: {
        role: {
          include: {
            rolePermissions: {
              include: { permission: true },
            },
          },
        },
      },
    });

    const permissions = new Set<string>();
    for (const ur of userRoles) {
      for (const rp of ur.role.rolePermissions) {
        permissions.add(rp.permission.name);
      }
    }

    return permissions;
  }

  /**
   * Seed standard system permissions and roles if not present
   */
  async seedDefaultRolesAndPermissions(organizationId: string, database: Prisma.TransactionClient = this.prisma) {
    const allPermissions = Object.values(KryptonPermission);

    // Upsert permissions
    for (const perm of allPermissions) {
      await database.permission.upsert({
        where: { name: perm },
        update: {},
        create: {
          name: perm,
          category: perm.split('.')[0] || 'general',
          description: `Permission for ${perm}`,
        },
      });
    }

    // Upsert System Administrator role with all permissions
    const adminRole = await database.role.upsert({
      where: {
        organizationId_name: {
          organizationId,
          name: SystemRole.SYSTEM_ADMINISTRATOR,
        },
      },
      update: {},
      create: {
        organizationId,
        name: SystemRole.SYSTEM_ADMINISTRATOR,
        description: 'Full system access',
        isSystem: true,
      },
    });

    const perms = await database.permission.findMany();
    for (const p of perms) {
      await database.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: adminRole.id,
            permissionId: p.id,
          },
        },
        update: {},
        create: {
          roleId: adminRole.id,
          permissionId: p.id,
        },
      });
    }

    return adminRole;
  }
}
