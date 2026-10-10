# Production deployment

Use this runbook with `infra/docker-compose.prod.yml`. Older GCP/runbook examples are historical and must not be used as production credentials or readiness evidence.

## Configuration

Copy `infra/.env.production.example` to an untracked environment file inside `infra`. Supply a DNS domain pointing to the server, the externally reachable TURN IP, and separate random hexadecimal secrets. Hex passwords avoid URL-encoding ambiguity in database/Redis URLs. Generate each with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Do not reuse secrets or commit the environment file.

Open TCP 80/443, TCP+UDP 3478, and UDP 49152?49250. Production Compose keeps PostgreSQL, Redis, API and signaling ports private. HTTPS/WSS share one domain through Caddy. TURN uses UDP/TCP on 3478; TURN TLS is not configured by this template. If UDP and direct TCP TURN are blocked on a client network, add a separately configured TLS TURN listener/certificate and advertise its URL.

`TRUST_PROXY=true` assumes exactly one trusted proxy and private API/signaling ports. Disable it when exposing the services directly. CORS defaults to the API origin; list any additional HTTPS browser origins explicitly.

## Fresh installation

From the repository root:

```powershell
docker compose --env-file infra/.env.production -f infra/docker-compose.prod.yml config --quiet
docker compose --env-file infra/.env.production -f infra/docker-compose.prod.yml build
docker compose --env-file infra/.env.production -f infra/docker-compose.prod.yml up -d
docker compose --env-file infra/.env.production -f infra/docker-compose.prod.yml ps
```

The `migrate` container runs `prisma migrate deploy` before API/signaling start. API and signaling readiness check their database/cache dependencies. Open the HTTPS site, create the first organization, sign in, generate an enrollment token, and register the Windows host with `https://your-domain/api/v1`. The single-use token is required; hosts initially remain offline until signed heartbeats arrive.

## Existing installations

Back up PostgreSQL and restore it to a disposable instance first. Compare that database with the original initial schema (`20261010000000_initial`). If an existing database was created using `prisma db push` and exactly matches that schema, baseline only the initial migration with `prisma migrate resolve --applied 20261010000000_initial`. Then apply `20261010000001_hardening` using `prisma migrate deploy`. Do not mark the hardening migration as applied before its columns exist. Reconcile any drift before production rollout.

The hardening migration adds organization policy and refresh-token MFA state. Existing tokens lack the new access scope/family claims and users must log in again. Recording-required legacy policies block new sessions until recording is disabled. Existing revoked devices remain revoked; re-enrollment cannot bypass revocation.

## Release and operation

Run CI and the two-machine acceptance tests listed in `../PRODUCTION_READINESS.md` before publishing. Use immutable image tags/digests for releases. Keep the preceding image for application rollback; do not automatically reverse schema migrations. Schedule encrypted database backups, restore drills and secret rotation. Monitor readiness, login failures, signaling disconnects, Redis memory, PostgreSQL storage, host availability and TURN allocation/resource limits. Establish retention for guest identities, ended sessions and audit records before a public rollout.

Build Windows installers only after native compilation and two-machine acceptance. Configure the publisher signing certificate and verify signed installers on a clean Windows machine. No signing key or deployment credentials are supplied by this repository.
