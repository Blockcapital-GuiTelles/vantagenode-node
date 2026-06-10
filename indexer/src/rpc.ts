// Minimal Bitcoin Core JSON-RPC client. We avoid bigger dependencies
// (bitcoin-core npm pkg has a swarm of transitive deps and a clunky
// promise wrapper) because all we really need is "post a JSON body
// with basic auth, parse the response, throw on error".

export class RpcError extends Error {
  // Explicit field declaration + assignment in the body — Node 22's
  // --experimental-strip-types (used in production CMD) does NOT
  // understand TS parameter properties (`public code: number` in the
  // ctor signature). Strip-only mode rejects that syntax wholesale.
  // Declaring the field on the class works under strip mode and is
  // equivalent at runtime.
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
    this.name = 'RpcError';
  }
}

interface RpcResponse<T> {
  result: T | null;
  error: { code: number; message: string } | null;
  id: string | number;
}

export interface RpcConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  timeoutMs?: number;
}

let nextId = 1;

export class RpcClient {
  private readonly auth: string;
  private readonly url: string;
  private readonly timeoutMs: number;

  constructor(cfg: RpcConfig) {
    this.url = `http://${cfg.host}:${cfg.port}/`;
    this.auth = 'Basic ' + Buffer.from(`${cfg.user}:${cfg.password}`).toString('base64');
    this.timeoutMs = cfg.timeoutMs ?? 30_000;
  }

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const id = nextId++;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let resp: Response;
    try {
      resp = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Authorization': this.auth,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '1.0', id, method, params }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(t);
    }
    if (!resp.ok && resp.status !== 500) {
      // 500 still includes a JSON-RPC error body; only abort here on
      // truly transport-level failures (401, 403, 502, network).
      throw new RpcError(resp.status, `HTTP ${resp.status} ${resp.statusText}`);
    }
    const json = (await resp.json()) as RpcResponse<T>;
    if (json.error) {
      throw new RpcError(json.error.code, json.error.message);
    }
    if (json.result === null || json.result === undefined) {
      throw new RpcError(-32000, `RPC ${method} returned null result`);
    }
    return json.result;
  }
}

// ----------------------------------------------------------------------
// Typed wrappers for the RPC calls the Tier 0 endpoints use. Keeping
// the typing close to the actual Bitcoin Core API surface so refactors
// stay grep-able.
// ----------------------------------------------------------------------

export interface BlockchainInfo {
  chain: string;
  blocks: number;
  headers: number;
  bestblockhash: string;
  difficulty: number;
  mediantime: number;
  verificationprogress: number;
  initialblockdownload: boolean;
  size_on_disk: number;
  pruned: boolean;
}

export interface MiningInfo {
  blocks: number;
  currentblockweight?: number;
  currentblocktx?: number;
  difficulty: number;
  networkhashps: number;
  pooledtx: number;
  chain: string;
}

export interface MempoolInfo {
  loaded: boolean;
  size: number;
  bytes: number;
  usage: number;
  total_fee: number;
  maxmempool: number;
  mempoolminfee: number;
  minrelaytxfee: number;
}

export interface NetworkInfo {
  version: number;
  subversion: string;
  protocolversion: number;
  connections: number;
  networkactive: boolean;
  warnings: string;
}

export interface TxOutSetInfo {
  height: number;
  bestblock: string;
  txouts: number;
  bogosize: number;
  hash_serialized_2?: string;
  // when coinstatsindex is enabled
  muhash?: string;
  total_amount: number;
  // available with coinstatsindex
  total_unspendable_amount?: number;
  block_info?: unknown;
}
