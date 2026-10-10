> Historical deployment notes. Do not execute these commands or reuse the example credentials. Use [DEPLOYMENT.md](DEPLOYMENT.md) for the current migration, secrets, networking and TLS workflow.

# KryptonRemote — GCP Isolated VM Deployment Guide

**Target GCP Project:** `project-7866fc3f-5dd5-4495-804`  
**Target Region / Zone:** `asia-south1` / `asia-south1-b` (Mumbai)  
**Deployment Type:** Dedicated Isolated Compute Engine VM (`krypton-remote-server`)  
**Safety Guarantee:** Complete isolation from `kryptovision-server`. Zero shared CPU, RAM, disk, or ports.

---

## 1. Architecture Overview

```
                      INTERNET
                         │
     ┌───────────────────┴───────────────────┐
     │                                       │
     ▼                                       ▼
┌─────────────────────────┐     ┌───────────────────────────────────┐
│ Existing VMS VM         │     │ NEW Isolated Krypton VM           │
│ kryptovision-server     │     │ krypton-remote-server             │
│ (34.14.220.41)          │     │ (Dedicated Static External IP)    │
│                         │     │                                   │
│ • Camera Streams        │     │ ┌───────────────────────────────┐ │
│ • VMS Storage / GPU     │     │ │ Docker Compose Stack:         │ │
│ • 100% UNTOUCHED        │     │ │ • Postgres 16 (Port 5432)     │ │
│                         │     │ │ • Redis 7 (Port 6379)         │ │
│                         │     │ │ • Coturn STUN/TURN (3478/5349)│ │
│                         │     │ │ • API Service (Port 4000)     │ │
│                         │     │ │ • Signaling Server (Port 4001)│ │
│                         │     │ └───────────────────────────────┘ │
└─────────────────────────┘     └───────────────────────────────────┘
```

---

## 2. One-Click Automated Deployment

From your local machine (PowerShell), run the automated deployment script:

```powershell
cd C:\RemoteDesktop
.\infra\gcp\deploy-krypton-vm.ps1
```

### What This Script Does:
1. **Verifies Project:** Sets active project to `project-7866fc3f-5dd5-4495-804`.
2. **Allocates Dedicated Static IP:** Creates `krypton-server-ip` in `asia-south1` so the server IP never changes.
3. **Creates Scoped Firewall Rule:** Creates `krypton-allow-ingress` tagged **strictly** to `krypton-server`:
   - TCP: `22, 80, 443, 4000, 4001, 3478, 5349`
   - UDP: `3478, 5349, 49152-49250` (WebRTC Media Relay)
   - *Note: This rule has zero effect on `kryptovision-server`.*
4. **Provisions VM:** Creates `krypton-remote-server` (`e2-medium`, Ubuntu 22.04 LTS, 35GB SSD) with Docker and Docker Compose pre-installed.

---

## 3. Uploading Code & Launching Containers

Once the VM is provisioned, upload the project directory and start the stack:

### Step 1: Upload repository to the new VM
```bash
gcloud compute scp --recurse . krypton-remote-server:/opt/krypton-remote/ --zone=asia-south1-b
```

### Step 2: SSH into the VM and build/run
```bash
gcloud compute ssh krypton-remote-server --zone=asia-south1-b
```

Inside the VM terminal:
```bash
cd /opt/krypton-remote

# Start all containers in background
docker compose -f infra/docker-compose.prod.yml up -d --build
```

### Step 3: Verify container health
```bash
docker compose -f infra/docker-compose.prod.yml ps
```

You should see 5 running containers:
- `krypton-postgres` (healthy)
- `krypton-redis` (healthy)
- `krypton-coturn` (running)
- `krypton-api` (running on `:4000`)
- `krypton-signaling` (running on `:4001`)

---

## 4. Connecting the Desktop Client

Once the server is running with its static external IP (e.g. `34.x.x.x`):

1. Update `.env` in `apps/desktop`:
   ```ini
   VITE_API_BASE_URL=http://<YOUR_STATIC_IP>:4000
   VITE_SIGNALING_URL=ws://<YOUR_STATIC_IP>:4001
   ```

2. Build the production Windows installer:
   ```powershell
   cd C:\RemoteDesktop\apps\desktop
   npm run build
   npm run tauri build
   ```
   The `.msi` and `.exe` installer will be located in:
   `apps/desktop/src-tauri/target/release/bundle/msi/`

---

## 5. Security & Isolation Verification Checklist

- [x] **Zero shared memory / CPU:** `kryptovision-server` runs on its own 8-vCPU instance; `krypton-remote-server` runs on its own isolated 2-vCPU instance.
- [x] **Zero shared database:** Krypton uses its own containerized PostgreSQL 16 volume; VMS databases are never accessed or queried.
- [x] **Firewall isolation:** Firewall rules use `--target-tags=krypton-server`, preventing any port exposure or collision on `kryptovision-server`.
- [x] **Bandwidth isolation:** Remote desktop screen capture traffic travels Direct P2P between user machines; only signaling metadata touches the server.
