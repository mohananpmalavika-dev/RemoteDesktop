import React, { useState, useEffect, useCallback } from "react";
import {
  FileText,
  ShieldCheck,
  Search,
  Filter,
  Download,
  Eye,
  CheckCircle2,
  XCircle,
  Clock,
  User,
  Laptop,
  RefreshCw,
  AlertCircle,
  ShieldAlert,
} from "lucide-react";
import {
  adminApi,
  AuditRecordDto,
  ChainVerificationResultDto,
} from "../api/client";

export type AuditRecord = AuditRecordDto;

export const AuditLogViewer: React.FC = () => {
  const [logs, setLogs] = useState<AuditRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [actionFilter, setActionFilter] = useState("ALL");
  const [selectedRecord, setSelectedRecord] = useState<AuditRecord | null>(
    null,
  );
  const [chainStatus, setChainStatus] =
    useState<ChainVerificationResultDto | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);

  const fetchLogs = useCallback(async () => {
    try {
      setError(null);
      const data = await adminApi.getAuditLogs(100, 0);
      setLogs(data);
    } catch (err: any) {
      console.warn("Failed to load audit logs:", err);
      setError(
        err.message || "Failed to fetch audit events from control plane.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  const handleVerifyChain = async () => {
    setIsVerifying(true);
    try {
      const result = await adminApi.verifyAuditChain();
      setChainStatus(result);
    } catch (err: any) {
      console.error("Failed to verify cryptographic chain:", err);
      setChainStatus({
        valid: false,
        verifiedCount: 0,
        lastEventHash: null,
        errorMessage:
          err.message || "Chain verification network request failed",
      });
    } finally {
      setIsVerifying(false);
    }
  };

  useEffect(() => {
    fetchLogs();
    handleVerifyChain();
  }, [fetchLogs]);

  const filteredLogs = logs.filter((log) => {
    const matchesSearch =
      log.action.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (log.targetId &&
        log.targetId.toLowerCase().includes(searchTerm.toLowerCase())) ||
      (log.actorEmail &&
        log.actorEmail.toLowerCase().includes(searchTerm.toLowerCase())) ||
      (log.sourceIp && log.sourceIp.includes(searchTerm));
    const matchesAction = actionFilter === "ALL" || log.action === actionFilter;
    return matchesSearch && matchesAction;
  });

  const handleExportJson = async () => {
    try {
      const exportData = await adminApi.exportAuditLogs();
      const dataStr =
        "data:text/json;charset=utf-8," +
        encodeURIComponent(JSON.stringify(exportData, null, 2));
      const downloadAnchor = document.createElement("a");
      downloadAnchor.setAttribute("href", dataStr);
      downloadAnchor.setAttribute(
        "download",
        `krypton_audit_package_${Date.now()}.json`,
      );
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
    } catch (err: any) {
      console.error("Export failed:", err);
      // Fallback to local logs
      const dataStr =
        "data:text/json;charset=utf-8," +
        encodeURIComponent(JSON.stringify(filteredLogs, null, 2));
      const downloadAnchor = document.createElement("a");
      downloadAnchor.setAttribute("href", dataStr);
      downloadAnchor.setAttribute(
        "download",
        `krypton_audit_logs_${Date.now()}.json`,
      );
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {/* Zero-Credential Compliance Assurance Banner & Cryptographic Chain State */}
      <div
        className="glass-panel"
        style={{
          padding: "16px 20px",
          borderLeft: chainStatus?.valid
            ? "4px solid #218768"
            : chainStatus
              ? "4px solid #ef4444"
              : "4px solid var(--brand)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "14px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          {chainStatus?.valid ? (
            <ShieldCheck size={26} color="#259775" />
          ) : chainStatus ? (
            <ShieldAlert size={26} color="#ef4444" />
          ) : (
            <ShieldCheck size={26} color="var(--brand)" />
          )}
          <div>
            <div
              style={{ fontSize: "14px", fontWeight: 600, color: "var(--ink)" }}
            >
              Immutable Cryptographic Audit Trail (Section 28 Compliance)
            </div>
            <div
              style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "2px" }}
            >
              {chainStatus ? (
                chainStatus.valid ? (
                  <span style={{ color: "#259775" }}>
                    ✓ Merkle Hash Chain Verified ({chainStatus.verifiedCount}{" "}
                    events chained back to genesis block).
                  </span>
                ) : (
                  <span style={{ color: "#c15975" }}>
                    ⚠ Cryptographic integrity mismatch at index{" "}
                    {chainStatus.errorIndex}: {chainStatus.errorMessage}
                  </span>
                )
              ) : (
                "Zero Credential Exposure Guarantee: All passwords, JWT tokens, private keys, and clipboard payloads are purged."
              )}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", gap: "10px" }}>
          <button
            onClick={handleVerifyChain}
            disabled={isVerifying}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              padding: "8px 12px",
              borderRadius: "6px",
              backgroundColor: "#ffffff",
              border: "1px solid var(--line)",
              color: "#259775",
              fontSize: "12px",
              fontWeight: 600,
              cursor: isVerifying ? "wait" : "pointer",
            }}
          >
            <RefreshCw size={13} className={isVerifying ? "spin" : ""} />
            {isVerifying ? "Verifying..." : "Verify Cryptographic Chain"}
          </button>

          <button
            onClick={handleExportJson}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              padding: "8px 14px",
              borderRadius: "6px",
              backgroundColor: "#ffffff",
              border: "1px solid var(--line)",
              color: "var(--brand)",
              fontSize: "12px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            <Download size={14} />
            Export JSON Audit Package
          </button>
        </div>
      </div>

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

      {/* Filter Toolbar */}
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
          <div
            style={{
              position: "relative",
              display: "flex",
              alignItems: "center",
            }}
          >
            <Search
              size={15}
              style={{ position: "absolute", left: "12px", color: "var(--muted)" }}
            />
            <input
              type="text"
              placeholder="Search action, actor email, IP, target..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              style={{
                padding: "8px 12px 8px 34px",
                width: "320px",
                backgroundColor: "#f8f6fd",
                border: "1px solid var(--line)",
                borderRadius: "8px",
                color: "var(--ink)",
                fontSize: "13px",
                outline: "none",
              }}
            />
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <Filter size={15} color="var(--muted)" />
            <select
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value)}
              style={{
                padding: "8px 12px",
                backgroundColor: "#f8f6fd",
                border: "1px solid var(--line)",
                borderRadius: "8px",
                color: "var(--ink)",
                fontSize: "13px",
                outline: "none",
              }}
            >
              <option value="ALL">All Actions</option>
              <option value="SESSION_START">SESSION_START</option>
              <option value="SESSION_END">SESSION_END</option>
              <option value="SESSION_TERMINATED">SESSION_TERMINATED</option>
              <option value="FILE_TRANSFER_START">FILE_TRANSFER_START</option>
              <option value="CLIPBOARD_SYNC">CLIPBOARD_SYNC</option>
              <option value="SESSION_REQUEST">SESSION_REQUEST</option>
              <option value="DEVICE_ENROLL">DEVICE_ENROLL</option>
            </select>
          </div>
        </div>

        <div style={{ fontSize: "13px", color: "var(--muted)" }}>
          Showing{" "}
          <span style={{ color: "var(--ink)", fontWeight: 600 }}>
            {filteredLogs.length}
          </span>{" "}
          security events
        </div>
      </div>

      {/* Empty State */}
      {!loading && filteredLogs.length === 0 && (
        <div
          className="glass-panel"
          style={{
            padding: "48px 24px",
            textAlign: "center",
            border: "1px dashed var(--line)",
            borderRadius: "12px",
          }}
        >
          <FileText
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
            No Audit Records Found
          </h3>
          <p
            style={{
              fontSize: "13px",
              color: "var(--muted)",
              maxWidth: "420px",
              margin: "0 auto",
            }}
          >
            There are currently no security audit events matching the selected
            filter criteria.
          </p>
        </div>
      )}

      {/* Audit Log Table */}
      {filteredLogs.length > 0 && (
        <div className="glass-panel" style={{ overflow: "hidden" }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              textAlign: "left",
            }}
          >
            <thead>
              <tr
                style={{
                  borderBottom: "1px solid var(--line)",
                  backgroundColor: "rgba(236, 230, 246, 0.6)",
                  fontSize: "12px",
                  textTransform: "uppercase",
                  color: "var(--muted)",
                  letterSpacing: "0.05em",
                }}
              >
                <th style={{ padding: "14px 18px" }}>Timestamp</th>
                <th style={{ padding: "14px 18px" }}>Action</th>
                <th style={{ padding: "14px 18px" }}>Actor</th>
                <th style={{ padding: "14px 18px" }}>Target</th>
                <th style={{ padding: "14px 18px" }}>Source IP</th>
                <th style={{ padding: "14px 18px" }}>Result</th>
                <th style={{ padding: "14px 18px", textAlign: "right" }}>
                  Metadata
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredLogs.map((log) => {
                const isSuccess = log.result === "SUCCESS";
                const isDenied = log.result === "DENIED";

                return (
                  <tr
                    key={log.id}
                    style={{
                      borderBottom: "1px solid var(--line)",
                      transition: "background-color 0.15s ease",
                    }}
                    onMouseEnter={(e) =>
                      (e.currentTarget.style.backgroundColor =
                        "rgba(30, 44, 66, 0.4)")
                    }
                    onMouseLeave={(e) =>
                      (e.currentTarget.style.backgroundColor = "transparent")
                    }
                  >
                    <td style={{ padding: "12px 18px" }}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "6px",
                          fontSize: "12px",
                          color: "var(--text-secondary)",
                        }}
                      >
                        <Clock size={13} color="var(--muted)" />
                        {new Date(log.timestamp).toLocaleString()}
                      </div>
                    </td>

                    <td style={{ padding: "12px 18px" }}>
                      <span
                        style={{
                          fontFamily: "JetBrains Mono, monospace",
                          fontWeight: 600,
                          fontSize: "12px",
                          padding: "3px 8px",
                          borderRadius: "4px",
                          backgroundColor: "#ede8f6",
                          color: "var(--brand)",
                        }}
                      >
                        {log.action}
                      </span>
                    </td>

                    <td style={{ padding: "12px 18px" }}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "6px",
                        }}
                      >
                        {log.actorType === "USER" ? (
                          <User size={14} color="var(--brand)" />
                        ) : (
                          <Laptop size={14} color="#a855f7" />
                        )}
                        <span style={{ fontSize: "13px", color: "#606078" }}>
                          {log.actorEmail || log.actorId}
                        </span>
                      </div>
                    </td>

                    <td style={{ padding: "12px 18px" }}>
                      <div style={{ fontSize: "13px", color: "#686078" }}>
                        {log.targetId || "-"}
                      </div>
                    </td>

                    <td style={{ padding: "12px 18px" }}>
                      <code style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                        {log.sourceIp || "-"}
                      </code>
                    </td>

                    <td style={{ padding: "12px 18px" }}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "6px",
                        }}
                      >
                        {isSuccess ? (
                          <CheckCircle2 size={15} color="#218768" />
                        ) : (
                          <XCircle size={15} color="#ef4444" />
                        )}
                        <span
                          style={{
                            fontSize: "12px",
                            fontWeight: 600,
                            color: isSuccess
                              ? "#218768"
                              : isDenied
                                ? "#f59e0b"
                                : "#ef4444",
                          }}
                        >
                          {log.result}
                        </span>
                      </div>
                    </td>

                    <td style={{ padding: "12px 18px", textAlign: "right" }}>
                      <button
                        onClick={() => setSelectedRecord(log)}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "6px",
                          padding: "5px 10px",
                          borderRadius: "6px",
                          backgroundColor: "#ede8f6",
                          border: "1px solid #c8bfd9",
                          color: "var(--text-secondary)",
                          fontSize: "12px",
                          cursor: "pointer",
                        }}
                      >
                        <Eye size={13} />
                        Inspect
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Metadata Detail Modal */}
      {selectedRecord && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(0, 0, 0, 0.75)",
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
              width: "600px",
              padding: "24px",
              backgroundColor: "#ffffff",
              border: "1px solid var(--line)",
              borderRadius: "14px",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "16px",
              }}
            >
              <div
                style={{ display: "flex", alignItems: "center", gap: "10px" }}
              >
                <FileText size={20} color="var(--brand)" />
                <h3
                  style={{
                    fontSize: "18px",
                    fontWeight: 600,
                    color: "var(--ink)",
                  }}
                >
                  Security Audit Event Details
                </h3>
              </div>
              <button
                onClick={() => setSelectedRecord(null)}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--muted)",
                  cursor: "pointer",
                  fontSize: "18px",
                }}
              >
                ✕
              </button>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "12px",
                marginBottom: "18px",
                fontSize: "13px",
              }}
            >
              <div>
                <span style={{ color: "var(--muted)" }}>Event ID: </span>
                <code style={{ color: "var(--ink)" }}>{selectedRecord.id}</code>
              </div>
              <div>
                <span style={{ color: "var(--muted)" }}>Action: </span>
                <span style={{ color: "var(--brand)", fontWeight: 600 }}>
                  {selectedRecord.action}
                </span>
              </div>
              <div>
                <span style={{ color: "var(--muted)" }}>Actor: </span>
                <span style={{ color: "var(--ink)" }}>
                  {selectedRecord.actorEmail || selectedRecord.actorId}
                </span>
              </div>
              <div>
                <span style={{ color: "var(--muted)" }}>Target: </span>
                <span style={{ color: "var(--ink)" }}>
                  {selectedRecord.targetId}
                </span>
              </div>
            </div>

            <div style={{ marginBottom: "20px" }}>
              <div
                style={{
                  fontSize: "12px",
                  fontWeight: 600,
                  color: "var(--text-secondary)",
                  marginBottom: "8px",
                  display: "flex",
                  justifyContent: "space-between",
                }}
              >
                <span>Sanitized Metadata Payload (JSON):</span>
                <span style={{ color: "#218768", fontSize: "11px" }}>
                  ✓ Zero sensitive tokens
                </span>
              </div>
              <pre
                style={{
                  backgroundColor: "#f9f7fc",
                  border: "1px solid var(--line)",
                  borderRadius: "8px",
                  padding: "14px",
                  color: "#259775",
                  fontSize: "12px",
                  maxHeight: "260px",
                  overflowY: "auto",
                }}
              >
                {JSON.stringify(selectedRecord.metadata, null, 2)}
              </pre>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                onClick={() => setSelectedRecord(null)}
                style={{
                  padding: "8px 18px",
                  backgroundColor: "var(--brand)",
                  border: "none",
                  borderRadius: "6px",
                  color: "#ffffff",
                  fontSize: "13px",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
