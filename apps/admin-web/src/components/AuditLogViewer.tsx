import React, { useState, useEffect, useCallback } from 'react';
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
  ShieldAlert
} from 'lucide-react';
import { adminApi, AuditRecordDto, ChainVerificationResultDto } from '../api/client';

export type AuditRecord = AuditRecordDto;

export const AuditLogViewer: React.FC = () => {
  const [logs, setLogs] = useState<AuditRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [actionFilter, setActionFilter] = useState('ALL');
  const [selectedRecord, setSelectedRecord] = useState<AuditRecord | null>(null);
  const [chainStatus, setChainStatus] = useState<ChainVerificationResultDto | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);

  const fetchLogs = useCallback(async () => {
    try {
      setError(null);
      const data = await adminApi.getAuditLogs(100, 0);
      setLogs(data);
    } catch (err: any) {
      console.warn('Failed to load audit logs:', err);
      setError(err.message || 'Failed to fetch audit events from control plane.');
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
      console.error('Failed to verify cryptographic chain:', err);
      setChainStatus({
        valid: false,
        verifiedCount: 0,
        lastEventHash: null,
        errorMessage: err.message || 'Chain verification network request failed',
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
      (log.targetId && log.targetId.toLowerCase().includes(searchTerm.toLowerCase())) ||
      (log.actorEmail && log.actorEmail.toLowerCase().includes(searchTerm.toLowerCase())) ||
      (log.sourceIp && log.sourceIp.includes(searchTerm));
    const matchesAction = actionFilter === 'ALL' || log.action === actionFilter;
    return matchesSearch && matchesAction;
  });

  const handleExportJson = async () => {
    try {
      const exportData = await adminApi.exportAuditLogs();
      const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(exportData, null, 2));
      const downloadAnchor = document.createElement('a');
      downloadAnchor.setAttribute('href', dataStr);
      downloadAnchor.setAttribute('download', `krypton_audit_package_${Date.now()}.json`);
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
    } catch (err: any) {
      console.error('Export failed:', err);
      // Fallback to local logs
      const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(filteredLogs, null, 2));
      const downloadAnchor = document.createElement('a');
      downloadAnchor.setAttribute('href', dataStr);
      downloadAnchor.setAttribute('download', `krypton_audit_logs_${Date.now()}.json`);
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* Zero-Credential Compliance Assurance Banner & Cryptographic Chain State */}
      <div
        className="glass-panel"
        style={{
          padding: '16px 20px',
          borderLeft: chainStatus?.valid ? '4px solid #10b981' : chainStatus ? '4px solid #ef4444' : '4px solid #3b82f6',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '14px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {chainStatus?.valid ? (
            <ShieldCheck size={26} color="#34d399" />
          ) : chainStatus ? (
            <ShieldAlert size={26} color="#ef4444" />
          ) : (
            <ShieldCheck size={26} color="#60a5fa" />
          )}
          <div>
            <div style={{ fontSize: '14px', fontWeight: 600, color: '#f8fafc' }}>
              Immutable Cryptographic Audit Trail (Section 28 Compliance)
            </div>
            <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '2px' }}>
              {chainStatus ? (
                chainStatus.valid ? (
                  <span style={{ color: '#34d399' }}>
                    ✓ Merkle Hash Chain Verified ({chainStatus.verifiedCount} events chained back to genesis block).
                  </span>
                ) : (
                  <span style={{ color: '#f87171' }}>
                    ⚠ Cryptographic integrity mismatch at index {chainStatus.errorIndex}: {chainStatus.errorMessage}
                  </span>
                )
              ) : (
                'Zero Credential Exposure Guarantee: All passwords, JWT tokens, private keys, and clipboard payloads are purged.'
              )}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            onClick={handleVerifyChain}
            disabled={isVerifying}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '8px 12px',
              borderRadius: '6px',
              backgroundColor: '#131b2a',
              border: '1px solid #1e2c42',
              color: '#34d399',
              fontSize: '12px',
              fontWeight: 600,
              cursor: isVerifying ? 'wait' : 'pointer',
            }}
          >
            <RefreshCw size={13} className={isVerifying ? 'spin' : ''} />
            {isVerifying ? 'Verifying...' : 'Verify Cryptographic Chain'}
          </button>

          <button
            onClick={handleExportJson}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '8px 14px',
              borderRadius: '6px',
              backgroundColor: '#131b2a',
              border: '1px solid #1e2c42',
              color: '#38bdf8',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
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

      {/* Filter Toolbar */}
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
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <Search size={15} style={{ position: 'absolute', left: '12px', color: '#64748b' }} />
            <input
              type="text"
              placeholder="Search action, actor email, IP, target..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              style={{
                padding: '8px 12px 8px 34px',
                width: '320px',
                backgroundColor: '#0d121c',
                border: '1px solid #1e2c42',
                borderRadius: '8px',
                color: '#f1f5f9',
                fontSize: '13px',
                outline: 'none',
              }}
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Filter size={15} color="#64748b" />
            <select
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value)}
              style={{
                padding: '8px 12px',
                backgroundColor: '#0d121c',
                border: '1px solid #1e2c42',
                borderRadius: '8px',
                color: '#f1f5f9',
                fontSize: '13px',
                outline: 'none',
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

        <div style={{ fontSize: '13px', color: '#64748b' }}>
          Showing <span style={{ color: '#f1f5f9', fontWeight: 600 }}>{filteredLogs.length}</span> security events
        </div>
      </div>

      {/* Empty State */}
      {!loading && filteredLogs.length === 0 && (
        <div
          className="glass-panel"
          style={{
            padding: '48px 24px',
            textAlign: 'center',
            border: '1px dashed #1e2c42',
            borderRadius: '12px',
          }}
        >
          <FileText size={36} color="#64748b" style={{ margin: '0 auto 12px auto' }} />
          <h3 style={{ fontSize: '16px', fontWeight: 600, color: '#cbd5e1', marginBottom: '6px' }}>
            No Audit Records Found
          </h3>
          <p style={{ fontSize: '13px', color: '#64748b', maxWidth: '420px', margin: '0 auto' }}>
            There are currently no security audit events matching the selected filter criteria.
          </p>
        </div>
      )}

      {/* Audit Log Table */}
      {filteredLogs.length > 0 && (
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
                <th style={{ padding: '14px 18px' }}>Timestamp</th>
                <th style={{ padding: '14px 18px' }}>Action</th>
                <th style={{ padding: '14px 18px' }}>Actor</th>
                <th style={{ padding: '14px 18px' }}>Target</th>
                <th style={{ padding: '14px 18px' }}>Source IP</th>
                <th style={{ padding: '14px 18px' }}>Result</th>
                <th style={{ padding: '14px 18px', textAlign: 'right' }}>Metadata</th>
              </tr>
            </thead>
            <tbody>
              {filteredLogs.map((log) => {
                const isSuccess = log.result === 'SUCCESS';
                const isDenied = log.result === 'DENIED';

                return (
                  <tr
                    key={log.id}
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
                    <td style={{ padding: '12px 18px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#94a3b8' }}>
                        <Clock size={13} color="#64748b" />
                        {new Date(log.timestamp).toLocaleString()}
                      </div>
                    </td>

                    <td style={{ padding: '12px 18px' }}>
                      <span
                        style={{
                          fontFamily: 'JetBrains Mono, monospace',
                          fontWeight: 600,
                          fontSize: '12px',
                          padding: '3px 8px',
                          borderRadius: '4px',
                          backgroundColor: '#1e293b',
                          color: '#60a5fa',
                        }}
                      >
                        {log.action}
                      </span>
                    </td>

                    <td style={{ padding: '12px 18px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        {log.actorType === 'USER' ? (
                          <User size={14} color="#38bdf8" />
                        ) : (
                          <Laptop size={14} color="#a855f7" />
                        )}
                        <span style={{ fontSize: '13px', color: '#e2e8f0' }}>
                          {log.actorEmail || log.actorId}
                        </span>
                      </div>
                    </td>

                    <td style={{ padding: '12px 18px' }}>
                      <div style={{ fontSize: '13px', color: '#cbd5e1' }}>{log.targetId || '-'}</div>
                    </td>

                    <td style={{ padding: '12px 18px' }}>
                      <code style={{ fontSize: '12px', color: '#94a3b8' }}>{log.sourceIp || '-'}</code>
                    </td>

                    <td style={{ padding: '12px 18px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        {isSuccess ? (
                          <CheckCircle2 size={15} color="#10b981" />
                        ) : (
                          <XCircle size={15} color="#ef4444" />
                        )}
                        <span
                          style={{
                            fontSize: '12px',
                            fontWeight: 600,
                            color: isSuccess ? '#10b981' : isDenied ? '#f59e0b' : '#ef4444',
                          }}
                        >
                          {log.result}
                        </span>
                      </div>
                    </td>

                    <td style={{ padding: '12px 18px', textAlign: 'right' }}>
                      <button
                        onClick={() => setSelectedRecord(log)}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '6px',
                          padding: '5px 10px',
                          borderRadius: '6px',
                          backgroundColor: '#1e293b',
                          border: '1px solid #334155',
                          color: '#94a3b8',
                          fontSize: '12px',
                          cursor: 'pointer',
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
              width: '600px',
              padding: '24px',
              backgroundColor: '#0d131f',
              border: '1px solid #27354a',
              borderRadius: '14px',
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
                <FileText size={20} color="#38bdf8" />
                <h3 style={{ fontSize: '18px', fontWeight: 600, color: '#f8fafc' }}>
                  Security Audit Event Details
                </h3>
              </div>
              <button
                onClick={() => setSelectedRecord(null)}
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

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: '12px',
                marginBottom: '18px',
                fontSize: '13px',
              }}
            >
              <div>
                <span style={{ color: '#64748b' }}>Event ID: </span>
                <code style={{ color: '#f1f5f9' }}>{selectedRecord.id}</code>
              </div>
              <div>
                <span style={{ color: '#64748b' }}>Action: </span>
                <span style={{ color: '#60a5fa', fontWeight: 600 }}>{selectedRecord.action}</span>
              </div>
              <div>
                <span style={{ color: '#64748b' }}>Actor: </span>
                <span style={{ color: '#f1f5f9' }}>{selectedRecord.actorEmail || selectedRecord.actorId}</span>
              </div>
              <div>
                <span style={{ color: '#64748b' }}>Target: </span>
                <span style={{ color: '#f1f5f9' }}>{selectedRecord.targetId}</span>
              </div>
            </div>

            <div style={{ marginBottom: '20px' }}>
              <div
                style={{
                  fontSize: '12px',
                  fontWeight: 600,
                  color: '#94a3b8',
                  marginBottom: '8px',
                  display: 'flex',
                  justifyContent: 'space-between',
                }}
              >
                <span>Sanitized Metadata Payload (JSON):</span>
                <span style={{ color: '#10b981', fontSize: '11px' }}>✓ Zero sensitive tokens</span>
              </div>
              <pre
                style={{
                  backgroundColor: '#07090e',
                  border: '1px solid #1e2c42',
                  borderRadius: '8px',
                  padding: '14px',
                  color: '#34d399',
                  fontSize: '12px',
                  maxHeight: '260px',
                  overflowY: 'auto',
                }}
              >
                {JSON.stringify(selectedRecord.metadata, null, 2)}
              </pre>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setSelectedRecord(null)}
                style={{
                  padding: '8px 18px',
                  backgroundColor: '#2563eb',
                  border: 'none',
                  borderRadius: '6px',
                  color: '#ffffff',
                  fontSize: '13px',
                  fontWeight: 600,
                  cursor: 'pointer',
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
