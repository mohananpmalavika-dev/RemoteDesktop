import { describe, it, expect } from 'vitest';
import { authorizeSessionMessage } from '../src/authorization';
import { SignalingMessageType as Type, AccessClaimsSchema } from '@krypton/protocol';

const session = { sessionId: 'session-a', organizationId: 'tenant-a', viewerUserId: 'user-a', deviceId: 'device-a', state: 'SIGNALING' };
const context = { tenantId: 'tenant-a', subjectId: 'user-a', subjectType: 'USER' as const, socketId: 'socket-a', authenticatedAt: new Date(), sessionIds: new Set<string>() };

describe('Signaling authorization uses authoritative membership and consent', () => {
  it('allows a member offer after approval', () => expect(authorizeSessionMessage(context, session, Type.OFFER)).toBe('viewer'));
  it.each([
    [{ ...context, tenantId: 'tenant-b' }, session, Type.OFFER, undefined],
    [{ ...context, subjectId: 'user-b' }, session, Type.OFFER, undefined],
    [context, session, Type.OFFER, 'different-session'],
    [context, { ...session, state: 'AUTHORIZING' }, Type.OFFER, undefined],
    [context, session, Type.SESSION_ACCEPT, undefined],
    [context, session, Type.ANSWER, undefined],
    [{ ...context, subjectType: 'DEVICE', subjectId: 'user-a' }, session, Type.OFFER, undefined],
  ])('rejects invalid tenant, member, role, guest scope, or consent', (ctx, record, type, guestScope) => {
    expect(() => authorizeSessionMessage(ctx as any, record, type as Type, guestScope as any)).toThrow();
  });
  it('rejects MFA and guest credentials as administration access tokens', () => {
    expect(AccessClaimsSchema.safeParse({ userId: 'user-a', mfaPending: true }).success).toBe(false);
    expect(AccessClaimsSchema.safeParse({ sub: 'user-a', tokenUse: 'guest-session', organizationId: 'tenant-a', sessionId: 'session-a' }).success).toBe(false);
  });
});
