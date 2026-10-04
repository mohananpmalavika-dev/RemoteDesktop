import { describe, it, expect, vi } from 'vitest';
import { AuditService } from '../src/audit/audit.service';
import { AuditController } from '../src/audit/audit.controller';
import { KryptonPermission } from '@krypton/shared-types';

describe('Phase 7: Enterprise Audit Log Mechanics & Gated Endpoint', () => {
  it('Sanitizes sensitive credentials from audit metadata (Section 28)', async () => {
    const mockPrisma = {
      auditLog: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(async ({ data }) => ({
          id: 'audit-log-uuid-1',
          ...data,
          timestamp: new Date(),
        })),
      },
    };

    const service = new AuditService(mockPrisma as any);

    const sensitiveMetadata = {
      password: 'SuperSecretPassword!',
      passwordHash: '$argon2id$v=19$m=65536...',
      token: 'jwt.token.here',
      refreshToken: 'refresh-family-id',
      accessToken: 'access-token-123',
      privateKey: '-----BEGIN PRIVATE KEY-----',
      clipboardContent: 'confidential payroll document text',
      clientVersion: '1.0.0',
      os: 'Windows 11',
    };

    const record = await service.record({
      organizationId: 'org-123',
      actorId: 'user-456',
      actorType: 'USER',
      action: 'DEVICE_CONNECT',
      targetType: 'DEVICE',
      targetId: 'dev-789',
      metadata: sensitiveMetadata,
    });

    expect(record).toBeDefined();
    expect(mockPrisma.auditLog.create).toHaveBeenCalledOnce();

    const createdData = mockPrisma.auditLog.create.mock.calls[0][0].data;
    // Verify all sensitive keys were strictly purged
    expect(createdData.metadata.password).toBeUndefined();
    expect(createdData.metadata.passwordHash).toBeUndefined();
    expect(createdData.metadata.token).toBeUndefined();
    expect(createdData.metadata.refreshToken).toBeUndefined();
    expect(createdData.metadata.accessToken).toBeUndefined();
    expect(createdData.metadata.privateKey).toBeUndefined();
    expect(createdData.metadata.clipboardContent).toBeUndefined();

    // Verify safe non-sensitive attributes were preserved
    expect(createdData.metadata.clientVersion).toBe('1.0.0');
    expect(createdData.metadata.os).toBe('Windows 11');
  });

  it('Exposes paginated audit log queries bounded to caller organization', async () => {
    const mockPrisma = {
      auditLog: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'audit-1',
            organizationId: 'org-123',
            action: 'SESSION_START',
            actorType: 'USER',
            timestamp: new Date(),
          },
          {
            id: 'audit-2',
            organizationId: 'org-123',
            action: 'FILE_TRANSFER_START',
            actorType: 'USER',
            timestamp: new Date(),
          },
        ]),
      },
    };

    const service = new AuditService(mockPrisma as any);
    const controller = new AuditController(service);

    const user = {
      id: 'user-admin',
      organizationId: 'org-123',
      role: 'ORGANIZATION_ADMINISTRATOR',
    };

    const logs = await controller.getAuditLogs(user, '20', '0');

    expect(logs).toHaveLength(2);
    expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-123' },
      orderBy: { timestamp: 'desc' },
      take: 20,
      skip: 0,
    });
  });

  it('Verifies AUDIT_VIEW permission constant binding', () => {
    expect(KryptonPermission.AUDIT_VIEW).toBe('audit.view');
  });

  it('Generates tamper-evident hash chain and verifies valid audit trail', async () => {
    const logs: any[] = [];
    const mockPrisma = {
      auditLog: {
        findFirst: vi.fn().mockImplementation(async () => {
          return logs.length > 0 ? logs[logs.length - 1] : null;
        }),
        create: vi.fn().mockImplementation(async ({ data }) => {
          const item = {
            id: `audit-${logs.length + 1}`,
            ...data,
            timestamp: new Date(Date.now() + logs.length * 1000),
          };
          logs.push(item);
          return item;
        }),
        findMany: vi.fn().mockImplementation(async () => {
          return [...logs].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
        }),
      },
    };

    const service = new AuditService(mockPrisma as any);

    // Record two chained events
    const event1 = await service.record({
      organizationId: 'org-123',
      actorId: 'user-1',
      actorType: 'USER',
      action: 'DEVICE_CONNECT',
      targetType: 'DEVICE',
      targetId: 'dev-1',
    });

    const event2 = await service.record({
      organizationId: 'org-123',
      actorId: 'user-1',
      actorType: 'USER',
      action: 'FILE_TRANSFER_START',
      targetType: 'DEVICE',
      targetId: 'dev-1',
    });

    expect(event1.metadata._chain).toBeDefined();
    expect(event1.metadata._chain.previousHash).toBe('GENESIS_HASH_KRYPTON_AUDIT_V1');
    expect(event2.metadata._chain.previousHash).toBe(event1.metadata._chain.eventHash);

    const verification = await service.verifyChain('org-123');
    expect(verification.valid).toBe(true);
    expect(verification.verifiedCount).toBe(2);

    // Now simulate tampering with event 1's payload
    event1.metadata._chain.canonicalPayload = 'tampered-payload';
    const tamperedVerification = await service.verifyChain('org-123');
    expect(tamperedVerification.valid).toBe(false);
    expect(tamperedVerification.errorIndex).toBe(0);
    expect(tamperedVerification.errorMessage).toContain('Tampered payload detected');
  });
});

