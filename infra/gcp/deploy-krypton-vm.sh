#!/usr/bin/env bash
set -e

# ==============================================================================
# KryptonRemote — Dedicated Isolated GCP VM Deployment Script
# Safely provisions `krypton-remote-server` without impacting `kryptovision-server`.
# ==============================================================================

PROJECT_ID="${1:-project-7866fc3f-5dd5-4495-804}"
ZONE="${2:-asia-south1-b}"
REGION="${3:-asia-south1}"
INSTANCE_NAME="${4:-krypton-remote-server}"
MACHINE_TYPE="${5:-e2-medium}"

echo "============================================================"
echo "  KryptonRemote — GCP Isolated VM Deployment Initiated"
echo "============================================================"
echo "Target Project: $PROJECT_ID"
echo "Target Zone:    $ZONE"
echo "Instance Name:  $INSTANCE_NAME"
echo ""

# 1. Set active project
echo "[1/4] Setting active GCP project..."
gcloud config set project "$PROJECT_ID"

# 2. Reserve static external IP address
echo "[2/4] Reserving static external IP 'krypton-server-ip'..."
IP_EXISTS=$(gcloud compute addresses list --filter="name=krypton-server-ip AND region:$REGION" --format="value(address)")
if [ -z "$IP_EXISTS" ]; then
    gcloud compute addresses create krypton-server-ip --region="$REGION" --description="Static IP for KryptonRemote Server & TURN"
    EXTERNAL_IP=$(gcloud compute addresses describe krypton-server-ip --region="$REGION" --format="value(address)")
else
    EXTERNAL_IP="$IP_EXISTS"
fi
echo "Static External IP: $EXTERNAL_IP"

# 3. Create isolated firewall rules (Scoped ONLY to tag 'krypton-server')
echo "[3/4] Configuring firewall rules (Tag: krypton-server)..."
FW_EXISTS=$(gcloud compute firewall-rules list --filter="name=krypton-allow-ingress" --format="value(name)")
if [ -z "$FW_EXISTS" ]; then
    gcloud compute firewall-rules create krypton-allow-ingress \
        --direction=INGRESS \
        --priority=1000 \
        --network=default \
        --action=ALLOW \
        --rules=tcp:22,tcp:80,tcp:443,tcp:4000,tcp:4001,tcp:3478,tcp:5349,udp:3478,udp:5349,udp:49152-49250 \
        --source-ranges=0.0.0.0/0 \
        --target-tags=krypton-server \
        --description="Allow HTTPS, API, Signaling, and WebRTC STUN/TURN for KryptonRemote"
    echo "Firewall rule 'krypton-allow-ingress' created."
else
    echo "Firewall rule 'krypton-allow-ingress' already configured."
fi

# 4. Provision the Compute Engine VM
echo "[4/4] Provisioning VM '$INSTANCE_NAME'..."
VM_EXISTS=$(gcloud compute instances list --filter="name=$INSTANCE_NAME AND zone:$ZONE" --format="value(name)")
if [ -z "$VM_EXISTS" ]; then
    gcloud compute instances create "$INSTANCE_NAME" \
        --zone="$ZONE" \
        --machine-type="$MACHINE_TYPE" \
        --network-interface="network=default,address=$EXTERNAL_IP" \
        --maintenance-policy=MIGRATE \
        --tags=krypton-server \
        --image-family=ubuntu-2204-lts \
        --image-project=ubuntu-os-cloud \
        --boot-disk-size=35GB \
        --boot-disk-type=pd-balanced \
        --metadata=startup-script='#!/bin/bash
apt-get update -y
apt-get install -y ca-certificates curl gnupg lsb-release git
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable docker
systemctl start docker
mkdir -p /opt/krypton-remote
'
    echo "VM '$INSTANCE_NAME' created successfully."
else
    echo "VM '$INSTANCE_NAME' already exists."
fi

echo "============================================================"
echo "  Deployment Initialized Successfully!"
echo "============================================================"
echo "External IP: $EXTERNAL_IP"
echo ""
echo "To copy repository and launch all containers:"
echo "  1. gcloud compute scp --recurse . ${INSTANCE_NAME}:/opt/krypton-remote/ --zone=$ZONE"
echo "  2. gcloud compute ssh ${INSTANCE_NAME} --zone=$ZONE --command='cd /opt/krypton-remote && docker compose -f infra/docker-compose.prod.yml up -d --build'"
