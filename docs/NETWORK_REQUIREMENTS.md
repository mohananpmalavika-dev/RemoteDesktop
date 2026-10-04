# KryptonRemote Network Requirements & Firewall Guide

## 1. Overview

KryptonRemote uses standard, enterprise-friendly ports. Connections prioritize direct peer-to-peer UDP paths and gracefully fall back to authenticated TURN/TLS relays when traversing restrictive corporate firewalls or symmetric NATs.

---

## 2. Inbound & Outbound Port Matrix

### Client / Host Endpoint (Outbound)

| Protocol | Destination Port | Service / Purpose | Required? |
| :--- | :--- | :--- | :---: |
| **HTTPS (TCP)** | `443` or `4000` | REST API (Device enrollment, auth, policies) | Yes |
| **WSS (TCP)** | `443` or `4001` | Signaling (Session handshake & ICE exchange) | Yes |
| **STUN/TURN (UDP/TCP)**| `3478` | NAT Discovery & Media Relay | Yes |
| **TURNS (TLS over TCP)**| `5349` | Secure Encrypted Media Relay (fallback) | Yes |
| **UDP** | `49152 - 65535` | WebRTC Direct P2P Media / Data channels | Recommended (optimizes latency) |

---

### Cloud Infrastructure / Edge Node (Inbound)

| Protocol | Port | Component | Notes |
| :--- | :--- | :--- | :--- |
| **TCP** | `4000` | `services/api` | Reverse-proxied via Nginx / Ingress |
| **TCP** | `4001` | `services/signaling` | WebSocket upgrade supported |
| **UDP/TCP** | `3478` | Coturn STUN/TURN | Unauthenticated STUN, HMAC TURN |
| **UDP/TCP** | `5349` | Coturn TURNS | TLS-wrapped TURN relay |
| **UDP** | `49152 - 65535` | Coturn Relay Ports | Port range allocated for media streaming |

---

## 3. Bandwidth & Latency Guidelines

| Remote Control Quality Tier | Target Resolution | Target FPS | Bandwidth Required | Max Acceptable RTT |
| :--- | :---: | :---: | :---: | :---: |
| **Ultra (CAD / High Performance)** | 4K (3840×2160) | 60 | 6.0 – 12.0 Mbps | < 30 ms |
| **High (Standard Workstation)** | 1080p (1920×1080) | 60 | 2.5 – 6.0 Mbps | < 80 ms |
| **Medium (Office Support)** | 1080p (1920×1080) | 30 | 1.2 – 2.5 Mbps | < 140 ms |
| **Low (Bandwidth Constrained)** | 720p (1280×720) | 15 | 400 – 800 kbps | < 250 ms |

---

## 4. WebRTC Quality of Service (QoS)

DSCP marking:
- Video RTP traffic can be tagged with DSCP `AF41` (Class 4, Low Drop Probability) or `CS4`.
- Input and control data channels are marked with DSCP `CS6` (Network Control) or `CS7` to prioritize user interaction over video packets under congestion.
