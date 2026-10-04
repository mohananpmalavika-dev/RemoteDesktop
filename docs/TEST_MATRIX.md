# KryptonRemote Automated Test Matrix

## 1. Scope & Execution

The KryptonRemote test suite spans both native Rust systems crates and TypeScript / Node.js microservices. All tests run in continuous integration pipelines before binary signing and artifact publication.

---

## 2. Test Suites Summary

### 2.1. Native Rust Crates (`cargo test --workspace`)

| Crate | Tests | Key Capabilities Verified |
| :--- | :---: | :--- |
| `krypton-device-identity` | 5 | Ed25519 key generation, PEM serialization, public key fingerprinting, Remote ID derivation (9-digit format). |
| `krypton-input` | 8 | Mouse input injection, keyboard scan code mapping, special combos (Ctrl+Alt+Del, Alt+Tab, TaskMgr), permission enforcement. |
| `krypton-file-transfer` | 8 | Inbound/outbound chunking, SHA-256 verification, resume state machine, transfer cancellation, permission gates. |
| `krypton-remote-core` | 7 | Engine state transitions, identity lifecycle, multi-monitor enumeration, session coordination. |
| `krypton-capture` | 3 | DXGI duplication initialization, dirty rect bounding, BGRA frame buffer allocations. |
| `krypton-clipboard` | 4 | Clipboard polling, text hashing, local/remote injection, permission gates. |
| `krypton-platform-windows` | 6 | Elevation query (`OpenProcessToken`), monitor detection, live telemetry (CPU, RAM, Disk, WTS session), Win32 SCM controller & recovery actions. |
| `krypton-transport` | 10 | RFC 6184 H.264 RTP packetizer (Single NALU & FU-A fragmentation), RTP depacketizer & loss tracking, ICE candidate parsing, route metrics, DataChannels. |
| `krypton-encoder` | 11 | Pure-Rust H.264 software encoding, BGRA to YUV420 conversion, Annex-B start codes, backend hardware probing, adaptive quality hysteresis controller. |
| **Total Rust Tests** | **62** | **100% Passing** |

---

### 2.2. Microservices & Web Applications (`npm test`)

| Package / Service | Tests | Key Capabilities Verified |
| :--- | :---: | :--- |
| `@krypton/protocol` | 3 | Zod schemas, signaling message validation, discriminator unions, type guards. |
| `@krypton/config` | 3 | Fail-fast environment variable validation, production default fallbacks. |
| `services/signaling` | 4 | Nonce challenge issuance, Ed25519 signature validation, JWT authentication, socket binding, tenant isolation. |
| `services/api` (Auth) | 5 | Argon2id password hashing, RFC 6238 TOTP verification, JWT issuance, token rotation. |
| `services/api` (Session) | 4 | Authoritative session lifecycle, Redis presence caching, active session termination. |
| `services/api` (Audit) | 4 | Zero-credential purge, paginated queries, Merkle hash chaining, tamper detection & chain verification. |
| **Total Node Tests** | **23** | **100% Passing** |

---

## 3. How to Run the Tests

```bash
# Run all TypeScript / Node.js tests across the monorepo:
npm test

# Run all Rust native crate tests across the workspace:
cargo test --workspace

# Run production build validation for Admin Web:
cd apps/admin-web && npm run build

# Run production build validation for Desktop Tauri app:
cd apps/desktop && npm run build
```
