# KryptonRemote Coturn Deployment & Configuration Guide

## 1. Architecture

Coturn provides RFC 5766 TURN (Traversal Using Relays around NAT) and RFC 5389 STUN capabilities for KryptonRemote. When direct P2P connectivity is blocked by restrictive firewalls or double NATs, media and data channel traffic routes securely through Coturn.

---

## 2. Production `turnserver.conf`

```ini
# /etc/coturn/turnserver.conf

# Listening Ports
listening-port=3478
tls-listening-port=5349
listening-ip=0.0.0.0

# External Public IP for NAT
external-ip=203.0.113.50

# Ephemeral Port Range for Relay Allocations
min-port=49152
max-port=65535

# Authentication via Long-Term Shared Secret (HMAC-SHA1)
use-auth-secret
static-auth-secret=your-cryptographically-secure-shared-secret
realm=turn.kryptonlogic.com

# TLS Certificates
cert=/etc/letsencrypt/live/turn.kryptonlogic.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.kryptonlogic.com/privkey.pem

# Security Hardening
no-stdout-log
log-file=/var/log/coturn/turnserver.log
no-multicast-peers
no-cli
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
```

---

## 3. Ephemeral Credential Generation in Control Plane

The control plane generates short-lived, time-limited TURN credentials:

```ts
import crypto from 'crypto';

export function generateTurnCredentials(username: string, secret: string, durationSeconds = 86400) {
  const timestamp = Math.floor(Date.now() / 1000) + durationSeconds;
  const ephemeralUser = `${timestamp}:${username}`;
  const hmac = crypto.createHmac('sha1', secret);
  hmac.update(ephemeralUser);
  const password = hmac.digest('base64');

  return {
    urls: [
      'turn:turn.kryptonlogic.com:3478?transport=udp',
      'turn:turn.kryptonlogic.com:3478?transport=tcp',
      'turns:turn.kryptonlogic.com:5349?transport=tcp',
    ],
    username: ephemeralUser,
    credential: password,
  };
}
```

---

## 4. High Availability & Scaling

For global deployments:
- Deploy Coturn instances across multiple geographical regions (US East, US West, Europe, APAC).
- Use GeoDNS (e.g., AWS Route53 or Cloudflare Geo Steering) to resolve `turn.kryptonlogic.com` to the nearest edge instance.
- Run health checks against port 3478 UDP to remove degraded relay nodes automatically.
