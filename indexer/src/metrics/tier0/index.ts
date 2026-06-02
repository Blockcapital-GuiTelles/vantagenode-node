// Tier-0 metric handlers — direct RPC pass-throughs, no DB needed.
//
// These return a single-point "current tip" series. They're the
// validation of the whole pipeline: if these return correct values
// the app integration works end-to-end before we tackle the harder
// indexed metrics.
//
// Naming convention matches the BL slugs so the app can swap source
// transparently per metric via feature flag.

import { registerMetric } from '../registry.ts';
import type {
  BlockchainInfo, MempoolInfo, MiningInfo, NetworkInfo, TxOutSetInfo,
} from '../../rpc.ts';

function tipPoint(v: number): { data: { t: string; v: number }[] } {
  return { data: [{ t: new Date().toISOString().slice(0, 10) + 'T00:00:00Z', v }] };
}

// ============================================================
// block_count — current chain tip height
// ============================================================
registerMetric({
  slug: 'block_count',
  shape: 'scalar',
  tier: 0,
  fmt: 'big',
  async compute({ rpc }) {
    const info = await rpc.call<BlockchainInfo>('getblockchaininfo');
    return tipPoint(info.blocks);
  },
});

// ============================================================
// difficulty — current network difficulty
// ============================================================
registerMetric({
  slug: 'difficulty',
  shape: 'scalar',
  tier: 0,
  fmt: 'big',
  async compute({ rpc }) {
    const info = await rpc.call<BlockchainInfo>('getblockchaininfo');
    return tipPoint(info.difficulty);
  },
});

// ============================================================
// hashrate — derived from networkhashps (last 120 blocks ~ 1 day)
// ============================================================
registerMetric({
  slug: 'hashrate',
  shape: 'scalar',
  tier: 0,
  fmt: 'hashes',
  async compute({ rpc }) {
    const info = await rpc.call<MiningInfo>('getmininginfo');
    return tipPoint(info.networkhashps);
  },
});

// ============================================================
// supply_total — total bitcoin in existence at chain tip
// (uses coinstatsindex for instant return; without it the call
//  would take ~30s walking the UTXO set)
// ============================================================
registerMetric({
  slug: 'supply_total',
  shape: 'scalar',
  tier: 0,
  fmt: 'btc',
  async compute({ rpc }) {
    const info = await rpc.call<TxOutSetInfo>('gettxoutsetinfo', ['muhash']);
    return tipPoint(info.total_amount);
  },
});

// ============================================================
// utxo_count — number of unspent outputs
// ============================================================
registerMetric({
  slug: 'utxo_count',
  shape: 'scalar',
  tier: 0,
  fmt: 'big',
  async compute({ rpc }) {
    const info = await rpc.call<TxOutSetInfo>('gettxoutsetinfo', ['muhash']);
    return tipPoint(info.txouts);
  },
});

// ============================================================
// mempool_size — number of pending tx
// ============================================================
registerMetric({
  slug: 'mempool_size',
  shape: 'scalar',
  tier: 0,
  fmt: 'big',
  async compute({ rpc }) {
    const info = await rpc.call<MempoolInfo>('getmempoolinfo');
    return tipPoint(info.size);
  },
});

// ============================================================
// mempool_bytes — virtual size of pending mempool
// ============================================================
registerMetric({
  slug: 'mempool_bytes',
  shape: 'scalar',
  tier: 0,
  fmt: 'big',
  async compute({ rpc }) {
    const info = await rpc.call<MempoolInfo>('getmempoolinfo');
    return tipPoint(info.bytes);
  },
});

// ============================================================
// mempool_min_fee — minimum fee accepted by our node's mempool
// (sat/vB equivalent; bitcoin core returns BTC/kvB so multiply)
// ============================================================
registerMetric({
  slug: 'mempool_min_fee_sat_per_vb',
  shape: 'scalar',
  tier: 0,
  fmt: 'big',
  async compute({ rpc }) {
    const info = await rpc.call<MempoolInfo>('getmempoolinfo');
    // BTC/kvB → sat/vB: BTC/kvB × 1e8 / 1000
    const satPerVb = info.mempoolminfee * 1e8 / 1000;
    return tipPoint(satPerVb);
  },
});

// ============================================================
// peer_count — connected peers
// ============================================================
registerMetric({
  slug: 'peer_count',
  shape: 'scalar',
  tier: 0,
  fmt: 'big',
  async compute({ rpc }) {
    const info = await rpc.call<NetworkInfo>('getnetworkinfo');
    return tipPoint(info.connections);
  },
});

// ============================================================
// fee_estimate_next_block — fee for inclusion in next block
// ============================================================
registerMetric({
  slug: 'fee_estimate_next_block_sat_per_vb',
  shape: 'scalar',
  tier: 0,
  fmt: 'big',
  async compute({ rpc }) {
    // 1-block target. Conservative estimate mode → economical = false.
    const est = await rpc.call<{ feerate?: number; blocks: number }>(
      'estimatesmartfee', [1, 'CONSERVATIVE']
    );
    if (typeof est.feerate !== 'number') return tipPoint(0);
    const satPerVb = est.feerate * 1e8 / 1000;
    return tipPoint(satPerVb);
  },
});
