# Roadmap

Phased plan to reach data parity with the third-party API ("BL")
currently powering VantageNode. Each phase ships something usable on
its own; cutover happens per-metric so there's no big-bang risk.

---

## F1 — Infrastructure (weeks 1-2)

**Goal:** node running, sync'd, monitored. Indexer skeleton boots and
talks to RPC. Nothing serving real traffic yet.

| # | Task | Owner | Status |
|---|---|---|---|
| 1.1 | Order Hetzner AX42 (€39/mo) | operator | ⚪ |
| 1.2 | Run `infra/provision.sh` on fresh Debian 12 | operator | ⚪ |
| 1.3 | Generate `rpcauth` + populate `.env` | operator | ⚪ |
| 1.4 | `docker compose up -d bitcoind` → Initial Block Download | bitcoind | ⚪ |
| 1.5 | Wait 1-3 days for IBD + txindex build | bitcoind | ⚪ |
| 1.6 | `docker compose up -d postgres indexer caddy` | operator | ⚪ |
| 1.7 | DNS: point `node.vantagenode.io` at the server IP | operator | ⚪ |
| 1.8 | Caddy auto-provisions Let's Encrypt cert | caddy | ⚪ |
| 1.9 | First `/healthz` curl returns `ok: true` | indexer | ⚪ |
| 1.10 | First `/api/catalog` returns Tier-0 list | indexer | ⚪ |

**Exit criteria:**
- bitcoind reports `initialblockdownload: false`
- `txindex` and `coinstatsindex` both present in `getindexinfo`
- `https://node.vantagenode.io/healthz` returns 200 with current
  block count matching mempool.space
- All 10 Tier-0 metrics return sensible values via `/api/metric/<slug>`

---

## F2 — Tier 0 API (weeks 3-4)

**Goal:** 25+ trivial metrics served from our node. Studio app reads
the easy ones from us as a per-metric feature-flag flip.

### What ships
| Slug | RPC source | Status |
|---|---|---|
| block_count | getblockchaininfo | ✅ skeleton |
| difficulty | getblockchaininfo | ✅ skeleton |
| hashrate | getmininginfo.networkhashps | ✅ skeleton |
| supply_total | gettxoutsetinfo (muhash) | ✅ skeleton |
| utxo_count | gettxoutsetinfo.txouts | ✅ skeleton |
| mempool_size | getmempoolinfo.size | ✅ skeleton |
| mempool_bytes | getmempoolinfo.bytes | ✅ skeleton |
| mempool_min_fee_sat_per_vb | getmempoolinfo.mempoolminfee | ✅ skeleton |
| peer_count | getnetworkinfo.connections | ✅ skeleton |
| fee_estimate_next_block_sat_per_vb | estimatesmartfee | ✅ skeleton |
| stocktoflow_nominal | derived from height + issuance | ⚪ |
| inflationrate_nominal | derived from height | ⚪ |
| block_subsidy_current | 50 × 0.5^(height/210000) | ⚪ |
| halving_countdown_blocks | next halving - height | ⚪ |
| daily_block_count | iterate yesterday's blocks | ⚪ |
| daily_transaction_count | sum block.nTx for yesterday | ⚪ |
| daily_total_fee_btc | sum block fee outputs | ⚪ |
| coin_age_destroyed_daily | Σ (UTXO age × value) for spent outputs | ⚪ |
| coinbase_reward_btc | block 0 → tip cumulative | ⚪ |
| chain_size_gb | getblockchaininfo.size_on_disk | ⚪ |
| witness_size_share | (block weight - tx size × 4) / block weight | ⚪ |
| segwit_adoption_pct | % of inputs spending witness UTXOs | ⚪ |
| taproot_adoption_pct | % of inputs spending P2TR | ⚪ |
| op_return_share | OP_RETURN size / block size | ⚪ |
| ordinals_inscription_rate | parse witness for ordinals tag | ⚪ |

**App-side work:** add a feature flag table per slug (`useOwnNode: true/false`).
Studio's `/api/metric/<slug>` handler checks the flag, tries our node
first when on, falls back to BL on 5xx/404.

---

## F3 — Tier 1 + Postgres (weeks 5-8)

**Goal:** indexer maintains UTXO state in Postgres; cohort metrics
(LTH/STH, supply distribution) become real.

### What ships
- `postgres-init.sql` schema applied via container init
- Indexer subscribes to ZMQ `rawblock` and updates state per block
- Backfill: walk every block from genesis to tip once, populate
  `block_index` + `utxo_age_buckets` daily snapshots
- Metrics:
  - supply_lth / supply_sth / supply_lth_percent
  - coin_days_destroyed_lth / coin_days_destroyed_sth
  - asol, dormancy_raw, mean_coin_age
  - active_addresses_24h
  - hodl_waves (binned)

**Estimated DB size after backfill:** ~150 GB.

**Risks:**
- Backfill is 2-4 days. Need to checkpoint progress so we can resume.
- Reorgs during backfill — process blocks as "tentative" until
  6 confirmations.

---

## F4 — Tier 2 heavy (weeks 9-14)

**Goal:** MVRV, NUPL, SOPR, Realized Cap, URPD, HODL Waves, RCap HODL
Waves, RHODL Ratio.

### Key dependencies
- **Price oracle internal:** pull Binance/Kraken/Bitstamp daily closes,
  store median in `price_history` table. Backfill 2010-01-01 → today.
- **Per-UTXO cost basis:** each UTXO records `value × price_at_creation`
  in `utxo_age_buckets.realized_value_usd`.
- **Spent output tracking:** when a UTXO is consumed, we know its
  cost basis (already in DB) and its consumption price (block time
  × that day's price). Realized P/L = consumption_value − cost_basis.

### What ships
- realized_cap (Σ UTXOs × cost basis)
- realized_price (realized_cap / supply)
- mvrv, mvrv_z
- nupl, net_unrealized_profit_loss
- sopr, sopr_lth, sopr_sth
- realized_profit, realized_loss (daily aggregates)
- realized_profit_by_age, realized_loss_by_age (binned)
- urpd_nonlog_supply (100-bucket histogram, ATH-partitioned)
- hodl_waves (rcap-weighted)
- rhodl_ratio (already have the formula in Studio — just point at our data)

---

## F5 — Cutover (weeks 15-16)

**Goal:** flip per-metric feature flags from BL → our node. BL stays
as fallback for 90 days, then retire.

### Process per metric
1. Compute both BL and our value for last 30 days
2. Compare: must match within ±0.5% relative error (some leeway for
   minor methodology differences, e.g. UTC midnight boundary)
3. Manual eyeball of 3-5 chart screenshots side by side
4. Flip flag; monitor error rate for 48h
5. If no incidents, mark BL retired for that slug

### Tracking
See `docs/METRIC-PARITY.md` for the per-metric checklist.

---

## F6 — Ongoing / optimisation

Stuff worth doing once we own the data:

- **Address clustering** (common-input heuristics, then change-address
  heuristics) to label known entities (exchanges, miners, custody)
- **Lightning Network** node side-by-side — capacity, channel count,
  fee market
- **Exchange flow tracking** — once clusters are labelled, we can
  serve "BTC flowing into/out of Coinbase" without third-party data
- **Taproot adoption breakdown** by tx type (P2TR-key-path vs
  script-path)
- **Ordinals/inscriptions** counter (controversial but a market signal)
- **Engine Room metrics** (Bull/Bear Tide, Exhaustion Pulse, etc)
  recomputed from our data so we own the full chain end-to-end

---

## Cost summary

| Phase | Server cost | Total cost-to-date (months × €39) |
|---|---|---|
| F1 (sync) | €39 / mo | €39 |
| F2 (Tier 0) | €39 / mo | €78 |
| F3 (Tier 1) | €39 / mo | €156 |
| F4 (Tier 2) | €39 / mo | €312 |
| F5 (cutover) | €39 / mo | €390 |

After cutover: BL subscription cancellable. Net savings = (BL_monthly − €39) × 12 per year.
