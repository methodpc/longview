// API routes and background refresh when DATA_PROVIDER = "finnhub" (free plan beta).
import { json, bad, SYM, cleanSym, cached, userSymbols, allUserSymbols, loadRows, putRow, usMarketOpen, HOUR } from './util.js';
import { Finnhub, FH_CURATED, FH_PROXIES, FH_MACRO, FH_QUOTE_SYMBOLS, FH_FUNDS, fetchFundamentals, normQuote, normGrades, normNews, bocUsdCad, twelveHistory } from './finnhub.js';
import { FUNDS } from './universe.js';

const FUND_MAX_AGE = 20 * HOUR;
// ETFs used in the beta (expense ratios approximate, from the issuers' fund pages).
const EXTRA_FUNDS = {
  SPY: { n: 'SPDR S&P 500 ETF', broad: true, kind: 'equity', exp: 0.09, expRet: 7.5 },
  DIA: { n: 'SPDR Dow Jones Industrial Average ETF', broad: false, kind: 'equity', exp: 0.16, expRet: 7.0 },
  IWM: { n: 'iShares Russell 2000 ETF', broad: true, kind: 'equity', exp: 0.19, expRet: 7.5 },
  EWC: { n: 'iShares MSCI Canada ETF', broad: true, kind: 'equity', exp: 0.50, expRet: 7.0 },
  EWU: { n: 'iShares MSCI United Kingdom ETF', broad: true, kind: 'equity', exp: 0.50, expRet: 7.0 },
  EWG: { n: 'iShares MSCI Germany ETF', broad: true, kind: 'equity', exp: 0.50, expRet: 7.0 },
  EWJ: { n: 'iShares MSCI Japan ETF', broad: true, kind: 'equity', exp: 0.50, expRet: 7.0 },
  EWH: { n: 'iShares MSCI Hong Kong ETF', broad: true, kind: 'equity', exp: 0.50, expRet: 7.0 },
};
const fundMeta = s => FUNDS[s] || EXTRA_FUNDS[s] || null;
const isFundSym = s => FH_FUNDS.includes(s) || !!FUNDS[s] || !!EXTRA_FUNDS[s];

function merge(s, f, q) {
  const base = f ? { ...f } : { t: s, n: s, type: isFundSym(s) ? 'Fund' : 'Stock', sec: isFundSym(s) ? 'Funds' : null, exch: 'US', home: 'US', ccy: 'USD', partial: true };
  if (q && q.price != null) {
    if (base.pe && base.price) base.pe = Math.round(base.pe * (q.price / base.price) * 100) / 100;
    Object.assign(base, { price: q.price, dchg: q.dchg, dchgAbs: q.dchgAbs, dayHigh: q.dayHigh, dayLow: q.dayLow, prevClose: q.prevClose, qts: q.ts });
  }
  return base;
}

async function liveQuote(env, ctx, fh, s) {
  return cached(ctx, 'fq:' + s, 15, async () => {
    const q = normQuote(s, await fh.try('quote', { symbol: s }));
    if (q) ctx.waitUntil(putRow(env, 'quotes', s, q).run());
    return q;
  });
}

async function getFundamentals(env, fh, s) {
  const row = await env.DB.prepare('SELECT data, updated_at FROM fundamentals WHERE symbol = ?').bind(s).first();
  if (row && Date.now() - row.updated_at < FUND_MAX_AGE) { const d = JSON.parse(row.data); return d.failed ? null : d; }
  const f = await fetchFundamentals(fh, s, fundMeta(s));
  if (f) await putRow(env, 'fundamentals', s, f).run();
  if (f) return f;
  const old = row ? JSON.parse(row.data) : null;
  return old && !old.failed ? old : null;
}

export async function handleFinnhub(req, env, ctx, url, user) {
  const fh = new Finnhub(env.FINNHUB_API_KEY, env.FINNHUB_BASE);
  const p = url.pathname.replace(/\/+$/, '');
  const seg = p.split('/').slice(2);

  if (p === '/api/markets') {
    const data = await cached(ctx, 'fh-markets', 30, async () => {
      const rows = await loadRows(env, 'quotes', FH_QUOTE_SYMBOLS);
      const fx = await cached(ctx, 'boc-fx', 3600, () => bocUsdCad().catch(() => null));
      return {
        indices: FH_PROXIES.map(i => ({ ...i, ...(rows[i.via]?.data || {}), s: i.via, idx: i.s, n: i.n, at: rows[i.via]?.at || null })),
        macro: FH_MACRO.map(m => m.src === 'boc' ? { ...m, ...(fx || {}), s: 'USDCAD', n: m.n } : { ...m, ...(rows[m.s]?.data || {}), n: m.n, at: rows[m.s]?.at || null }),
        at: Date.now(),
      };
    });
    return json({ live: true, proxy: true, ...data });
  }

  if (p === '/api/quotes') {
    const syms = (url.searchParams.get('symbols') || '').split(',').map(cleanSym).filter(s => SYM.test(s)).slice(0, 200);
    const rows = await loadRows(env, 'quotes', syms);
    return json({ live: true, quotes: Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.data])) });
  }

  if (p === '/api/universe') {
    const extra = await userSymbols(env, user);
    const syms = [...new Set([...FH_CURATED, ...extra])];
    const [funds, qs] = await Promise.all([loadRows(env, 'fundamentals', syms), loadRows(env, 'quotes', syms)]);
    const items = [], pending = [];
    for (const s of syms) {
      const f = funds[s]?.data?.failed ? null : funds[s]?.data;
      const q = qs[s]?.data;
      if (!f) pending.push(s);
      if (!f && !q) continue;
      items.push(merge(s, f, q));
    }
    return json({ live: true, items, pending, at: Date.now() });
  }

  if (seg[0] === 'stock' && seg[1]) {
    let s = cleanSym(decodeURIComponent(seg[1]));
    if (!SYM.test(s)) return bad('Bad symbol');
    if (s === 'USDCAD') {
      const fx = await cached(ctx, 'boc-fx', 3600, () => bocUsdCad().catch(() => null));
      return json({ live: true, item: { t: 'USDCAD', n: 'US dollar in Canadian dollars', type: 'Macro', ...(fx || {}) }, news: [] });
    }
    if (/\.(TO|V|NE|CN)$/.test(s)) {
      return bad(`Toronto listings (.TO) aren't on the free beta data plan. Many Canadian companies also trade in New York: try ${s.replace(/\.(TO|V|NE|CN)$/, '').replace(/-[AB]$/, '')}.`, 404);
    }
    const proxy = FH_PROXIES.find(x => x.s === s);
    if (proxy) s = proxy.via;
    const isMacro = FH_MACRO.some(m => m.s === s) || s.includes(':');
    const [f, q] = await Promise.all([isMacro ? null : getFundamentals(env, fh, s), liveQuote(env, ctx, fh, s)]);
    if (!f && !q) return bad(`No data found for ${s}. The beta covers US-listed stocks and ETFs.`, 404);
    const [grades, news] = await Promise.all([
      f?.type === 'Stock' ? cached(ctx, 'fgr:' + s, 6 * 3600, async () => normGrades(await fh.try('stock/recommendation', { symbol: s }))) : null,
      f ? cached(ctx, 'fnw:' + s, 900, async () => {
        const to = new Date().toISOString().slice(0, 10), from = new Date(Date.now() - 10 * 864e5).toISOString().slice(0, 10);
        return normNews(await fh.try('company-news', { symbol: s, from, to })).slice(0, 8).map(n => ({ ...n, t: s }));
      }) : [],
    ]);
    const item = merge(s, f, q);
    const pr = FH_PROXIES.find(x => x.via === s);
    if (pr) item.proxyFor = pr.n;
    if (isMacro) { item.type = 'Macro'; item.n = FH_MACRO.find(m => m.s === s)?.n || s; }
    return json({ live: true, item, target: null, grades, news });
  }

  if (seg[0] === 'history' && seg[1]) {
    let s = cleanSym(decodeURIComponent(seg[1]));
    const proxy = FH_PROXIES.find(x => x.s === s); if (proxy) s = proxy.via;
    const range = url.searchParams.get('range') || '1y';
    const days = { '1m': 31, '6m': 183, '1y': 366, '5y': 1830 }[range] || 366;
    if (!env.TWELVEDATA_API_KEY || s.includes(':') || s === 'USDCAD') {
      return json({ live: true, points: [], note: 'Price charts need a history source. Add a free Twelve Data key (TWELVEDATA_API_KEY) or switch to FMP.' });
    }
    try {
      const points = await cached(ctx, `th:${s}:${range}`, range === '1m' ? 1800 : 6 * 3600, () => twelveHistory(env.TWELVEDATA_API_KEY, s, days));
      return json({ live: true, points });
    } catch (e) { return json({ live: true, points: [], note: 'No price history: ' + e.message }); }
  }

  if (p === '/api/news') {
    const syms = (url.searchParams.get('symbols') || '').split(',').map(cleanSym).filter(s => SYM.test(s) && !s.includes('.')).slice(0, 4);
    const items = syms.length
      ? await cached(ctx, 'fn:' + syms.sort().join(','), 900, async () => {
          const to = new Date().toISOString().slice(0, 10), from = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
          const all = await Promise.all(syms.map(async s => normNews(await fh.try('company-news', { symbol: s, from, to })).slice(0, 6).map(n => ({ ...n, t: s }))));
          return all.flat().sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 25);
        })
      : await cached(ctx, 'fn:general', 900, async () => normNews(await fh.try('news', { category: 'general' })).slice(0, 25));
    return json({ live: true, items });
  }

  if (p === '/api/earnings') {
    const from = new Date().toISOString().slice(0, 10), to = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
    const all = await cached(ctx, 'fe:' + from, 6 * 3600, async () => {
      const r = await fh.try('calendar/earnings', { from, to });
      return (r?.earningsCalendar || []).map(x => ({ t: x.symbol, date: x.date, epsEst: x.epsEstimate ?? null, revEst: x.revenueEstimate ?? null, epsAct: x.epsActual ?? null }));
    });
    const follow = new Set([...FH_CURATED, ...(await userSymbols(env, user))]);
    return json({ live: true, items: all.filter(x => follow.has(x.t)).sort((a, b) => a.date.localeCompare(b.date)) });
  }

  if (p === '/api/search') {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 40);
    if (!q) return json({ items: [] });
    const items = await cached(ctx, 'fs:' + q.toLowerCase(), 86400, async () => {
      const r = await fh.try('search', { q });
      return (r?.result || []).filter(x => x.symbol && !x.symbol.includes('.') && /Common Stock|ETP|ADR|REIT|ETF/i.test(x.type || ''))
        .slice(0, 12).map(x => ({ t: x.symbol, n: x.description, exch: x.type === 'ETP' ? 'ETF' : 'US', ccy: 'USD' }));
    });
    return json({ live: true, items });
  }

  if (p === '/api/admin/refresh' && req.method === 'POST') {
    const token = req.headers.get('x-admin-token');
    if (!(req.headers.has('cf-access-authenticated-user-email') || (env.ADMIN_TOKEN && token === env.ADMIN_TOKEN))) return bad('Not allowed', 403);
    return json(await tickFinnhub(env, { force: true }));
  }
  return null; // fall through to shared routes
}

// Runs every minute from the cron trigger. Spends at most FINNHUB_BUDGET calls (default 40, plan limit is 60/min,
// leaving room for people browsing the site), split between fundamentals and quotes.
export async function tickFinnhub(env, { force = false } = {}) {
  const fh = new Finnhub(env.FINNHUB_API_KEY, env.FINNHUB_BASE);
  const budget = Math.max(6, Math.min(48, parseInt(env.FINNHUB_BUDGET || '40', 10)));
  const mine = (await allUserSymbols(env)).filter(s => !s.includes('.'));
  const syms = [...new Set([...mine, ...FH_CURATED])];
  const quoteSyms = [...new Set([...FH_QUOTE_SYMBOLS, ...syms])];
  const [funds, qs] = await Promise.all([loadRows(env, 'fundamentals', syms), loadRows(env, 'quotes', quoteSyms)]);
  const now = Date.now();

  // 1) Fundamentals (2 calls each): many while the database is filling, a few once it's full.
  const due = syms.filter(s => !funds[s] || now - funds[s].at > FUND_MAX_AGE).sort((a, b) => (funds[a]?.at || 0) - (funds[b]?.at || 0));
  const missing = syms.filter(s => !funds[s]).length;
  const fundN = Math.min(due.length, Math.floor((missing > 15 ? budget * 0.6 : budget * 0.2) / 2));
  const fundDone = [], fundFailed = [];
  for (let i = 0; i < fundN; i += 6) {
    const part = due.slice(i, Math.min(i + 6, fundN));
    fh.transient = false;
    const res = await Promise.all(part.map(s => fetchFundamentals(fh, s, fundMeta(s)).catch(() => null)));
    const stmts = [];
    res.forEach((f, j) => {
      if (f) { fundDone.push(part[j]); stmts.push(putRow(env, 'fundamentals', part[j], f)); }
      else { fundFailed.push(part[j]); if (!fh.transient) stmts.push(putRow(env, 'fundamentals', part[j], { t: part[j], failed: true })); }
    });
    if (stmts.length) await env.DB.batch(stmts);
    if (fh.limited) break;
  }

  // 2) Quotes with the rest of the budget. Outside US market hours, only refresh quotes older than 6 hours.
  const open = usMarketOpen();
  const maxAge = open || force ? 0 : 6 * HOUR;
  const left = Math.max(0, budget - fh.calls);
  const qdue = quoteSyms.filter(s => !qs[s] || now - qs[s].at > maxAge)
    .sort((a, b) => (FH_QUOTE_SYMBOLS.includes(b) - FH_QUOTE_SYMBOLS.includes(a)) || (mine.includes(b) - mine.includes(a)) || ((qs[a]?.at || 0) - (qs[b]?.at || 0)))
    .slice(0, fh.limited ? 0 : left);
  let qDone = 0;
  for (let i = 0; i < qdue.length; i += 10) {
    const part = qdue.slice(i, i + 10);
    const res = await Promise.all(part.map(async s => normQuote(s, await fh.try('quote', { symbol: s }))));
    const stmts = res.map((q, j) => q && putRow(env, 'quotes', part[j], q)).filter(Boolean);
    qDone += stmts.length;
    if (stmts.length) await env.DB.batch(stmts);
    if (fh.limited) break;
  }
  return { marketOpen: open, fundamentals: { refreshed: fundDone.length, failed: fundFailed, stillMissing: Math.max(0, missing - fundDone.length) }, quotes: { refreshed: qDone, due: qdue.length }, calls: fh.calls, rateLimited: fh.limited };
}
