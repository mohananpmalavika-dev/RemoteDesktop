import { Injectable } from '@nestjs/common';
import crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { createLogger } from '@krypton/logger';
import { AuditAction } from '@krypton/shared-types';

const logger = createLogger({ serviceName: 'audit-service' });

export interface RecordAuditParams {
  organizationId: string;
  actorId?: string;
  actorType: 'USER' | 'DEVICE' | 'SYSTEM';
  action: AuditAction | string;
  targetType: string;
  targetId?: string;
  sessionId?: string;
  sourceIp?: string;
  userAgent?: string;
  result?: 'SUCCESS' | 'FAILURE' | 'DENIED';
  reason?: string;
  metadata?: Record<string, any>;
}

export interface ChainVerificationResult {
  valid: boolean;
  verifiedCount: number;
  lastEventHash: string | null;
  errorIndex?: number;
  errorMessage?: string;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Appends a tamper-evident chained security audit event to PostgreSQL (Section 18)
   * eventHash = SHA256(canonicalEventPayload + previousEventHash)
   */
  async record(params: RecordAuditParams) {
    try {
      // Ensure zero sensitive credentials in audit metadata (Section 18 & 28)
      const sanitizedMetadata = params.metadata ? { ...params.metadata } : {};
      delete sanitizedMetadata.password;
      delete sanitizedMetadata.passwordHash;
      delete sanitizedMetadata.token;
      delete sanitizedMetadata.refreshToken;
      delete sanitizedMetadata.accessToken;
      delete sanitizedMetadata.privateKey;
      delete sanitizedMetadata.clipboardContent;
      delete sanitizedMetadata.turnSecret;

      // 1. Fetch the latest audit record to get the previous event hash
      const lastRecord = await this.prisma.auditLog.findFirst({
        where: { organizationId: params.organizationId },
        orderBy: { timestamp: 'desc' },
      });

      const lastMetadata = (lastRecord?.metadata as any) || {};
      const previousHash = lastMetadata._chain?.eventHash || 'GENESIS_HASH_KRYPTON_AUDIT_V1';
      const eventTimestamp = new Date();

      // 2. Build canonical payload
      const canonicalPayload = JSON.stringify({
        organizationId: params.organizationId,
        actorId: params.actorId || 'SYSTEM',
        actorType: params.actorType,
        action: params.action,
        targetType: params.targetType,
        targetId: params.targetId || 'NONE',
        result: params.result || 'SUCCESS',
        timestamp: eventTimestamp.toISOString(),
        sanitizedMetadata,
      });

      // 3. Compute Merkle event hash: SHA256(canonicalPayload + previousHash)
      const eventHash = crypto
        .createHash('sha256')
        .update(canonicalPayload + previousHash)
        .digest('hex');

      sanitizedMetadata._chain = {
        previousHash,
        eventHash,
        canonicalPayload,
      };

      const record = await this.prisma.auditLog.create({
        data: {
          organizationId: params.organizationId,
          actorId: params.actorId,
          actorType: params.actorType,
          action: params.action,
          targetType: params.targetType,
          targetId: params.targetId,
          sessionId: params.sessionId,
          sourceIp: params.sourceIp,
          userAgent: params.userAgent,
          result: params.result || 'SUCCESS',
          reason: params.reason,
          metadata: sanitizedMetadata,
          timestamp: eventTimestamp,
        },
      });

      logger.info(
        {
          auditId: record.id,
          action: params.action,
          actorId: params.actorId,
          result: params.result,
          eventHash,
        },
        'Tamper-evident security audit event recorded'
      );

      return record;
    } catch (err) {
      logger.error({ err, params }, 'CRITICAL: Failed to write security audit log');
      throw err;
    }
  }

  /**
   * Cryptographically verifies the tamper-evident hash chain for an organization (Section 18)
   */
  async verifyChain(organizationId: string): Promise<ChainVerificationResult> {
    const logs = await this.prisma.auditLog.findMany({
      where: { organizationId },
      orderBy: { timestamp: 'asc' },
    });

    if (logs.length === 0) {
      return { valid: true, verifiedCount: 0, lastEventHash: null };
    }

    let expectedPreviousHash = 'GENESIS_HASH_KRYPTON_AUDIT_V1';

    for (let i = 0; i < logs.length; i++) {
      const entry = logs[i]!;
      const meta = (entry.metadata as any) || {};
      const chain = meta._chain;

      if (!chain || !chain.eventHash || !chain.previousHash) {
        // Missing chain metadata on this entry
        return {
          valid: false,
          verifiedCount: i,
          lastEventHash: null,
          errorIndex: i,
          errorMessage: `Audit entry ${entry.id} is missing cryptographic chaining metadata.`,
        };
      }

      if (chain.previousHash !== expectedPreviousHash) {
        return {
          valid: false,
          verifiedCount: i,
          lastEventHash: chain.eventHash,
          errorIndex: i,
          errorMessage: `Chain break detected at index ${i}: expected previous hash ${expectedPreviousHash}, found ${chain.previousHash}.`,
        };
      }

      // Recompute hash
      const recomputedHash = crypto
        .createHash('sha256')
        .update(chain.canonicalPayload + chain.previousHash)
        .digest('hex');

      if (recomputedHash !== chain.eventHash) {
        return {
          valid: false,
          verifiedCount: i,
          lastEventHash: chain.eventHash,
          errorIndex: i,
          errorMessage: `Tampered payload detected at index ${i}: hash mismatch.`,
        };
      }

      expectedPreviousHash = chain.eventHash;
    }

    return {
      valid: true,
      verifiedCount: logs.length,
      lastEventHash: expectedPreviousHash,
    };
  }

  async getOrganizationAuditLogs(organizationId: string, limit = 50, offset = 0) {
    return this.prisma.auditLog.findMany({
      where: { organizationId },
      orderBy: { timestamp: 'desc' },
      take: Math.min(limit, 100),
      skip: offset,
    });
  }

  async exportAuditLogs(organizationId: string) {
    const logs = await this.prisma.auditLog.findMany({
      where: { organizationId },
      orderBy: { timestamp: 'asc' },
    });
    const verification = await this.verifyChain(organizationId);

    return {
      organizationId,
      exportedAt: new Date().toISOString(),
      chainVerification: verification,
      recordCount: logs.length,
      records: logs,
    };
  }
}
