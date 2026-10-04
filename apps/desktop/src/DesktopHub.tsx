import { useRef, useState, type FormEvent } from "react";
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
  ArrowUpRight,
  Lock,
  Search,
  Command,
  Zap,
  ChevronRight,
  CircleHelp,
  Laptop,
  Radio,
} from "lucide-react";

type Tab =
  | "home"
  | "devices"
  | "file-transfer"
  | "sessions"
  | "settings"
  | "diagnostics";
interface Device {
  id: string;
  name: string;
  remoteId: string;
  lastConnected: string;
  os: string;
}
interface Props {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  remoteId: string;
  deviceName: string;
  isElevated: boolean;
  monitorCount: number;
  isNative: boolean;
  copied: boolean;
  copyError: string;
  onCopyId: () => void;
  remoteIdInput: string;
  onRemoteIdChange: (value: string) => void;
  onConnect: (event: FormEvent) => void;
  connecting: boolean;
  connectionError: string;
  recentDevices: Device[];
}
const tabs = [
  { id: "home", label: "Connection hub", icon: Monitor },
  { id: "devices", label: "My devices", icon: HardDrive },
  { id: "sessions", label: "Session history", icon: History },
  { id: "file-transfer", label: "File transfer", icon: FolderSync },
  { id: "settings", label: "Settings", icon: Settings },
  { id: "diagnostics", label: "Diagnostics", icon: Activity },
] as const;

export function DesktopHub(p: Props) {
  const [query, setQuery] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const validIdentity = /^\d{9}$/.test(p.remoteId.replace(/\s/g, ""));
  const goConnect = (id = "") => {
    if (id) p.onRemoteIdChange(id);
    p.onTabChange("home");
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
    });
  };
  const devices = p.recentDevices.filter((d) =>
    `${d.name} ${d.remoteId}`.toLowerCase().includes(query.toLowerCase()),
  );
  const recentList = (full = false) => (
    <section className="recent-panel">
      <div className="section-heading">
        <div>
          <h2>
            {p.activeTab === "sessions"
              ? "Connection history"
              : "Recent devices"}{" "}
            <span className="count-badge">{p.recentDevices.length}</span>
          </h2>
          <p>Your next connection is just a click away.</p>
        </div>
        {!full && (
          <button
            className="text-button"
            onClick={() => p.onTabChange("devices")}
          >
            View all devices <ArrowUpRight size={15} />
          </button>
        )}
      </div>
      {full && (
        <label className="search-field">
          <Search size={17} />
          <input
            aria-label="Search recent devices"
            placeholder="Search by device name or Remote ID"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      )}
      {devices.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">
            <Laptop size={25} />
            <span className="tiny-plus">+</span>
          </div>
          <div>
            <h3>
              {query ? "No matching devices" : "Your connections start here"}
            </h3>
            <p>
              {query
                ? "Try a different name or Remote ID."
                : "Devices you connect to will appear here for easy access."}
            </p>
          </div>
          <button className="secondary-button" onClick={() => goConnect()}>
            Connect a device <ArrowRight size={15} />
          </button>
        </div>
      ) : (
        <div className="table-scroll">
          <table className="recent-devices-table">
            <thead>
              <tr>
                <th>Device name</th>
                <th>Remote ID</th>
                <th>Platform</th>
                <th>Last connected</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.id}>
                  <td>
                    <span className="table-device">
                      <span className="device-small-icon">
                        <Monitor size={17} />
                      </span>
                      {d.name}
                    </span>
                  </td>
                  <td className="device-id-cell">{d.remoteId}</td>
                  <td>{d.os}</td>
                  <td>{d.lastConnected}</td>
                  <td>
                    <button
                      className="btn-connect-sm"
                      onClick={() => goConnect(d.remoteId)}
                    >
                      Connect <ArrowUpRight size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
  return (
    <>
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="brand-icon">
            <Command size={24} />
          </div>
          <div className="brand-stack">
            <span className="brand-title">
              krypton<span>remote</span>
            </span>
            <span className="brand-tag">YOUR WORLD. CONNECTED.</span>
          </div>
        </div>
        <div className="workspace-selector">
          <span className="workspace-avatar">KL</span>
          <div>
            <strong>My workspace</strong>
            <small>Personal workspace</small>
          </div>
          <ChevronRight size={15} />
        </div>
        <nav className="sidebar-nav" aria-label="Main navigation">
          <span className="nav-label">WORKSPACE</span>
          {tabs.map(({ id, label, icon: Icon }, i) => (
            <button
              key={id}
              className={`nav-item ${p.activeTab === id ? "active" : ""} ${i === 4 ? "nav-separated" : ""}`}
              aria-current={p.activeTab === id ? "page" : undefined}
              onClick={() => p.onTabChange(id)}
            >
              <Icon size={18} />
              <span>{label}</span>
              {p.activeTab === id && <span className="nav-active-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="security-note">
            <ShieldCheck size={20} />
            <strong>Private by design</strong>
            <p>
              Your device. Your permissions.
              <br />
              You're always in control.
            </p>
          </div>
          <button
            className="help-button"
            onClick={() => setShowHelp(!showHelp)}
            aria-expanded={showHelp}
          >
            <CircleHelp size={17} />
            Connection guide
            <ArrowUpRight size={14} />
          </button>
          <div className="sidebar-footer">
            <div className="user-avatar">D</div>
            <div className="user-info">
              <span className="user-name">Dhanya</span>
              <span className="user-role">IT Administrator</span>
            </div>
            <span className="account-dot" />
          </div>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <ChevronRight size={13} />
            <span>{tabs.find((t) => t.id === p.activeTab)?.label}</span>
          </div>
          <div
            className={`header-status ${!p.isNative ? "preview-status" : ""}`}
          >
            <span className="status-indicator" />
            {p.isNative ? "Desktop client" : "Browser preview"}
          </div>
        </header>
        <div className="content-body">
          {showHelp && (
            <section className="help-panel">
              <div>
                <CircleHelp size={20} />
                <h2>Make your first connection</h2>
              </div>
              <ol>
                <li>Open KryptonRemote on both Windows devices.</li>
                <li>Ask the other person for their 9-digit Remote ID.</li>
                <li>
                  Enter their ID and connect. They choose which permissions to
                  allow.
                </li>
              </ol>
              <button
                className="text-button"
                onClick={() => setShowHelp(false)}
              >
                Got it <Check size={15} />
              </button>
            </section>
          )}
          {p.activeTab === "home" ? (
            <>
              <section className="hero">
                <div className="hero-copy">
                  <div className="eyebrow">
                    <span /> YOUR REMOTE WORKSPACE
                  </div>
                  <h1>
                    Your world.
                    <br />
                    <span>Within reach.</span>
                  </h1>
                  <p>
                    Your devices, one connection away.
                    <br />
                    Connect securely and pick up where you left off.
                  </p>
                </div>
                <div className="connection-art" aria-hidden="true">
                  <div className="orbit orbit-one" />
                  <div className="orbit orbit-two" />
                  <div className="art-grid" />
                  <div className="art-line" />
                  <div className="art-computer computer-back">
                    <span className="art-window-bar">
                      <i />
                      <i />
                      <i />
                    </span>
                    <div className="art-screen-lines">
                      <i />
                      <i />
                      <i />
                    </div>
                  </div>
                  <div className="art-computer computer-front">
                    <span className="art-window-bar">
                      <i />
                      <i />
                      <i />
                    </span>
                    <div className="art-screen-symbol">
                      <Command size={28} />
                    </div>
                    <span className="art-screen-footer" />
                  </div>
                  <div className="art-security">
                    <Lock size={17} />
                  </div>
                  <span className="art-tag">
                    <span /> A closer connection
                  </span>
                  <span className="art-spark spark-one" />
                  <span className="art-spark spark-two" />
                </div>
              </section>
              <div className="dashboard-grid">
                <section className="card connect-card">
                  <div className="card-header">
                    <div className="card-icon">
                      <ArrowUpRight size={20} />
                    </div>
                    <span className="step-number">01 / CONNECT</span>
                  </div>
                  <h2>Make your next connection.</h2>
                  <p className="card-description">
                    Enter a Remote ID to access another device.
                  </p>
                  <form onSubmit={p.onConnect} className="connect-form">
                    <label htmlFor="remote-id">Remote ID</label>
                    <div
                      className={`input-wrapper ${p.connectionError ? "has-error" : ""}`}
                    >
                      <Monitor size={19} />
                      <input
                        ref={inputRef}
                        id="remote-id"
                        type="text"
                        inputMode="numeric"
                        autoComplete="off"
                        maxLength={15}
                        placeholder="000 000 000"
                        value={p.remoteIdInput}
                        onChange={(e) => p.onRemoteIdChange(e.target.value)}
                        aria-invalid={!!p.connectionError}
                        aria-describedby={
                          p.connectionError
                            ? "connection-error"
                            : "connect-note"
                        }
                        className="remote-id-input"
                      />
                    </div>
                    <button
                      type="submit"
                      className="btn-primary"
                      disabled={p.connecting}
                    >
                      {p.connecting ? "Connecting…" : "Connect to device"}
                      <ArrowRight size={18} />
                    </button>
                    {p.connectionError && (
                      <p
                        id="connection-error"
                        className="inline-error"
                        role="alert"
                      >
                        {p.connectionError}
                      </p>
                    )}
                  </form>
                  <div className="connect-note" id="connect-note">
                    <Lock size={12} />
                    End-to-end encrypted connection
                  </div>
                </section>
                <section className="card device-card">
                  <div className="card-header">
                    <div className="card-icon">
                      <Monitor size={20} />
                    </div>
                    <span className="step-number">02 / SHARE ACCESS</span>
                  </div>
                  <h2>Your device. Your invitation.</h2>
                  <p className="card-description">
                    Share your ID to let someone connect to you.
                  </p>
                  <div className="identity-label">YOUR REMOTE ID</div>
                  <div
                    className={`remote-id-display ${!validIdentity ? "identity-unavailable" : ""}`}
                  >
                    {p.remoteId}
                  </div>
                  <button
                    className="copy-id-button"
                    onClick={p.onCopyId}
                    disabled={!validIdentity}
                  >
                    {p.copied ? <Check size={15} /> : <Copy size={15} />}
                    <span aria-live="polite">
                      {p.copied ? "ID copied to clipboard" : "Copy Remote ID"}
                    </span>
                  </button>
                  {p.copyError && (
                    <p className="inline-error" role="alert">
                      {p.copyError}
                    </p>
                  )}
                  <div className="device-bottom">
                    <div className="device-host">
                      <span className="host-icon">
                        <Laptop size={18} />
                      </span>
                      <div>
                        <strong>{p.deviceName}</strong>
                        <small>
                          {p.isNative
                            ? "Windows · " +
                              p.monitorCount +
                              (p.monitorCount === 1 ? " display" : " displays")
                            : "Launch the desktop app to get your ID"}
                        </small>
                      </div>
                    </div>
                    <span
                      className={`status-badge ${!validIdentity ? "standby" : ""}`}
                    >
                      <span className="status-indicator" />
                      {validIdentity
                        ? "Ready"
                        : p.isNative
                          ? "Unavailable"
                          : "Preview"}
                    </span>
                  </div>
                </section>
              </div>
              {recentList()}
              <div className="trust-strip">
                <span>
                  <ShieldCheck size={16} />
                  You approve every incoming connection
                </span>
                <span>
                  <Zap size={16} />
                  Direct device-to-device streaming
                </span>
              </div>
            </>
          ) : (
            <>
              <div className="page-heading">
                <div className="eyebrow">YOUR WORKSPACE</div>
                <h1>{tabs.find((t) => t.id === p.activeTab)?.label}</h1>
                <p>
                  {p.activeTab === "devices"
                    ? "The devices you have connected to, all in one place."
                    : p.activeTab === "sessions"
                      ? "Return to devices from your recent connections."
                      : p.activeTab === "file-transfer"
                        ? "Move files between connected devices."
                        : p.activeTab === "settings"
                          ? "Your local device and access settings."
                          : "A closer look at your desktop client."}
                </p>
              </div>
              {(p.activeTab === "devices" || p.activeTab === "sessions") &&
                recentList(true)}
              {p.activeTab === "file-transfer" && (
                <section className="feature-panel">
                  <div className="feature-icon">
                    <FolderSync size={35} />
                  </div>
                  <span className="eyebrow">BUILT FOR YOUR WORKFLOW</span>
                  <h2>Your files. On the other side.</h2>
                  <p>
                    Start a remote session with file transfer permission.
                    <br />
                    Use the session toolbar to send files to the connected
                    device.
                  </p>
                  <button className="btn-primary" onClick={() => goConnect()}>
                    Start a connection <ArrowRight size={18} />
                  </button>
                  <div className="feature-details">
                    <span>
                      <Lock size={15} />
                      Encrypted in transit
                    </span>
                    <span>
                      <Check size={15} />
                      File integrity verification
                    </span>
                  </div>
                </section>
              )}
              {(p.activeTab === "settings" ||
                p.activeTab === "diagnostics") && (
                <>
                  <section className="details-panel">
                    <div className="section-heading">
                      <div>
                        <h2>
                          {p.activeTab === "settings"
                            ? "Device & access"
                            : "Client environment"}
                        </h2>
                        <p>
                          {p.isNative
                            ? "Information from this desktop client."
                            : "Native device information is available in the Windows app."}
                        </p>
                      </div>
                      <Activity size={20} />
                    </div>
                    <dl className="details-list">
                      <div>
                        <dt>Device name</dt>
                        <dd>{p.deviceName}</dd>
                      </div>
                      <div>
                        <dt>Remote ID</dt>
                        <dd>{p.remoteId}</dd>
                      </div>
                      <div>
                        <dt>Environment</dt>
                        <dd>
                          {p.isNative ? "Windows desktop" : "Browser preview"}
                        </dd>
                      </div>
                      <div>
                        <dt>Privilege level</dt>
                        <dd>
                          {p.isNative
                            ? p.isElevated
                              ? "Administrator"
                              : "Standard user"
                            : "Unavailable in browser"}
                        </dd>
                      </div>
                      <div>
                        <dt>Displays</dt>
                        <dd>
                          {p.isNative
                            ? p.monitorCount
                            : "Unavailable in browser"}
                        </dd>
                      </div>
                      <div>
                        <dt>Session status</dt>
                        <dd>
                          <Radio size={14} />
                          No active viewer session
                        </dd>
                      </div>
                    </dl>
                  </section>
                  <div className="info-banner">
                    <ShieldCheck size={22} />
                    <div>
                      <strong>You decide who gets access.</strong>
                      <p>
                        Screen control, clipboard, and file transfers are
                        approved individually when you accept a support request.
                      </p>
                    </div>
                  </div>
                </>
              )}
            </>
          )}
          <footer className="content-footer">
            <span>
              KRYPTONREMOTE <span className="footer-divider">/</span> STAY
              CONNECTED.
            </span>
            <span>
              v1.0 <span className="footer-divider">·</span> Made for your
              workspace
            </span>
          </footer>
        </div>
      </main>
    </>
  );
}
