# KryptonRemote Threat Model & STRIDE Analysis

## 1. Scope & System Boundaries

The KryptonRemote platform encompasses:
- Native Windows Desktop Host Agent (`crates/*`, `apps/desktop`)
- Web Admin Portal (`apps/admin-web`)
- API Control Plane (`services/api`)
- WebRTC Signaling Cluster (`services/signaling`)
- TURN / STUN Relays (`infra/coturn`)
- Ephemeral Cache & PubSub (Redis)
- Durable State Store (PostgreSQL)

---

## 2. Threat Actors & Capabilities

| Threat Actor | Motivations | Capabilities / Attack Vectors |
| :--- | :--- | :--- |
| **Malicious Technician** | Exfiltrate corporate intellectual property, install unauthorized backdoors | Valid credentials in an organization, authenticated remote control capability |
| **Compromised Host Agent** | Pivot into other corporate machines or manipulate control plane | Controls local OS, attempts spoofing signaling payloads or other device identities |
| **Rogue / Compelled TURN Operator** | Inspect or manipulate video streams, steal files in transit | Controls network relay intermediary, inspects UDP packets |
| **Network Man-in-the-Middle (MITM)** | Hijack sessions, replay signaling messages | Sits on public network or coffee shop Wi-Fi |
| **Tenant Cross-Polluter** | Access another company's devices or audit records | Multi-tenant tenant user attempting parameter tampering (IDOR) |

---

## 3. STRIDE Analysis & Mitigations

### 3.1. Spoofing
- **Threat:** A compromised host or technician sends signaling messages pretending to be another device ID or user ID.
- **Mitigation:** The signaling server ignores client-provided identity strings in message payloads. Sockets are strictly bound to `AuthenticatedSocketContext` established via Ed25519 signature or JWT validation at connection handshake.

### 3.2. Tampering
- **Threat:** An attacker tampers with database audit logs to erase evidence of unauthorized remote control.
- **Mitigation:** Tamper-evident Merkle hash chaining. Each audit event includes `SHA256(canonicalPayload + previousHash)`. Any mutation of previous rows invalidates the cryptographic chain verification endpoint (`GET /audit/verify`).
- **Threat:** Modification of file chunks in transit.
- **Mitigation:** Full-file SHA-256 integrity verification after chunk reassembly before disk commitment.

### 3.3. Repudiation
- **Threat:** A technician denies taking actions on a remote device (e.g., viewing confidential files).
- **Mitigation:** Authoritative session audit records logged in PostgreSQL with actor ID, organization ID, source IP, timestamp, and Merkle hash verification.

### 3.4. Information Disclosure
- **Threat:** Password hashes, tokens, or confidential clipboard data leaking into log files or telemetry dashboards.
- **Mitigation:** Zero-credential sanitization filter strips sensitive fields recursively before persistence. Structured logging redacts authorization headers.

### 3.5. Denial of Service
- **Threat:** Flooding signaling WebSockets or API endpoints with connection requests.
- **Mitigation:** Token bucket and sliding window rate limiting in signaling server and NestJS throttler guard in API gateway.

### 3.6. Elevation of Privilege
- **Threat:** An attended support session bypassing host consent or granting file transfer when the host only permitted screen viewing.
- **Mitigation:** Host agent enforces local permission gates. If the host consent dialog did not grant `fileTransfer`, incoming file transfer data channel messages are rejected at the native Rust layer.
