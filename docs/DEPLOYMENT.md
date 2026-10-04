# KryptonRemote Enterprise Deployment Guide

## 1. Overview

KryptonRemote is deployed using Docker Compose for on-premises/edge deployments or Kubernetes for scalable cloud environments.

---

## 2. Infrastructure Components

1. **API Gateway & Control Plane (`services/api`):**
   - Port: `4000`
   - Framework: NestJS 10 / Node.js 20+
   - Dependencies: PostgreSQL 16+, Redis 7+
2. **Signaling Cluster (`services/signaling`):**
   - Port: `4001` (WebSocket)
   - Real-time ICE exchange and session orchestration
   - Dependencies: Redis PubSub (session routing)
3. **Admin Web Portal (`apps/admin-web`):**
   - Port: `3000`
   - Static asset hosting / SPA via Nginx
4. **TURN / STUN Media Relay (`infra/coturn`):**
   - Ports: `3478` UDP/TCP (STUN/TURN), `5349` UDP/TCP (TURNS / TLS), `49152-65535` UDP (Relay allocations)
   - coturn 4.6+

---

## 3. Docker Compose Orchestration

Use the pre-configured `infra/docker-compose.yml`:

```bash
# 1. Configure environment variables
cp .env.example .env

# 2. Start PostgreSQL, Redis, and Coturn
docker compose up -d postgres redis coturn

# 3. Run database migrations
npx prisma migrate deploy

# 4. Start Control Plane and Signaling Services
docker compose up -d api signaling admin-web
```

---

## 4. Environment Variables Checklist

| Variable | Description | Example / Default |
| :--- | :--- | :--- |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://krypton:secret@postgres:5432/krypton_db?schema=public` |
| `REDIS_URL` | Redis connection URL | `redis://redis:6379` |
| `JWT_ACCESS_SECRET` | Secret for user access tokens | `256-bit cryptographically secure string` |
| `JWT_REFRESH_SECRET` | Secret for refresh token families | `256-bit cryptographically secure string` |
| `COTURN_SECRET` | Shared secret for ephemeral TURN credentials | `alphanumeric secure secret` |
| `TURN_SERVER_URL` | Publicly reachable TURN host | `turn:turn.kryptonlogic.com:3478` |
| `NODE_ENV` | Runtime environment | `production` |

---

## 5. Kubernetes Helm / Manifest Architecture

In production Kubernetes clusters:
- API instances run behind an Ingress Controller (with TLS termination).
- Signaling instances use sticky sessions or Redis PubSub horizontal scaling.
- Coturn runs in `hostNetwork: true` mode on dedicated edge nodes to minimize NAT traversal latency.
