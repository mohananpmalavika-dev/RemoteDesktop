import { describe, it, expect, vi } from 'vitest';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { DeviceAuthGuard } from '../src/auth/device-auth.guard';
import { AuthGuard } from '../src/auth/auth.guard';
import { SessionsService } from '../src/sessions/sessions.service';

vi.mock('@krypton/config', () => ({ getConfig: () => ({ JWT_ACCESS_SECRET: 'regression-secret-that-is-long-enough' }) }));
const deviceId = crypto.randomUUID(), userId = crypto.randomUUID(), organizationId = crypto.randomUUID();
const context = (req: any) => ({ switchToHttp: () => ({ getRequest: () => req }), getHandler: () => null, getClass: () => null }) as any;
const caps = { screenView: true, control: false, clipboard: false, fileTransfer: false, audioListen: false };

describe('Signed host requests', () => {
  function fixture() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const request: any = { headers: { 'x-device-id': deviceId, 'x-device-timestamp': String(Date.now()),
      'x-device-nonce': crypto.randomBytes(16).toString('hex') }, rawBody: Buffer.from('{"state":"CONNECTED"}'),
      method: 'POST', originalUrl: '/api/v1/sessions/123/host-state', path: '/api/v1/sessions/123/host-state', params: { id: '123' } };
    const payload = `${request.method}\n${request.originalUrl}\n${request.headers['x-device-timestamp']}\n${request.headers['x-device-nonce']}\n${crypto.createHash('sha256').update(request.rawBody).digest('hex')}`;
    request.headers['x-device-signature'] = crypto.sign(null, Buffer.from(payload), privateKey).toString('base64');
    const device = { id: deviceId, organizationId, status: 'ONLINE', isEnrolled: true,
      deviceKeys: [{ publicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') }] };
    const claim = vi.fn().mockResolvedValue('OK');
    const guard = new DeviceAuthGuard({ device: { findUnique: vi.fn().mockResolvedValue(device) } } as any,
      { getClient: () => ({ set: claim }) } as any);
    return { request, device, guard, claim };
  }
  it('accepts a valid signature and consumes its nonce exactly once', async () => {
    const { request, guard, claim } = fixture();
    expect(await guard.canActivate(context(request))).toBe(true);
    expect(request.device).toEqual({ id: deviceId, organizationId });
    claim.mockResolvedValue(null);
    await expect(guard.canActivate(context(request))).rejects.toThrow('signed device');
  });
  it.each(['body', 'route', 'timestamp', 'revoked', 'identity'])('rejects a changed %s before claiming the nonce', async mode => {
    const { request, device, guard, claim } = fixture();
    if (mode === 'body') request.rawBody = Buffer.from('{}');
    if (mode === 'route') request.originalUrl += '/other';
    if (mode === 'timestamp') request.headers['x-device-timestamp'] = String(Date.now() - 61_000);
    if (mode === 'revoked') device.status = 'REVOKED';
    if (mode === 'identity') { request.path = '/api/v1/devices/other/heartbeat'; request.params.id = crypto.randomUUID(); }
    await expect(guard.canActivate(context(request))).rejects.toThrow();
    expect(claim).not.toHaveBeenCalled();
  });
});

describe('Administration access scope', () => {
  const claims = { sub: userId, userId, organizationId, email: 'admin@example.test', tokenUse: 'access',
    familyId: crypto.randomUUID(), mfaVerified: true };
  function fixture(overrides: any = {}) {
    const prisma = { user: { findUnique: vi.fn().mockResolvedValue({ id: userId, organizationId, status: 'ACTIVE' }) },
      refreshToken: { findFirst: vi.fn().mockResolvedValue({}) } };
    const guard = new AuthGuard({ getAllAndOverride: () => false } as any, prisma as any);
    const req: any = { headers: { authorization: `Bearer ${jwt.sign({ ...claims, ...overrides }, 'regression-secret-that-is-long-enough', { expiresIn: '1m' })}` } };
    return { guard, prisma, req };
  }
  it('accepts live access tokens and preserves verified MFA', async () => {
    const { guard, req } = fixture();
    expect(await guard.canActivate(context(req))).toBe(true);
    expect(req.user.mfaVerified).toBe(true);
  });
  it.each(['guest-session', 'mfa'])('rejects %s tokens at protected administration routes', async tokenUse => {
    const { guard, req } = fixture({ tokenUse });
    await expect(guard.canActivate(context(req))).rejects.toThrow('invalid or expired');
  });
  it('rejects a logged-out token family immediately', async () => {
    const { guard, req, prisma } = fixture(); prisma.refreshToken.findFirst.mockResolvedValue(null as any);
    await expect(guard.canActivate(context(req))).rejects.toThrow('invalid or expired');
  });
  it('rejects inactive accounts and tokens for another tenant', async () => {
    const { guard, req, prisma } = fixture(); prisma.user.findUnique.mockResolvedValue({ id: userId, organizationId: crypto.randomUUID(), status: 'ACTIVE' });
    await expect(guard.canActivate(context(req))).rejects.toThrow('invalid or expired');
  });
});

describe('Authoritative host consent', () => {
  function fixture() {
    const session = { id: crypto.randomUUID(), deviceId, viewerUserId: userId, state: 'AUTHORIZING', createdAt: new Date(),
      device: { organizationId }, capabilities: { ...caps } };
    const prisma: any = { $queryRaw: vi.fn(), remoteSession: { findUnique: vi.fn().mockResolvedValue(session), update: vi.fn(), count: vi.fn().mockResolvedValue(0) } };
    prisma.$transaction = vi.fn((callback: any) => callback(prisma));
    const client = { get: vi.fn().mockResolvedValue(JSON.stringify({ state: 'AUTHORIZING', policy: {} })),
      setex: vi.fn(), eval: vi.fn().mockResolvedValue(1), publish: vi.fn() };
    const service = new SessionsService(prisma as any, { getClient: () => client } as any,
      { record: vi.fn() } as any, {} as any, { generateIceConfiguration: () => ({ iceServers: [] }) } as any, {} as any);
    return { session, prisma, client, service };
  }
  it.each(['wrong-host', 'upgrade-control', 'expired', 'missing-cache'])('rejects %s consent without updating the database', async mode => {
    const { session, prisma, client, service } = fixture();
    if (mode === 'expired') session.createdAt = new Date(Date.now() - 301_000);
    if (mode === 'missing-cache') client.get.mockResolvedValue(null as any);
    await expect(service.acceptSession(session.id, { ...caps, control: mode === 'upgrade-control' },
      mode === 'wrong-host' ? crypto.randomUUID() : deviceId)).rejects.toThrow();
    expect(prisma.remoteSession.update).not.toHaveBeenCalled();
  });
  it('persists the capability reduction before dispatching consent with the correct routing keys', async () => {
    const { session, prisma, client, service } = fixture();
    prisma.remoteSession.update.mockResolvedValue({ state: 'SIGNALING', capabilities: caps });
    await service.acceptSession(session.id, caps, deviceId);
    expect(prisma.remoteSession.update.mock.calls[0][0].where).toEqual({ id: session.id, state: 'AUTHORIZING' });
    expect(JSON.parse(client.publish.mock.calls[0][1])).toMatchObject({ targetTenantId: organizationId,
      targetSubjectId: userId, message: { type: 'SESSION_ACCEPT', payload: { acceptedCapabilities: caps } } });
  });
  it('does not resurrect a session after its Redis authorization expires', async () => {
    const { session, prisma, client, service } = fixture(); session.state = 'CONNECTED'; client.get.mockResolvedValue(null as any);
    await expect(service.updateHostState(session.id, deviceId, { state: 'CONNECTED' })).rejects.toThrow('expired');
    expect(prisma.remoteSession.update).not.toHaveBeenCalled();
  });
  it('rejects consent if another session already owns the host', async () => {
    const { session, prisma, service } = fixture(); prisma.remoteSession.count.mockResolvedValue(1);
    await expect(service.acceptSession(session.id, caps, deviceId)).rejects.toThrow('active session');
    expect(prisma.remoteSession.update).not.toHaveBeenCalled();
  });
});
