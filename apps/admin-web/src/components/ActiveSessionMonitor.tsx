import React, { useState, useEffect, useCallback } from 'react';
import {
  Radio,
  ShieldAlert,
  Clock,
  Eye,
  MousePointer,
  Clipboard,
  FileDown,
  PowerOff,
  AlertOctagon,
  RefreshCw,
  AlertCircle
} from 'lucide-react';
import { adminApi, ActiveSessionDto } from '../api/client';

export type ActiveSession = ActiveSessionDto;

export const ActiveSessionMonitor: React.FC = () => {
  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [killModalSession, setKillModalSession] = useState<ActiveSession | null>(null);
  const [killReason, setKillReason] = useState('Administrative Security Termination');
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [isTerminating, setIsTerminating] = useState(false);

  const fetchSessions = useCallback(async () => {
    try {
      setError(null);
      const data = await adminApi.getActiveSessions();
      setSessions(data);
    } catch (err: any) {
      console.warn('Failed to fetch live active sessions:', err);
      setError(err.message || 'Failed to query active session matrix from control plane.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSessions();
    const interval = setInterval(fetchSessions, 5000);
    return () => clearInterval(interval);
  }, [fetchSessions]);

  const handleConfirmKill = async () => {
    if (!killModalSession) return;
    const killedId = killModalSession.id;
    const deviceName = killModalSession.hostDeviceName;

    setIsTerminating(true);
    try {
      await adminApi.terminateSession(killedId, killReason);
      setSessions((prev) => prev.filter((s) => s.id !== killedId));
      setKillModalSession(null);
      setActionNotice(
        `Forced Termination Confirmed: Session ${killedId} on "${deviceName}" forcibly terminated. Signaling & WebRTC transport severed.`
      );
      setTimeout(() => setActionNotice(null), 6000);
    } catch (err: any) {
      setActionNotice(`Failed to terminate session: ${err.message || 'Network error'}`);
    } finally {
      setIsTerminating(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* Alert banner */}
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
          <AlertOctagon size={18} />
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

      {/* Header bar */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '12px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Radio size={20} color="#34d399" />
          <h2 style={{ fontSize: '18px', fontWeight: 600, color: '#f8fafc' }}>
            Live Remote Session Matrix
          </h2>
          <span
            style={{
              padding: '2px 8px',
              borderRadius: '12px',
              backgroundColor: 'rgba(16, 185, 129, 0.15)',
              border: '1px solid rgba(16, 185, 129, 0.3)',
              color: '#34d399',
              fontSize: '12px',
              fontWeight: 600,
            }}
          >
            {sessions.length} Active
          </span>
        </div>

        <button
          onClick={() => {
            setLoading(true);
            fetchSessions();
          }}
          disabled={loading}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '8px 14px',
            borderRadius: '6px',
            backgroundColor: '#131b2a',
            border: '1px solid #1e2c42',
            color: '#94a3b8',
            fontSize: '13px',
            cursor: loading ? 'wait' : 'pointer',
          }}
        >
          <RefreshCw size={14} className={loading ? 'spin' : ''} />
          Refresh Streams
        </button>
      </div>

      {/* Empty State */}
      {!loading && sessions.length === 0 && (
        <div
          className="glass-panel"
          style={{
            padding: '48px 24px',
            textAlign: 'center',
            border: '1px dashed #1e2c42',
            borderRadius: '12px',
          }}
        >
          <Radio size={36} color="#64748b" style={{ margin: '0 auto 12px auto' }} />
          <h3 style={{ fontSize: '16px', fontWeight: 600, color: '#cbd5e1', marginBottom: '6px' }}>
            No Active Remote Sessions
          </h3>
          <p style={{ fontSize: '13px', color: '#64748b', maxWidth: '420px', margin: '0 auto' }}>
            There are currently no live WebRTC peer connections or active technician sessions running across the fleet.
          </p>
        </div>
      )}

      {/* Sessions Grid */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {sessions.map((session) => (
          <div
            key={session.id}
            className="glass-panel"
            style={{
              padding: '20px',
              border: '1px solid #1e2c42',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                flexWrap: 'wrap',
                gap: '12px',
              }}
            >
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
                  <span style={{ fontSize: '16px', fontWeight: 700, color: '#f8fafc' }}>
                    {session.hostDeviceName}
                  </span>
                  <span
                    style={{
                      fontFamily: 'JetBrains Mono, monospace',
                      backgroundColor: '#0a0e17',
                      padding: '2px 8px',
                      borderRadius: '4px',
                      fontSize: '12px',
                      color: '#38bdf8',
                      border: '1px solid #1e2c42',
                    }}
                  >
                    {session.hostRemoteId}
                  </span>
                  <span
                    style={{
                      padding: '2px 8px',
                      borderRadius: '4px',
                      fontSize: '11px',
                      fontWeight: 600,
                      backgroundColor:
                        session.route === 'DIRECT_P2P'
                          ? 'rgba(16, 185, 129, 0.15)'
                          : 'rgba(59, 130, 246, 0.15)',
                      color: session.route === 'DIRECT_P2P' ? '#34d399' : '#60a5fa',
                      border:
                        session.route === 'DIRECT_P2P'
                          ? '1px solid rgba(16, 185, 129, 0.3)'
                          : '1px solid rgba(59, 130, 246, 0.3)',
                    }}
                  >
                    {session.route === 'DIRECT_P2P' ? 'DIRECT P2P (LAN/Hole-punch)' : 'COTURN RELAY (TLS/UDP)'}
                  </span>
                </div>
                <div style={{ fontSize: '13px', color: '#94a3b8' }}>
                  Technician: <span style={{ color: '#e2e8f0', fontWeight: 500 }}>{session.technicianEmail}</span> •
                  Session ID: <code style={{ color: '#64748b' }}>{session.id}</code>
                </div>
              </div>

              <button
                onClick={() => setKillModalSession(session)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '8px 14px',
                  borderRadius: '6px',
                  backgroundColor: 'rgba(239, 68, 68, 0.15)',
                  border: '1px solid rgba(239, 68, 68, 0.4)',
                  color: '#f87171',
                  fontSize: '13px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#dc2626';
                  e.currentTarget.style.color = '#ffffff';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.15)';
                  e.currentTarget.style.color = '#f87171';
                }}
              >
                <PowerOff size={15} />
                Emergency Terminate
              </button>
            </div>

            {/* Metrics & Capabilities row */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: '12px',
                backgroundColor: 'rgba(13, 18, 28, 0.6)',
                padding: '12px 16px',
                borderRadius: '8px',
                border: '1px solid #1a2538',
              }}
            >
              <div>
                <div style={{ fontSize: '11px', color: '#64748b', textTransform: 'uppercase' }}>
                  Video Stream
                </div>
                <div style={{ fontSize: '14px', fontWeight: 600, color: '#38bdf8' }}>
                  {session.metrics.fps} FPS @ {session.metrics.bitrateMbps} Mbps
                </div>
              </div>

              <div>
                <div style={{ fontSize: '11px', color: '#64748b', textTransform: 'uppercase' }}>
                  Network RTT Latency
                </div>
                <div
                  style={{
                    fontSize: '14px',
                    fontWeight: 600,
                    color: session.metrics.rttMs < 30 ? '#10b981' : '#f59e0b',
                  }}
                >
                  {session.metrics.rttMs} ms (Loss: {session.metrics.packetLossPercent}%)
                </div>
              </div>

              <div>
                <div style={{ fontSize: '11px', color: '#64748b', textTransform: 'uppercase' }}>
                  Duration
                </div>
                <div style={{ fontSize: '14px', fontWeight: 600, color: '#f1f5f9', display: 'flex', alignItems: 'center', gap: '5px' }}>
                  <Clock size={14} color="#64748b" />
                  {session.duration}
                </div>
              </div>

              <div>
                <div style={{ fontSize: '11px', color: '#64748b', textTransform: 'uppercase', marginBottom: '4px' }}>
                  Active Consent Permissions
                </div>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <span
                    title="Screen View"
                    style={{
                      padding: '2px 6px',
                      borderRadius: '4px',
                      fontSize: '11px',
                      backgroundColor: session.capabilities.screen ? 'rgba(59, 130, 246, 0.2)' : '#1e293b',
                      color: session.capabilities.screen ? '#60a5fa' : '#64748b',
                    }}
                  >
                    <Eye size={12} style={{ display: 'inline', marginRight: '3px' }} /> View
                  </span>
                  <span
                    title="Remote Control"
                    style={{
                      padding: '2px 6px',
                      borderRadius: '4px',
                      fontSize: '11px',
                      backgroundColor: session.capabilities.control ? 'rgba(16, 185, 129, 0.2)' : '#1e293b',
                      color: session.capabilities.control ? '#34d399' : '#64748b',
                    }}
                  >
                    <MousePointer size={12} style={{ display: 'inline', marginRight: '3px' }} /> Control
                  </span>
                  <span
                    title="Clipboard Sync"
                    style={{
                      padding: '2px 6px',
                      borderRadius: '4px',
                      fontSize: '11px',
                      backgroundColor: session.capabilities.clipboard ? 'rgba(168, 85, 247, 0.2)' : '#1e293b',
                      color: session.capabilities.clipboard ? '#c084fc' : '#64748b',
                    }}
                  >
                    <Clipboard size={12} style={{ display: 'inline', marginRight: '3px' }} /> Clip
                  </span>
                  <span
                    title="File Transfer"
                    style={{
                      padding: '2px 6px',
                      borderRadius: '4px',
                      fontSize: '11px',
                      backgroundColor: session.capabilities.fileTransfer ? 'rgba(245, 158, 11, 0.2)' : '#1e293b',
                      color: session.capabilities.fileTransfer ? '#fbbf24' : '#64748b',
                    }}
                  >
                    <FileDown size={12} style={{ display: 'inline', marginRight: '3px' }} /> Files
                  </span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Emergency Kill Confirmation Modal */}
      {killModalSession && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.8)',
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
              width: '500px',
              padding: '24px',
              backgroundColor: '#0d131f',
              border: '1px solid #7f1d1d',
              borderRadius: '14px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
              <ShieldAlert size={26} color="#ef4444" />
              <h3 style={{ fontSize: '18px', fontWeight: 700, color: '#fca5a5' }}>
                Forced Session Termination
              </h3>
            </div>

            <p style={{ fontSize: '13px', color: '#cbd5e1', marginBottom: '14px', lineHeight: 1.5 }}>
              You are about to forcibly terminate the active remote session on{' '}
              <strong style={{ color: '#ffffff' }}>{killModalSession.hostDeviceName}</strong> connected
              by <strong style={{ color: '#ffffff' }}>{killModalSession.technicianEmail}</strong>.
            </p>

            <div style={{ marginBottom: '18px' }}>
              <label style={{ display: 'block', fontSize: '12px', color: '#94a3b8', marginBottom: '6px' }}>
                Required Audit Justification Reason:
              </label>
              <input
                type="text"
                value={killReason}
                onChange={(e) => setKillReason(e.target.value)}
                style={{
                  width: '100%',
                  padding: '9px 12px',
                  backgroundColor: '#07090e',
                  border: '1px solid #1e2c42',
                  borderRadius: '8px',
                  color: '#f1f5f9',
                  fontSize: '13px',
                }}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button
                onClick={() => setKillModalSession(null)}
                disabled={isTerminating}
                style={{
                  padding: '8px 16px',
                  backgroundColor: 'transparent',
                  border: '1px solid #334155',
                  borderRadius: '6px',
                  color: '#94a3b8',
                  fontSize: '13px',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmKill}
                disabled={isTerminating}
                style={{
                  padding: '8px 16px',
                  backgroundColor: '#dc2626',
                  border: 'none',
                  borderRadius: '6px',
                  color: '#ffffff',
                  fontSize: '13px',
                  fontWeight: 600,
                  cursor: isTerminating ? 'wait' : 'pointer',
                }}
              >
                {isTerminating ? 'Severing...' : 'Sever Connection Now'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
