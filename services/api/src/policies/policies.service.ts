import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '@krypton/shared-types';

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
    const client = this.redis.getClient();
    const cached = await client.get(`krypton:policy:${organizationId}`);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch {}
    }

    // Default enterprise policy
    const defaultPolicy: TenantPolicyDto = {
      requireMfa: true,
      enforceConsent: true,
      idleTimeoutMin: 15,
      clipboardPolicy: 'BIDIRECTIONAL',
      maxFileMb: 500,
      sessionRecording: true,
    };

    await client.set(`krypton:policy:${organizationId}`, JSON.stringify(defaultPolicy));
    return defaultPolicy;
  }

  async updatePolicy(
    organizationId: string,
    dto: TenantPolicyDto,
    actorId: string
  ): Promise<TenantPolicyDto> {
    const client = this.redis.getClient();
    await client.set(`krypton:policy:${organizationId}`, JSON.stringify(dto));

    // Update all enrolled device policies for this organization in PostgreSQL
    await this.prisma.devicePolicy.updateMany({
      where: { device: { organizationId } },
      data: {
        requireMfa: dto.requireMfa,
        allowClipboard: dto.clipboardPolicy !== 'DISABLED',
        allowFileTransfer: dto.maxFileMb > 0,
        requireSessionRecording: dto.sessionRecording,
      },
    });

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
