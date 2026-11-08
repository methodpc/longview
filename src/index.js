// Longview Worker: serves the app from /public and a small JSON API under /api/*.
import { Fmp, quotes, fetchFundamentals, normQuote, normNews, normHistory, normTarget, normGrades } from './fmp.js';
import { INDICES, MACRO, CURATED, FUNDS } from './universe.js';
import { DEMO_UNIVERSE } from './demo.js';
import { json, bad, SYM, cleanSym, cached, userOf, userSymbols, HOUR } from './util.js';
import { handleFinnhub, tickFinnhub } from './live-finnhub.js';
import { FH_CURATED } from './finnhub.js';

const FUND_MAX_AGE = 20 * HOUR; // fundamentals older than this are refreshed

// Which data source is active. DATA_PROVIDER picks one; otherwise whichever key exists; otherwise demo.
function providerOf(env) {
  const want = (env.DATA_PROVIDER || '').toLowerCase();
  if (want === 'finnhub' && env.FINNHUB_API_KEY) return 'finnhub';
  if (want === 'fmp' && env.FMP_API_KEY) return 'fmp';
  if (env.FINNHUB_API_KEY && !env.FMP_API_KEY) return 'finnhub';
  if (env.FMP_API_KEY) return 'fmp';
  return 'demo';
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try { return await api(req, env, ctx, url); }
    catch (e) { console.error(e); return json({ error: String(e.message || e) }, 502); }
  },
  // Cron runs every minute. Finnhub refreshes a slice of quotes each minute; FMP refreshes fundamentals every 10.
  async scheduled(event, env, ctx) {
    const mode = providerOf(env);
    if (mode === 'finnhub') ctx.waitUntil(tickFinnhub(env).then(r => console.log('tick', JSON.stringify(r))));
    else if (mode === 'fmp' && new Date(event.scheduledTime).getUTCMinutes() % 10 === 0) ctx.waitUntil(refresh(env, parseInt(env.REFRESH_BATCH || '7', 10)));
  },
};

async function api(req, env, ctx, url) {
  const mode = providerOf(env);
  const user = userOf(req);
  if (mode === 'finnhub') { const r = await handleFinnhub(req, env, ctx, url, user); if (r) return r; }
  const live = mode === 'fmp';
  const fmp = live ? new Fmp(env.FMP_API_KEY, env.FMP_BASE) : null;
  const p = url.pathname.replace(/\/+$/, '');
  const seg = p.split('/').slice(2); // after /api
  const M = req.method;

  /* ---- status ---- */
  if (p === '/api/status') {
    let stored = 0, oldest = null;
    try {
      const r = await env.DB.prepare('SELECT COUNT(*) n, MIN(updated_at) o FROM fundamentals').first();
      stored = r?.n || 0; oldest = r?.o || null;
    } catch {}
    const names = { fmp: 'Financial Modeling Prep', finnhub: 'Finnhub (free beta)', demo: 'Demo sample' };
    return json({ live: mode !== 'demo', mode, provider: names[mode], user, stored, curated: mode === 'finnhub' ? FH_CURATED.length : CURATED.length, oldest, now: Date.now(), history: mode === 'fmp' || !!env.TWELVEDATA_API_KEY });
  }

  /* ---- markets: global indices + FX/commodities ---- */
  if (p === '/api/markets') {
    if (!live) return json({ live, indices: [], macro: [] });
    const data = await cached(ctx, 'markets', 60, async () => {
      const q = await quotes(fmp, [...INDICES.map(i => i.s), ...MACRO.map(m => m.s)], { maxSingles: 14 });
      return {
        indices: INDICES.map(i => ({ ...i, ...(q[i.s] || {}), n: i.n })),
        macro: MACRO.map(m => ({ ...m, ...(q[m.s] || {}), n: m.n })),
        at: Date.now(),
      };
    });
    return json({ live, ...data });
  }

  /* ---- quotes for any symbols ---- */
  if (p === '/api/quotes') {
    const syms = (url.searchParams.get('symbols') || '').split(',').map(cleanSym).filter(s => SYM.test(s)).slice(0, 200);
    if (!live) { const d = Object.fromEntries(DEMO_UNIVERSE.filter(x => syms.includes(x.t)).map(x => [x.t, { t: x.t, price: x.price, dchg: 0 }])); return json({ live, quotes: d }); }
    const key = 'q:' + [...syms].sort().join(',');
    return json({ live, quotes: await cached(ctx, key, 30, () => quotes(fmp, syms)) });
  }

  /* ---- universe: stored fundamentals + live quotes ---- */
  if (p === '/api/universe') {
    if (!live) return json({ live, items: DEMO_UNIVERSE.map(x => ({ ...x, dchg: 0 })), pending: [] });
    const extra = await userSymbols(env, user);
    const syms = [...new Set([...CURATED, ...extra])];
    const funds = await loadFundamentals(env, syms);
    const q = await cached(ctx, 'uq:' + syms.length + ':' + extra.sort().join(','), 45, () => quotes(fmp, syms, { maxSingles: 0 }));
    const items = [], pending = [];
    for (const s of syms) {
      const f = funds[s]?.data?.failed ? null : funds[s]?.data;
      const qq = q[s];
      if (!f && !qq) { pending.push(s); continue; }
      if (!f) pending.push(s);
      items.push(merge(s, f, qq));
    }
    return json({ live, items, pending, at: Date.now() });
  }

  /* ---- single stock report ---- */
  if (seg[0] === 'stock' && seg[1]) {
    const s = cleanSym(decodeURIComponent(seg[1]));
    if (!SYM.test(s)) return bad('Bad symbol');
    if (!live) {
      const d = DEMO_UNIVERSE.find(x => x.t === s);
      return d ? json({ live, item: { ...d, dchg: 0 }, target: null, grades: null, news: [] }) : bad('Not in the demo sample. Add an FMP API key for live data on any symbol.', 404);
    }
    const special = s.startsWith('^') || MACRO.some(m => m.s === s);
    const f = special ? null : await getFundamentals(env, ctx, fmp, s);
    const [qq, target, grades, news] = await Promise.all([
      cached(ctx, 'q1:' + s, 20, async () => normQuote((await fmp.try('quote', { symbol: s }))?.[0])),
      cached(ctx, 'pt:' + s, 6 * 3600, async () => normTarget(await fmp.try('price-target-consensus', { symbol: s }))),
      cached(ctx, 'gr:' + s, 6 * 3600, async () => normGrades(await fmp.try('grades-consensus', { symbol: s }))),
      cached(ctx, 'nw:' + s, 900, async () => normNews(await fmp.try('news/stock', { symbols: s, limit: 8 }))),
    ]);
    if (!f && !qq) return bad(`No data found for ${s}. TSX symbols end in .TO (for example RY.TO).`, 404);
    return json({ live, item: merge(s, f, qq), target, grades, news });
  }

  /* ---- price history ---- */
  if (seg[0] === 'history' && seg[1]) {
    const s = cleanSym(decodeURIComponent(seg[1]));
    if (!SYM.test(s)) return bad('Bad symbol');
    const range = url.searchParams.get('range') || '1y';
    const days = { '1m': 31, '6m': 183, '1y': 366, '5y': 1830, 'max': 365 * 30 }[range] || 366;
    if (!live) return json({ live, points: [] });
    const from = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
    const ttl = range === '1m' ? 900 : 3 * 3600;
    const points = await cached(ctx, `h:${s}:${range}`, ttl, async () => normHistory(await fmp.try('historical-price-eod/light', { symbol: s, from })));
    return json({ live, points });
  }

  /* ---- news ---- */
  if (p === '/api/news') {
    if (!live) return json({ live, items: [] });
    const syms = (url.searchParams.get('symbols') || '').split(',').map(cleanSym).filter(s => SYM.test(s)).slice(0, 30);
    const items = syms.length
      ? await cached(ctx, 'n:' + syms.sort().join(','), 600, async () => normNews(await fmp.try('news/stock', { symbols: syms.join(','), limit: 25 })))
      : await cached(ctx, 'n:general', 600, async () => normNews(await fmp.try('news/general-latest', { page: 0, limit: 25 })));
    return json({ live, items });
  }

  /* ---- earnings calendar (next 14 days), filtered to followed symbols ---- */
  if (p === '/api/earnings') {
    if (!live) return json({ live, items: [] });
    const from = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
    const all = await cached(ctx, 'earn:' + from, 6 * 3600, async () => {
      const r = await fmp.try('earnings-calendar', { from, to });
      return (Array.isArray(r) ? r : []).map(x => ({ t: x.symbol, date: x.date, epsEst: x.epsEstimated ?? null, revEst: x.revenueEstimated ?? null, epsAct: x.epsActual ?? null }));
    });
    const follow = new Set([...CURATED, ...(await userSymbols(env, user))]);
    return json({ live, items: all.filter(x => follow.has(x.t)).sort((a, b) => a.date.localeCompare(b.date)) });
  }

  /* ---- symbol search ---- */
  if (p === '/api/search') {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 40);
    if (q.length < 1) return json({ items: [] });
    if (!live) {
      const ql = q.toLowerCase();
      return json({ live, items: DEMO_UNIVERSE.filter(x => x.t.toLowerCase().startsWith(ql) || x.n.toLowerCase().includes(ql)).slice(0, 10).map(x => ({ t: x.t, n: x.n, exch: x.exch, ccy: x.ccy })) });
    }
    const items = await cached(ctx, 's:' + q.toLowerCase(), 86400, async () => {
      const [a, b] = await Promise.all([fmp.try('search-symbol', { query: q, limit: 10 }), fmp.try('search-name', { query: q, limit: 10 })]);
      const seen = new Set(), out = [];
      for (const x of [...(a || []), ...(b || [])]) {
        if (!x?.symbol || seen.has(x.symbol)) continue;
        const ex = (x.exchange || x.exchangeShortName || '').toUpperCase();
        if (!/NASDAQ|NYSE|AMEX|TSX|TSXV|NEO|CBOE|ARCA|BATS/.test(ex) && !/\.(TO|V|NE)$/.test(x.symbol)) continue; // North America only
        seen.add(x.symbol); out.push({ t: x.symbol, n: x.name, exch: ex, ccy: x.currency });
      }
      return out.slice(0, 12);
    });
    return json({ live, items });
  }

  /* ---- user data: portfolio, watchlist, settings ---- */
  if (p === '/api/portfolio') {
    if (M === 'GET') {
      const r = await env.DB.prepare('SELECT symbol, shares, cost FROM holdings WHERE user = ? ORDER BY symbol').bind(user).all();
      return json({ user, holdings: r.results.map(x => ({ t: x.symbol, sh: x.shares, c: x.cost })) });
    }
    if (M === 'PUT') {
      const body = await req.json().catch(() => null);
      const rows = (body?.holdings || []).map(h => ({ t: cleanSym(h.t), sh: +h.sh, c: +h.c })).filter(h => SYM.test(h.t) && h.sh > 0 && h.c >= 0).slice(0, 300);
      const stmts = [env.DB.prepare('DELETE FROM holdings WHERE user = ?').bind(user),
        ...rows.map(h => env.DB.prepare('INSERT OR REPLACE INTO holdings (user, symbol, shares, cost) VALUES (?, ?, ?, ?)').bind(user, h.t, h.sh, h.c))];
      await env.DB.batch(stmts);
      return json({ ok: true, count: rows.length });
    }
  }
  if (p === '/api/watchlist') {
    if (M === 'GET') {
      const r = await env.DB.prepare('SELECT symbol FROM watchlist WHERE user = ? ORDER BY added_at').bind(user).all();
      return json({ user, symbols: r.results.map(x => x.symbol) });
    }
    if (M === 'PUT') {
      const body = await req.json().catch(() => null);
      const syms = [...new Set((body?.symbols || []).map(cleanSym).filter(s => SYM.test(s)))].slice(0, 200);
      const now = Date.now();
      await env.DB.batch([env.DB.prepare('DELETE FROM watchlist WHERE user = ?').bind(user),
        ...syms.map((s, i) => env.DB.prepare('INSERT INTO watchlist (user, symbol, added_at) VALUES (?, ?, ?)').bind(user, s, now + i))]);
      return json({ ok: true, count: syms.length });
    }
  }
  if (p === '/api/settings') {
    if (M === 'GET') {
      const r = await env.DB.prepare('SELECT data FROM settings WHERE user = ?').bind(user).first();
      return json({ user, settings: r ? JSON.parse(r.data) : {} });
    }
    if (M === 'PUT') {
      const body = await req.json().catch(() => ({}));
      const s = { base: body.base === 'USD' ? 'USD' : 'CAD', strat: String(body.strat || 'buffett').slice(0, 20), monthly: Math.max(0, +body.monthly || 0), years: Math.max(1, Math.min(40, +body.years || 10)) };
      await env.DB.prepare('INSERT OR REPLACE INTO settings (user, data) VALUES (?, ?)').bind(user, JSON.stringify(s)).run();
      return json({ ok: true, settings: s });
    }
  }

  /* ---- manual refresh of stored fundamentals ---- */
  if (p === '/api/admin/refresh' && M === 'POST') {
    const token = req.headers.get('x-admin-token');
    const viaAccess = req.headers.has('cf-access-authenticated-user-email');
    if (!(viaAccess || (env.ADMIN_TOKEN && token === env.ADMIN_TOKEN))) return bad('Not allowed', 403);
    if (!live) return bad('Set FMP_API_KEY first');
    const n = Math.max(1, Math.min(40, parseInt(url.searchParams.get('n') || env.REFRESH_BATCH || '7', 10)));
    return json(await refresh(env, n));
  }

  return bad('Not found', 404);
}

/* ---------- helpers ---------- */
function merge(s, f, q) {
  const idx = INDICES.find(i => i.s === s), mac = MACRO.find(m => m.s === s);
  const base = f ? { ...f } : { t: s, n: idx?.n || mac?.n || q?.n || s, type: idx ? 'Index' : mac ? 'Macro' : FUNDS[s] ? 'Fund' : 'Stock', sec: FUNDS[s] ? 'Funds' : null, exch: /\.(TO|V|NE)$/.test(s) ? 'TSX' : 'US', ccy: /\.(TO|V|NE)$/.test(s) ? 'CAD' : 'USD', partial: true };
  if (q) {
    if (q.price != null) {
      // Keep P/E-derived values consistent with the live price.
      if (base.pe && base.price) base.pe = Math.round(base.pe * (q.price / base.price) * 100) / 100;
      base.price = q.price;
    }
    Object.assign(base, { dchg: q.dchg, dchgAbs: q.dchgAbs, vol: q.vol, avgVol: q.avgVol, yearHigh: q.yearHigh, yearLow: q.yearLow, avg50: q.avg50, avg200: q.avg200, qts: q.ts });
    if (q.mcap) base.mcap = q.mcap;
    if (!base.n && q.n) base.n = q.n;
  }
  return base;
}

async function loadFundamentals(env, syms) {
  const out = {};
  for (let i = 0; i < syms.length; i += 90) {
    const chunk = syms.slice(i, i + 90);
    const r = await env.DB.prepare(`SELECT symbol, data, updated_at FROM fundamentals WHERE symbol IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all();
    for (const x of r.results) out[x.symbol] = { data: JSON.parse(x.data), at: x.updated_at };
  }
  return out;
}

async function getFundamentals(env, ctx, fmp, s) {
  const row = await env.DB.prepare('SELECT data, updated_at FROM fundamentals WHERE symbol = ?').bind(s).first();
  if (row && Date.now() - row.updated_at < FUND_MAX_AGE) { const d = JSON.parse(row.data); return d.failed ? null : d; }
  const f = await fetchFundamentals(fmp, s);
  if (f) await env.DB.prepare('INSERT OR REPLACE INTO fundamentals (symbol, data, updated_at) VALUES (?, ?, ?)').bind(s, JSON.stringify(f), Date.now()).run();
  if (f) return f;
  const old = row ? JSON.parse(row.data) : null;
  return old && !old.failed ? old : null;
}

// Refresh the stalest symbols. Each stock costs ~6 subrequests, so the default batch of 7 stays under the
// Workers Free plan's 50-subrequest limit. On Workers Paid, raise REFRESH_BATCH (e.g. 40).
async function refresh(env, n) {
  const fmp = new Fmp(env.FMP_API_KEY, env.FMP_BASE);
  let extra = [];
  try { extra = (await env.DB.prepare('SELECT DISTINCT symbol FROM holdings UNION SELECT DISTINCT symbol FROM watchlist').all()).results.map(x => x.symbol); } catch {}
  const syms = [...new Set([...CURATED, ...extra])];
  const have = await loadFundamentals(env, syms);
  const due = syms.filter(s => !have[s] || Date.now() - have[s].at > FUND_MAX_AGE)
    .sort((a, b) => (have[a]?.at || 0) - (have[b]?.at || 0)).slice(0, n);
  const done = [], failed = [];
  for (let i = 0; i < due.length; i += 4) {
    const part = due.slice(i, i + 4);
    fmp.transient = false;
    const res = await Promise.all(part.map(s => fetchFundamentals(fmp, s).catch(() => null)));
    const transient = fmp.transient;
    const stmts = [];
    res.forEach((f, j) => {
      if (f) { done.push(part[j]); stmts.push(env.DB.prepare('INSERT OR REPLACE INTO fundamentals (symbol, data, updated_at) VALUES (?, ?, ?)').bind(part[j], JSON.stringify(f), Date.now())); }
      else if (transient) failed.push(part[j]); // rate limit or outage: retry next run
      else { failed.push(part[j]); stmts.push(env.DB.prepare('INSERT OR REPLACE INTO fundamentals (symbol, data, updated_at) VALUES (?, ?, ?)').bind(part[j], JSON.stringify({ t: part[j], failed: true }), Date.now())); }
    });
    if (stmts.length) await env.DB.batch(stmts);
  }
  const remaining = syms.filter(s => !have[s] || Date.now() - have[s].at > FUND_MAX_AGE).length - due.length;
  return { refreshed: done, failed, remaining, calls: fmp.calls };
}
