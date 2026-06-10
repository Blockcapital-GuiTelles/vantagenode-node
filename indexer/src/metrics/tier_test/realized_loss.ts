// Realized Loss test handler — second slug shipped via the tier_test
// pattern (after mvrv_test). Same shape, same provenance: baked
// snapshot of BL's realized_loss daily series, frozen at the moment
// this commit was prepared, served by the node so the Engine Room
// can render an admin-only test indicator without depending on BL
// at request time.
//
// What "realized loss" measures: the USD value of all spent UTXOs on
// a given day where the price at spend was LOWER than the price at
// the original receive. Captures economic loss actually crystallized
// onchain — the canonical capitulation tape. Spikes mark forced
// selling events (Mar-2020, May-2021 China ban, May/Jun-2022 Luna,
// Nov-2022 FTX), troughs the steady-state low-conviction selling
// during bull markets.
//
// Will be replaced by an indexer that computes from UTXO age + price
// once Tier-2 ships (#128), at which point this static handler and
// its baked snapshot retire together.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerMetric } from '../registry.ts';

// __dirname-equivalent for ESM. The data/ directory sits next to src/
// in the indexer image (Dockerfile COPYs both): /app/data and /app/src.
// This file lives at src/metrics/tier_test/, so going three parents
// up reaches /app, where ./data/ is.
const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = join(__dirname, '..', '..', '..', 'data', 'realized_loss_test.json');

// Lazy memoized read — the file is sub-MB on disk but parsed once
// and reused on every request. Frozen snapshot = no mtime check.
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
  slug: 'realized_loss_test',
  shape: 'scalar',
  tier: 0, // test handler — stays in tier 0 so the registry keeps loading it
  fmt: 'usd',
  async compute() {
    return { data: loadSnapshot() };
  },
});
