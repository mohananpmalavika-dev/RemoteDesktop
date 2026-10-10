/**
 * Enterprise Admin API Client for KryptonRemote Control Plane
 */

export const API_BASE = import.meta.env.VITE_API_URL || '/api/v1';

export function getAuthToken(): string | null {
  return localStorage.getItem('krypton_admin_token') || sessionStorage.getItem('krypton_admin_token');
}

export function setAuthToken(token: string, persist = false) {
  localStorage.removeItem('krypton_admin_token'); sessionStorage.removeItem('krypton_admin_token');
  (persist ? localStorage : sessionStorage).setItem('krypton_admin_token', token);
}
export function clearAuth() {
  for (const storage of [localStorage, sessionStorage]) { storage.removeItem('krypton_admin_token'); storage.removeItem('krypton_refresh_token'); }
  window.dispatchEvent(new Event('krypton:auth-changed'));
}
export function saveTokens(tokens: { accessToken: string; refreshToken: string }, persist = false) {
  for (const storage of [localStorage, sessionStorage]) { storage.removeItem('krypton_admin_token'); storage.removeItem('krypton_refresh_token'); }
  setAuthToken(tokens.accessToken, persist);
  (persist ? localStorage : sessionStorage).setItem('krypton_refresh_token', tokens.refreshToken);
}
let refreshing: Promise<boolean> | null = null;
async function refreshAccess(): Promise<boolean> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const persist = !!localStorage.getItem('krypton_refresh_token');
    const token = localStorage.getItem('krypton_refresh_token') || sessionStorage.getItem('krypton_refresh_token');
    if (!token) return false;
    const response = await fetch(`${API_BASE}/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: token }) });
    if (!response.ok) return false;
    saveTokens(await response.json(), persist); return true;
  })().catch(() => false);
  try { return await refreshing; } finally { refreshing = null; }
}

export async function apiRequest<T>(endpoint: string, options: RequestInit = {}, retried = false): Promise<T> {
  const token = getAuthToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const url = `${API_BASE}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (response.status === 401 && !endpoint.startsWith('/auth/') && !retried) {
    if (await refreshAccess()) return apiRequest<T>(endpoint, options, true);
    clearAuth();
  }
  if (!response.ok) {
    let errorBody: any;
    try {
      errorBody = await response.json();
    } catch {
      errorBody = { message: response.statusText };
    }
    const err = new Error(errorBody.message || `API request failed with status ${response.status}`);
    (err as any).status = response.status;
    (err as any).details = errorBody;
    throw err;
  }

  return response.json();
}

export interface ActiveSessionDto {
  id: string;
  technicianEmail: string;
  hostDeviceName: string;
  hostRemoteId: string;
  route: 'DIRECT_P2P' | 'TURN_RELAY';
  startedAt: string;
  duration: string;
  capabilities: {
    screen: boolean;
    control: boolean;
    clipboard: boolean;
    fileTransfer: boolean;
  };
  metrics: {
    fps: number | null;
    bitrateMbps: number | null;
    rttMs: number | null;
    packetLossPercent: number | null;
  };
}

export interface AuditRecordDto {
  id: string;
  timestamp: string;
  actorType: 'USER' | 'DEVICE' | 'SYSTEM';
  actorId: string;
  actorEmail?: string;
  action: string;
  targetType: string;
  targetId: string;
  sourceIp: string;
  result: 'SUCCESS' | 'FAILURE' | 'DENIED';
  metadata: Record<string, any>;
}

export interface ChainVerificationResultDto {
  valid: boolean;
  verifiedCount: number;
  lastEventHash: string | null;
  errorIndex?: number;
  errorMessage?: string;
}

export interface DeviceRecordDto {
  id: string;
  remoteId: string;
  deviceName: string;
  hostname: string;
  os: string;
  osVersion: string;
  architecture: string;
  agentVersion: string;
  status: 'ONLINE' | 'DEGRADED' | 'OFFLINE' | 'REVOKED';
  lastHeartbeat: string;
  cpuPercent: number | null;
  memoryPercent: number | null;
  sessionCount: number;
  policyName: string;
}

export interface TenantPolicyDto {
  requireMfa: boolean;
  enforceConsent: boolean;
  idleTimeoutMin: number;
  clipboardPolicy: 'BIDIRECTIONAL' | 'CLIENT_TO_HOST' | 'DISABLED';
  maxFileMb: number;
  sessionRecording: boolean;
}

export interface CurrentUser { id: string; email: string; username: string; mfaEnabled: boolean; organization: { id: string; name: string }; permissions: string[] }
export const adminApi = {
  login: (identifier: string, password: string) => apiRequest<any>('/auth/login', { method: 'POST', body: JSON.stringify({ username: identifier, password }) }),
  verifyMfa: (mfaToken: string, code: string) => apiRequest<any>('/auth/mfa/verify', { method: 'POST', body: JSON.stringify({ mfaToken, code }) }),
  register: (body: object) => apiRequest<any>('/auth/register', { method: 'POST', body: JSON.stringify(body) }),
  me: () => apiRequest<CurrentUser>('/auth/me'),
  setupMfa: () => apiRequest<{ secret: string; otpAuthUrl: string }>('/auth/mfa/setup', { method: 'POST', body: '{}' }),
  activateMfa: (secret: string, code: string) => apiRequest<any>('/auth/mfa/activate', { method: 'POST', body: JSON.stringify({ secret, code }) }),
  logout: async () => {
    const refreshToken = localStorage.getItem('krypton_refresh_token') || sessionStorage.getItem('krypton_refresh_token');
    try { if (refreshToken) await apiRequest('/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken }) }); } finally { clearAuth(); }
  },
  // Health
  checkHealth: async () => {
    return apiRequest<{ status: string; dependencies?: Record<string, string> }>('/health/ready');
  },

  // Sessions
  getActiveSessions: async (): Promise<ActiveSessionDto[]> => {
    return apiRequest<ActiveSessionDto[]>('/sessions/active');
  },

  terminateSession: async (sessionId: string, reason: string): Promise<{ success: boolean; terminatedSessionId: string }> => {
    return apiRequest<{ success: boolean; terminatedSessionId: string }>(`/sessions/${sessionId}/terminate`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },

  // Audit Logs
  getAuditLogs: async (limit = 50, offset = 0): Promise<AuditRecordDto[]> => {
    return apiRequest<AuditRecordDto[]>(`/audit/logs?limit=${limit}&offset=${offset}`);
  },

  verifyAuditChain: async (): Promise<ChainVerificationResultDto> => {
    return apiRequest<ChainVerificationResultDto>('/audit/verify');
  },

  exportAuditLogs: async () => {
    return apiRequest<any>('/audit/export');
  },

  // Devices
  getDevices: async (limit = 50, offset = 0): Promise<DeviceRecordDto[]> => {
    return apiRequest<DeviceRecordDto[]>(`/devices?limit=${limit}&offset=${offset}`);
  },

  createEnrollmentToken: async (expiresInHours = 24): Promise<{ token: string; expiresAt: string }> => {
    return apiRequest<{ token: string; expiresAt: string }>('/devices/enrollment-tokens', {
      method: 'POST',
      body: JSON.stringify({ expiresInHours }),
    });
  },

  revokeDevice: async (deviceId: string): Promise<{ success: boolean; deviceId: string }> => {
    return apiRequest<{ success: boolean; deviceId: string }>(`/devices/${deviceId}/revoke`, {
      method: 'POST',
    });
  },

  // Policies
  getPolicies: async (): Promise<TenantPolicyDto> => {
    return apiRequest<TenantPolicyDto>('/policies');
  },

  updatePolicies: async (policies: Partial<TenantPolicyDto>): Promise<TenantPolicyDto> => {
    return apiRequest<TenantPolicyDto>('/policies', {
      method: 'PUT',
      body: JSON.stringify(policies),
    });
  },
};
