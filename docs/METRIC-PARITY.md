# Metric parity tracker

Per-metric checklist of "does our node match the BL value?" Update as
metrics graduate from skeleton → cross-validated → cutover.

## Status legend

| Glyph | Meaning |
|---|---|
| ⚪ | Not implemented |
| 🟡 | Implemented, needs validation |
| 🟠 | Validated, divergence found — investigating |
| 🟢 | Validated ±0.5% — ready to cutover |
| ✅ | Cutover complete, BL retired for this slug |

## Validation procedure

1. Implement the handler in `indexer/src/metrics/`
2. Run side-by-side fetch:
   ```bash
   ./scripts/parity-check.sh <slug>
   ```
   The script hits both this node and BL for the last 90 days,
   computes max relative error.
3. If max error ≤ 0.5%, mark 🟢. Document any methodology delta in
   the metric's handler file.
4. App-side: flip the feature flag, monitor 48h.
5. Mark ✅ in this file. After 90 days with no issues, retire BL
   subscription for that slug.

---

## Tier 0 (RPC pass-through, no historical backfill)

| Slug | Status | Notes |
|---|---|---|
| block_count | 🟡 | Implemented, returns tip height |
| difficulty | 🟡 | |
| hashrate | 🟡 | networkhashps over last 120 blocks |
| supply_total | 🟡 | gettxoutsetinfo muhash |
| utxo_count | 🟡 | |
| mempool_size | 🟡 | |
| mempool_bytes | 🟡 | |
| mempool_min_fee_sat_per_vb | 🟡 | |
| peer_count | 🟡 | |
| fee_estimate_next_block_sat_per_vb | 🟡 | estimatesmartfee 1-block CONSERVATIVE |
| stocktoflow_nominal | ⚪ | derived from height + issuance schedule |
| inflationrate_nominal | ⚪ | annualised from current epoch reward |
| block_subsidy_current | ⚪ | 50 × 0.5^(height/210000) |
| halving_countdown_blocks | ⚪ | |
| chain_size_gb | ⚪ | getblockchaininfo.size_on_disk |

## Tier 1 (lightweight DB)

| Slug | Status | Notes |
|---|---|---|
| supply_lth | ⚪ | UTXO age >= 155 days |
| supply_sth | ⚪ | UTXO age < 155 days |
| supply_lth_percent | ⚪ | supply_lth / supply_total |
| coin_days_destroyed | ⚪ | Σ (UTXO age × value) on spent |
| coin_days_destroyed_lth | ⚪ | CDD restricted to age ≥ 155d UTXOs |
| asol | ⚪ | average spent output lifespan |
| dormancy_raw | ⚪ | CDD / spent_volume |
| mean_coin_age | ⚪ | supply-weighted average age |
| active_addresses_24h | ⚪ | dedup of sender/receiver scriptPubKeys |
| daily_block_count | ⚪ | blocks per UTC day |
| daily_transaction_count | ⚪ | sum block.nTx for the day |
| hodl_waves | ⚪ | binned by age band |

## Tier 2 (heavy — needs price oracle + per-UTXO cost basis)

| Slug | Status | Notes |
|---|---|---|
| realized_cap | ⚪ | Σ UTXOs × price_at_creation |
| realized_price | ⚪ | realized_cap / supply_total |
| mvrv | ⚪ | market_cap / realized_cap |
| mvrv_z | ⚪ | (market_cap - realized_cap) / σ |
| nupl | ⚪ | (market_cap - realized_cap) / market_cap |
| net_unrealized_profit_loss | ⚪ | |
| sopr | ⚪ | spent_value / cost_basis |
| sopr_lth | ⚪ | SOPR for UTXOs ≥ 155d |
| sopr_sth | ⚪ | SOPR for UTXOs < 155d |
| realized_profit | ⚪ | sum positive (consumption - cost) |
| realized_loss | ⚪ | sum absolute negative |
| realized_profit_by_age | ⚪ | binned by spent-output age |
| realized_loss_by_age | ⚪ | |
| urpd_nonlog_supply | ⚪ | 100-bucket histogram, ATH-partitioned |
| unspent_output_by_age_sumbtc | ⚪ | classic HODL Waves |
| unspent_output_by_age_costvalue | ⚪ | RCap HODL Waves — drives RHODL |
| rhodl_ratio | ⚪ | already implemented in Studio; will switch source |
| liveliness | ⚪ | cointime metric |
| vaultedness | ⚪ | inverse cointime metric |

---

## Known methodology deltas with BL

(To be filled as we discover them during F2/F3/F4 validation.)

| Slug | Our convention | BL convention | Impact |
|---|---|---|---|
| _example_ | UTC midnight cutoff | NY midnight cutoff | ±0.3% on daily aggregates |
