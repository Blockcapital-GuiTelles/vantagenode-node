// VantageNode indexer HTTP server.
//
// Responsibilities:
//   - Health/readiness endpoints
//   - /api/metric/<slug> — serves the registered handler
//   - /api/catalog       — lists every metric this indexer supports
// Auth: HMAC-shared-secret via X-Node-Auth header (see ./auth.ts).
//
// What we explicitly do NOT do here yet (these come in F3+):
//   - Postgres persistence
//   - ZMQ subscriber for incremental updates
//   - Initial block backfill
// Tier 0 is RPC-only, no DB. Adding DB writes is a layer above this
// once the indexer service runs continuously.

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { requireNodeAuth } from './auth.ts';
import { RpcClient } from './rpc.ts';
import { getMetricHandler, listMetrics } from './metrics/registry.ts';

// Register every Tier-0 metric. Import side effect: each file in
// metrics/tier0/* calls registerMetric() at import time.
import './metrics/tier0/index.ts';

const PORT = parseInt(process.env.PORT ?? '3001', 10);

const rpc = new RpcClient({
  host: process.env.BITCOIN_RPC_HOST ?? '127.0.0.1',
  port: parseInt(process.env.BITCOIN_RPC_PORT ?? '8332', 10),
  user: process.env.BITCOIN_RPC_USER ?? 'indexer',
  password: process.env.BITCOIN_RPC_PASSWORD ?? '',
});

const app = new Hono();

// ============================================================
// Health (public, no auth)
// ============================================================
app.get('/healthz', async (c) => {
  try {
    const info = await rpc.call<{ blocks: number; initialblockdownload: boolean }>(
      'getblockchaininfo'
    );
    return c.json({
      ok: true,
      blocks: info.blocks,
      initialBlockDownload: info.initialblockdownload,
      ts: new Date().toISOString(),
    });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 503);
  }
});

// ============================================================
// Auth (everything below requires X-Node-Auth)
// ============================================================
app.use('/api/*', requireNodeAuth);

// ============================================================
// Catalog — list registered metrics
// ============================================================
app.get('/api/catalog', (c) => {
  return c.json({
    metrics: listMetrics().map((h) => ({
      slug: h.slug,
      shape: h.shape,
      tier: h.tier,
      fmt: h.fmt ?? null,
    })),
    ts: new Date().toISOString(),
  });
});

// ============================================================
// Metric serve
// ============================================================
app.get('/api/metric/:slug', async (c) => {
  const slug = c.req.param('slug');
  const handler = getMetricHandler(slug);
  if (!handler) {
    return c.json({ error: 'unknown_metric', metric: slug }, 404);
  }

  const from = c.req.query('from') ?? defaultFrom();
  const to = c.req.query('to') ?? new Date().toISOString().slice(0, 10);

  try {
    const result = await handler.compute({ rpc, from, to });
    return c.json({
      metric: slug,
      resolution: 'd1',
      shape: handler.shape,
      source: 'vantagenode-node',
      cached: false,
      partial: false,
      status: 'ready',
      ...result,
    });
  } catch (err) {
    console.error(`[${slug}] compute failed:`, err);
    return c.json({
      metric: slug,
      resolution: 'd1',
      shape: handler.shape,
      source: 'vantagenode-node',
      status: 'error',
      message: 'upstream node temporarily unavailable',
    }, 503);
  }
});

function defaultFrom(): string {
  // 5 years back, same as the Studio app's default range.
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - 5);
  return d.toISOString().slice(0, 10);
}

// ============================================================
// Boot
// ============================================================
serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[indexer] listening on http://0.0.0.0:${info.port}`);
  console.log(`[indexer] registered ${listMetrics().length} metrics`);
  console.log(`[indexer] bitcoind RPC: ${process.env.BITCOIN_RPC_HOST}:${process.env.BITCOIN_RPC_PORT}`);
});
