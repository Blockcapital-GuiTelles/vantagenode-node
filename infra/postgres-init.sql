-- VantageNode indexer schema bootstrap.
--
-- Runs once on first container start via docker-entrypoint-initdb.d.
-- Idempotent (IF NOT EXISTS) so a re-bootstrap from a fresh volume is
-- safe; subsequent schema changes go through versioned migrations
-- managed by the indexer itself (not in this file).

-- ============================================================
-- daily_snapshots — one row per (metric, date) with the value.
--
-- This is the wire-shape table that the API queries. Derived metrics
-- write into here once per UTC day; the API serves slices by date
-- range without ever touching live bitcoind state.
-- ============================================================
CREATE TABLE IF NOT EXISTS daily_snapshots (
    metric TEXT NOT NULL,
    snapshot_date DATE NOT NULL,
    -- value_scalar: simple metrics. value_binned: JSONB {bin_label: number}.
    -- Only one is populated per row; CHECK constraint enforces this.
    value_scalar DOUBLE PRECISION,
    value_binned JSONB,
    -- bookkeeping
    computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    source TEXT NOT NULL DEFAULT 'indexer',
    PRIMARY KEY (metric, snapshot_date),
    CHECK ((value_scalar IS NOT NULL) <> (value_binned IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_daily_snapshots_date ON daily_snapshots (snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_daily_snapshots_metric_date ON daily_snapshots (metric, snapshot_date DESC);

-- ============================================================
-- block_index — light cache of per-block metadata.
--
-- Indexer materialises (height, time, hash, tx_count, total_fee,
-- total_output_value) for every block it processes. Lets us serve
-- historical aggregates without RPC round-trips per block.
-- ============================================================
CREATE TABLE IF NOT EXISTS block_index (
    height INTEGER PRIMARY KEY,
    hash TEXT NOT NULL UNIQUE,
    block_time TIMESTAMPTZ NOT NULL,
    tx_count INTEGER NOT NULL,
    total_output_btc DOUBLE PRECISION NOT NULL,
    total_fee_btc DOUBLE PRECISION NOT NULL,
    -- coin_days_destroyed lives at block granularity because reorgs
    -- can change it; aggregated to daily_snapshots for serving.
    coin_days_destroyed DOUBLE PRECISION,
    -- when our indexer ingested this block
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_block_index_time ON block_index (block_time DESC);

-- ============================================================
-- price_history — local copy of BTC/USD daily closes.
--
-- The indexer needs price to compute Realized Cap, MVRV, NUPL, SOPR,
-- URPD, etc. We don't depend on the Studio's price cache because the
-- indexer must run independently. Refresher pulls from Binance/Kraken
-- /Bitstamp and stores median per day.
-- ============================================================
CREATE TABLE IF NOT EXISTS price_history (
    snapshot_date DATE PRIMARY KEY,
    close_usd DOUBLE PRECISION NOT NULL,
    source TEXT NOT NULL DEFAULT 'binance',
    refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- utxo_age_buckets — daily snapshot of supply by UTXO age band.
--
-- The expensive one. Indexer walks the UTXO set (gettxoutsetinfo +
-- per-output age) and classifies into age buckets at each UTC midnight.
-- Backbone of HODL Waves, Realized Cap, RCap HODL Waves, RHODL.
-- ============================================================
CREATE TABLE IF NOT EXISTS utxo_age_buckets (
    snapshot_date DATE NOT NULL,
    age_band TEXT NOT NULL,  -- e.g. '[1, 7>', '[365, 720>'
    -- amount of BTC sitting in this band
    btc_amount DOUBLE PRECISION NOT NULL,
    -- realized value: Σ (utxo.value × price_at_creation)
    realized_value_usd DOUBLE PRECISION NOT NULL,
    -- count of UTXOs (sometimes useful)
    utxo_count INTEGER NOT NULL,
    PRIMARY KEY (snapshot_date, age_band)
);
CREATE INDEX IF NOT EXISTS idx_utxo_age_date ON utxo_age_buckets (snapshot_date DESC);

-- ============================================================
-- metric_metadata — slug -> properties.
--
-- Mirrors a subset of the Studio CATALOG: shape, fmt, defaultScale,
-- etc. Used by the indexer to validate registrations at boot. NOT
-- the source of truth for editorial fields (those live in the app).
-- ============================================================
CREATE TABLE IF NOT EXISTS metric_metadata (
    slug TEXT PRIMARY KEY,
    shape TEXT NOT NULL CHECK (shape IN ('scalar', 'binned')),
    tier INTEGER NOT NULL CHECK (tier IN (0, 1, 2)),
    last_computed TIMESTAMPTZ,
    last_error TEXT,
    notes TEXT
);
