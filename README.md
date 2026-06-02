# VantageNode · Onchain Node

> Bitcoin full node + custom indexer + REST API. Powers the onchain
> metrics shown in [VantageNode terminal](https://vantagenode.io)
> without depending on a third-party data provider.

**Status:** 🟡 Scaffolding — Phase 1 in progress. Not yet running in production.

The VantageNode app currently consumes its onchain data from a third-
party API ("BL"). This repository is the parallel project that will
eventually replace that dependency with our own Bitcoin node + indexer
running on a Hetzner VPS, giving us:

- **Data sovereignty** — every metric reproducible from raw chain data
- **Zero recurring API cost** beyond the VPS itself (~€39/mo)
- **Latency** matching block time (10 min) instead of upstream cache delay
- **Custom metrics** the BL doesn't expose (Lightning state, ordinals,
  taproot adoption, address clusters, etc) when we want them

---

## High-level architecture

```
┌──────────────────────────────────────────────────────────┐
│  Hetzner AX42 dedicated — €39/mo                         │
│  Debian 12 · 64 GB RAM · 2× 512 GB NVMe RAID1           │
│  ────────────────────────────────────────────────────    │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │ bitcoind (Bitcoin Core 27.x)                      │   │
│  │  · txindex=1                                      │   │
│  │  · coinstatsindex=1                               │   │
│  │  · prune=0 (full archive)                         │   │
│  │  · RPC :8332 (loopback only)                      │   │
│  │  · ZMQ :28332 (rawblock notifications)            │   │
│  └──────────────────────────────────────────────────┘   │
│                          │                                │
│  ┌──────────────────────────────────────────────────┐   │
│  │ vantagenode-indexer (Node.js + TypeScript)        │   │
│  │  · Hono HTTP server                               │   │
│  │  · bitcoincore-rpc client                         │   │
│  │  · ZMQ subscriber → incremental updates           │   │
│  │  · Postgres for derived state                     │   │
│  │  · /api/metric/<slug>?from=...&to=...             │   │
│  └──────────────────────────────────────────────────┘   │
│                          │                                │
│  ┌──────────────────────────────────────────────────┐   │
│  │ postgres (16) — derived metrics + UTXO state       │   │
│  └──────────────────────────────────────────────────┘   │
│                          │                                │
│  ┌──────────────────────────────────────────────────┐   │
│  │ caddy (TLS edge) — Let's Encrypt auto-renew       │   │
│  │  · HTTPS only · HMAC auth required                │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
└──────────────────────────────────────────────────────────┘
                          │ HTTPS
                          ▼
              ┌─────────────────────┐
              │ VantageNode App     │
              │ (Railway, Studio)   │
              │  · Tries this node  │
              │    first; falls     │
              │    back to BL       │
              └─────────────────────┘
```

---

## Repo layout

```
.
├── README.md                 ← you are here
├── docker-compose.yml        ← bitcoind + postgres + indexer + caddy
├── .env.example              ← copy → .env, fill in
├── infra/
│   ├── provision.sh          ← idempotent bootstrap for a fresh AX42
│   ├── bitcoin.conf          ← Bitcoin Core config (txindex, coinstats, ZMQ)
│   ├── Caddyfile             ← TLS reverse proxy + auth gate
│   └── postgres-init.sql     ← schema bootstrap
├── indexer/                  ← TypeScript service
│   ├── src/
│   │   ├── server.ts         ← Hono app
│   │   ├── rpc.ts            ← Bitcoin Core RPC client
│   │   ├── auth.ts           ← shared-secret HMAC check
│   │   └── metrics/
│   │       ├── registry.ts   ← slug → handler map
│   │       └── tier0/        ← trivial RPC pass-throughs
│   ├── package.json
│   ├── tsconfig.json
│   └── Dockerfile
└── docs/
    ├── ROADMAP.md            ← phased plan, current sprint, next sprint
    ├── RUNBOOK.md            ← ops: backup, restore, monitoring
    ├── METRIC-PARITY.md      ← BL ↔ our-node comparison checklist
    └── DECISIONS.md          ← architecture decision records (ADRs)
```

---

## Phased roadmap (see `docs/ROADMAP.md` for detail)

| Phase | Scope | Duration | Status |
|---|---|---|---|
| **F1 — Infra** | VPS provisioned, bitcoind synced, indexer skeleton | 2 weeks | 🟡 in progress |
| **F2 — Tier 0 API** | 25 trivial metrics served (hashrate, supply, etc) | 2 weeks | ⚪ pending |
| **F3 — Tier 1 + indexer** | CDD, ASOL, supply LTH/STH (40 metrics) | 4 weeks | ⚪ pending |
| **F4 — Tier 2 (heavy)** | MVRV, NUPL, SOPR, URPD, HODL Waves, RHODL | 6 weeks | ⚪ pending |
| **F5 — Cutover** | BL → our node per-metric feature flag flip | 2 weeks | ⚪ pending |
| **F6 — Optimizations** | Address clustering, Lightning, Taproot adoption | ongoing | ⚪ pending |

**Total to feature parity:** ~16 weeks. **MVP useful for the app:** end of F2 (~4 weeks).

---

## How the VantageNode app integrates

The plan is **zero breaking changes** on the app side. The indexer
exposes endpoints with **the same response shape** the BL uses today:

```http
GET https://node.vantagenode.io/api/metric/sopr?from=2024-01-01&to=2026-06-01
X-Node-Auth: <hmac>

{
  "metric": "sopr",
  "resolution": "d1",
  "shape": "scalar",
  "data": [{"t": "2024-01-01T00:00:00Z", "v": 1.012}, ...],
  "source": "vantagenode-node",
  "cached": false,
  "partial": false,
  "status": "ready"
}
```

The Studio app gets one new env var: `VANTAGE_NODE_URL`. When set, it
tries our node first per-metric and falls back to BL on 404/5xx. A
feature flag table (per slug) lets us cutover gradually.

---

## Quick start (local dev — no actual node)

```bash
git clone git@github.com:Blockcapital-GuiTelles/vantagenode-node.git
cd vantagenode-node
cp .env.example .env
# Set BITCOIN_RPC_HOST=<remote-bitcoind> or run a local regtest first
docker compose up indexer postgres
# Indexer at http://localhost:3001
```

For production deploy (Hetzner AX42), see `infra/provision.sh` and
`docs/RUNBOOK.md`.

---

## License & ownership

Private, all rights reserved. © VantageNode LLC, 2026.
