# KryptonRemote — Architecture & Codebase Audit

**Date:** 2026-09-21  
**Project:** KryptonRemote (KryptonLogic)  
**Target:** Production-Grade Remote Desktop Platform  

---

## 1. Executive Summary & Repository State

- **Current Workspace Status:** `C:\RemoteDesktop` is currently a clean, empty repository.
- **Existing Code / Mocks:** None. Zero legacy debt, zero stubbed mocks, zero fake setTimeout loops.
- **System Environment Assessment:**
  - **Operating System:** Windows 10/11 x64
  - **Node.js Runtime:** `v24.15.0`
  - **Package Manager:** `npm 11.12.1`
  - **Container Runtime:** `Docker 29.4.2` (Docker Compose supported)
  - **Version Control:** `git 2.53.0.windows.3`
  - **Native Compiler Toolchain:** Rustup available via winget (`Rustlang.Rustup 1.29.1`) for the native capture, input, and WebRTC streaming engine (`crates/*`).

---

## 2. Architecture & Design Alignment

### 2.1 Core Pillars
1. **Control Plane & Signaling:**
   - **Backend Services:** NestJS + TypeScript, modular microservice / modular monolith structure (`services/api`, `services/signaling`, `services/session-broker`).
   - **Database & Storage:** PostgreSQL for relational, audit, and durable records with Prisma typed migrations; Redis for presence, ephemeral signaling routing, distributed rate-limiting, and short-lived session states.
   - **Signaling Protocol:** Strict JSON schema versioned WebSockets (`wss://`) with tenant isolation, cryptographic handshake, and session tokens.
2. **Native Remote Engine (`crates/*`):**
   - **Capture:** Windows Graphics Capture (WGC) and DXGI Desktop Duplication (`crates/capture`).
   - **Input & Display:** Win32 SendInput with accurate multi-monitor and DPI scaling normalization (`crates/input`).
   - **Video Pipeline:** Frame buffer damage detection, H.264/VP8 encoding pipeline with graceful software fallback (`crates/encoder`).
   - **WebRTC Transport:** Direct P2P via ICE/STUN; Coturn TURN relay fallback (`crates/transport`).
   - **Device Identity:** Hardware-backed/DPAPI-protected cryptographic key pairs (Ed25519) generated locally during device enrollment (`crates/device-identity`).
3. **Client Applications:**
   - **Desktop App (`apps/desktop`):** Tauri 2 + React + TypeScript + Vite. Operates in dual roles: Remote Host Agent and Viewer Client.
   - **Admin Web Console (`apps/admin-web`):** React + Vite + TanStack Query + Tailwind/Enterprise CSS for device inventory, audit trail, role assignment, and policy configuration.

---

## 3. Strict Prohibitions & Verification Gates

Per non-negotiable guidelines:
- **No Mocking in Production:** Mocks are strictly restricted to isolated automated test suites.
- **No Silent Fallbacks:** Production builds will fail-fast if environment variables (`DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, etc.) are missing or resolving to `localhost`.
- **Zero Stealth / OS Bypasses:** All elevation and remote operations conform to standard Windows security boundaries, explicit user consent prompts, and system tray notifications.
- **Strict Cryptographic Device Identity:** No remote connections authenticated solely by Remote ID, MAC address, or hostname.

---

## 4. Phase-by-Phase Roadmap

1. **Phase 1: Foundation (Monorepo, Backend Skeleton, Tauri Desktop Shell, Docker Compose, DB Migrations)**
2. **Phase 2: Identity, Device Enrollment, RBAC & Presence**
3. **Phase 3: Session Broker, Consent Flow & WebRTC Signaling**
4. **Phase 4: Production Screen Capture & Video Pipeline**
5. **Phase 5: Remote Input Injection & Multi-DPI Coordinate Mapping**
6. **Phase 6: Productivity Suite (Clipboard, Encrypted Chunked File Transfer, Multi-Monitor)**
7. **Phase 7: Enterprise Hardening (Admin Console, Audit System, System Tray, Packaging)**
8. **Phase 8: Release Gate, Security Scans & SBOM Validation**
