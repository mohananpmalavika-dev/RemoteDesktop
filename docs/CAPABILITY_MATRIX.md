# Current release capabilities

See `../PRODUCTION_READINESS.md` for verified checks and outstanding release gates. Implemented paths are not yet certified for production networking.

| Area | Current implementation | Remaining acceptance/work |
| --- | --- | --- |
| Identity | Token enrollment, Ed25519 identity, signed requests, revocation | Installer persistence/upgrade tests |
| Administration | Registration, login, MFA, refresh/logout, inventory, policies, audit | Invitations, custom roles, password recovery |
| Consent/signaling | Authoritative host consent, tenant/session scope, WebSocket SDP/ICE | Live PostgreSQL/Redis and multi-machine evidence |
| Video | DXGI/software H.264, bounded WebRTC data channel frames, WebCodecs canvas | Network performance, hardware encoding, monitor switching |
| Control | Win32 mouse/keyboard, capability gates | UAC/secure desktop unsupported; stuck-key/reconnect acceptance |
| Clipboard | Text, size limits, direction policy | Both-platform/browser permission acceptance |
| Files | Checksum verification, chunk acknowledgments, policy limits, no overwrite | End-to-end desktop/browser download tests; restart-resume pending |
| Infrastructure | Migrations, private DB/cache, authenticated Redis, HTTPS/WSS proxy, TURN UDP/TCP | Container smoke, backup restore, TURN TLS and production load |
| Recording/audio/unattended access | Disabled or rejected | Additional implementation required |
