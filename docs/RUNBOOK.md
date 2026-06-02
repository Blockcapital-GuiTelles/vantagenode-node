# Runbook

Day-to-day operations for the VantageNode onchain node.

> **Audience:** the operator (you + future Claude sessions). Assumes
> SSH access as `vn` user on the production host.

---

## First-time setup checklist

- [ ] Hetzner AX42 ordered, Debian 12 installed
- [ ] `infra/provision.sh` ran cleanly as root
- [ ] SSH key in `/home/vn/.ssh/authorized_keys`
- [ ] `sshd` reloaded, root login disabled, password auth disabled
- [ ] As `vn`: cloned repo to `~/vantagenode-node`
- [ ] `.env` populated with real secrets (NOT defaults)
- [ ] `infra/gen-rpcauth.sh indexer` ran → `rpcauth` line in `.env`
- [ ] `docker compose pull` succeeded
- [ ] `docker compose up -d bitcoind` (only bitcoind for IBD)
- [ ] DNS A-record `node.vantagenode.io` → server IP

---

## Daily ops

### Check health

```bash
# From any machine:
curl https://node.vantagenode.io/healthz

# Expected:
# {"ok":true,"blocks":850123,"initialBlockDownload":false,"ts":"..."}
```

### Check container status

```bash
ssh vn@<server>
cd ~/vantagenode-node
docker compose ps
docker compose logs --tail=200 bitcoind
docker compose logs --tail=200 indexer
```

### Disk usage

```bash
df -h /opt/vantagenode
du -sh /opt/vantagenode/*

# Block chain typically: 720 GB and growing ~60 GB/yr
# Postgres after F3 backfill: ~150 GB
# Caddy logs: <100 MB (rolled by Caddy)
```

### Restart a service

```bash
docker compose restart indexer
# bitcoind stop is slower — give it 5min grace:
docker compose stop bitcoind
docker compose up -d bitcoind
```

---

## Backups

### What gets backed up

- `/opt/vantagenode/postgres` — full daily snapshot via `pg_dump`
- Block chain data is NOT backed up — it's deterministic; we can
  resync from peers if the volume is lost (1-3 days)
- Indexer code is in git (this repo)
- `.env` lives ONLY on the production host (in 1Password if you
  want a copy)

### Daily Postgres dump

Add to `vn` user's crontab:

```cron
# Run at 04:00 UTC daily
0 4 * * * docker compose -f /home/vn/vantagenode-node/docker-compose.yml exec -T postgres pg_dump -U vn vantagenode | gzip > /opt/vantagenode/backups/pg-$(date +\%Y\%m\%d).sql.gz && find /opt/vantagenode/backups -name 'pg-*.sql.gz' -mtime +30 -delete
```

### Offsite copy via Hetzner Storage Box (€3/mo)

```bash
# One-time: rclone config to point at storage-box
# Then daily cron:
0 5 * * * rclone sync /opt/vantagenode/backups storagebox:vantagenode-backups
```

---

## Incident playbooks

### bitcoind unhealthy

```bash
docker compose logs --tail=500 bitcoind | grep -i error
# Common: out-of-disk
df -h /opt/vantagenode

# If "Disk space too low" → expand volume OR drop oldest indexes
# (last resort: prune, but we lose archive-grade)
```

### indexer returns 503 on /healthz

```bash
# bitcoind RPC probably down. Check auth:
docker compose exec indexer wget -qO- \
  --header="Authorization: Basic $(echo -n indexer:$BITCOIN_RPC_PASSWORD | base64)" \
  --post-data='{"jsonrpc":"1.0","method":"getblockchaininfo"}' \
  http://bitcoind:8332/

# If 401 → rpcauth/password mismatch. Re-run gen-rpcauth.sh.
```

### Caddy can't get a certificate

```bash
docker compose logs caddy | grep -i error

# Common causes:
#   - DNS not propagated yet (wait 5-30 min, retry)
#   - UFW blocks port 80 (provision.sh opens it; verify with `ufw status`)
#   - Let's Encrypt rate-limit (5 certs/week per domain)
```

### Disk filling fast

```bash
# Find culprit:
sudo du -hd 1 /opt/vantagenode
# Bitcoin: normal ~720 GB. If much more, check that prune is OFF.
# Postgres: should grow ~5-10 MB/day after F3.
# Caddy logs: should auto-roll; if not, check Caddyfile log block.

# Emergency: stop indexer, dump old Postgres rows, restart
docker compose exec postgres psql -U vn vantagenode -c "
  DELETE FROM block_index WHERE block_time < now() - interval '2 years';
"
```

---

## Rotation procedures

### Rotate NODE_SHARED_SECRET

1. On the Studio side (Railway), set the new secret as a second env
   var (`NODE_SHARED_SECRET_NEXT`). App tries new first, falls back
   to old.
2. SSH to node host: update `.env`, `docker compose up -d indexer`
3. Verify Studio is using the new secret (logs).
4. Remove the old secret from Studio.

### Rotate bitcoind RPC password

1. As `vn`: regenerate rpcauth + cleartext:
   ```bash
   python3 infra/gen-rpcauth.py indexer
   # paste rpcauth=... into .env BITCOIND_RPCAUTH
   # paste cleartext into .env BITCOIN_RPC_PASSWORD
   ```
2. Restart both: `docker compose up -d bitcoind indexer`
3. Verify with `/healthz`.

---

## Monitoring

### Local metrics
- `http://127.0.0.1:9100/metrics` — node_exporter (CPU/RAM/disk/network)
- `http://127.0.0.1:3001/healthz` — indexer health (auth not required)

### Recommended Grafana dashboards
- Node Exporter Full (1860)
- Bitcoin Core stats — community dashboard, ID TBD

### Alerts to set up

| Alert | Trigger |
|---|---|
| Disk usage > 85% | Hetzner email |
| `verificationprogress` < 1.0 for > 10 min (post-IBD) | Slack |
| `/healthz` returns non-200 for 5 min | Slack + pager |
| Daily Postgres dump fails | Slack |

---

## Useful one-liners

```bash
# Current sync progress
docker compose exec bitcoind bitcoin-cli getblockchaininfo | jq .verificationprogress

# Peer list
docker compose exec bitcoind bitcoin-cli getpeerinfo | jq '.[] | {addr, subver, synced_blocks}'

# Force a peer disconnect (if you suspect a bad actor)
docker compose exec bitcoind bitcoin-cli disconnectnode "x.x.x.x:8333"

# Manual call to indexer (for debug; uses /healthz which is unauth'd)
curl https://node.vantagenode.io/healthz | jq .

# With auth (any /api/* path)
SIG=$(echo -n "GET:/api/catalog" | openssl dgst -sha256 -hmac "$NODE_SHARED_SECRET" | awk '{print $2}')
curl -H "X-Node-Auth: $SIG" https://node.vantagenode.io/api/catalog
```
