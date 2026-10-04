import React, { useState, useEffect } from 'react';
import {
  Shield,
  Lock,
  Clock,
  Clipboard,
  FileDown,
  Video,
  Save,
  CheckCircle2,
  AlertCircle
} from 'lucide-react';
import { adminApi, TenantPolicyDto } from '../api/client';

export const TenantPolicyManager: React.FC = () => {
  const [requireMfa, setRequireMfa] = useState(true);
  const [enforceConsent, setEnforceConsent] = useState(true);
  const [idleTimeoutMin, setIdleTimeoutMin] = useState(15);
  const [clipboardPolicy, setClipboardPolicy] = useState<'BIDIRECTIONAL' | 'CLIENT_TO_HOST' | 'DISABLED'>('BIDIRECTIONAL');
  const [maxFileMb, setMaxFileMb] = useState(500);
  const [sessionRecording, setSessionRecording] = useState(true);
  const [savedNotice, setSavedNotice] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadPolicies() {
      try {
        setError(null);
        const policies = await adminApi.getPolicies();
        if (policies) {
          setRequireMfa(policies.requireMfa ?? true);
          setEnforceConsent(policies.enforceConsent ?? true);
          setIdleTimeoutMin(policies.idleTimeoutMin ?? 15);
          setClipboardPolicy(policies.clipboardPolicy || 'BIDIRECTIONAL');
          setMaxFileMb(policies.maxFileMb ?? 500);
          setSessionRecording(policies.sessionRecording ?? true);
        }
      } catch (err: any) {
        console.warn('Failed to load policies from API, using default policy values:', err);
      } finally {
        setLoading(false);
      }
    }
    loadPolicies();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const payload: TenantPolicyDto = {
        requireMfa,
        enforceConsent,
        idleTimeoutMin,
        clipboardPolicy,
        maxFileMb,
        sessionRecording,
      };
      await adminApi.updatePolicies(payload);
      setSavedNotice(true);
      setTimeout(() => setSavedNotice(false), 4000);
    } catch (err: any) {
      setError(err.message || 'Failed to commit security policies to control plane.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '800px' }}>
      {savedNotice && (
        <div
          style={{
            padding: '12px 16px',
            borderRadius: '8px',
            backgroundColor: 'rgba(16, 185, 129, 0.15)',
            border: '1px solid rgba(16, 185, 129, 0.4)',
            color: '#34d399',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            fontSize: '14px',
          }}
        >
          <CheckCircle2 size={18} />
          Organization Security Policies successfully committed to PostgreSQL. Applied immediately to all fleet agents.
        </div>
      )}

      {error && (
        <div
          style={{
            padding: '12px 16px',
            borderRadius: '8px',
            backgroundColor: 'rgba(239, 68, 68, 0.15)',
            border: '1px solid rgba(239, 68, 68, 0.4)',
            color: '#f87171',
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

      <div className="glass-panel" style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '22px' }}>
        <div>
          <h3 style={{ fontSize: '18px', fontWeight: 600, color: '#f8fafc', marginBottom: '4px' }}>
            Enterprise Security Policy Controls
          </h3>
          <p style={{ fontSize: '13px', color: '#94a3b8' }}>
            Enforce mandatory zero-trust governance rules across all technicians and enrolled devices.
          </p>
        </div>

        {/* Policy Items */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* MFA */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '14px 16px',
              backgroundColor: '#0a0e17',
              borderRadius: '8px',
              border: '1px solid #1a2538',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <Lock size={20} color="#38bdf8" />
              <div>
                <div style={{ fontSize: '14px', fontWeight: 600, color: '#f1f5f9' }}>
                  Enforce Multi-Factor Authentication (MFA / TOTP)
                </div>
                <div style={{ fontSize: '12px', color: '#64748b' }}>
                  Requires RFC 6238 TOTP verification on every technician sign-in before session authorization.
                </div>
              </div>
            </div>
            <input
              type="checkbox"
              checked={requireMfa}
              onChange={(e) => setRequireMfa(e.target.checked)}
              style={{ width: '18px', height: '18px', cursor: 'pointer', accentColor: '#2563eb' }}
            />
          </div>

          {/* Attended Consent */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '14px 16px',
              backgroundColor: '#0a0e17',
              borderRadius: '8px',
              border: '1px solid #1a2538',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <Shield size={20} color="#34d399" />
              <div>
                <div style={{ fontSize: '14px', fontWeight: 600, color: '#f1f5f9' }}>
                  Mandatory Attended Host Consent Dialog
                </div>
                <div style={{ fontSize: '12px', color: '#64748b' }}>
                  Requires local desktop user to explicitly click "Accept" and select allowed permissions.
                </div>
              </div>
            </div>
            <input
              type="checkbox"
              checked={enforceConsent}
              onChange={(e) => setEnforceConsent(e.target.checked)}
              style={{ width: '18px', height: '18px', cursor: 'pointer', accentColor: '#2563eb' }}
            />
          </div>

          {/* Idle Timeout */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '14px 16px',
              backgroundColor: '#0a0e17',
              borderRadius: '8px',
              border: '1px solid #1a2538',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <Clock size={20} color="#f59e0b" />
              <div>
                <div style={{ fontSize: '14px', fontWeight: 600, color: '#f1f5f9' }}>
                  Automatic Idle Disconnect
                </div>
                <div style={{ fontSize: '12px', color: '#64748b' }}>
                  Automatically closes connection when zero keyboard or mouse inputs are detected.
                </div>
              </div>
            </div>
            <select
              value={idleTimeoutMin}
              onChange={(e) => setIdleTimeoutMin(parseInt(e.target.value, 10))}
              style={{
                padding: '6px 12px',
                backgroundColor: '#131b2a',
                border: '1px solid #1e2c42',
                borderRadius: '6px',
                color: '#f1f5f9',
                fontSize: '13px',
              }}
            >
              <option value={5}>5 Minutes</option>
              <option value={15}>15 Minutes</option>
              <option value={30}>30 Minutes</option>
              <option value={60}>1 Hour</option>
            </select>
          </div>

          {/* Clipboard Policy */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '14px 16px',
              backgroundColor: '#0a0e17',
              borderRadius: '8px',
              border: '1px solid #1a2538',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <Clipboard size={20} color="#a855f7" />
              <div>
                <div style={{ fontSize: '14px', fontWeight: 600, color: '#f1f5f9' }}>
                  Clipboard Synchronization Policy
                </div>
                <div style={{ fontSize: '12px', color: '#64748b' }}>
                  Control bidirectional data loss prevention rules for remote clipboard.
                </div>
              </div>
            </div>
            <select
              value={clipboardPolicy}
              onChange={(e) => setClipboardPolicy(e.target.value as any)}
              style={{
                padding: '6px 12px',
                backgroundColor: '#131b2a',
                border: '1px solid #1e2c42',
                borderRadius: '6px',
                color: '#f1f5f9',
                fontSize: '13px',
              }}
            >
              <option value="BIDIRECTIONAL">Bidirectional Sync</option>
              <option value="CLIENT_TO_HOST">Client-to-Host Only (DLP Safe)</option>
              <option value="DISABLED">Completely Disabled</option>
            </select>
          </div>

          {/* File Transfer Size */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '14px 16px',
              backgroundColor: '#0a0e17',
              borderRadius: '8px',
              border: '1px solid #1a2538',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <FileDown size={20} color="#06b6d4" />
              <div>
                <div style={{ fontSize: '14px', fontWeight: 600, color: '#f1f5f9' }}>
                  Max Resumable File Transfer Size
                </div>
                <div style={{ fontSize: '12px', color: '#64748b' }}>
                  Enforces per-transfer limit with SHA-256 integrity verification.
                </div>
              </div>
            </div>
            <select
              value={maxFileMb}
              onChange={(e) => setMaxFileMb(parseInt(e.target.value, 10))}
              style={{
                padding: '6px 12px',
                backgroundColor: '#131b2a',
                border: '1px solid #1e2c42',
                borderRadius: '6px',
                color: '#f1f5f9',
                fontSize: '13px',
              }}
            >
              <option value={100}>100 MB</option>
              <option value={500}>500 MB</option>
              <option value={2048}>2 GB (Large Package)</option>
              <option value={10240}>10 GB</option>
            </select>
          </div>

          {/* Screen Recording */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '14px 16px',
              backgroundColor: '#0a0e17',
              borderRadius: '8px',
              border: '1px solid #1a2538',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <Video size={20} color="#ec4899" />
              <div>
                <div style={{ fontSize: '14px', fontWeight: 600, color: '#f1f5f9' }}>
                  Mandatory Session Screen Recording
                </div>
                <div style={{ fontSize: '12px', color: '#64748b' }}>
                  Captures H.264 video of all remote sessions for corporate compliance audits.
                </div>
              </div>
            </div>
            <input
              type="checkbox"
              checked={sessionRecording}
              onChange={(e) => setSessionRecording(e.target.checked)}
              style={{ width: '18px', height: '18px', cursor: 'pointer', accentColor: '#2563eb' }}
            />
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '10px' }}>
          <button
            onClick={handleSave}
            disabled={saving || loading}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '10px 20px',
              borderRadius: '8px',
              backgroundColor: '#2563eb',
              border: 'none',
              color: '#ffffff',
              fontSize: '14px',
              fontWeight: 600,
              cursor: saving ? 'wait' : 'pointer',
              boxShadow: '0 2px 10px rgba(37, 99, 235, 0.3)',
            }}
          >
            <Save size={16} />
            {saving ? 'Saving...' : 'Commit Policy Updates'}
          </button>
        </div>
      </div>
    </div>
  );
};
