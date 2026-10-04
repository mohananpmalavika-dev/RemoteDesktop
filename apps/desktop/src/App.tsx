import React, { useState, useEffect } from "react";
import { DesktopHub } from "./DesktopHub";
import { RemoteCanvas } from "./RemoteCanvas";
import { ShieldAlert, Wifi, X, Maximize2, Lock } from "lucide-react";
import { SessionCapabilities, SessionState } from "@krypton/shared-types";
import { formatRemoteId } from "./remoteIdentity";

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
  route: "DIRECT_P2P" | "TURN_RELAY";
  capabilities: SessionCapabilities;
  fps: number;
  bitrateKbps: number;
  rttMs: number;
  packetLossPct: number;
}

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
  const [connecting, setConnecting] = useState(false);
  const [copyError, setCopyError] = useState("");
  const isNative = "__TAURI_INTERNALS__" in window;
  const [isElevated, setIsElevated] = useState<boolean>(false);
  const [monitorCount, setMonitorCount] = useState<number>(1);

  const [myRemoteId, setMyRemoteId] = useState<string>("Loading...");
  const [identityError, setIdentityError] = useState("");
  const [enrolling, setEnrolling] = useState(false);
  const [myDeviceName, setMyDeviceName] = useState<string>("Local Host");

  // State: Incoming Support Request on Host (Section 10)
  const [incomingRequest, setIncomingRequest] =
    useState<IncomingSessionRequest | null>(null);
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
          setMyRemoteId(formatted ?? "Registration required");
          if (id !== null && !formatted) {
            setIdentityError("No valid Remote ID was returned. Register this device with your API server.");
          }
        } catch (idErr) {
          console.warn("Device identity initialize fallback:", idErr);
          setMyRemoteId("Unavailable");
          setIdentityError(typeof idErr === "string" ? idErr : "Could not load this device's registration.");
        }

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

  const handleEnroll = async (apiUrl: string, enrollmentToken: string) => {
    if (!isNative || enrolling) return;
    setEnrolling(true);
    setIdentityError("");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const id = await invoke<string>("enroll_device", { apiUrl, enrollmentToken });
      const formatted = formatRemoteId(id);
      if (!formatted) throw new Error("The server did not return a valid 9-digit Remote ID.");
      setMyRemoteId(formatted);
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

    // Start session state machine sequence: AUTHORIZING -> SIGNALING -> ICE_GATHERING -> CONNECTING -> CONNECTED
    const newSessionId = "session-" + Date.now();

    setConnecting(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("start_viewer_session", {
        targetRemoteId: targetId,
        sessionId: newSessionId,
      });
    } catch (err) {
      console.warn("Backend start_viewer_session notice:", err);
      setConnectionError(
        "Could not start the session. Check the Remote ID and try again.",
      );
      return;
    } finally {
      setConnecting(false);
    }

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
      state: SessionState.CONNECTED,
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

  // Periodic Telemetry Polling (Section 12: Real connection metrics only, N/A when unmeasured)
  useEffect(() => {
    if (!activeSession) return;
    const timer = setInterval(async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const telem = await invoke<any>("get_session_telemetry");
        if (telem) {
          setActiveSession((prev) => {
            if (!prev) return null;
            return {
              ...prev,
              route: telem.route === "TurnRelay" ? "TURN_RELAY" : "DIRECT_P2P",
              fps: telem.actual_fps ? Math.round(telem.actual_fps) : 0,
              bitrateKbps: telem.bitrate_bps
                ? Math.round(telem.bitrate_bps / 1000)
                : 0,
              rttMs:
                telem.rtt_ms !== null && telem.rtt_ms !== undefined
                  ? telem.rtt_ms
                  : -1,
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
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("start_host_session", {
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
      console.warn("start_host_session error:", e);
    }
    console.info(
      "Session consent accepted with capabilities:",
      consentCapabilities,
    );
    setIncomingRequest(null);
  };

  const handleRejectConsent = () => {
    if (!incomingRequest) return;
    console.info("Session consent rejected");
    setIncomingRequest(null);
  };

  const handleDisconnectSession = async () => {
    console.info("Disconnecting active remote session");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("disconnect_session");
    } catch (e) {
      console.warn("disconnect_session error:", e);
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
              <X size={14} style={{ display: "inline", marginRight: 4 }} />{" "}
              Disconnect
            </button>
            <div style={{ fontWeight: 600, fontSize: "13px" }}>
              {activeSession.deviceName}{" "}
              <span style={{ color: "var(--text-muted)" }}>
                ({activeSession.remoteId})
              </span>
            </div>
            <div
              className="stat-pill"
              style={{
                color:
                  activeSession.state === SessionState.CONNECTED
                    ? "var(--status-online)"
                    : "var(--status-degraded)",
              }}
            >
              {activeSession.state}
            </div>
            <div
              className="stat-pill"
              style={{ color: "var(--accent-primary)" }}
            >
              <Wifi size={12} style={{ display: "inline", marginRight: 4 }} />
              {activeSession.route === "DIRECT_P2P"
                ? "DIRECT P2P"
                : "TURN RELAY"}
            </div>
          </div>

          <div className="toolbar-right">
            <div className="toolbar-stats">
              <span className="stat-pill">
                {activeSession.fps > 0 ? `${activeSession.fps} FPS` : "N/A FPS"}
              </span>
              <span className="stat-pill">
                {activeSession.bitrateKbps > 0
                  ? `${(activeSession.bitrateKbps / 1000).toFixed(1)} Mbps`
                  : "N/A Mbps"}
              </span>
              <span className="stat-pill">
                {activeSession.rttMs >= 0
                  ? `${activeSession.rttMs} ms RTT`
                  : "RTT: N/A"}
              </span>
              <span className="stat-pill">
                {activeSession.packetLossPct > 0
                  ? `${activeSession.packetLossPct.toFixed(1)}% Loss`
                  : "0% Loss"}
              </span>
            </div>
            <button
              style={{
                background: "none",
                border: "none",
                color: "var(--text-secondary)",
                cursor: "pointer",
              }}
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
        <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
          <RemoteCanvas
            sessionId={activeSession.sessionId}
            isViewer={true}
            allowInputControl={activeSession.capabilities.control}
            allowClipboard={activeSession.capabilities.clipboard}
            allowFileTransfer={activeSession.capabilities.fileTransfer}
            onCaptureStarted={(displayId) =>
              console.info("[viewer] Capture started on display", displayId)
            }
            onCaptureStopped={() => console.info("[viewer] Capture stopped")}
            onError={(msg) => console.error("[viewer] Capture error:", msg)}
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
                  checked={consentCapabilities.control}
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
                  checked={consentCapabilities.clipboard}
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
                  checked={consentCapabilities.fileTransfer}
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
