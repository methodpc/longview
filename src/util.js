// Shared helpers for the Worker.

export const json = (d, status = 200) => new Response(JSON.stringify(d), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
export const bad = (msg, status = 400) => json({ error: msg }, status);
export const SYM = /^[A-Z0-9^.\-=:]{1,24}$/;
export const cleanSym = s => String(s || '').trim().toUpperCase();
export const HOUR = 3600e3;

// Two-level cache: per-isolate memory, then Cloudflare's edge cache (works on custom domains).
const MEM = new Map();
export async function cached(ctx, key, ttlSec, fn) {
  const m = MEM.get(key);
  if (m && m.exp > Date.now()) return m.v;
  const req = new Request('https://cache.longview.internal/' + encodeURIComponent(key));
  let hit = null;
  try { hit = await caches.default.match(req); } catch {}
  if (hit) { const v = await hit.json(); MEM.set(key, { v, exp: Date.now() + ttlSec * 1000 }); return v; }
  const v = await fn();
  MEM.set(key, { v, exp: Date.now() + ttlSec * 1000 });
  if (MEM.size > 500) MEM.delete(MEM.keys().next().value);
  try { ctx.waitUntil(caches.default.put(req, new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${ttlSec}` } }))); } catch {}
  return v;
}

// Cloudflare Access adds this header after sign-in. Without Access, everyone shares one portfolio ("me").
export const userOf = req => (req.headers.get('cf-access-authenticated-user-email') || 'me').toLowerCase();

export async function userSymbols(env, user) {
  try {
    const r = await env.DB.prepare('SELECT symbol FROM holdings WHERE user = ?1 UNION SELECT symbol FROM watchlist WHERE user = ?1').bind(user).all();
    return r.results.map(x => x.symbol);
  } catch { return []; }
}
export async function allUserSymbols(env) {
  try { return (await env.DB.prepare('SELECT DISTINCT symbol FROM holdings UNION SELECT DISTINCT symbol FROM watchlist').all()).results.map(x => x.symbol); }
  catch { return []; }
}

// Read JSON rows from a (symbol, data, updated_at) table.
export async function loadRows(env, table, syms) {
  const out = {};
  for (let i = 0; i < syms.length; i += 90) {
    const chunk = syms.slice(i, i + 90);
    if (!chunk.length) continue;
    const r = await env.DB.prepare(`SELECT symbol, data, updated_at FROM ${table} WHERE symbol IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all();
    for (const x of r.results) out[x.symbol] = { data: JSON.parse(x.data), at: x.updated_at };
  }
  return out;
}
export const putRow = (env, table, sym, data) =>
  env.DB.prepare(`INSERT OR REPLACE INTO ${table} (symbol, data, updated_at) VALUES (?, ?, ?)`).bind(sym, JSON.stringify(data), Date.now());

// Is the US stock market in regular hours right now? (ignores holidays)
export function usMarketOpen(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const g = t => parts.find(p => p.type === t)?.value;
  if (['Sat', 'Sun'].includes(g('weekday'))) return false;
  const m = +g('hour') * 60 + +g('minute');
  return m >= 570 && m < 965; // 9:30 – 16:05
}
