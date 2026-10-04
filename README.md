# KryptonRemote

**Enterprise-Grade Windows Remote Desktop Platform**  
*Built by KryptonLogic Corp*

KryptonRemote is an enterprise-grade Windows remote support and desktop management platform engineered for zero-trust security environments, high-performance WebRTC streaming, and compliance auditing.

---

## Key Capabilities

- **Real WebRTC Transport (P2P + TURN):** RFC 6184 H.264 RTP packetization and depacketization, FU-A fragmentation, 90kHz timestamp conversion, multiplexed SCTP DataChannels (`remote-control`, `clipboard`, `file-transfer`, `telemetry`, `session-control`), and automated failover from direct UDP to authenticated Coturn relay.
- **Cryptographic Device Identity & Signaling Security:** Challenge-response nonce authentication via Ed25519 signatures for devices and Argon2id-derived JWTs for technicians. Sockets are strictly bound to authenticated contexts with full tenant and channel isolation.
- **Tamper-Evident Merkle Audit Logging:** Every security and remote action is recorded with SHA-256 Merkle hash chaining (`eventHash = SHA256(canonicalPayload + previousHash)`). Fully verifiable via `GET /api/v1/audit/verify`.
- **Zero-Credential Exposure (Section 28):** Passwords, JWTs, private keys, and clipboard payloads are recursively purged before persistence.
- **Hardened Windows Host Agent:** DXGI Desktop Duplication, pure-Rust H.264 software encoding with Annex-B start codes, dynamic hardware encoder probing (NVENC/QSV/AMF), multi-monitor display switching, Win32 `SendInput` coordinate normalization, Win32 Service Control Manager (SCM) integration with auto-recovery, and live telemetry (CPU, RAM, Disk, active console session).
- **Productivity Suite:** Attended host consent dialog with granular permissions, bi-directional and client-to-host clipboard synchronization, and resumable chunked file transfers (64KB chunks with end-to-end SHA-256 verification).
- **Zero Mock State:** All sample data, mock timers, and fake fallbacks removed across the production codebase.

---

## Monorepo Architecture

```
KryptonRemote/
├── apps/
│   ├── admin-web/       # React 19 + Vite Enterprise Administration Portal
│   └── desktop/         # Tauri 2 + React Windows Host Agent & Viewer Client
├── crates/
│   ├── capture/         # DXGI Desktop Duplication & frame acquisition
│   ├── clipboard/       # System clipboard polling, hashing & injection
│   ├── device-identity/ # Ed25519 keypair generation & 9-digit Remote ID
│   ├── encoder/         # Pure-Rust H.264 encoder & Adaptive Quality Controller
│   ├── file-transfer/   # Resumable chunked file transfer with SHA-256
│   ├── input/           # Win32 SendInput injection & coordinate mapping
│   ├── platform-windows/# Windows SCM service, UAC elevation & live telemetry
│   ├── remote-core/     # Engine lifecycle & session state machine
│   └── transport/       # WebRTC peer connection, RTP packetizer & DataChannels
├── docs/                # Enterprise documentation, threat models & runbooks
├── packages/
│   ├── config/          # Fail-fast environment variable validation
│   ├── logger/          # Structured Pino logging with redaction
│   ├── protocol/        # Zod-validated signaling message schemas
│   └── shared-types/    # TypeScript types & RBAC permissions
├── prisma/              # PostgreSQL schema & durable migrations
└── services/
    ├── api/             # NestJS 10 REST Control Plane
    └── signaling/       # Cryptographic WebSocket WebRTC signaling server
```

---

## Quick Start

### 1. Prerequisites
- **OS:** Windows 10/11 or Windows Server (x86_64)
- **Node.js:** v20+ & npm 10+
- **Rust:** 1.80+ (toolchain: `x86_64-pc-windows-gnu` or `x86_64-pc-windows-msvc`)
- **Docker & Docker Compose:** for infrastructure dependencies

### 2. Infrastructure Setup
```bash
# Clone and enter directory
git clone https://github.com/KryptonLogic/KryptonRemote.git
cd KryptonRemote

# Copy environment variables
cp .env.example .env

# Start PostgreSQL, Redis, and Coturn
docker compose -f infra/docker-compose.yml up -d

# Apply database schema
npx prisma migrate deploy
```

### 3. Build & Run Microservices
```bash
# Install dependencies
npm install

# Start API control plane
cd services/api && npm run start:dev

# Start Signaling cluster
cd services/signaling && npm run start:dev

# Start Admin Web Portal
cd apps/admin-web && npm run dev
```

### 4. Build Windows Desktop Agent
```bash
cd apps/desktop
npm run tauri dev
```

---

## Running the Automated Test Suite

```bash
# 1. Run all Node.js / TypeScript microservice tests (23 tests):
npm test

# 2. Run all native Rust workspace tests (53 tests):
cargo test --workspace

# 3. Validate frontend production builds:
cd apps/admin-web && npm run build
cd apps/desktop && npm run build
```

---

## Enterprise Documentation

- [Capability Matrix & Production Readiness](file:///C:/RemoteDesktop/docs/CAPABILITY_MATRIX.md)
- [Security Architecture & Standards](file:///C:/RemoteDesktop/docs/SECURITY.md)
- [Threat Model & STRIDE Analysis](file:///C:/RemoteDesktop/docs/THREAT_MODEL.md)
- [Enterprise Deployment Guide](file:///C:/RemoteDesktop/docs/DEPLOYMENT.md)
- [Operations & Runbook](file:///C:/RemoteDesktop/docs/OPERATIONS.md)
- [Automated Test Matrix](file:///C:/RemoteDesktop/docs/TEST_MATRIX.md)
- [Network & Firewall Requirements](file:///C:/RemoteDesktop/docs/NETWORK_REQUIREMENTS.md)
- [Coturn Deployment & Configuration](file:///C:/RemoteDesktop/docs/TURN_DEPLOYMENT.md)
- [Windows Host Agent & Service Guide](file:///C:/RemoteDesktop/docs/WINDOWS_AGENT.md)

---

## License

Copyright © 2026 KryptonLogic Corp. All rights reserved.
Commercial Enterprise Software.
