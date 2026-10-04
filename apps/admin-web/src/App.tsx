import React, { useState, useEffect } from 'react';
import {
  Laptop,
  Radio,
  FileText,
  Shield,
  Building2,
  Lock,
  Cpu
} from 'lucide-react';
import { DeviceInventory } from './components/DeviceInventory';
import { ActiveSessionMonitor } from './components/ActiveSessionMonitor';
import { AuditLogViewer } from './components/AuditLogViewer';
import { TenantPolicyManager } from './components/TenantPolicyManager';
import { adminApi } from './api/client';

type Tab = 'inventory' | 'sessions' | 'audit' | 'policies';

export const App: React.FC = () => {
  const [currentTab, setCurrentTab] = useState<Tab>('inventory');
  const [activeSessionCount, setActiveSessionCount] = useState<number>(0);
  const [controlPlaneStatus, setControlPlaneStatus] = useState<'OPERATIONAL' | 'DEGRADED' | 'DISCONNECTED'>('OPERATIONAL');

  useEffect(() => {
    async function checkStatus() {
      try {
        const health = await adminApi.checkHealth();
        if (health && health.status === 'UP') {
          setControlPlaneStatus('OPERATIONAL');
        } else {
          setControlPlaneStatus('DEGRADED');
        }
      } catch {
        setControlPlaneStatus('DISCONNECTED');
      }

      try {
        const sessions = await adminApi.getActiveSessions();
        setActiveSessionCount(sessions.length);
      } catch {
        // preserve current count if temporary network fluctuation
      }
    }

    checkStatus();
    const interval = setInterval(checkStatus, 6000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div
      style={{
        display: 'flex',
        minHeight: '100vh',
        backgroundColor: '#07090e',
        color: '#f1f5f9',
      }}
    >
      {/* Sidebar Navigation */}
      <aside
        style={{
          width: '260px',
          borderRight: '1px solid #1e2c42',
          backgroundColor: '#0b0f19',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '24px 16px',
        }}
      >
        <div>
          {/* Brand Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '32px', paddingLeft: '8px' }}>
            <div
              style={{
                width: '36px',
                height: '36px',
                borderRadius: '8px',
                backgroundColor: '#2563eb',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 0 16px rgba(37, 99, 235, 0.4)',
              }}
            >
              <Cpu size={22} color="#ffffff" />
            </div>
            <div>
              <div style={{ fontSize: '16px', fontWeight: 800, letterSpacing: '-0.02em', color: '#f8fafc' }}>
                KryptonRemote
              </div>
              <div style={{ fontSize: '11px', color: '#38bdf8', fontWeight: 600, textTransform: 'uppercase' }}>
                Admin Portal v1.0
              </div>
            </div>
          </div>

          {/* Nav Items */}
          <nav style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <button
              onClick={() => setCurrentTab('inventory')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '10px 14px',
                borderRadius: '8px',
                border: 'none',
                backgroundColor: currentTab === 'inventory' ? '#1e293b' : 'transparent',
                color: currentTab === 'inventory' ? '#38bdf8' : '#94a3b8',
                fontSize: '14px',
                fontWeight: currentTab === 'inventory' ? 600 : 500,
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'all 0.15s ease',
              }}
            >
              <Laptop size={18} />
              Device Inventory
            </button>

            <button
              onClick={() => setCurrentTab('sessions')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '10px 14px',
                borderRadius: '8px',
                border: 'none',
                backgroundColor: currentTab === 'sessions' ? '#1e293b' : 'transparent',
                color: currentTab === 'sessions' ? '#38bdf8' : '#94a3b8',
                fontSize: '14px',
                fontWeight: currentTab === 'sessions' ? 600 : 500,
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'all 0.15s ease',
              }}
            >
              <Radio size={18} />
              Active Sessions
              <span
                style={{
                  marginLeft: 'auto',
                  backgroundColor: activeSessionCount > 0 ? '#10b981' : '#334155',
                  color: '#ffffff',
                  fontSize: '11px',
                  fontWeight: 700,
                  padding: '1px 6px',
                  borderRadius: '10px',
                }}
              >
                {activeSessionCount}
              </span>
            </button>

            <button
              onClick={() => setCurrentTab('audit')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '10px 14px',
                borderRadius: '8px',
                border: 'none',
                backgroundColor: currentTab === 'audit' ? '#1e293b' : 'transparent',
                color: currentTab === 'audit' ? '#38bdf8' : '#94a3b8',
                fontSize: '14px',
                fontWeight: currentTab === 'audit' ? 600 : 500,
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'all 0.15s ease',
              }}
            >
              <FileText size={18} />
              Audit Trail
            </button>

            <button
              onClick={() => setCurrentTab('policies')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '10px 14px',
                borderRadius: '8px',
                border: 'none',
                backgroundColor: currentTab === 'policies' ? '#1e293b' : 'transparent',
                color: currentTab === 'policies' ? '#38bdf8' : '#94a3b8',
                fontSize: '14px',
                fontWeight: currentTab === 'policies' ? 600 : 500,
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'all 0.15s ease',
              }}
            >
              <Shield size={18} />
              Tenant Policies
            </button>
          </nav>
        </div>

        {/* Tenant Details Footer */}
        <div
          style={{
            padding: '14px',
            borderRadius: '10px',
            backgroundColor: '#07090e',
            border: '1px solid #1e2c42',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
            <Building2 size={16} color="#60a5fa" />
            <span style={{ fontSize: '13px', fontWeight: 600, color: '#f8fafc' }}>
              KryptonLogic Corp
            </span>
          </div>
          <div style={{ fontSize: '11px', color: '#64748b' }}>
            Tenant: <code style={{ color: '#94a3b8' }}>org_enterprise_prod</code>
          </div>
          <div
            style={{
              marginTop: '10px',
              paddingTop: '8px',
              borderTop: '1px solid #1a2538',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <Lock size={12} color="#10b981" />
            <span style={{ fontSize: '11px', color: '#34d399', fontWeight: 600 }}>
              MFA Gated (Argon2id/TOTP)
            </span>
          </div>
        </div>
      </aside>

      {/* Main Content Pane */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
        {/* Top Navbar */}
        <header
          style={{
            height: '64px',
            borderBottom: '1px solid #1e2c42',
            backgroundColor: '#0b0f19',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 32px',
          }}
        >
          <div style={{ fontSize: '18px', fontWeight: 700, color: '#f8fafc' }}>
            {currentTab === 'inventory' && 'Managed Device Fleet'}
            {currentTab === 'sessions' && 'Active Remote Connections'}
            {currentTab === 'audit' && 'Security & Compliance Audit Trail'}
            {currentTab === 'policies' && 'Fleet Governance & Security Policies'}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '5px 12px',
                borderRadius: '20px',
                backgroundColor:
                  controlPlaneStatus === 'OPERATIONAL'
                    ? 'rgba(16, 185, 129, 0.1)'
                    : controlPlaneStatus === 'DEGRADED'
                    ? 'rgba(245, 158, 11, 0.1)'
                    : 'rgba(239, 68, 68, 0.1)',
                border:
                  controlPlaneStatus === 'OPERATIONAL'
                    ? '1px solid rgba(16, 185, 129, 0.3)'
                    : controlPlaneStatus === 'DEGRADED'
                    ? '1px solid rgba(245, 158, 11, 0.3)'
                    : '1px solid rgba(239, 68, 68, 0.3)',
              }}
            >
              <span
                style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  backgroundColor:
                    controlPlaneStatus === 'OPERATIONAL'
                      ? '#10b981'
                      : controlPlaneStatus === 'DEGRADED'
                      ? '#f59e0b'
                      : '#ef4444',
                }}
              />
              <span
                style={{
                  fontSize: '12px',
                  fontWeight: 600,
                  color:
                    controlPlaneStatus === 'OPERATIONAL'
                      ? '#34d399'
                      : controlPlaneStatus === 'DEGRADED'
                      ? '#fbbf24'
                      : '#f87171',
                }}
              >
                Control Plane: {controlPlaneStatus === 'OPERATIONAL' ? 'Operational' : controlPlaneStatus === 'DEGRADED' ? 'Degraded' : 'Offline / Standby'}
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div
                style={{
                  width: '34px',
                  height: '34px',
                  borderRadius: '50%',
                  backgroundColor: '#1e3a8a',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#93c5fd',
                  fontWeight: 600,
                  fontSize: '13px',
                }}
              >
                SA
              </div>
              <div>
                <div style={{ fontSize: '13px', fontWeight: 600, color: '#f1f5f9' }}>
                  System Administrator
                </div>
                <div style={{ fontSize: '11px', color: '#64748b' }}>
                  admin@kryptonlogic.com
                </div>
              </div>
            </div>
          </div>
        </header>

        {/* Dynamic Tab Body */}
        <div style={{ padding: '32px', flex: 1 }}>
          {currentTab === 'inventory' && <DeviceInventory />}
          {currentTab === 'sessions' && <ActiveSessionMonitor />}
          {currentTab === 'audit' && <AuditLogViewer />}
          {currentTab === 'policies' && <TenantPolicyManager />}
        </div>
      </main>
    </div>
  );
};

export default App;
