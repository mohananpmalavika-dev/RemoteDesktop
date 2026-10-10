import React, { useState, useEffect } from "react";
import {
  Laptop,
  Radio,
  FileText,
  Shield,
  Lock,
  Building2,
  Command,
  ChevronRight,
  ArrowUpRight,
  Monitor,
} from "lucide-react";
import { DeviceInventory } from "./components/DeviceInventory";
import { ActiveSessionMonitor } from "./components/ActiveSessionMonitor";
import { AuditLogViewer } from "./components/AuditLogViewer";
import { TenantPolicyManager } from "./components/TenantPolicyManager";
import { WebRemoteViewer } from "./components/WebRemoteViewer";
import { adminApi, CurrentUser, getAuthToken } from "./api/client";
import { AuthPanel } from "./components/AuthPanel";

type Tab = "viewer" | "inventory" | "sessions" | "audit" | "policies";

export const App: React.FC = () => {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [showAuth, setShowAuth] = useState(false);
  useEffect(() => {
    const load = () => { if (getAuthToken()) void adminApi.me().then(setUser).catch(() => setUser(null)); else setUser(null); };
    load(); window.addEventListener('krypton:auth-changed', load);
    return () => window.removeEventListener('krypton:auth-changed', load);
  }, []);
  const [currentTab, setCurrentTab] = useState<Tab>("viewer");
  const [selectedRemoteId, setSelectedRemoteId] = useState<string>("");
  const [activeSessionCount, setActiveSessionCount] = useState<number>(0);
  const [controlPlaneStatus, setControlPlaneStatus] = useState<
    "OPERATIONAL" | "DEGRADED" | "DISCONNECTED"
  >("DISCONNECTED");

  useEffect(() => {
    // Check URL parameters for direct remote connection (e.g. ?remoteId=834951220)
    const params = new URLSearchParams(window.location.search);
    const paramRemoteId = params.get("remoteId");
    if (paramRemoteId) {
      setSelectedRemoteId(paramRemoteId);
      setCurrentTab("viewer");
    }
  }, []);

  useEffect(() => {
    async function checkStatus() {
      try {
        const health = await adminApi.checkHealth();
        if (health && health.status === "UP") {
          setControlPlaneStatus("OPERATIONAL");
        } else {
          setControlPlaneStatus("DEGRADED");
        }
      } catch {
        setControlPlaneStatus("DISCONNECTED");
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
  }, [user]);

  const pages = {
    viewer: {
      title: "Connection hub.",
      subtitle: "A little less distance. A lot more possibility.",
      label: "Remote Viewer",
      icon: Monitor,
    },
    inventory: {
      title: "Your fleet. Under control.",
      subtitle: "Manage your devices and make every connection count.",
      label: "Device inventory",
      icon: Laptop,
    },
    sessions: {
      title: "A closer connection.",
      subtitle:
        "Monitor and manage live remote sessions across your workspace.",
      label: "Active sessions",
      icon: Radio,
    },
    audit: {
      title: "Every action. Accounted for.",
      subtitle: "Track security events and review your workspace activity.",
      label: "Audit trail",
      icon: FileText,
    },
    policies: {
      title: "Your rules. Everywhere.",
      subtitle: "Set the access policies that protect your entire fleet.",
      label: "Tenant policies",
      icon: Shield,
    },
  };
  return (
    <div className="admin-app">
      <aside className="admin-sidebar">
        <div className="admin-brand">
          <div className="admin-brand-icon">
            <Command size={24} />
          </div>
          <div>
            <strong>
              krypton<span>remote</span>
            </strong>
            <small>YOUR WORLD. CONNECTED.</small>
          </div>
        </div>
        <div className="admin-workspace">
          <span>KL</span>
          <div>
            <strong>{user?.organization.name || "Public viewer"}</strong>
            <small>Admin workspace</small>
          </div>
          <ChevronRight size={15} />
        </div>
        <nav aria-label="Administration">
          <span className="admin-nav-label">CONTROL CENTER</span>
          {(Object.keys(pages) as Tab[]).map((tab) => {
            const Icon = pages[tab].icon;
            return (
              <button
                key={tab}
                className={`admin-nav-item ${currentTab === tab ? "active" : ""}`}
                aria-current={currentTab === tab ? "page" : undefined}
                onClick={() => { if (tab !== "viewer" && !user) setShowAuth(true); else setCurrentTab(tab); }}
              >
                <Icon size={18} />
                <span>{pages[tab].label}</span>
                {tab === "sessions" && (
                  <span className="admin-count">{activeSessionCount}</span>
                )}
              </button>
            );
          })}
        </nav>
        <div className="admin-sidebar-bottom">
          <div className="admin-security">
            <Shield size={23} />
            <strong>Built for peace of mind.</strong>
            <p>
              Device identity, access policies,
              <br />
              and an auditable workspace.
            </p>
          </div>
          <button className="admin-account" onClick={() => setShowAuth(true)}>
            <span className="admin-avatar">SA</span>
            <div>
              <strong>{user?.username || "Sign in"}</strong>
              <small>{user?.email || "Manage your workspace"}</small>
            </div>
          </button>
        </div>
      </aside>
      <main className="admin-main">
        <header className="admin-topbar">
          <div className="admin-breadcrumb">
            Workspace <ChevronRight size={13} />
            <span>{pages[currentTab].label}</span>
          </div>
          <span
            className={`admin-plane-status ${controlPlaneStatus.toLowerCase()}`}
          >
            <i />
            Control plane{" "}
            {controlPlaneStatus === "OPERATIONAL"
              ? "online"
              : controlPlaneStatus === "DEGRADED"
                ? "degraded"
                : "offline"}
          </span>
        </header>
        <div className="admin-content">
          <section className="admin-heading">
            <div>
              <span className="admin-eyebrow">
                KRYPTON / YOUR REMOTE WORKSPACE
              </span>
              <h1>{pages[currentTab].title}</h1>
              <p>{pages[currentTab].subtitle}</p>
            </div>
            <div className="admin-heading-icon">
              <Building2 size={37} />
              <ArrowUpRight size={18} />
            </div>
          </section>
          {showAuth && <AuthPanel user={user} onSignedIn={setUser} onClose={() => setShowAuth(false)} />}
          <div className="admin-tab-content">
            {currentTab === "viewer" && (
              <WebRemoteViewer initialRemoteId={selectedRemoteId} />
            )}
            {user && currentTab === "inventory" && (
              <DeviceInventory
                onConnect={(remoteId) => {
                  setSelectedRemoteId(remoteId);
                  setCurrentTab("viewer");
                }}
              />
            )}
            {user && currentTab === "sessions" && <ActiveSessionMonitor />}
            {user && currentTab === "audit" && <AuditLogViewer />}
            {user && currentTab === "policies" && <TenantPolicyManager />}
          </div>
          <footer className="admin-footer">
            <span>
              <Lock size={12} />
              Your workspace. Your control.
            </span>
            <span>KRYPTONREMOTE / ADMIN v1.0</span>
          </footer>
        </div>
      </main>
    </div>
  );
};

export default App;
