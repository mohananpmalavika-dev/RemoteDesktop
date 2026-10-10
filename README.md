# KryptonRemote

Windows remote support application with a browser viewer and an administration console.

Release status: hardening changes implemented; release acceptance tests remain pending. See [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md) for verified results and limitations.

## Supported release scope

- Windows host enrollment with a single-use token and persisted Ed25519 identity.
- Public browser connections by Remote ID, with explicit host consent and individual permissions.
- Authenticated administration: organization registration, login, MFA setup, rotating refresh tokens, device inventory/revocation, policy management, active sessions, and audit verification.
- Native DXGI screen capture and software H.264 encoding delivered over encrypted WebRTC data channels. The viewer requires WebCodecs support in a secure browser context.
- Remote keyboard/mouse input, text clipboard, and checksum-verified file transfers. Browser transfers are capped at 100 MB and also respect the workspace limit.

Session recording, unattended access, audio, secure attention/UAC desktop control, and user invitations/password recovery are outside the current release implementation. Multi-monitor switching and cross-network performance require further work and acceptance evidence.

## Local development

Use Node.js 22.18 or newer, npm, Rust, the Windows build tools/WebView2 for the desktop app, and Docker for PostgreSQL/Redis/Coturn.

```powershell
Copy-Item .env.example .env
npm ci
npm run prisma:generate
docker compose -f infra/docker-compose.yml up -d
npx prisma migrate deploy
npm run build
```

Run `npm run start --workspace=@krypton/api`, `npm run start --workspace=@krypton/signaling`, and `npm run dev --workspace=@krypton/admin-web` in separate terminals. Run `npm run tauri:dev` for the Windows application. Create an organization in the browser account panel, generate a device enrollment token, and register the host using the server URL and token. Enrollment is required before sharing a Remote ID.

```powershell
npm run typecheck
npm test
cargo check --workspace --locked
cargo test --workspace --locked
npm audit
```

`npm run test:integration` launches the built API/signaling services against explicitly supplied disposable PostgreSQL/Redis instances. It requires `KRYPTON_TEST_DATABASE=disposable`, `DATABASE_URL`, and `REDIS_URL`. The CI workflow provisions these automatically. Windows CI skips the three tests that require an interactive display/clipboard; run the full native suite on a Windows desktop before release.

## Production deployment

Follow [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Production Compose builds the frontend inside the API image, applies versioned migrations, uses private database/cache networks, and terminates HTTPS/WSS with Caddy. Supply a real domain, public TURN address, and independently generated secrets. Existing installations created with `prisma db push` need a reviewed migration baseline before deployment.
