import React, { useState, useEffect } from "react";
import { DesktopHub } from "./DesktopHub";
import { WebRemoteViewer } from "../../admin-web/src/components/WebRemoteViewer";
import { useHostAgent } from "./useHostAgent";
import { ShieldAlert, Lock } from "lucide-react";
import { SessionCapabilities, SessionState } from "@krypton/shared-types";
import { formatRemoteId } from "./remoteIdentity";

interface RecentDevice {
  id: string;
  name: string;
  remoteId: string;
  lastConnected: string;
  os: string;
}

interface ActiveViewerSession {
  sessionId: string;
  remoteId: string;
  deviceName: string;
  state: SessionState;
  route: "DIRECT_P2P" | "TURN_RELAY";
  capabilities: SessionCapabilities;
  fps: number;
  bitrateKbps: number;
  rttMs: number;
  packetLossPct: number;
}

const DEFAULT_API_URL = import.meta.env.VITE_API_BASE_URL
  ? `${import.meta.env.VITE_API_BASE_URL}/api/v1`
  : "";

export default function App() {
  const [activeTab, setActiveTab] = useState<
    | "home"
    | "devices"
    | "file-transfer"
    | "sessions"
    | "settings"
    | "diagnostics"
  >("home");
  const [remoteIdInput, setRemoteIdInput] = useState("");
  const [copied, setCopied] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const connecting = false;
  const [copyError, setCopyError] = useState("");
  const isNative = "__TAURI_INTERNALS__" in window;
  const [isElevated, setIsElevated] = useState<boolean>(false);
  const [monitorCount, setMonitorCount] = useState<number>(1);

  const [myRemoteId, setMyRemoteId] = useState<string>("Loading...");
  const [identityError, setIdentityError] = useState("");
  const [enrolling, setEnrolling] = useState(false);
  const [myDeviceName, setMyDeviceName] = useState<string>("Local Host");

  const [hostFileProgress, setHostFileProgress] = useState('');
  const [deviceApiUrl, setDeviceApiUrl] = useState(DEFAULT_API_URL);
  const host = useHostAgent(isNative, myRemoteId);
  const incomingRequest = host.request;
  const [consentCapabilities, setConsentCapabilities] =
    useState<SessionCapabilities>({
      screenView: true,
      control: true,
      clipboard: false,
      fileTransfer: false,
      audioListen: false,
    });

  // State: Active Remote Viewer Session on Technician side (Section 20 & 21)
  const [activeSession, setActiveSession] =
    useState<ActiveViewerSession | null>(null);

  const [recentDevices, setRecentDevices] = useState<RecentDevice[]>(() => {
    try {
      const saved = localStorage.getItem("krypton_recent_devices");
      if (saved) return JSON.parse(saved);
    } catch {}
    return [];
  });

  useEffect(() => {
    if (!isNative) {
      setMyRemoteId("Desktop app only");
      setMyDeviceName("Browser preview");
      return;
    }
    (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");

        try {
          const id = await invoke<string | null>("initialize_identity");
          const formatted = formatRemoteId(id);
          if (formatted) {
            setMyRemoteId(formatted);
          } else {
            setMyRemoteId("Registration required");
          }
        } catch (idErr) {
          console.warn("Device identity initialize fallback:", idErr);
          setMyRemoteId("Registration required");
        }

        const registration = await invoke<{ apiUrl: string } | null>("get_device_registration");
        if (registration) setDeviceApiUrl(registration.apiUrl);
        const telemetry = await invoke<any>("get_windows_telemetry");
        if (telemetry) {
          setIsElevated(telemetry.is_elevated);
          setMonitorCount(telemetry.monitor_count);
          if (telemetry.computer_name) {
            setMyDeviceName(telemetry.computer_name);
          }
        }
      } catch (error) {
        console.warn("Native device telemetry unavailable:", error);
      }
    })();
  }, []);

  const handleEnroll = async (apiUrl = "", enrollmentToken = "") => {
    if (!isNative || enrolling) return;
    setEnrolling(true);
    setIdentityError("");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const targetUrl = apiUrl.trim() || DEFAULT_API_URL;
      const id = await invoke<string>("enroll_device", {
        apiUrl: targetUrl,
        enrollmentToken: enrollmentToken.trim() ? enrollmentToken.trim() : null,
      });
      const formatted = formatRemoteId(id);
      if (!formatted) throw new Error("The server did not return a valid 9-digit Remote ID.");
      setMyRemoteId(formatted);
      const saved = await invoke<{ apiUrl: string }>("get_device_registration");
      setDeviceApiUrl(saved.apiUrl);
    } catch (error) {
      setIdentityError(typeof error === "string" ? error : error instanceof Error ? error.message : "Could not register this device.");
    } finally {
      setEnrolling(false);
    }
  };

  const handleCopyId = async () => {
    const formatted = formatRemoteId(myRemoteId);
    if (!formatted) return;
    try {
      await navigator.clipboard.writeText(formatted.replace(/\s/g, ""));
      setCopyError("");
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyError("Could not copy. Select and copy your Remote ID manually.");
    }
  };

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (connecting) return;
    setConnectionError("");
    const targetId = remoteIdInput.replace(/\s+/g, "");
    if (!/^\d{9}$/.test(targetId)) {
      setConnectionError(
        "Enter the 9-digit Remote ID of the device you want to access.",
      );
      return;
    }
    if (!isNative) {
      setConnectionError(
        "Open KryptonRemote on Windows to start a session. This is the browser preview.",
      );
      return;
    }

    if (!deviceApiUrl) { setConnectionError("Configure your server URL and enroll this device in Settings first."); return; }
    const newSessionId = "pending";
    setRecentDevices((prev) => {
      const updated = [
        {
          id: `dev-${Date.now()}`,
          name: `Remote Device (${targetId})`,
          remoteId: targetId,
          lastConnected: "Just now",
          os: "Windows",
        },
        ...prev.filter(
          (d) =>
            d.remoteId.replace(/\s+/g, "") !== targetId.replace(/\s+/g, ""),
        ),
      ].slice(0, 10);
      try {
        localStorage.setItem("krypton_recent_devices", JSON.stringify(updated));
      } catch {}
      return updated;
    });

    setActiveSession({
      sessionId: newSessionId,
      remoteId: targetId,
      deviceName: "Remote Device (" + targetId + ")",
      state: SessionState.AUTHORIZING,
      route: "DIRECT_P2P",
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

  useEffect(() => {
    if (incomingRequest) setConsentCapabilities({ ...incomingRequest.requestedCapabilities, audioListen: false });
  }, [incomingRequest?.sessionId]);
  const handleAcceptConsent = async () => {
    try { await host.accept(consentCapabilities); }
    catch (error) { setIdentityError(String(error)); }
  };
  const handleRejectConsent = async () => {
    try { await host.reject(); } catch (error) { setIdentityError(String(error)); }
  };

  if (activeSession) {
    return <div className="app-container"><button onClick={() => setActiveSession(null)}>Back to connection hub</button>
      <WebRemoteViewer initialRemoteId={activeSession.remoteId} autoConnect apiBase={deviceApiUrl} onClose={() => setActiveSession(null)} />
    </div>;
  }

  return (
    <div className="app-container">
      {isNative && <div role="status" style={{ padding: '10px 20px', display: 'flex', gap: 16, alignItems: 'center' }}>
        <span>{host.status}</span><button onClick={() => void host.disconnect()}>End support session</button>
        <label>Send file to viewer<input type="file" onChange={async event => {
          const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
          try { await host.sendFile(file, percent => setHostFileProgress(`${file.name}: ${percent}%`)); }
          catch (error) { setHostFileProgress(String(error)); }
        }} /></label><span>{hostFileProgress}</span>
        {host.error && <span role="alert">{host.error}</span>}
      </div>}
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
                <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                  An external technician is requesting access to this device.
                </div>
              </div>
            </div>

            <div className="consent-details">
              <div className="detail-row">
                <span className="detail-label">Requested by:</span>
                <span className="detail-value">
                  {incomingRequest.viewerName}
                </span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Organization:</span>
                <span className="detail-value">
                  {incomingRequest.organizationName}
                </span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Verification:</span>
                <span
                  className="detail-value"
                  style={{ color: "var(--status-online)" }}
                >
                  <Lock
                    size={12}
                    style={{ display: "inline", marginRight: 4 }}
                  />{" "}
                  Signed Token Verified
                </span>
              </div>
            </div>

            <div className="permissions-toggle-group">
              <div
                style={{
                  fontSize: "12px",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  color: "var(--text-muted)",
                  marginBottom: 8,
                }}
              >
                Select Allowed Capabilities:
              </div>

              <label className="permission-toggle-item">
                <input
                  type="checkbox"
                  checked={consentCapabilities.screenView}
                  onChange={(e) =>
                    setConsentCapabilities({
                      ...consentCapabilities,
                      screenView: e.target.checked,
                    })
                  }
                />
                <span>View Screen</span>
              </label>

              <label className="permission-toggle-item">
                <input
                  type="checkbox"
                  disabled={!incomingRequest.requestedCapabilities.control} checked={consentCapabilities.control}
                  onChange={(e) =>
                    setConsentCapabilities({
                      ...consentCapabilities,
                      control: e.target.checked,
                    })
                  }
                />
                <span>Control Keyboard & Mouse</span>
              </label>

              <label className="permission-toggle-item">
                <input
                  type="checkbox"
                  disabled={!incomingRequest.requestedCapabilities.clipboard} checked={consentCapabilities.clipboard}
                  onChange={(e) =>
                    setConsentCapabilities({
                      ...consentCapabilities,
                      clipboard: e.target.checked,
                    })
                  }
                />
                <span>Synchronize Clipboard</span>
              </label>

              <label className="permission-toggle-item">
                <input
                  type="checkbox"
                  disabled={!incomingRequest.requestedCapabilities.fileTransfer} checked={consentCapabilities.fileTransfer}
                  onChange={(e) =>
                    setConsentCapabilities({
                      ...consentCapabilities,
                      fileTransfer: e.target.checked,
                    })
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

      <DesktopHub
        activeTab={activeTab}
        onTabChange={setActiveTab}
        remoteId={myRemoteId}
        identityError={identityError}
        enrolling={enrolling}
        onEnroll={handleEnroll}
        deviceName={myDeviceName}
        isElevated={isElevated}
        monitorCount={monitorCount}
        isNative={isNative}
        copied={copied}
        copyError={copyError}
        onCopyId={handleCopyId}
        remoteIdInput={remoteIdInput}
        onRemoteIdChange={(value) => {
          setRemoteIdInput(value);
          setConnectionError("");
        }}
        onConnect={handleConnect}
        connecting={connecting}
        connectionError={connectionError}
        recentDevices={recentDevices}
      />
    </div>
  );
}
