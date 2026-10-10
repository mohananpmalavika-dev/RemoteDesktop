import { AuthenticatedSocketContext, SignalingMessageType } from '@krypton/protocol';

export function authorizeSessionMessage(context: AuthenticatedSocketContext, session: any,
  type: SignalingMessageType, guestSessionId?: string): 'viewer' | 'device' {
  if (session.organizationId !== context.tenantId || (guestSessionId && guestSessionId !== session.sessionId)) {
    throw new Error('Session scope mismatch');
  }
  const viewer = context.subjectType === 'USER' && context.subjectId === session.viewerUserId;
  const device = context.subjectType === 'DEVICE' && context.subjectId === session.deviceId;
  if (!viewer && !device) throw new Error('Session membership unauthorized');
  if ([SignalingMessageType.SESSION_ACCEPT, SignalingMessageType.SESSION_REJECT].includes(type)) {
    throw new Error('Consent must be submitted through the signed host API');
  }
  if (type === SignalingMessageType.SESSION_REQUEST && (!viewer || session.state !== 'AUTHORIZING')) throw new Error('Invalid session request');
  if (type === SignalingMessageType.OFFER && !viewer) throw new Error('Only the viewer may offer');
  if (type === SignalingMessageType.ANSWER && !device) throw new Error('Only the host may answer');
  if (![SignalingMessageType.SESSION_REQUEST, SignalingMessageType.SESSION_END].includes(type) &&
      !['SIGNALING', 'ICE_GATHERING', 'CONNECTING', 'CONNECTED', 'DEGRADED', 'RECONNECTING'].includes(session.state)) {
    throw new Error('Host consent is required');
  }
  return viewer ? 'viewer' : 'device';
}
