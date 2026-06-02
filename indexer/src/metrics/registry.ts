// Metric registry. Each slug maps to a handler that returns a series
// in the same shape the VantageNode app already understands:
//   { metric, resolution, shape, data, source, cached, partial, status }
//
// Tier-0 handlers serve current-tip values straight from RPC. They
// return a single-point series so the API contract is uniform across
// tiers; the app can render a number badge from data[0].v or plot
// the full historical curve once we have daily_snapshots populated.

import type { RpcClient } from '../rpc.ts';

export type MetricShape = 'scalar' | 'binned';

export interface MetricPoint {
  t: string | number;
  v: number;
}

export interface BinnedPoint {
  t: string | number;
  bins: Record<string, number>;
}

export interface MetricResponse {
  metric: string;
  resolution: 'd1';
  shape: MetricShape;
  source: 'vantagenode-node';
  cached: boolean;
  partial: boolean;
  status: 'ready' | 'preparing';
  data?: MetricPoint[];
  binnedData?: BinnedPoint[];
  binLabels?: string[];
  message?: string;
}

export interface MetricHandler {
  slug: string;
  shape: MetricShape;
  tier: 0 | 1 | 2;
  fmt?: 'usd' | 'btc' | 'ratio' | 'percent' | 'hashes' | 'big';
  /**
   * Compute the metric for a given date range. Tier-0 handlers can
   * ignore from/to and just return the current value.
   */
  compute(opts: {
    rpc: RpcClient;
    from: string;
    to: string;
  }): Promise<{ data?: MetricPoint[]; binnedData?: BinnedPoint[]; binLabels?: string[] }>;
}

const REGISTRY: Record<string, MetricHandler> = {};

export function registerMetric(handler: MetricHandler): void {
  if (REGISTRY[handler.slug]) {
    throw new Error(`[metrics] duplicate registration: ${handler.slug}`);
  }
  REGISTRY[handler.slug] = handler;
}

export function getMetricHandler(slug: string): MetricHandler | null {
  return REGISTRY[slug] ?? null;
}

export function listMetrics(): MetricHandler[] {
  return Object.values(REGISTRY).sort((a, b) => a.slug.localeCompare(b.slug));
}
