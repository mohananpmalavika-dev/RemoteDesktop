# KryptonRemote Windows Host Agent Operations & Service Hardening

## 1. Overview

The KryptonRemote Windows Host Agent runs either as an interactive user desktop application or as a hardened Windows NT service for unattended infrastructure support.

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
