# Architecture Decision Records

Short, dated notes on why we picked what we picked. New decisions
go at the top.

---

## ADR-006 — Indexer in TypeScript (not Rust)

**Date:** 2026-06-02
**Status:** accepted
**Context:** Indexer needs to walk the blockchain and maintain UTXO
state. Rust is the canonical choice for performance + correctness
(electrs, mempool/backend, btcd-like tooling). TypeScript on Node 22
is more familiar to the team (the entire VantageNode app is TS).

**Decision:** Start in TypeScript. Migrate to Rust only if profiling
shows the indexer can't keep up with block tip (~10 min/block, so
even sub-optimal code has lots of headroom).

**Trade-offs:**
- ✅ Same language as Studio app — easier code review, shared mental model
- ✅ Hono + node-postgres are mature, no exotic deps
- ✅ `--experimental-strip-types` runs .ts directly, no build step
- ❌ Full-chain backfill might take 5-7 days vs 2-3 in Rust (acceptable for a one-time op)
- ❌ Memory footprint higher for UTXO scans (10-15 GB vs 4-6 GB in Rust)

**Reversal condition:** if backfill takes >7 days OR memory >20 GB
during a steady-state pass.

---

## ADR-005 — Caddy for TLS, not nginx

**Date:** 2026-06-02
**Status:** accepted
**Context:** Need TLS termination + reverse proxy in front of the
indexer. Options: nginx + certbot, Caddy, Traefik.

**Decision:** Caddy.

**Reasoning:**
- 4-line Caddyfile vs ~30 lines of nginx + a separate certbot setup
- Auto Let's Encrypt renewal built-in
- HTTP/3 enabled by default
- The Studio app uses Railway's edge so we have no nginx muscle memory
  to leverage either way

---

## ADR-004 — Hetzner AX42 dedicated (not Cloud VPS)

**Date:** 2026-06-02
**Status:** accepted
**Context:** Need 700+ GB SSD/NVMe for bitcoind + 8+ GB RAM for sync.
Hetzner Cloud CPX41 (8 vCPU, 16 GB, 240 GB) + 1 TB volume = €68/mo.
Hetzner AX42 dedicated (Ryzen 5 5600X, 64 GB, 2× 512 GB NVMe RAID1) = €39/mo.

**Decision:** AX42 dedicated.

**Reasoning:**
- Cheaper than Cloud + storage volume
- RAID1 NVMe = built-in disk redundancy
- 64 GB RAM is overkill for bitcoind, but Postgres backfill + indexer
  passes will use it
- Dedicated hardware = no noisy-neighbour CPU steal
- Bitcoin community (Umbrel, mempool.space, BTCPay) publicly recommends
  Hetzner dedicated as the standard

**Trade-offs:**
- ❌ Not as elastic as cloud (can't scale CPU/RAM independently)
- ❌ Single-AZ failure → site down (acceptable: we have BL as fallback)

---

## ADR-003 — Postgres on the same host (not a managed DB)

**Date:** 2026-06-02
**Status:** accepted
**Context:** Indexer needs a DB. Options: same-host Postgres, Hetzner
managed Postgres, Railway managed Postgres (used by Studio).

**Decision:** Same-host Postgres in Docker, sharing the AX42.

**Reasoning:**
- 64 GB RAM has plenty of room for both bitcoind and Postgres
- Co-location = ~0.1 ms latency vs ~5-10 ms across cloud network
- Indexer makes thousands of small writes per block; network DB
  would dominate the cost profile
- Backups via daily pg_dump → Hetzner Storage Box covers the
  durability story without managed-DB premium

**Trade-offs:**
- ❌ Single point of failure: host dies = both Bitcoin data and Postgres
  data are lost (mitigated by RAID1 + offsite backup)
- ❌ Can't scale Postgres independently if it ever pegs CPU

---

## ADR-002 — txindex + coinstatsindex ON, prune OFF

**Date:** 2026-06-02
**Status:** accepted
**Context:** Bitcoin Core supports pruning (drops old blocks to save
disk, down to ~5 GB) and several optional indexes.

**Decision:** prune=0, txindex=1, coinstatsindex=1.

**Reasoning:**
- We're building an analytics indexer, not a wallet — full history is
  the product
- txindex enables electrs and any future "look up tx by hash" feature
- coinstatsindex makes `gettxoutsetinfo` instant (vs 30s+ without)
- Disk cost is real (~800 GB total) but absorbed by the 2× 512 GB
  RAID1 array of the AX42

---

## ADR-001 — Separate repo, not subfolder of Studio

**Date:** 2026-06-02
**Status:** accepted
**Context:** The Studio app (vantagenode.io frontend + Railway deploy)
already lives in `BlockCapital/Studio`. Should the node live there too?

**Decision:** Separate repo at `vantagenode-node`.

**Reasoning:**
- Different deploy target (Hetzner dedicated vs Railway)
- Different language stack (Node TS indexer + bitcoind + Postgres
  vs the Studio's Node TS + Postgres)
- Different sensitivity (rpcauth password, SSH keys vs the Studio's
  Stripe/Hotmart secrets)
- Different CI cadence (the node won't need Studio's frontend rebuild)
- Independent issue tracking & PR review

**Trade-offs:**
- ❌ Need to keep the metric shape contract synced between repos.
  Mitigation: short contract doc + an integration test in Studio that
  pings our `/healthz` + `/api/catalog`.
