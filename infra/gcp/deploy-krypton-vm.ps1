<#
.SYNOPSIS
    Deploys a dedicated, isolated Compute Engine VM for KryptonRemote on GCP.
    Safely creates `krypton-remote-server` without touching `kryptovision-server`.
#>

[CmdletBinding()]
param(
    [string]$ProjectId = "project-7866fc3f-5dd5-4495-804",
    [string]$Zone = "asia-south1-b",
    [string]$Region = "asia-south1",
    [string]$InstanceName = "krypton-remote-server",
    [string]$MachineType = "e2-medium"
)

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  KryptonRemote — GCP Isolated VM Deployment Initiated" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "Target Project: $ProjectId"
Write-Host "Target Zone:    $Zone"
Write-Host "Instance Name:  $InstanceName (Isolated from kryptovision-server)"
Write-Host ""

# 1. Set active project
Write-Host "[1/5] Setting active GCP project..." -ForegroundColor Yellow
gcloud config set project $ProjectId

# 2. Reserve a static external IP address
Write-Host "[2/5] Reserving static external IP 'krypton-server-ip'..." -ForegroundColor Yellow
$ipExists = gcloud compute addresses list --filter="name=krypton-server-ip AND region:$Region" --format="value(address)"
if (-not $ipExists) {
    gcloud compute addresses create krypton-server-ip --region=$Region --description="Static IP for KryptonRemote Server & TURN"
    $ExternalIp = gcloud compute addresses describe krypton-server-ip --region=$Region --format="value(address)"
} else {
    $ExternalIp = $ipExists
}
Write-Host "Static External IP: $ExternalIp" -ForegroundColor Green

# 3. Create isolated firewall rules (Scoped ONLY to tag 'krypton-server')
Write-Host "[3/5] Configuring firewall rules for Krypton (Tag: krypton-server)..." -ForegroundColor Yellow
$fwExists = gcloud compute firewall-rules list --filter="name=krypton-allow-ingress" --format="value(name)"
if (-not $fwExists) {
    gcloud compute firewall-rules create krypton-allow-ingress `
        --direction=INGRESS `
        --priority=1000 `
        --network=default `
        --action=ALLOW `
        --rules=tcp:22,tcp:80,tcp:443,tcp:4000,tcp:4001,tcp:3478,tcp:5349,udp:3478,udp:5349,udp:49152-49250 `
        --source-ranges=0.0.0.0/0 `
        --target-tags=krypton-server `
        --description="Allow HTTPS, API, Signaling, and WebRTC STUN/TURN for KryptonRemote"
    Write-Host "Firewall rule 'krypton-allow-ingress' created successfully." -ForegroundColor Green
} else {
    Write-Host "Firewall rule 'krypton-allow-ingress' already configured." -ForegroundColor Green
}

# 4. Prepare cloud-init startup script to install Docker & Compose
$startupScript = @'
#!/bin/bash
set -e
apt-get update -y
apt-get install -y ca-certificates curl gnupg lsb-release git ufw

# Install Docker & Docker Compose plugin
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null

apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

systemctl enable docker
systemctl start docker

# Create app directory
mkdir -p /opt/krypton-remote
echo "KryptonRemote VM initialized successfully." > /opt/krypton-remote/ready.txt
'@

$tempScriptPath = [System.IO.Path]::GetTempFileName()
Set-Content -Path $tempScriptPath -Value $startupScript -Encoding ASCII

# 5. Provision the Compute Engine VM
Write-Host "[4/5] Provisioning VM '$InstanceName'..." -ForegroundColor Yellow
$vmExists = gcloud compute instances list --filter="name=$InstanceName AND zone:$Zone" --format="value(name)"
if (-not $vmExists) {
    gcloud compute instances create $InstanceName `
        --zone=$Zone `
        --machine-type=$MachineType `
        --network-interface="network=default,address=$ExternalIp" `
        --maintenance-policy=MIGRATE `
        --tags=krypton-server `
        --image-family=ubuntu-2204-lts `
        --image-project=ubuntu-os-cloud `
        --boot-disk-size=35GB `
        --boot-disk-type=pd-balanced `
        --metadata-from-file=startup-script=$tempScriptPath
    Write-Host "VM '$InstanceName' created successfully." -ForegroundColor Green
} else {
    Write-Host "VM '$InstanceName' already exists." -ForegroundColor Green
}

Remove-Item -Path $tempScriptPath -Force -ErrorAction SilentlyContinue

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  Deployment Completed Successfully!" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "Instance:     $InstanceName" -ForegroundColor Yellow
Write-Host "Zone:         $Zone" -ForegroundColor Yellow
Write-Host "External IP:  $ExternalIp" -ForegroundColor Green
Write-Host ""
Write-Host "Next Steps to deploy the containers:" -ForegroundColor Cyan
Write-Host "  1. SSH into the new VM:"
Write-Host "     gcloud compute ssh $InstanceName --zone=$Zone"
Write-Host "  2. Upload code and launch Docker Compose:"
Write-Host "     gcloud compute scp --recurse . ${InstanceName}:/opt/krypton-remote/ --zone=$Zone"
Write-Host "     gcloud compute ssh $InstanceName --zone=$Zone --command='cd /opt/krypton-remote && docker compose -f infra/docker-compose.prod.yml up -d --build'"
Write-Host ""
Write-Host "NOTE: 'kryptovision-server' was untouched and is operating completely isolated." -ForegroundColor Green
