import React, { useState, useEffect, useCallback } from "react";
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
  AlertCircle,
} from "lucide-react";
import { adminApi, ActiveSessionDto } from "../api/client";

export type ActiveSession = ActiveSessionDto;

export const ActiveSessionMonitor: React.FC = () => {
  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [killModalSession, setKillModalSession] =
    useState<ActiveSession | null>(null);
  const [killReason, setKillReason] = useState(
    "Administrative Security Termination",
  );
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [isTerminating, setIsTerminating] = useState(false);

  const fetchSessions = useCallback(async () => {
    try {
      setError(null);
      const data = await adminApi.getActiveSessions();
      setSessions(data);
    } catch (err: any) {
      console.warn("Failed to fetch live active sessions:", err);
      setError(
        err.message ||
          "Failed to query active session matrix from control plane.",
      );
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
        `Forced Termination Confirmed: Session ${killedId} on "${deviceName}" forcibly terminated. Signaling & WebRTC transport severed.`,
      );
      setTimeout(() => setActionNotice(null), 6000);
    } catch (err: any) {
      setActionNotice(
        `Failed to terminate session: ${err.message || "Network error"}`,
      );
    } finally {
      setIsTerminating(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {/* Alert banner */}
      {actionNotice && (
        <div
          style={{
            padding: "12px 16px",
            borderRadius: "8px",
            backgroundColor: "rgba(239, 68, 68, 0.15)",
            border: "1px solid rgba(239, 68, 68, 0.4)",
            color: "#b4556e",
            display: "flex",
            alignItems: "center",
            gap: "10px",
            fontSize: "14px",
          }}
        >
          <AlertOctagon size={18} />
          {actionNotice}
        </div>
      )}

      {error && (
        <div
          style={{
            padding: "12px 16px",
            borderRadius: "8px",
            backgroundColor: "rgba(245, 158, 11, 0.15)",
            border: "1px solid rgba(245, 158, 11, 0.4)",
            color: "#aa7b25",
            display: "flex",
            alignItems: "center",
            gap: "10px",
            fontSize: "14px",
          }}
        >
          <AlertCircle size={18} />
          {error}
        </div>
      )}

      {/* Header bar */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "12px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <Radio size={20} color="#259775" />
          <h2 style={{ fontSize: "18px", fontWeight: 600, color: "var(--ink)" }}>
            Live Remote Session Matrix
          </h2>
          <span
            style={{
              padding: "2px 8px",
              borderRadius: "12px",
              backgroundColor: "rgba(16, 185, 129, 0.15)",
              border: "1px solid rgba(16, 185, 129, 0.3)",
              color: "#259775",
              fontSize: "12px",
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
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "8px 14px",
            borderRadius: "6px",
            backgroundColor: "#ffffff",
            border: "1px solid var(--line)",
            color: "var(--text-secondary)",
            fontSize: "13px",
            cursor: loading ? "wait" : "pointer",
          }}
        >
          <RefreshCw size={14} className={loading ? "spin" : ""} />
          Refresh Streams
        </button>
      </div>

      {/* Empty State */}
      {!loading && sessions.length === 0 && (
        <div
          className="glass-panel"
          style={{
            padding: "48px 24px",
            textAlign: "center",
            border: "1px dashed var(--line)",
            borderRadius: "12px",
          }}
        >
          <Radio
            size={36}
            color="var(--muted)"
            style={{ margin: "0 auto 12px auto" }}
          />
          <h3
            style={{
              fontSize: "16px",
              fontWeight: 600,
              color: "#686078",
              marginBottom: "6px",
            }}
          >
            No Active Remote Sessions
          </h3>
          <p
            style={{
              fontSize: "13px",
              color: "var(--muted)",
              maxWidth: "420px",
              margin: "0 auto",
            }}
          >
            There are currently no live WebRTC peer connections or active
            technician sessions running across the fleet.
          </p>
        </div>
      )}

      {/* Sessions Grid */}
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        {sessions.map((session) => (
          <div
            key={session.id}
            className="glass-panel"
            style={{
              padding: "20px",
              border: "1px solid var(--line)",
              display: "flex",
              flexDirection: "column",
              gap: "16px",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                flexWrap: "wrap",
                gap: "12px",
              }}
            >
              <div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    marginBottom: "4px",
                  }}
                >
                  <span
                    style={{
                      fontSize: "16px",
                      fontWeight: 700,
                      color: "var(--ink)",
                    }}
                  >
                    {session.hostDeviceName}
                  </span>
                  <span
                    style={{
                      fontFamily: "JetBrains Mono, monospace",
                      backgroundColor: "#f8f6fd",
                      padding: "2px 8px",
                      borderRadius: "4px",
                      fontSize: "12px",
                      color: "var(--brand)",
                      border: "1px solid var(--line)",
                    }}
                  >
                    {session.hostRemoteId}
                  </span>
                  <span
                    style={{
                      padding: "2px 8px",
                      borderRadius: "4px",
                      fontSize: "11px",
                      fontWeight: 600,
                      backgroundColor:
                        session.route === "DIRECT_P2P"
                          ? "rgba(16, 185, 129, 0.15)"
                          : "rgba(115, 87, 236, 0.15)",
                      color:
                        session.route === "DIRECT_P2P" ? "#259775" : "var(--brand)",
                      border:
                        session.route === "DIRECT_P2P"
                          ? "1px solid rgba(16, 185, 129, 0.3)"
                          : "1px solid rgba(115, 87, 236, 0.3)",
                    }}
                  >
                    {session.route === "DIRECT_P2P"
                      ? "DIRECT P2P (LAN/Hole-punch)"
                      : "COTURN RELAY (TLS/UDP)"}
                  </span>
                </div>
                <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
                  Technician:{" "}
                  <span style={{ color: "#606078", fontWeight: 500 }}>
                    {session.technicianEmail}
                  </span>{" "}
                  • Session ID:{" "}
                  <code style={{ color: "var(--muted)" }}>{session.id}</code>
                </div>
              </div>

              <button
                onClick={() => setKillModalSession(session)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "8px 14px",
                  borderRadius: "6px",
                  backgroundColor: "rgba(239, 68, 68, 0.15)",
                  border: "1px solid rgba(239, 68, 68, 0.4)",
                  color: "#c15975",
                  fontSize: "13px",
                  fontWeight: 600,
                  cursor: "pointer",
                  transition: "all 0.2s ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = "#dc2626";
                  e.currentTarget.style.color = "#f3f6ef";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor =
                    "rgba(239, 68, 68, 0.15)";
                  e.currentTarget.style.color = "#c15975";
                }}
              >
                <PowerOff size={15} />
                Emergency Terminate
              </button>
            </div>

            {/* Metrics & Capabilities row */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: "12px",
                backgroundColor: "rgba(236, 230, 246, 0.6)",
                padding: "12px 16px",
                borderRadius: "8px",
                border: "1px solid var(--line)",
              }}
            >
              <div>
                <div
                  style={{
                    fontSize: "11px",
                    color: "var(--muted)",
                    textTransform: "uppercase",
                  }}
                >
                  Video Stream
                </div>
                <div
                  style={{
                    fontSize: "14px",
                    fontWeight: 600,
                    color: "var(--brand)",
                  }}
                >
                  {session.metrics.fps} FPS @ {session.metrics.bitrateMbps} Mbps
                </div>
              </div>

              <div>
                <div
                  style={{
                    fontSize: "11px",
                    color: "var(--muted)",
                    textTransform: "uppercase",
                  }}
                >
                  Network RTT Latency
                </div>
                <div
                  style={{
                    fontSize: "14px",
                    fontWeight: 600,
                    color: session.metrics.rttMs < 30 ? "#218768" : "#f59e0b",
                  }}
                >
                  {session.metrics.rttMs} ms (Loss:{" "}
                  {session.metrics.packetLossPercent}%)
                </div>
              </div>

              <div>
                <div
                  style={{
                    fontSize: "11px",
                    color: "var(--muted)",
                    textTransform: "uppercase",
                  }}
                >
                  Duration
                </div>
                <div
                  style={{
                    fontSize: "14px",
                    fontWeight: 600,
                    color: "var(--ink)",
                    display: "flex",
                    alignItems: "center",
                    gap: "5px",
                  }}
                >
                  <Clock size={14} color="var(--muted)" />
                  {session.duration}
                </div>
              </div>

              <div>
                <div
                  style={{
                    fontSize: "11px",
                    color: "var(--muted)",
                    textTransform: "uppercase",
                    marginBottom: "4px",
                  }}
                >
                  Active Consent Permissions
                </div>
                <div style={{ display: "flex", gap: "6px" }}>
                  <span
                    title="Screen View"
                    style={{
                      padding: "2px 6px",
                      borderRadius: "4px",
                      fontSize: "11px",
                      backgroundColor: session.capabilities.screen
                        ? "rgba(115, 87, 236, 0.2)"
                        : "#ede8f6",
                      color: session.capabilities.screen
                        ? "var(--brand)"
                        : "var(--muted)",
                    }}
                  >
                    <Eye
                      size={12}
                      style={{ display: "inline", marginRight: "3px" }}
                    />{" "}
                    View
                  </span>
                  <span
                    title="Remote Control"
                    style={{
                      padding: "2px 6px",
                      borderRadius: "4px",
                      fontSize: "11px",
                      backgroundColor: session.capabilities.control
                        ? "rgba(16, 185, 129, 0.2)"
                        : "#ede8f6",
                      color: session.capabilities.control
                        ? "#259775"
                        : "var(--muted)",
                    }}
                  >
                    <MousePointer
                      size={12}
                      style={{ display: "inline", marginRight: "3px" }}
                    />{" "}
                    Control
                  </span>
                  <span
                    title="Clipboard Sync"
                    style={{
                      padding: "2px 6px",
                      borderRadius: "4px",
                      fontSize: "11px",
                      backgroundColor: session.capabilities.clipboard
                        ? "rgba(168, 85, 247, 0.2)"
                        : "#ede8f6",
                      color: session.capabilities.clipboard
                        ? "#9564ba"
                        : "var(--muted)",
                    }}
                  >
                    <Clipboard
                      size={12}
                      style={{ display: "inline", marginRight: "3px" }}
                    />{" "}
                    Clip
                  </span>
                  <span
                    title="File Transfer"
                    style={{
                      padding: "2px 6px",
                      borderRadius: "4px",
                      fontSize: "11px",
                      backgroundColor: session.capabilities.fileTransfer
                        ? "rgba(245, 158, 11, 0.2)"
                        : "#ede8f6",
                      color: session.capabilities.fileTransfer
                        ? "#aa7b25"
                        : "var(--muted)",
                    }}
                  >
                    <FileDown
                      size={12}
                      style={{ display: "inline", marginRight: "3px" }}
                    />{" "}
                    Files
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
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(0, 0, 0, 0.8)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
            backdropFilter: "blur(4px)",
          }}
        >
          <div
            className="glass-panel"
            style={{
              width: "500px",
              padding: "24px",
              backgroundColor: "#ffffff",
              border: "1px solid #7f1d1d",
              borderRadius: "14px",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "12px",
                marginBottom: "16px",
              }}
            >
              <ShieldAlert size={26} color="#ef4444" />
              <h3
                style={{ fontSize: "18px", fontWeight: 700, color: "#b4556e" }}
              >
                Forced Session Termination
              </h3>
            </div>

            <p
              style={{
                fontSize: "13px",
                color: "#686078",
                marginBottom: "14px",
                lineHeight: 1.5,
              }}
            >
              You are about to forcibly terminate the active remote session on{" "}
              <strong style={{ color: "var(--ink)" }}>
                {killModalSession.hostDeviceName}
              </strong>{" "}
              connected by{" "}
              <strong style={{ color: "var(--ink)" }}>
                {killModalSession.technicianEmail}
              </strong>
              .
            </p>

            <div style={{ marginBottom: "18px" }}>
              <label
                style={{
                  display: "block",
                  fontSize: "12px",
                  color: "var(--text-secondary)",
                  marginBottom: "6px",
                }}
              >
                Required Audit Justification Reason:
              </label>
              <input
                type="text"
                value={killReason}
                onChange={(e) => setKillReason(e.target.value)}
                style={{
                  width: "100%",
                  padding: "9px 12px",
                  backgroundColor: "#f9f7fc",
                  border: "1px solid var(--line)",
                  borderRadius: "8px",
                  color: "var(--ink)",
                  fontSize: "13px",
                }}
              />
            </div>

            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: "10px",
              }}
            >
              <button
                onClick={() => setKillModalSession(null)}
                disabled={isTerminating}
                style={{
                  padding: "8px 16px",
                  backgroundColor: "transparent",
                  border: "1px solid #c8bfd9",
                  borderRadius: "6px",
                  color: "var(--text-secondary)",
                  fontSize: "13px",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmKill}
                disabled={isTerminating}
                style={{
                  padding: "8px 16px",
                  backgroundColor: "#dc2626",
                  border: "none",
                  borderRadius: "6px",
                  color: "#f3f6ef",
                  fontSize: "13px",
                  fontWeight: 600,
                  cursor: isTerminating ? "wait" : "pointer",
                }}
              >
                {isTerminating ? "Severing..." : "Sever Connection Now"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
