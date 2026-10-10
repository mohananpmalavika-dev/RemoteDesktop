import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '@krypton/shared-types';
import { z } from 'zod';
import { parseBody } from '../common/validation';

export const tenantPolicySchema = z.object({
  requireMfa: z.boolean().default(false),
  enforceConsent: z.literal(true).default(true),
  idleTimeoutMin: z.number().int().min(1).max(120).default(15),
  clipboardPolicy: z.enum(['BIDIRECTIONAL', 'CLIENT_TO_HOST', 'DISABLED']).default('BIDIRECTIONAL'),
  maxFileMb: z.number().int().min(0).max(500).default(100),
  sessionRecording: z.literal(false).default(false),
}).strict();

export interface TenantPolicyDto {
  requireMfa: boolean;
  enforceConsent: boolean;
  idleTimeoutMin: number;
  clipboardPolicy: 'BIDIRECTIONAL' | 'CLIENT_TO_HOST' | 'DISABLED';
  maxFileMb: number;
  sessionRecording: boolean;
}

@Injectable()
export class PoliciesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService
  ) {}

  async getPolicy(organizationId: string): Promise<TenantPolicyDto> {
    const organization = await this.prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
    return tenantPolicySchema.parse(organization.policy);
  }

  async updatePolicy(
    organizationId: string,
    dto: TenantPolicyDto,
    actorId: string
  ): Promise<TenantPolicyDto> {
    dto = parseBody(tenantPolicySchema, dto);
    await this.prisma.$transaction(async tx => {
      await tx.organization.update({ where: { id: organizationId }, data: { policy: { ...dto } } });
      await tx.devicePolicy.updateMany({
      where: { device: { organizationId } },
      data: {
        requireMfa: dto.requireMfa,
        allowClipboard: dto.clipboardPolicy !== 'DISABLED',
        allowFileTransfer: dto.maxFileMb > 0,
        requireSessionRecording: dto.sessionRecording,
      },
      });
    });
    await this.redis.getClient().del(`krypton:policy:${organizationId}`);

    await this.audit.record({
      organizationId,
      actorId,
      actorType: 'USER',
      action: AuditAction.POLICY_CHANGED,
      targetType: 'TENANT_POLICY',
      targetId: organizationId,
      result: 'SUCCESS',
      metadata: dto,
    });

    return dto;
  }
}
