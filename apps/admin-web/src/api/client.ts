/**
 * Enterprise Admin API Client for KryptonRemote Control Plane
 */

const API_BASE = import.meta.env.VITE_API_URL || '/api/v1';

export function getAuthToken(): string | null {
  return localStorage.getItem('krypton_admin_token') || sessionStorage.getItem('krypton_admin_token');
}

export function setAuthToken(token: string, persist = true) {
  if (persist) {
    localStorage.setItem('krypton_admin_token', token);
  } else {
    sessionStorage.setItem('krypton_admin_token', token);
  }
}

async function apiRequest<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
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
    fps: number;
    bitrateMbps: number;
    rttMs: number;
    packetLossPercent: number;
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
  status: 'ONLINE' | 'DEGRADED' | 'OFFLINE';
  lastHeartbeat: string;
  cpuPercent: number;
  memoryPercent: number;
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

export const adminApi = {
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

  updatePolicies: async (policies: Partial<TenantPolicyDto>): Promise<{ success: boolean; policies: TenantPolicyDto }> => {
    return apiRequest<{ success: boolean; policies: TenantPolicyDto }>('/policies', {
      method: 'PUT',
      body: JSON.stringify(policies),
    });
  },
};
