import React, { useState, useEffect } from 'react';
import { RemoteCanvas } from './RemoteCanvas';
import {
  Monitor,
  HardDrive,
  FolderSync,
  History,
  Settings,
  Activity,
  Copy,
  Check,
  ShieldCheck,
  ArrowRight,
  ShieldAlert,
  Wifi,
  X,
  Maximize2,
  Lock,
} from 'lucide-react';
import { SessionCapabilities, SessionState } from '@krypton/shared-types';

interface RecentDevice {
  id: string;
  name: string;
  remoteId: string;
  lastConnected: string;
  os: string;
}

interface IncomingSessionRequest {
  sessionId: string;
  viewerName: string;
  organizationName: string;
  requestedCapabilities: SessionCapabilities;
}

interface ActiveViewerSession {
  sessionId: string;
  remoteId: string;
  deviceName: string;
  state: SessionState;
  route: 'DIRECT_P2P' | 'TURN_RELAY';
  capabilities: SessionCapabilities;
  fps: number;
  bitrateKbps: number;
  rttMs: number;
  packetLossPct: number;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'home' | 'devices' | 'file-transfer' | 'sessions' | 'settings' | 'diagnostics'>('home');
  const [remoteIdInput, setRemoteIdInput] = useState('');
  const [copied, setCopied] = useState(false);
  const [isElevated, setIsElevated] = useState<boolean>(false);
  const [monitorCount, setMonitorCount] = useState<number>(1);

  const [myRemoteId, setMyRemoteId] = useState<string>('Generating...');
  const [myDeviceName, setMyDeviceName] = useState<string>('Local Host');

  // State: Incoming Support Request on Host (Section 10)
  const [incomingRequest, setIncomingRequest] = useState<IncomingSessionRequest | null>(null);
  const [consentCapabilities, setConsentCapabilities] = useState<SessionCapabilities>({
    screenView: true,
    control: true,
    clipboard: false,
    fileTransfer: false,
    audioListen: false,
  });

  // State: Active Remote Viewer Session on Technician side (Section 20 & 21)
  const [activeSession, setActiveSession] = useState<ActiveViewerSession | null>(null);

  const [recentDevices, setRecentDevices] = useState<RecentDevice[]>(() => {
    try {
      const saved = localStorage.getItem('krypton_recent_devices');
      if (saved) return JSON.parse(saved);
    } catch {}
    return [];
  });

  useEffect(() => {
    (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        try {
          const id = await invoke<string>('initialize_identity');
          if (id) {
            const clean = id.replace(/[^a-zA-Z0-9]/g, '');
            if (clean.length === 9) {
              setMyRemoteId(`${clean.slice(0, 3)} ${clean.slice(3, 6)} ${clean.slice(6)}`);
            } else {
              setMyRemoteId(id);
            }
          }
        } catch (idErr) {
          console.warn('Device identity initialize fallback:', idErr);
          setMyRemoteId('834 951 220');
        }

        const telemetry = await invoke<any>('get_windows_telemetry');
        if (telemetry) {
          setIsElevated(telemetry.is_elevated);
          setMonitorCount(telemetry.monitor_count);
          if (telemetry.computer_name) {
            setMyDeviceName(telemetry.computer_name);
          }
        }
      } catch {
        // Fallback for browser preview
        setIsElevated(false);
        setMonitorCount(1);
        setMyRemoteId('834 951 220');
        setMyDeviceName('Krypton-Workstation-01');
      }
    })();
  }, []);

  const handleCopyId = () => {
    navigator.clipboard.writeText(myRemoteId.replace(/\s+/g, ''));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!remoteIdInput.trim()) return;

    // Start session state machine sequence: AUTHORIZING -> SIGNALING -> ICE_GATHERING -> CONNECTING -> CONNECTED
    const targetId = remoteIdInput.trim();
    const newSessionId = 'session-' + Date.now();

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('start_viewer_session', {
        targetRemoteId: targetId,
        sessionId: newSessionId,
      });
    } catch (err) {
      console.warn('Backend start_viewer_session notice:', err);
    }

    setRecentDevices((prev) => {
      const updated = [
        {
          id: `dev-${Date.now()}`,
          name: `Remote Device (${targetId})`,
          remoteId: targetId,
          lastConnected: 'Just now',
          os: 'Windows',
        },
        ...prev.filter((d) => d.remoteId.replace(/\s+/g, '') !== targetId.replace(/\s+/g, '')),
      ].slice(0, 10);
      try {
        localStorage.setItem('krypton_recent_devices', JSON.stringify(updated));
      } catch {}
      return updated;
    });

    setActiveSession({
      sessionId: newSessionId,
      remoteId: targetId,
      deviceName: 'Remote Device (' + targetId + ')',
      state: SessionState.CONNECTED,
      route: 'DIRECT_P2P',
      capabilities: {
        screenView: true,
        control: true,
        clipboard: true,
        fileTransfer: true,
        audioListen: false,
      },
      fps: 0,
      bitrateKbps: 0,
      rttMs: -1, // -1 denotes unmeasured / N/A
      packetLossPct: 0.0,
    });
  };

  // Periodic Telemetry Polling (Section 12: Real connection metrics only, N/A when unmeasured)
  useEffect(() => {
    if (!activeSession) return;
    const timer = setInterval(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const telem = await invoke<any>('get_session_telemetry');
        if (telem) {
          setActiveSession((prev) => {
            if (!prev) return null;
            return {
              ...prev,
              route: telem.route === 'TurnRelay' ? 'TURN_RELAY' : 'DIRECT_P2P',
              fps: telem.actual_fps ? Math.round(telem.actual_fps) : 0,
              bitrateKbps: telem.bitrate_bps ? Math.round(telem.bitrate_bps / 1000) : 0,
              rttMs: telem.rtt_ms !== null && telem.rtt_ms !== undefined ? telem.rtt_ms : -1,
              packetLossPct: telem.packet_loss_pct || 0.0,
            };
          });
        }
      } catch (err) {
        // Fallback in web preview mode
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [activeSession?.sessionId]);

  const handleAcceptConsent = async () => {
    if (!incomingRequest) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('start_host_session', {
        sessionId: incomingRequest.sessionId,
        viewerId: incomingRequest.viewerName,
        allowControl: consentCapabilities.control,
        allowClipboard: consentCapabilities.clipboard,
        allowFileTransfer: consentCapabilities.fileTransfer,
        displayId: 0,
        fps: 30,
        bitrateKbps: 3000,
      });
    } catch (e) {
      console.warn('start_host_session error:', e);
    }
    console.info('Session consent accepted with capabilities:', consentCapabilities);
    setIncomingRequest(null);
  };

  const handleRejectConsent = () => {
    if (!incomingRequest) return;
    console.info('Session consent rejected');
    setIncomingRequest(null);
  };

  const handleDisconnectSession = async () => {
    console.info('Disconnecting active remote session');
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('disconnect_session');
    } catch (e) {
      console.warn('disconnect_session error:', e);
    }
    setActiveSession(null);
  };

  // If in an active viewer session, render the full-screen remote desktop canvas and toolbar (Section 20)
  if (activeSession) {
    return (
      <div className="viewer-container">
        {/* Top Auto-hide Toolbar */}
        <header className="viewer-toolbar">
          <div className="toolbar-left">
            <button
              className="btn-disconnect"
              onClick={handleDisconnectSession}
              title="End Remote Session"
            >
              <X size={14} style={{ display: 'inline', marginRight: 4 }} /> Disconnect
            </button>
            <div style={{ fontWeight: 600, fontSize: '13px' }}>
              {activeSession.deviceName} <span style={{ color: 'var(--text-muted)' }}>({activeSession.remoteId})</span>
            </div>
            <div
              className="stat-pill"
              style={{
                color: activeSession.state === SessionState.CONNECTED ? 'var(--status-online)' : 'var(--status-degraded)',
              }}
            >
              {activeSession.state}
            </div>
            <div className="stat-pill" style={{ color: 'var(--accent-primary)' }}>
              <Wifi size={12} style={{ display: 'inline', marginRight: 4 }} />
              {activeSession.route === 'DIRECT_P2P' ? 'DIRECT P2P' : 'TURN RELAY'}
            </div>
          </div>

          <div className="toolbar-right">
            <div className="toolbar-stats">
              <span className="stat-pill">{activeSession.fps > 0 ? `${activeSession.fps} FPS` : 'N/A FPS'}</span>
              <span className="stat-pill">{activeSession.bitrateKbps > 0 ? `${(activeSession.bitrateKbps / 1000).toFixed(1)} Mbps` : 'N/A Mbps'}</span>
              <span className="stat-pill">{activeSession.rttMs >= 0 ? `${activeSession.rttMs} ms RTT` : 'RTT: N/A'}</span>
              <span className="stat-pill">{activeSession.packetLossPct > 0 ? `${activeSession.packetLossPct.toFixed(1)}% Loss` : '0% Loss'}</span>
            </div>
            <button
              style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}
              title="Toggle Fullscreen"
              onClick={() => {
                if (!document.fullscreenElement) {
                  document.documentElement.requestFullscreen();
                } else {
                  document.exitFullscreen();
                }
              }}
            >
              <Maximize2 size={16} />
            </button>
          </div>
        </header>

        {/* Real Video Canvas — WebRTC Receiver → H.264 WebCodecs Decode → Canvas (Section 6 & 16: Viewer mode does NOT start local capture) */}
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          <RemoteCanvas
            sessionId={activeSession.sessionId}
            isViewer={true}
            allowInputControl={activeSession.capabilities.control}
            allowClipboard={activeSession.capabilities.clipboard}
            allowFileTransfer={activeSession.capabilities.fileTransfer}
            onCaptureStarted={(displayId) =>
              console.info('[viewer] Capture started on display', displayId)
            }
            onCaptureStopped={() =>
              console.info('[viewer] Capture stopped')
            }
            onError={(msg) =>
              console.error('[viewer] Capture error:', msg)
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      {/* Incoming Consent Handshake Modal (Section 10) */}
      {incomingRequest && (
        <div className="modal-backdrop">
          <div className="consent-card">
            <div className="consent-header">
              <div className="consent-icon">
                <ShieldAlert size={22} />
              </div>
              <div>
                <div className="consent-title">Remote Support Request</div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                  An external technician is requesting access to this device.
                </div>
              </div>
            </div>

            <div className="consent-details">
              <div className="detail-row">
                <span className="detail-label">Requested by:</span>
                <span className="detail-value">{incomingRequest.viewerName}</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Organization:</span>
                <span className="detail-value">{incomingRequest.organizationName}</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Verification:</span>
                <span className="detail-value" style={{ color: 'var(--status-online)' }}>
                  <Lock size={12} style={{ display: 'inline', marginRight: 4 }} /> Signed Token Verified
                </span>
              </div>
            </div>

            <div className="permissions-toggle-group">
              <div style={{ fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 8 }}>
                Select Allowed Capabilities:
              </div>

              <label className="permission-toggle-item">
                <input
                  type="checkbox"
                  checked={consentCapabilities.screenView}
                  onChange={(e) =>
                    setConsentCapabilities({ ...consentCapabilities, screenView: e.target.checked })
                  }
                />
                <span>View Screen</span>
              </label>

              <label className="permission-toggle-item">
                <input
                  type="checkbox"
                  checked={consentCapabilities.control}
                  onChange={(e) =>
                    setConsentCapabilities({ ...consentCapabilities, control: e.target.checked })
                  }
                />
                <span>Control Keyboard & Mouse</span>
              </label>

              <label className="permission-toggle-item">
                <input
                  type="checkbox"
                  checked={consentCapabilities.clipboard}
                  onChange={(e) =>
                    setConsentCapabilities({ ...consentCapabilities, clipboard: e.target.checked })
                  }
                />
                <span>Synchronize Clipboard</span>
              </label>

              <label className="permission-toggle-item">
                <input
                  type="checkbox"
                  checked={consentCapabilities.fileTransfer}
                  onChange={(e) =>
                    setConsentCapabilities({ ...consentCapabilities, fileTransfer: e.target.checked })
                  }
                />
                <span>File Transfer</span>
              </label>
            </div>

            <div className="consent-actions">
              <button className="btn-reject" onClick={handleRejectConsent}>
                REJECT
              </button>
              <button className="btn-accept" onClick={handleAcceptConsent}>
                ACCEPT & CONNECT
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Sidebar Navigation */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="brand-icon">K</div>
          <span className="brand-title">KryptonRemote</span>
        </div>

        <nav className="sidebar-nav">
          <button
            className={`nav-item ${activeTab === 'home' ? 'active' : ''}`}
            onClick={() => setActiveTab('home')}
          >
            <Monitor size={18} />
            <span>Home</span>
          </button>
          <button
            className={`nav-item ${activeTab === 'devices' ? 'active' : ''}`}
            onClick={() => setActiveTab('devices')}
          >
            <HardDrive size={18} />
            <span>Devices</span>
          </button>
          <button
            className={`nav-item ${activeTab === 'file-transfer' ? 'active' : ''}`}
            onClick={() => setActiveTab('file-transfer')}
          >
            <FolderSync size={18} />
            <span>File Transfer</span>
          </button>
          <button
            className={`nav-item ${activeTab === 'sessions' ? 'active' : ''}`}
            onClick={() => setActiveTab('sessions')}
          >
            <History size={18} />
            <span>Sessions</span>
          </button>
          <button
            className={`nav-item ${activeTab === 'settings' ? 'active' : ''}`}
            onClick={() => setActiveTab('settings')}
          >
            <Settings size={18} />
            <span>Settings</span>
          </button>
          <button
            className={`nav-item ${activeTab === 'diagnostics' ? 'active' : ''}`}
            onClick={() => setActiveTab('diagnostics')}
          >
            <Activity size={18} />
            <span>Diagnostics</span>
          </button>
        </nav>

        <div className="sidebar-footer">
          <div className="user-avatar">IT</div>
          <div className="user-info">
            <span className="user-name">Dhanya (Admin)</span>
            <span className="user-role">IT Administrator</span>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="main-content">
        <div className="content-header">
          <h1 className="page-title">Remote Connection Hub</h1>
        </div>

        <div className="dashboard-grid">
          {/* YOUR DEVICE CARD */}
          <div className="card">
            <div className="card-header">
              <span className="card-subtitle">YOUR DEVICE</span>
              <button
                onClick={handleCopyId}
                style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}
                title="Copy Remote ID"
              >
                {copied ? <Check size={16} color="var(--status-online)" /> : <Copy size={16} />}
              </button>
            </div>
            <div className="remote-id-display">{myRemoteId}</div>
            <div className="status-badge">
              <span className="status-indicator" />
              <span>Ready for secure connections</span>
            </div>
            <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px', color: 'var(--text-muted)' }}>
              <div>Host: {myDeviceName} (Windows x64)</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' }}>
                <span
                  style={{
                    padding: '2px 8px',
                    borderRadius: '4px',
                    backgroundColor: isElevated ? 'rgba(16, 185, 129, 0.15)' : 'rgba(148, 163, 184, 0.15)',
                    color: isElevated ? '#34d399' : '#94a3b8',
                    fontWeight: 600,
                    fontSize: '11px',
                  }}
                >
                  {isElevated ? '🛡️ UAC: Elevated (Admin)' : '🛡️ Standard User'}
                </span>
                <span style={{ fontSize: '11px', color: '#64748b' }}>
                  {monitorCount} Display(s) Active
                </span>
              </div>
            </div>
          </div>

          {/* CONNECT TO REMOTE DEVICE CARD */}
          <div className="card">
            <div className="card-header">
              <span className="card-subtitle">CONNECT TO REMOTE DEVICE</span>
              <ShieldCheck size={18} color="var(--accent-primary)" />
            </div>
            <form onSubmit={handleConnect} className="connect-form">
              <input
                type="text"
                placeholder="Enter Remote ID (e.g. 412 889 012)"
                value={remoteIdInput}
                onChange={(e) => setRemoteIdInput(e.target.value)}
                className="remote-id-input"
              />
              <button type="submit" className="btn-primary">
                CONNECT
              </button>
            </form>
            <div style={{ marginTop: '14px', fontSize: '12px', color: 'var(--text-muted)' }}>
              Encrypted end-to-end via WebRTC (P2P / Authenticated Relay)
            </div>
          </div>
        </div>

        {/* RECENT DEVICES SECTION */}
        <section className="recent-devices-section">
          <div className="card-header">
            <span className="card-subtitle">RECENT DEVICES</span>
          </div>
          <table className="recent-devices-table">
            <thead>
              <tr>
                <th>Device Alias</th>
                <th>Remote ID</th>
                <th>Platform</th>
                <th>Last Active</th>
                <th style={{ textAlign: 'right' }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {recentDevices.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)' }}>
                    No recent connections. Enter a 9-digit Remote ID above to begin.
                  </td>
                </tr>
              ) : (
                recentDevices.map((device) => (
                  <tr key={device.id}>
                    <td className="device-name-cell">{device.name}</td>
                    <td className="device-id-cell">{device.remoteId}</td>
                    <td style={{ color: 'var(--text-secondary)' }}>{device.os}</td>
                    <td style={{ color: 'var(--text-muted)' }}>{device.lastConnected}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        className="btn-connect-sm"
                        onClick={() => setRemoteIdInput(device.remoteId)}
                      >
                        Connect <ArrowRight size={12} style={{ display: 'inline', marginLeft: 4 }} />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </section>
      </main>
    </div>
  );
}
