# KryptonRemote Security Architecture & Specification

## 1. Overview

KryptonRemote is engineered from the ground up on zero-trust principles. No client or peer is inherently trusted; authoritative state is enforced by the control plane and cryptographic challenge-response mechanisms.

---

## 2. Cryptographic Standards

| Mechanism | Algorithm / Standard | Specification / Implementation |
| :--- | :--- | :--- |
| **Device Identity** | Ed25519 (Edwards-curve Digital Signature Algorithm) | RFC 8032 via `ed25519-dalek` |
| **Technician Passwords** | Argon2id | Memory: 64MB, Iterations: 3, Parallelism: 4 |
| **Token Verification** | HMAC-SHA256 (JWT) | RS256 / HS256 with 15-minute access token lifespan |
| **Transport Encryption** | DTLS 1.3 / SRTP & SCTP over DTLS | AES-256-GCM / TLS_AES_256_GCM_SHA384 |
| **Audit Chaining** | SHA-256 Merkle Chain | `SHA256(canonicalPayload + previousHash)` |
| **File Integrity** | SHA-256 | Validated end-to-end after chunk reassembly |

---

## 3. Zero-Credential Exposure Policy (Section 28)

KryptonRemote guarantees that sensitive credentials never enter storage, persistent logging, or unauthenticated transport:
1. **Sanitization Filter:**
   All metadata entering the audit system is recursively inspected. The following keys are strictly deleted:
   - `password`, `passwordHash`, `salt`
   - `token`, `refreshToken`, `accessToken`, `jwt`
   - `privateKey`, `secret`, `signingKey`
   - `clipboardContent` (replaced by length and content hash)
2. **PostgreSQL Protection:**
   Database fields storing audit metadata are guaranteed to be purged of plain secrets.
3. **Log Obfuscation:**
   Pino structured loggers are configured with redaction paths for authorization headers, cookie headers, and private keys.

---

## 4. Signaling Authentication & Tenant Isolation

1. **Instant Challenge Nonce:**
   Upon WebSocket connection to the signaling server (`ws://signaling:4001`), the server immediately transmits an `AUTH_CHALLENGE` message containing a cryptographically random 32-byte hexadecimal nonce.
2. **Signature Verification:**
   - **Device:** Signs `nonce` with its local Ed25519 private key. The server queries the database for the enrolled public key and verifies `Ed25519::verify(nonce, signature, publicKey)`.
   - **User:** Presents a signed JWT. The server validates the cryptographic signature and checks that the user has not been revoked.
3. **Socket Context Binding:**
   Once verified, the socket is bound to an `AuthenticatedSocketContext`:
   ```ts
   {
     entityType: 'USER' | 'DEVICE',
     entityId: string,
     organizationId: string,
     role?: string,
     permissions: KryptonPermission[]
   }
   ```
4. **Session Message Authorization:**
   Every signaling message (`OFFER`, `ANSWER`, `ICE_CANDIDATE`, `SESSION_ACCEPT`, `SESSION_REJECT`, `SESSION_END`) undergoes strict multi-tenant and session membership validation. Messages referencing unauthorized session IDs or mismatching organization IDs are immediately dropped with a 4403 status.

---

## 5. Attended Host Consent & Remote Control

1. **Mandatory Consent Dialog:**
   When an incoming session request is signaled to a host device, a modal dialog appears requesting explicit user acceptance.
2. **Granular Permissions:**
   The host user can toggle individual permissions:
   - View Screen
   - Remote Mouse & Keyboard Control
   - Clipboard Synchronization
   - File Transfer
3. **Emergency Disconnect:**
   The local host user retains absolute priority over remote inputs. Moving the physical mouse or clicking the system tray "Sever Connection" immediately tears down the WebRTC data channels and kills the capture session.

---

## 6. Vulnerability Disclosure & Incident Response

Security issues should be reported directly to security@kryptonlogic.com with PGP encryption. Security advisories are tracked and published under CVE guidelines.
