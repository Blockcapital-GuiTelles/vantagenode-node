#!/usr/bin/env bash
#
# VantageNode onchain node — initial provisioning script.
#
# Idempotent. Designed to run on a fresh Hetzner AX42 / AX62 (or any
# Debian 12 host with at least 8 GB RAM and 800 GB SSD). Run as root
# (or via sudo); the script creates a dedicated 'vn' user for the
# stack and locks down the rest.
#
# Usage:
#   ssh root@<server-ip>
#   curl -fsSL https://raw.githubusercontent.com/Blockcapital-GuiTelles/vantagenode-node/main/infra/provision.sh | bash
#   # or clone the repo first and run ./infra/provision.sh
#
# What this does (in order):
#   1. System update + base packages
#   2. Swap (16 GB) — bitcoind IBD likes the headroom
#   3. Unattended security upgrades
#   4. Firewall (UFW) — only SSH + HTTPS + Bitcoin P2P (8333) public
#   5. SSH hardening (key-only, no root, no password)
#   6. Docker + docker compose plugin
#   7. Dedicated 'vn' user that owns /opt/vantagenode
#   8. Storage layout: /opt/vantagenode/{bitcoin,postgres}
#   9. Prometheus node_exporter (port 9100, loopback only)
#  10. fail2ban for SSH bruteforce protection
#
# NOTE: this does NOT clone the repo or start the stack. After running
# this you should:
#   - As the 'vn' user, clone the repo into ~/vantagenode-node
#   - Copy .env.example → .env, fill in secrets
#   - docker compose pull && docker compose up -d
#   - Wait for IBD (1-3 days)

set -euo pipefail

# ============================================================
# Pre-flight
# ============================================================
if [[ $EUID -ne 0 ]]; then
    echo "[provision] must run as root (use sudo)"
    exit 1
fi

if [[ ! -f /etc/os-release ]] || ! grep -q "ID=debian" /etc/os-release; then
    echo "[provision] WARNING: this script is tuned for Debian 12. Continuing anyway..."
fi

log() { echo -e "\n\033[1;36m[provision]\033[0m $1"; }

# ============================================================
# 1. System update + base packages
# ============================================================
log "Updating apt cache and installing base packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq \
    curl wget git rsync \
    htop ncdu tmux vim less \
    ca-certificates gnupg lsb-release \
    ufw fail2ban \
    unattended-upgrades \
    python3 python3-pip \
    jq

# ============================================================
# 2. Swap (16 GB) — sizes bitcoind sync gracefully on small-RAM hosts
#    and gives the indexer headroom for big in-memory passes.
# ============================================================
if [[ ! -f /swapfile ]]; then
    log "Creating 16 GB swap..."
    fallocate -l 16G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo "/swapfile none swap sw 0 0" >> /etc/fstab
    sysctl vm.swappiness=10 >/dev/null
    echo "vm.swappiness=10" > /etc/sysctl.d/99-vantagenode.conf
else
    log "Swap already exists, skipping."
fi

# ============================================================
# 3. Unattended security upgrades
# ============================================================
log "Enabling unattended security upgrades..."
cat > /etc/apt/apt.conf.d/50unattended-upgrades <<'EOF'
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}-security";
};
Unattended-Upgrade::AutoFixInterruptedDpkg "true";
Unattended-Upgrade::Automatic-Reboot "false";
EOF
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
systemctl enable --now unattended-upgrades

# ============================================================
# 4. Firewall — only SSH + HTTPS + Bitcoin P2P
# ============================================================
log "Configuring UFW firewall..."
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH'
ufw allow 80/tcp comment 'HTTP (Caddy → Let''s Encrypt challenge)'
ufw allow 443/tcp comment 'HTTPS API'
ufw allow 8333/tcp comment 'Bitcoin P2P'
# node_exporter on :9100 is reached by the Prometheus container via
# the host-gateway. The two Docker default bridges are 172.16/12 and
# 10/8 — allow scraping from both so the observability stack works
# regardless of which bridge docker compose picks at start-up.
ufw allow from 172.16.0.0/12 to any port 9100 proto tcp comment 'node_exporter ← docker bridge'
ufw allow from 10.0.0.0/8 to any port 9100 proto tcp comment 'node_exporter ← docker bridge'
ufw --force enable

# ============================================================
# 5. SSH hardening
# ============================================================
log "Hardening SSH..."
SSHD_CFG=/etc/ssh/sshd_config.d/99-vantagenode.conf
cat > "$SSHD_CFG" <<'EOF'
# VantageNode SSH hardening — overrides /etc/ssh/sshd_config defaults.
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
MaxAuthTries 3
ClientAliveInterval 300
ClientAliveCountMax 2
AllowUsers vn
EOF
# Don't reload sshd here — operator must add 'vn' user's authorized_keys
# first or they'll lock themselves out. We print a reminder at the end.

# ============================================================
# 6. Docker + compose plugin
# ============================================================
if ! command -v docker >/dev/null 2>&1; then
    log "Installing Docker Engine..."
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/debian/gpg \
        | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
        https://download.docker.com/linux/debian $(lsb_release -cs) stable" \
        > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
        docker-buildx-plugin docker-compose-plugin
    systemctl enable --now docker
else
    log "Docker already installed."
fi

# ============================================================
# 7. Dedicated 'vn' user
# ============================================================
if ! id vn >/dev/null 2>&1; then
    log "Creating 'vn' user..."
    useradd -m -s /bin/bash -G docker vn
    mkdir -p /home/vn/.ssh
    chmod 700 /home/vn/.ssh
    touch /home/vn/.ssh/authorized_keys
    chmod 600 /home/vn/.ssh/authorized_keys
    chown -R vn:vn /home/vn/.ssh
    echo "[provision] NOTE: paste your public SSH key into:"
    echo "                /home/vn/.ssh/authorized_keys"
    echo "           BEFORE rebooting or reloading sshd!"
else
    log "User 'vn' already exists."
fi

# ============================================================
# 8. Storage layout
# ============================================================
log "Preparing /opt/vantagenode storage layout..."
mkdir -p /opt/vantagenode/{bitcoin,postgres,backups}
chown -R vn:vn /opt/vantagenode
# Bitcoin needs to write as UID 1000 inside the lncm/bitcoind image.
# Match that by giving the bitcoin dir the right perms. If the host
# 'vn' user is not UID 1000, the docker-compose volume mount handles
# the mapping automatically (no chown needed because of the named
# bind mount semantics).

# ============================================================
# 9. Prometheus node_exporter (bound on all interfaces; ufw still
#    blocks WAN — only the docker bridge subnets (set up in step 11)
#    are allowed to reach :9100, so Prometheus inside the compose
#    network scrapes it via host-gateway. Original bind 127.0.0.1
#    failed because the bridge gateway IP is NOT loopback from
#    node_exporter's POV.
# ============================================================
if ! command -v node_exporter >/dev/null 2>&1; then
    log "Installing node_exporter..."
    NE_VER=1.8.2
    cd /tmp
    wget -q "https://github.com/prometheus/node_exporter/releases/download/v${NE_VER}/node_exporter-${NE_VER}.linux-amd64.tar.gz"
    tar xzf "node_exporter-${NE_VER}.linux-amd64.tar.gz"
    mv "node_exporter-${NE_VER}.linux-amd64/node_exporter" /usr/local/bin/
    rm -rf "node_exporter-${NE_VER}.linux-amd64"*
    useradd -rs /bin/false node_exporter 2>/dev/null || true
    cat > /etc/systemd/system/node_exporter.service <<'EOF'
[Unit]
Description=Prometheus node_exporter
After=network.target

[Service]
User=node_exporter
Group=node_exporter
Type=simple
ExecStart=/usr/local/bin/node_exporter --web.listen-address=:9100

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable --now node_exporter
else
    log "node_exporter already installed."
fi

# ============================================================
# 10. fail2ban for SSH
# ============================================================
log "Configuring fail2ban for SSH..."
cat > /etc/fail2ban/jail.d/vantagenode.conf <<'EOF'
[sshd]
enabled = true
maxretry = 3
findtime = 10m
bantime = 1h
EOF
systemctl restart fail2ban

# ============================================================
# Done
# ============================================================
log "Provisioning complete."
cat <<'EOF'

Next steps:
  1. Paste your SSH public key into:
       /home/vn/.ssh/authorized_keys
  2. Test SSH from another terminal BEFORE closing this session:
       ssh vn@<this-server-ip>
  3. Reload sshd to enforce the hardened config:
       systemctl reload sshd
  4. As the 'vn' user:
       git clone https://github.com/Blockcapital-GuiTelles/vantagenode-node.git
       cd vantagenode-node
       cp .env.example .env
       # Fill in secrets, then:
       docker compose pull
       docker compose up -d bitcoind
       # Wait ~1-3 days for Initial Block Download.
       # Then bring up postgres + indexer + caddy:
       docker compose up -d
  5. Point DNS for node.vantagenode.io at this server's IP.
  6. First HTTPS request to https://node.vantagenode.io will trigger
     Caddy to provision the Let's Encrypt cert.

EOF
