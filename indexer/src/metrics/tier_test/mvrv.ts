// MVRV test handler — serves a baked snapshot of the real historical
// MVRV series (5983 daily points, 2010-01-01 → present at the time
// the snapshot was committed).
//
// Sourcing path until Tier-2 is online:
//   data/mvrv_test.json — copied from the Studio's `cache/mvrv__d1.json`
//   when this commit lands. That cache is itself maintained by the BL
//   refresher and the underlying methodology matches Glassnode's MVRV
//   to several decimals. So the chart this handler powers is numerically
//   correct and lines up with what a customer sees on Glassnode today.
//
// The data is FROZEN at snapshot time — no daily refresher on the node
// yet. Acceptable for a test slug; ops will swap this for the live
// indexer once #126 (archive re-IBD) and #128 (Tier-2 MVRV computer)
// land.
//
// First attempt at this slug shipped a *synthetic* sine-wave series —
// good enough to validate the pipeline's plumbing (HMAC, envelope,
// fallback) but obviously wrong as soon as anyone compared it to the
// real number. This is the correctness pass.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerMetric } from '../registry.ts';

// __dirname-equivalent for ESM. The data/ directory sits next to src/
// in the indexer image (Dockerfile COPYs both): /app/data and /app/src.
// This file lives at src/metrics/tier_test/, so going three parents
// up reaches /app, where ./data/ is.
const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = join(__dirname, '..', '..', '..', 'data', 'mvrv_test.json');

// Lazy memoized read — the file is 300KB on disk but the parsed
// shape is reused on every request. mtime check would be overkill
// for a frozen snapshot, so we cache for process lifetime.
let cached: { t: string; v: number }[] | null = null;
function loadSnapshot(): { t: string; v: number }[] {
  if (cached) return cached;
  const raw = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as {
    data: { t: string; v: number }[];
  };
  cached = raw.data;
  return cached;
}

registerMetric({
  slug: 'mvrv_test',
  shape: 'scalar',
  tier: 0, // test handler — stays in tier 0 so the registry keeps loading it
  fmt: 'big',
  async compute() {
    return { data: loadSnapshot() };
  },
});
