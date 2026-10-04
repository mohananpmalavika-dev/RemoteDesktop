# KryptonRemote Windows Host Agent Operations & Service Hardening

## 1. Overview

The KryptonRemote Windows Host Agent runs either as an interactive user desktop application or as a hardened Windows NT service for unattended infrastructure support.

### Getting the device's 9-digit Remote ID

In the desktop Connection hub, enter your API server URL (for example
`https://remote.example.com/api/v1`) and a single-use device enrollment token
issued by an administrator through `POST /api/v1/devices/enrollment-tokens`.
Click **Get Remote ID**. The server assigns the ID; **Copy Remote ID** copies
its nine digits, while the screen displays `XXX XXX XXX`.

The client saves the registration in its Tauri local app data directory and
protects its private key with Windows DPAPI for the current user. Restarting
the app keeps the same identity and ID. Enrollment tokens are not saved.
For local development, `http://localhost:4000/api/v1` is supported; use the
configured API port. Remote servers require HTTPS.

An unregistered device displays **Registration required**. The cryptographic
public key is never displayed or copied as a Remote ID. **Registered** means
an ID was assigned, not that host signaling is online. The desktop's existing
viewer/host signaling integration still needs completion for connections
between two computers; registering an ID alone does not establish a session.

---

## 2. Windows Service Deployment & Lifecycle

The agent interacts with the Windows Service Control Manager (SCM) using native Win32 APIs and CLI management.

### Service Installation:
```powershell
# Run with elevated Administrator privileges:
sc.exe create KryptonRemoteAgent binPath= "C:\Program Files\KryptonRemote\krypton-desktop.exe --service" DisplayName= "KryptonRemote Host Service" start= auto
sc.exe failure KryptonRemoteAgent reset= 86400 actions= restart/60000/restart/60000/restart/60000
sc.exe start KryptonRemoteAgent
```

### Automatic Recovery Configuration:
- `reset= 86400`: Clears failure counter after 24 hours of stable uptime.
- `actions= restart/60000/restart/60000/restart/60000`: Automatically restarts the service after 60 seconds on first, second, and subsequent crashes.

---

## 3. UAC & Secure Desktop Interaction

1. **Elevation Check:**
   The agent checks its elevation level via `is_process_elevated()` using `OpenProcessToken` and `GetTokenInformation(TokenElevation)`.
2. **UAC Prompts & Session Switching:**
   Standard user processes cannot interact with elevated UAC consent prompts or Winlogon desktop screens (Desktop 0 isolation). When installed as an elevated Windows Service, the agent uses `WTSGetActiveConsoleSessionId` and duplicates the active user's winlogon token to display consent dialogues and inject keyboard combinations (such as Ctrl+Alt+Del).

---

## 4. Unattended vs. Attended Modes

| Feature | Attended Support Mode | Unattended Infrastructure Mode |
| :--- | :--- | :--- |
| **Startup Type** | On-demand by user or startup tray | Windows NT Service (`start= auto`) |
| **Consent Prompt** | Required on screen before control | Pre-authorized via Tenant Policy |
| **User Notifications** | System tray notification & live indicator | System event logging & admin audit trail |
| **Permissions** | Granularly chosen by user | Bound to Organization Tenant Policy |
| **Disconnection** | Host user can sever instantly | Administrative kill via Web Portal |

---

## 5. Uninstallation

```powershell
sc.exe stop KryptonRemoteAgent
sc.exe delete KryptonRemoteAgent
Remove-Item -Recurse -Force "C:\ProgramData\KryptonRemote"
```
