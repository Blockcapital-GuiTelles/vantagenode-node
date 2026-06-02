// HMAC-based shared-secret auth between the VantageNode app and this
// indexer. Same pattern used by the Binance worker on the main repo:
// the app sends X-Node-Auth: <HMAC-SHA256(secret, "GET:/api/metric/<slug>")>
// and we verify before serving.
//
// The signed string is METHOD:PATH so a replay can't be redirected to
// another endpoint, but we don't bother with a nonce because:
//   - TLS already guarantees integrity & freshness
//   - The data we serve is public-ish (block stats) — replay is harmless
//
// timingSafeEqual comparison defeats timing oracles.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Context, Next } from 'hono';

const SECRET = process.env.NODE_SHARED_SECRET ?? '';
if (!SECRET) {
  console.error('[auth] NODE_SHARED_SECRET not set — every request will be rejected.');
}

function expected(method: string, path: string): string {
  return createHmac('sha256', SECRET).update(`${method}:${path}`).digest('hex');
}

export async function requireNodeAuth(c: Context, next: Next) {
  // Health endpoint is public so external monitors can poll.
  if (c.req.path === '/healthz') return next();
  if (!SECRET) return c.json({ error: 'server misconfigured' }, 503);

  const provided = c.req.header('X-Node-Auth') ?? '';
  if (!provided) return c.json({ error: 'missing X-Node-Auth' }, 401);

  // Strip query string from path — the signed string covers METHOD:PATH only.
  const url = new URL(c.req.url);
  const exp = expected(c.req.method, url.pathname);
  const a = Buffer.from(exp, 'hex');
  const b = Buffer.from(provided, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return c.json({ error: 'invalid X-Node-Auth' }, 401);
  }
  return next();
}
