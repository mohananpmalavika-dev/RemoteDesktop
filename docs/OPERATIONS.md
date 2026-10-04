# KryptonRemote Operations & Runbook

## 1. Health Monitoring & Probes

KryptonRemote exposes standardized Kubernetes liveness and readiness probes adhering to Section 38.

### Endpoints:
- `GET /api/v1/health/live`: Returns `{ "status": "UP", "timestamp": "..." }` if the process is responsive.
- `GET /api/v1/health/ready`: Performs live dependency checks against PostgreSQL and Redis:
  ```json
  {
    "status": "UP",
    "timestamp": "2026-10-04T01:00:00.000Z",
    "dependencies": {
      "database": "HEALTHY",
      "redis": "HEALTHY"
    }
  }
  ```

---

## 2. Standard Operational Runbooks

### Runbook 1: Emergency Session Termination
When an active remote session exhibits suspicious behavior or a technician's credentials are compromised:
1. Navigate to the Admin Web Portal -> **Active Sessions**.
2. Click **Emergency Terminate** next to the target session.
3. Enter justification reason for audit logging.
4. The control plane issues a termination message across Redis PubSub and severs signaling WebSockets, immediately tearing down WebRTC transport.
5. Alternatively, invoke the API directly:
   ```bash
   curl -X POST https://api.krypton.corp/api/v1/sessions/<sessionId>/terminate \
     -H "Authorization: Bearer <AdminJWT>" \
     -H "Content-Type: application/json" \
     -d '{"reason": "Security incident containment"}'
   ```

### Runbook 2: Device Key Invalidation & Revocation
If a host machine is lost, stolen, or decommissioned:
1. Navigate to **Device Inventory**.
2. Locate the device Remote ID and click **Revoke**.
3. The device's public key is marked revoked in PostgreSQL. Any subsequent signaling connection attempt from that device will fail cryptographic challenge-response authentication.

### Runbook 3: Audit Trail Verification & Export
For compliance audits (SOC 2, ISO 27001, HIPAA):
1. Navigate to **Audit Trail**.
2. Click **Verify Cryptographic Chain** to validate the continuous Merkle hash tree.
3. Click **Export JSON Audit Package** to generate a cryptographically signed export bundle.

---

## 3. Telemetry & Metrics Collection

Fleet devices transmit periodic heartbeats (default every 30 seconds) containing:
- CPU utilization percentage
- Memory load percentage
- Active remote session count
- Uptime in seconds
- Agent build version

Data is cached in Redis (`krypton:device:telemetry:<deviceId>`) and queryable via `GET /api/v1/devices`.
