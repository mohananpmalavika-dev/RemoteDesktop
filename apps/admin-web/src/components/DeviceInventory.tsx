import React, { useState, useEffect, useCallback } from 'react';
import {
  Laptop,
  Server,
  Plus,
  RefreshCw,
  Search,
  CheckCircle,
  AlertTriangle,
  XCircle,
  Key,
  Shield,
  Trash2,
  ExternalLink,
  Copy,
  Check,
  AlertCircle
} from 'lucide-react';
import { adminApi, DeviceRecordDto } from '../api/client';

export type DeviceRecord = DeviceRecordDto;

export const DeviceInventory: React.FC = () => {
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState<string>('ALL');
  const [showEnrollModal, setShowEnrollModal] = useState(false);
  const [enrollHours, setEnrollHours] = useState(24);
  const [generatedToken, setGeneratedToken] = useState<string | null>(null);
  const [generatingToken, setGeneratingToken] = useState(false);
  const [copied, setCopied] = useState(false);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const fetchDevices = useCallback(async () => {
    try {
      setError(null);
      const data = await adminApi.getDevices(100, 0);
      setDevices(data);
    } catch (err: any) {
      console.warn('Failed to load fleet devices:', err);
      setError(err.message || 'Failed to retrieve enrolled device fleet from control plane.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDevices();
    const interval = setInterval(fetchDevices, 10000);
    return () => clearInterval(interval);
  }, [fetchDevices]);

  const filteredDevices = devices.filter((dev) => {
    const matchesSearch =
      dev.deviceName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (dev.remoteId && dev.remoteId.includes(searchTerm)) ||
      (dev.hostname && dev.hostname.toLowerCase().includes(searchTerm.toLowerCase()));
    const matchesStatus = filterStatus === 'ALL' || dev.status === filterStatus;
    return matchesSearch && matchesStatus;
  });

  const handleGenerateEnrollment = async () => {
    setGeneratingToken(true);
    try {
      const res = await adminApi.createEnrollmentToken(enrollHours);
      setGeneratedToken(res.token);
      setCopied(false);
    } catch (err: any) {
      setActionNotice(`Failed to issue enrollment token: ${err.message}`);
    } finally {
      setGeneratingToken(false);
    }
  };

  const handleRevokeDevice = async (deviceId: string, name: string) => {
    if (confirm(`Are you sure you want to revoke enrollment for device "${name}"? Its Ed25519 identity key will be permanently invalidated in the control plane.`)) {
      try {
        await adminApi.revokeDevice(deviceId);
        setDevices((prev) => prev.filter((d) => d.id !== deviceId));
        setActionNotice(`Device "${name}" key revoked and disconnected from fleet.`);
        setTimeout(() => setActionNotice(null), 5000);
      } catch (err: any) {
        setActionNotice(`Failed to revoke device: ${err.message}`);
      }
    }
  };

  const handleCopyToken = () => {
    if (generatedToken) {
      navigator.clipboard.writeText(generatedToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* Top Banner Notice */}
      {actionNotice && (
        <div
          style={{
            padding: '12px 16px',
            borderRadius: '8px',
            backgroundColor: 'rgba(239, 68, 68, 0.15)',
            border: '1px solid rgba(239, 68, 68, 0.4)',
            color: '#fca5a5',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            fontSize: '14px',
          }}
        >
          <AlertTriangle size={18} />
          {actionNotice}
        </div>
      )}

      {error && (
        <div
          style={{
            padding: '12px 16px',
            borderRadius: '8px',
            backgroundColor: 'rgba(245, 158, 11, 0.15)',
            border: '1px solid rgba(245, 158, 11, 0.4)',
            color: '#fbbf24',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            fontSize: '14px',
          }}
        >
          <AlertCircle size={18} />
          {error}
        </div>
      )}

      {/* Header Controls */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '16px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div
            style={{
              position: 'relative',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <Search
              size={16}
              style={{
                position: 'absolute',
                left: '12px',
                color: '#64748b',
              }}
            />
            <input
              type="text"
              placeholder="Search Remote ID, device, hostname..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              style={{
                padding: '9px 12px 9px 36px',
                width: '320px',
                backgroundColor: '#0d121c',
                border: '1px solid #1e2c42',
                borderRadius: '8px',
                color: '#f1f5f9',
                fontSize: '14px',
                outline: 'none',
              }}
            />
          </div>

          <div style={{ display: 'flex', gap: '6px' }}>
            {['ALL', 'ONLINE', 'DEGRADED', 'OFFLINE'].map((status) => (
              <button
                key={status}
                onClick={() => setFilterStatus(status)}
                style={{
                  padding: '7px 14px',
                  borderRadius: '6px',
                  fontSize: '12px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  border:
                    filterStatus === status
                      ? '1px solid #3b82f6'
                      : '1px solid #1e2c42',
                  backgroundColor:
                    filterStatus === status ? '#1e3a8a' : '#0d121c',
                  color: filterStatus === status ? '#93c5fd' : '#94a3b8',
                }}
              >
                {status}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            onClick={() => {
              setLoading(true);
              fetchDevices();
            }}
            disabled={loading}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '9px 14px',
              borderRadius: '8px',
              backgroundColor: '#131b2a',
              border: '1px solid #1e2c42',
              color: '#94a3b8',
              fontSize: '13px',
              fontWeight: 500,
              cursor: loading ? 'wait' : 'pointer',
            }}
          >
            <RefreshCw size={15} className={loading ? 'spin' : ''} />
            Refresh Telemetry
          </button>

          <button
            onClick={() => {
              setShowEnrollModal(true);
              handleGenerateEnrollment();
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '9px 16px',
              borderRadius: '8px',
              backgroundColor: '#2563eb',
              border: 'none',
              color: '#ffffff',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
              boxShadow: '0 2px 10px rgba(37, 99, 235, 0.3)',
            }}
          >
            <Plus size={16} />
            Enroll New Device
          </button>
        </div>
      </div>

      {/* Fleet Summary Pills */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: '14px',
        }}
      >
        <div
          className="glass-panel"
          style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', gap: '14px' }}
        >
          <div
            style={{
              width: '42px',
              height: '42px',
              borderRadius: '10px',
              backgroundColor: 'rgba(59, 130, 246, 0.15)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#60a5fa',
            }}
          >
            <Laptop size={22} />
          </div>
          <div>
            <div style={{ fontSize: '12px', color: '#94a3b8', fontWeight: 500 }}>Total Fleet</div>
            <div style={{ fontSize: '22px', fontWeight: 700, color: '#f8fafc' }}>
              {devices.length}
            </div>
          </div>
        </div>

        <div
          className="glass-panel"
          style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', gap: '14px' }}
        >
          <div
            style={{
              width: '42px',
              height: '42px',
              borderRadius: '10px',
              backgroundColor: 'rgba(16, 185, 129, 0.15)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#34d399',
            }}
          >
            <CheckCircle size={22} />
          </div>
          <div>
            <div style={{ fontSize: '12px', color: '#94a3b8', fontWeight: 500 }}>Online Active</div>
            <div style={{ fontSize: '22px', fontWeight: 700, color: '#34d399' }}>
              {devices.filter((d) => d.status === 'ONLINE').length}
            </div>
          </div>
        </div>

        <div
          className="glass-panel"
          style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', gap: '14px' }}
        >
          <div
            style={{
              width: '42px',
              height: '42px',
              borderRadius: '10px',
              backgroundColor: 'rgba(245, 158, 11, 0.15)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fbbf24',
            }}
          >
            <AlertTriangle size={22} />
          </div>
          <div>
            <div style={{ fontSize: '12px', color: '#94a3b8', fontWeight: 500 }}>Degraded (High Load)</div>
            <div style={{ fontSize: '22px', fontWeight: 700, color: '#fbbf24' }}>
              {devices.filter((d) => d.status === 'DEGRADED').length}
            </div>
          </div>
        </div>

        <div
          className="glass-panel"
          style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', gap: '14px' }}
        >
          <div
            style={{
              width: '42px',
              height: '42px',
              borderRadius: '10px',
              backgroundColor: 'rgba(148, 163, 184, 0.12)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#94a3b8',
            }}
          >
            <XCircle size={22} />
          </div>
          <div>
            <div style={{ fontSize: '12px', color: '#94a3b8', fontWeight: 500 }}>Offline</div>
            <div style={{ fontSize: '22px', fontWeight: 700, color: '#94a3b8' }}>
              {devices.filter((d) => d.status === 'OFFLINE').length}
            </div>
          </div>
        </div>
      </div>

      {/* Empty State */}
      {!loading && filteredDevices.length === 0 && (
        <div
          className="glass-panel"
          style={{
            padding: '48px 24px',
            textAlign: 'center',
            border: '1px dashed #1e2c42',
            borderRadius: '12px',
          }}
        >
          <Laptop size={36} color="#64748b" style={{ margin: '0 auto 12px auto' }} />
          <h3 style={{ fontSize: '16px', fontWeight: 600, color: '#cbd5e1', marginBottom: '6px' }}>
            No Enrolled Devices Found
          </h3>
          <p style={{ fontSize: '13px', color: '#64748b', maxWidth: '420px', margin: '0 auto 18px auto' }}>
            There are currently no Windows endpoints enrolled in this tenant. Generate an enrollment token to onboard machines.
          </p>
          <button
            onClick={() => {
              setShowEnrollModal(true);
              handleGenerateEnrollment();
            }}
            style={{
              padding: '8px 16px',
              backgroundColor: '#2563eb',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              fontSize: '13px',
              cursor: 'pointer',
            }}
          >
            Enroll First Device
          </button>
        </div>
      )}

      {/* Device Table */}
      {filteredDevices.length > 0 && (
        <div className="glass-panel" style={{ overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
            <thead>
              <tr
                style={{
                  borderBottom: '1px solid #1e2c42',
                  backgroundColor: 'rgba(13, 18, 28, 0.6)',
                  fontSize: '12px',
                  textTransform: 'uppercase',
                  color: '#64748b',
                  letterSpacing: '0.05em',
                }}
              >
                <th style={{ padding: '14px 18px' }}>Device & Hostname</th>
                <th style={{ padding: '14px 18px' }}>Remote ID</th>
                <th style={{ padding: '14px 18px' }}>Status & Presence</th>
                <th style={{ padding: '14px 18px' }}>Hardware / OS</th>
                <th style={{ padding: '14px 18px' }}>Telemetry (CPU/RAM)</th>
                <th style={{ padding: '14px 18px' }}>Security Policy</th>
                <th style={{ padding: '14px 18px', textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredDevices.map((device) => {
                const statusColor =
                  device.status === 'ONLINE'
                    ? '#10b981'
                    : device.status === 'DEGRADED'
                    ? '#f59e0b'
                    : '#64748b';

                return (
                  <tr
                    key={device.id}
                    style={{
                      borderBottom: '1px solid #1a2538',
                      transition: 'background-color 0.15s ease',
                    }}
                    onMouseEnter={(e) =>
                      (e.currentTarget.style.backgroundColor = 'rgba(30, 44, 66, 0.4)')
                    }
                    onMouseLeave={(e) =>
                      (e.currentTarget.style.backgroundColor = 'transparent')
                    }
                  >
                    <td style={{ padding: '14px 18px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <Server size={18} color="#60a5fa" />
                        <div>
                          <div style={{ fontWeight: 600, color: '#f1f5f9', fontSize: '14px' }}>
                            {device.deviceName}
                          </div>
                          <div style={{ fontSize: '12px', color: '#64748b' }}>
                            {device.hostname}
                          </div>
                        </div>
                      </div>
                    </td>

                    <td style={{ padding: '14px 18px' }}>
                      <span
                        style={{
                          fontFamily: 'JetBrains Mono, monospace',
                          fontWeight: 600,
                          backgroundColor: '#0a0e17',
                          padding: '4px 8px',
                          borderRadius: '6px',
                          border: '1px solid #1e2c42',
                          color: '#38bdf8',
                          fontSize: '13px',
                        }}
                      >
                        {device.remoteId}
                      </span>
                    </td>

                    <td style={{ padding: '14px 18px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span
                          className={device.status === 'ONLINE' ? 'pulse-online' : ''}
                          style={{
                            width: '9px',
                            height: '9px',
                            borderRadius: '50%',
                            backgroundColor: statusColor,
                            display: 'inline-block',
                          }}
                        />
                        <span
                          style={{
                            fontSize: '13px',
                            fontWeight: 600,
                            color: statusColor,
                          }}
                        >
                          {device.status}
                        </span>
                        <span style={{ fontSize: '11px', color: '#64748b' }}>
                          ({device.lastHeartbeat})
                        </span>
                      </div>
                    </td>

                    <td style={{ padding: '14px 18px' }}>
                      <div style={{ fontSize: '13px', color: '#cbd5e1' }}>{device.os}</div>
                      <div style={{ fontSize: '11px', color: '#64748b' }}>
                        {device.architecture} • Agent v{device.agentVersion}
                      </div>
                    </td>

                    <td style={{ padding: '14px 18px' }}>
                      {device.status !== 'OFFLINE' ? (
                        <div style={{ width: '120px' }}>
                          <div
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              fontSize: '11px',
                              color: '#94a3b8',
                              marginBottom: '3px',
                            }}
                          >
                            <span>CPU: {device.cpuPercent}%</span>
                            <span>RAM: {device.memoryPercent}%</span>
                          </div>
                          <div
                            style={{
                              height: '4px',
                              backgroundColor: '#1e293b',
                              borderRadius: '2px',
                              overflow: 'hidden',
                            }}
                          >
                            <div
                              style={{
                                width: `${device.cpuPercent}%`,
                                height: '100%',
                                backgroundColor:
                                  device.cpuPercent > 80 ? '#ef4444' : '#3b82f6',
                              }}
                            />
                          </div>
                        </div>
                      ) : (
                        <span style={{ fontSize: '12px', color: '#64748b' }}>Telemetry inactive</span>
                      )}
                    </td>

                    <td style={{ padding: '14px 18px' }}>
                      <div
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '6px',
                          padding: '4px 10px',
                          borderRadius: '6px',
                          backgroundColor: 'rgba(59, 130, 246, 0.1)',
                          border: '1px solid rgba(59, 130, 246, 0.2)',
                          color: '#93c5fd',
                          fontSize: '12px',
                        }}
                      >
                        <Shield size={13} />
                        {device.policyName || 'Default Fleet Policy'}
                      </div>
                    </td>

                    <td style={{ padding: '14px 18px', textAlign: 'right' }}>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'flex-end',
                          alignItems: 'center',
                          gap: '8px',
                        }}
                      >
                        <button
                          title="Initiate Remote Connect"
                          disabled={device.status === 'OFFLINE'}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px',
                            padding: '6px 12px',
                            borderRadius: '6px',
                            backgroundColor:
                              device.status === 'OFFLINE'
                                ? 'rgba(30, 41, 59, 0.5)'
                                : '#2563eb',
                            border: 'none',
                            color: device.status === 'OFFLINE' ? '#64748b' : '#ffffff',
                            fontSize: '12px',
                            fontWeight: 500,
                            cursor: device.status === 'OFFLINE' ? 'not-allowed' : 'pointer',
                          }}
                        >
                          <ExternalLink size={13} />
                          Connect
                        </button>

                        <button
                          onClick={() => handleRevokeDevice(device.id, device.deviceName)}
                          title="Revoke Device Credentials"
                          style={{
                            padding: '6px 8px',
                            borderRadius: '6px',
                            backgroundColor: 'transparent',
                            border: '1px solid #334155',
                            color: '#94a3b8',
                            cursor: 'pointer',
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.borderColor = '#ef4444';
                            e.currentTarget.style.color = '#ef4444';
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.borderColor = '#334155';
                            e.currentTarget.style.color = '#94a3b8';
                          }}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Enrollment Token Modal */}
      {showEnrollModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.75)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
            backdropFilter: 'blur(4px)',
          }}
        >
          <div
            className="glass-panel"
            style={{
              width: '520px',
              padding: '24px',
              backgroundColor: '#0d131f',
              border: '1px solid #27354a',
              borderRadius: '14px',
              boxShadow: '0 20px 40px rgba(0,0,0,0.6)',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '16px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <Key size={20} color="#38bdf8" />
                <h3 style={{ fontSize: '18px', fontWeight: 600, color: '#f8fafc' }}>
                  Generate Device Enrollment Token
                </h3>
              </div>
              <button
                onClick={() => setShowEnrollModal(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#64748b',
                  cursor: 'pointer',
                  fontSize: '18px',
                }}
              >
                ✕
              </button>
            </div>

            <p style={{ fontSize: '13px', color: '#94a3b8', marginBottom: '20px', lineHeight: 1.5 }}>
              Single-use cryptographic enrollment token (Section 9). The host agent presents this
              token along with its local Ed25519 public key to enroll into the fleet.
            </p>

            <div style={{ marginBottom: '18px' }}>
              <label
                style={{
                  display: 'block',
                  fontSize: '12px',
                  fontWeight: 600,
                  color: '#cbd5e1',
                  marginBottom: '8px',
                }}
              >
                Token Expiration Window:
              </label>
              <select
                value={enrollHours}
                onChange={(e) => setEnrollHours(parseInt(e.target.value, 10))}
                style={{
                  width: '100%',
                  padding: '9px 12px',
                  backgroundColor: '#07090e',
                  border: '1px solid #1e2c42',
                  borderRadius: '8px',
                  color: '#f1f5f9',
                  fontSize: '13px',
                }}
              >
                <option value={1}>1 Hour (Immediate Enrollment)</option>
                <option value={24}>24 Hours (Standard IT Provisioning)</option>
                <option value={72}>72 Hours (Weekend Deployment)</option>
              </select>
            </div>

            {generatingToken && (
              <div style={{ padding: '16px', textAlign: 'center', color: '#94a3b8', fontSize: '13px' }}>
                Generating cryptographic token in control plane...
              </div>
            )}

            {!generatingToken && generatedToken && (
              <div style={{ marginBottom: '24px' }}>
                <label
                  style={{
                    display: 'block',
                    fontSize: '12px',
                    fontWeight: 600,
                    color: '#38bdf8',
                    marginBottom: '8px',
                  }}
                >
                  Cryptographic Token (Single-Use):
                </label>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    backgroundColor: '#07090e',
                    border: '1px solid #223249',
                    borderRadius: '8px',
                    padding: '10px 14px',
                  }}
                >
                  <code
                    style={{
                      fontFamily: 'JetBrains Mono, monospace',
                      fontSize: '12px',
                      color: '#34d399',
                      wordBreak: 'break-all',
                      flex: 1,
                    }}
                  >
                    {generatedToken}
                  </code>
                  <button
                    onClick={handleCopyToken}
                    style={{
                      padding: '6px 10px',
                      backgroundColor: copied ? '#059669' : '#1e293b',
                      border: 'none',
                      borderRadius: '6px',
                      color: '#ffffff',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                      fontSize: '12px',
                    }}
                  >
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button
                onClick={() => setShowEnrollModal(false)}
                style={{
                  padding: '9px 16px',
                  backgroundColor: 'transparent',
                  border: '1px solid #334155',
                  borderRadius: '8px',
                  color: '#cbd5e1',
                  fontSize: '13px',
                  cursor: 'pointer',
                }}
              >
                Close
              </button>
              <button
                onClick={handleGenerateEnrollment}
                disabled={generatingToken}
                style={{
                  padding: '9px 16px',
                  backgroundColor: '#2563eb',
                  border: 'none',
                  borderRadius: '8px',
                  color: '#ffffff',
                  fontSize: '13px',
                  fontWeight: 600,
                  cursor: generatingToken ? 'wait' : 'pointer',
                }}
              >
                Generate New Token
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
