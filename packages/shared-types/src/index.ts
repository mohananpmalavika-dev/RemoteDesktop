/**
 * Standard Error Model (Section 38)
 */
export interface KryptonApiError {
  code: string;
  message: string;
  requestId: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

/**
 * Standard RBAC Permissions (Section 9)
 */
export enum KryptonPermission {
  REMOTE_SESSION_CREATE = 'remote.session.create',
  REMOTE_SCREEN_VIEW = 'remote.screen.view',
  REMOTE_CONTROL = 'remote.control',
  REMOTE_CLIPBOARD_READ = 'remote.clipboard.read',
  REMOTE_CLIPBOARD_WRITE = 'remote.clipboard.write',
  REMOTE_FILE_UPLOAD = 'remote.file.upload',
  REMOTE_FILE_DOWNLOAD = 'remote.file.download',
  REMOTE_AUDIO_LISTEN = 'remote.audio.listen',
  REMOTE_UNATTENDED_CONNECT = 'remote.unattended.connect',
  REMOTE_SESSION_RECORD = 'remote.session.record',
  REMOTE_SESSION_TERMINATE = 'remote.session.terminate',
  
  DEVICE_VIEW = 'device.view',
  DEVICE_ENROLL = 'device.enroll',
  DEVICE_REVOKE = 'device.revoke',
  DEVICE_RENAME = 'device.rename',
  
  POLICY_VIEW = 'policy.view',
  POLICY_MANAGE = 'policy.manage',
  
  USER_VIEW = 'user.view',
  USER_MANAGE = 'user.manage',
  
  AUDIT_VIEW = 'audit.view',
  AUDIT_EXPORT = 'audit.export',
  ADMIN_SYSTEM = 'admin.system',
}

/**
 * Canonical System Roles
 */
export enum SystemRole {
  SYSTEM_ADMINISTRATOR = 'System Administrator',
  ORGANIZATION_ADMINISTRATOR = 'Organization Administrator',
  IT_ADMINISTRATOR = 'IT Administrator',
  TECHNICIAN = 'Technician',
  AUDITOR = 'Auditor',
  READ_ONLY_OPERATOR = 'Read-only Operator',
}

/**
 * Device Presence & Telemetry (Section 22)
 */
export interface DeviceHeartbeat {
  deviceId: string;
  timestamp: string;
  agentVersion: string;
  os: string;
  osVersion: string;
  architecture: string;
  currentUser?: string;
  sessionCount: number;
  cpuPercent: number;
  memoryPercent: number;
  uptimeSeconds: number;
}

export enum DeviceStatus {
  ONLINE = 'ONLINE',
  DEGRADED = 'DEGRADED',
  OFFLINE = 'OFFLINE',
  REVOKED = 'REVOKED',
}

/**
 * Remote Session State Machine (Section 21)
 */
export enum SessionState {
  DISCONNECTED = 'DISCONNECTED',
  AUTHORIZING = 'AUTHORIZING',
  SIGNALING = 'SIGNALING',
  ICE_GATHERING = 'ICE_GATHERING',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  DEGRADED = 'DEGRADED',
  RECONNECTING = 'RECONNECTING',
  REJECTED = 'REJECTED',
  EXPIRED = 'EXPIRED',
  FAILED = 'FAILED',
  ENDED = 'ENDED',
}

/**
 * Session Capabilities (Section 10)
 */
export interface SessionCapabilities {
  screenView: boolean;
  control: boolean;
  clipboard: boolean;
  fileTransfer: boolean;
  audioListen: boolean;
}

/**
 * Audit Log Actions (Section 28)
 */
export enum AuditAction {
  USER_LOGIN = 'USER_LOGIN',
  USER_LOGIN_FAILED = 'USER_LOGIN_FAILED',
  MFA_SUCCESS = 'MFA_SUCCESS',
  MFA_FAILED = 'MFA_FAILED',
  DEVICE_ENROLLED = 'DEVICE_ENROLLED',
  DEVICE_REVOKED = 'DEVICE_REVOKED',
  DEVICE_RENAMED = 'DEVICE_RENAMED',
  REMOTE_SESSION_REQUESTED = 'REMOTE_SESSION_REQUESTED',
  REMOTE_SESSION_ACCEPTED = 'REMOTE_SESSION_ACCEPTED',
  REMOTE_SESSION_REJECTED = 'REMOTE_SESSION_REJECTED',
  REMOTE_SESSION_STARTED = 'REMOTE_SESSION_STARTED',
  REMOTE_SESSION_ENDED = 'REMOTE_SESSION_ENDED',
  FILE_TRANSFER_STARTED = 'FILE_TRANSFER_STARTED',
  FILE_TRANSFER_COMPLETED = 'FILE_TRANSFER_COMPLETED',
  FILE_TRANSFER_FAILED = 'FILE_TRANSFER_FAILED',
  POLICY_CHANGED = 'POLICY_CHANGED',
  ROLE_CHANGED = 'ROLE_CHANGED',
}

/**
 * Normalized Input Coordinates (Section 16)
 */
export interface NormalizedCoordinates {
  x: number; // 0.0 - 1.0 (relative to display width)
  y: number; // 0.0 - 1.0 (relative to display height)
  monitorIndex?: number;
}
