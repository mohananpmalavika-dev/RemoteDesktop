# Production readiness - 2026-10-10

Scope: Windows attended host/desktop viewer and public browser connections by Remote ID.

Status: release candidate implementation; production approval is pending the release gates below. Automated tests do not prove a complete two-machine remote support session.

## Changes implemented

- Removed tokenless enrollment, automatic organization creation, fabricated device availability, and synthetic connected states from the user connection path.
- Added signed Ed25519 host HTTP requests, timestamp/nonces and replay protection, authoritative key revocation, strict request validation, and Redis-backed rate limiting.
- Isolated guest tokens to one session. Protected administration rejects guest/MFA tokens, inactive users, cross-tenant identities, and revoked token families. Refresh rotation claims tokens atomically; login/MFA setup challenges are scoped and single-use.
- Enforced tenant ownership, verified MFA policy, capability reduction, host consent expiry, exclusive active host sessions, correct signaling routing, and immediate session termination on revocation.
- Added host enrollment/runtime discovery, challenge authentication, reconnection, real WebRTC SDP/ICE exchange, capture delivery, H.264 fragmentation/reassembly and decoding, remote input, clipboard and file channel handling.
- Added capture initialization error propagation, idle screen keyframes, bounded buffering, live bitrate updates, and permission revocation/capture shutdown on disconnect. Screen capture cannot be shared when screen permission is declined.
- Added no-clobber, path, metadata, chunk-size, and checksum validation for native downloads; browser sender/receiver handshake and verified downloads.
- Added account registration/login/MFA UI, durable tenant policies, real host telemetry, serialized audit chains, recursive credential redaction, and detection of changes to stored audit fields.
- Added versioned database migrations, non-root containers, required production secrets, authenticated Redis, private PostgreSQL/Redis ports, TLS proxy, readiness checks, desktop CSP, CI and a disposable-service integration harness.

## Verification evidence

| Check | Result |
| --- | --- |
| TypeScript production builds, API/signaling and both frontends | Passed locally; repeated after final changes |
| Workspace TypeScript type checks, including both frontends | Passed locally after dependency builds |
| TypeScript regression suite | 56 tests passed, including nested credential redaction and stored-field tamper assertions |
| Windows Rust workspace suite | 62 workspace tests passed, including Windows display enumeration, capture-path/encoder checks and clipboard roundtrip; the expanded 6-test file-transfer suite also passed (64 native tests total) |
| Tauri Windows compilation | Passed locally with `cargo check --package krypton-desktop --locked` |
| Full npm dependency audit | 0 vulnerabilities after compatible Nest patches, Vitest update, and the scoped deepmerge-ts override; Prisma generation passed with the override |
| Production Compose configuration parsing | Passed with disposable configuration; daemon/image execution remains pending |
| Migration SQL generation, schema validation and Prisma client generation | Passed; migrations have not been applied to a live database in this session |
| Disposable database/API/signaling integration | Harness and CI added; not executed locally because Docker Desktop/service could not start |
| Browser visual verification | Not executed: no browser surfaces available in computer-use tools |
| Installer build/signature, internet P2P and forced TURN | Pending |

The existing suite includes mocked service dependencies and protocol/unit tests. The capture-path test uses a generated gradient if Windows denies capture, such as on a locked desktop; it does not prove decoded screen pixels at the viewer. The native transport crate tests are not evidence that the frontend connection path completed SDP negotiation and delivered a remote desktop across two machines.

## Required release gates

1. Run the CI service job against fresh PostgreSQL/Redis, including migration application, API/signaling integration and both Docker image builds. Verify migration baseline/upgrade on a restored copy of an existing database.
2. Run the browser UI and Windows installer on two real machines: register/enroll, approve/decline consent, display real pixels, control input, clipboard both directions, files both directions, disconnect/reconnect, and revoke an active host.
3. Verify separate-ISP direct connections and forced TURN using deployed credentials. Test blocked UDP, relay TCP, slow networks, secure browser context/WebCodecs, multiple pending requests, and prolonged connections/token expiry. Record observed FPS/latency/resource usage.
4. Build and sign Windows installers with the publisher certificate; test clean installation, upgrade, uninstall and saved identity persistence. Check antivirus/SmartScreen results and WebView2 distribution.
5. Configure the domain, HTTPS, TURN external address/firewall, production secrets, monitored backups and tested restore, service alerts, audit retention, guest identity/session retention, and load limits.

## Explicit feature limitations

Recording and audio are rejected/disabled. Host consent is mandatory. PIN/unattended access is unavailable. The current host selects the first capturable display; monitor switching is pending. Screen capture/encoding uses the software backend; hardware probing is not proof of hardware encoding. Secure attention (Ctrl+Alt+Del) and UAC secure desktop are unavailable. Invitations, custom role administration, password recovery, service-mode unattended hosting and automatic updater distribution are pending. Browser downloads and the shared desktop viewer require manual platform acceptance testing.

No production deployment or release publication was performed. The pre-existing deletion of `deploy.tar.gz` was preserved.
