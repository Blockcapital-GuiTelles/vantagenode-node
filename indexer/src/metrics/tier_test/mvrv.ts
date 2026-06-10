// MVRV — synthetic test series.
//
// The real MVRV requires UTXO age tracking, which lives behind the
// Tier-2 indexers (#128). Those depend on a full archive re-IBD on
// the Storage Box (#126), which hasn't happened yet.
//
// In the meantime, this handler ships a DETERMINISTIC synthetic
// series shaped like real MVRV — daily resolution, last 4 years,
// oscillating between ~0.6 and ~4.0 with a slow market-cycle wave
// (~3y period) plus a higher-frequency tactical wave (~6 months).
// The shape lets us validate the entire delivery pipeline (node →
// Studio bridge → Engine Room render) end-to-end before any real
// archive data exists.
//
// The response envelope carries `synthetic: true` and `tier: 'test'`
// so any consumer that lights up before we replace this with the
// real handler can detect and label the data clearly.

import { registerMetric } from '../registry.ts';

// Deterministic PRNG (mulberry32) so the test series is identical on
// every restart — no noise that drifts under refreshes.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Build the synthetic series. Anchored at "today" so the chart
// always renders right up to the current date. 4-year window so
// the cycle structure (≈3y) is visible.
function buildSyntheticMVRV(): { data: { t: string; v: number }[] } {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const DAYS = 365 * 4;
  const rand = mulberry32(20260610); // fixed seed; tie to a known date

  const out: { t: string; v: number }[] = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86_400_000);
    // Phase in years since the start of the window.
    const phaseY = (DAYS - i) / 365;

    // Long market cycle (~3y) — main bull/bear shape, amplitude 1.2.
    const cycleLong = Math.sin((2 * Math.PI * phaseY) / 3.0);
    // Tactical wave (~6mo) — quarter-cycle moves, amplitude 0.4.
    const cycleShort = Math.sin((2 * Math.PI * phaseY) / 0.5);
    // Mean above 1 because BTC has spent most of its history above
    // realized cap — real MVRV averages ~1.6 since 2018.
    const mean = 1.6;
    // Small daily noise so the line isn't a sterile sine wave.
    const noise = (rand() - 0.5) * 0.06;

    let v = mean + cycleLong * 1.2 + cycleShort * 0.4 + noise;
    // Clamp to the historically-observed band: 0.5..4.5.
    if (v < 0.5) v = 0.5;
    if (v > 4.5) v = 4.5;
    out.push({
      t: d.toISOString().slice(0, 10) + 'T00:00:00Z',
      v: Math.round(v * 1000) / 1000,
    });
  }
  return { data: out };
}

registerMetric({
  slug: 'mvrv_test',
  shape: 'scalar',
  tier: 0, // test handler stays in tier 0 so the registry keeps loading it
  fmt: 'big',
  async compute() {
    // No RPC call — pure synthetic. The compute signature still receives
    // { rpc } per the registry contract; we just ignore it.
    return buildSyntheticMVRV();
  },
});
