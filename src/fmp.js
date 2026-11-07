// Financial Modeling Prep adapter. Every FMP response is normalized here so the rest of the app
// never depends on FMP's field names. To switch providers, replace this file and keep the same outputs.
import { FUNDS, isTSX } from './universe.js';

const DEFAULT_BASE = 'https://financialmodelingprep.com/stable/';

export class FmpError extends Error {
  constructor(path, status, msg) { super(`FMP ${path} → ${status}: ${msg}`); this.status = status || null; }
}

export class Fmp {
  constructor(key, base) { this.key = key; this.base = base || DEFAULT_BASE; this.calls = 0; }
  async get(path, params = {}) {
    const u = new URL(path, this.base);
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, v);
    u.searchParams.set('apikey', this.key);
    this.calls++;
    let r;
    try { r = await fetch(u.toString(), { headers: { accept: 'application/json' } }); }
    catch (e) { throw new FmpError(path, 0, String(e.message || e)); }
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch { throw new FmpError(path, r.status, text.slice(0, 160)); }
    if (!r.ok) throw new FmpError(path, r.status, (j && (j['Error Message'] || j.message)) || text.slice(0, 160));
    if (j && !Array.isArray(j) && j['Error Message']) throw new FmpError(path, r.status, j['Error Message']);
    return j;
  }
  // Returns null instead of throwing: plan-restricted or missing data must not break a page.
  async try(path, params) {
    try { return await this.get(path, params); }
    catch (e) { if (!e.status || e.status === 429 || e.status >= 500) this.transient = true; return null; }
  }
}

/* ---------- helpers ---------- */
const first = a => (Array.isArray(a) ? a[0] : a) || {};
const num = v => { const n = typeof v === 'string' ? parseFloat(v) : v; return typeof n === 'number' && isFinite(n) ? n : null; };
const pick = (o, ...keys) => { for (const k of keys) { const v = num(o?.[k]); if (v != null) return v; } return null; };
const pct = v => (v == null ? null : v * 100);
const clamp = (v, a, b) => (v == null ? null : Math.max(a, Math.min(b, v)));
const round = (v, d = 2) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

export function currencyOf(sym, fallback) { return fallback || (isTSX(sym) ? 'CAD' : 'USD'); }

/* ---------- quotes ---------- */
export function normQuote(q) {
  if (!q || !q.symbol) return null;
  return {
    t: q.symbol,
    n: q.name || null,
    price: num(q.price),
    dchg: pick(q, 'changePercentage', 'changesPercentage'),
    dchgAbs: num(q.change),
    vol: num(q.volume),
    avgVol: num(q.avgVolume),
    mcap: num(q.marketCap),
    yearHigh: num(q.yearHigh),
    yearLow: num(q.yearLow),
    dayHigh: num(q.dayHigh),
    dayLow: num(q.dayLow),
    prevClose: num(q.previousClose),
    avg50: num(q.priceAvg50),
    avg200: num(q.priceAvg200),
    exch: q.exchange || null,
    ts: num(q.timestamp),
  };
}

// Batch quotes. Uses FMP's batch endpoint; falls back to single quotes for anything missing (capped, to protect
// the Worker's subrequest budget).
export async function quotes(fmp, symbols, { maxSingles = 12 } = {}) {
  const out = {};
  const uniq = [...new Set(symbols.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += 100) {
    const chunk = uniq.slice(i, i + 100);
    const res = await fmp.try('batch-quote', { symbols: chunk.join(',') });
    (Array.isArray(res) ? res : []).forEach(q => { const n = normQuote(q); if (n) out[n.t] = n; });
  }
  const missing = uniq.filter(s => !out[s]).slice(0, maxSingles);
  const singles = await Promise.all(missing.map(s => fmp.try('quote', { symbol: s })));
  singles.forEach(r => { const n = normQuote(first(r)); if (n) out[n.t] = n; });
  return out;
}

/* ---------- fundamentals ---------- */
// ~6 FMP calls per stock, 3 per fund. Result is stored in D1 and refreshed daily.
export async function fetchFundamentals(fmp, sym) {
  const meta = FUNDS[sym];
  if (meta) return fetchFund(fmp, sym, meta);

  const [profile, ratios, km, inc, est, chg] = await Promise.all([
    fmp.try('profile', { symbol: sym }),
    fmp.try('ratios-ttm', { symbol: sym }),
    fmp.try('key-metrics-ttm', { symbol: sym }),
    fmp.try('income-statement', { symbol: sym, period: 'annual', limit: 6 }),
    fmp.try('analyst-estimates', { symbol: sym, period: 'annual', page: 0, limit: 10 }),
    fmp.try('stock-price-change', { symbol: sym }),
  ]);
  const p = first(profile);
  if (!p.symbol && !first(ratios).symbol) return null; // unknown symbol
  if (p.isEtf || p.isFund) return fetchFund(fmp, sym, null, p, chg);

  const r = first(ratios), k = first(km), c = first(chg);
  const price = num(p.price);
  let pe = pick(r, 'priceToEarningsRatioTTM', 'peRatioTTM');
  if (pe != null && pe <= 0) pe = null;

  // EPS history (newest first)
  const rows = (Array.isArray(inc) ? inc : []).filter(x => x && x.date).sort((a, b) => b.date.localeCompare(a.date));
  const eps = rows.map(x => pick(x, 'epsDiluted', 'epsdiluted', 'eps'));
  const rev = rows.map(x => num(x.revenue));
  let epsG5 = null;
  const yrs = Math.min(5, eps.length - 1);
  if (yrs >= 3 && eps[0] > 0 && eps[yrs] > 0) epsG5 = (Math.pow(eps[0] / eps[yrs], 1 / yrs) - 1) * 100;
  else if (yrs >= 3 && eps[0] != null && eps[yrs] != null) epsG5 = eps[0] > eps[yrs] ? 0 : -10; // turnaround / decline, rough
  const revG = rev[0] > 0 && rev[1] > 0 ? (rev[0] / rev[1] - 1) * 100 : null;

  // Forward growth from analyst EPS estimates (up to ~3 years out)
  const ttmEps = pe && price ? price / pe : eps[0];
  let estG = null, estSrc = null;
  const now = Date.now();
  const fut = (Array.isArray(est) ? est : [])
    .map(x => ({ d: Date.parse(x.date), e: pick(x, 'epsAvg', 'estimatedEpsAvg') }))
    .filter(x => x.d > now && x.e != null).sort((a, b) => a.d - b.d);
  if (fut.length && ttmEps > 0) {
    const tgt = fut[Math.min(2, fut.length - 1)];
    const years = Math.max(1, (tgt.d - now) / (365.25 * 864e5) + 0.5);
    if (tgt.e > 0) { estG = (Math.pow(tgt.e / ttmEps, 1 / years) - 1) * 100; estSrc = 'analysts'; }
  }
  if (estG == null && epsG5 != null) { estG = clamp(epsG5, 0, 15); estSrc = 'history'; }
  estG = clamp(estG, -30, 60);

  const fcfP = pick(r, 'priceToFreeCashFlowRatioTTM');
  return {
    t: sym, n: p.companyName || null, type: 'Stock',
    sec: p.sector || null, ind: p.industry || null, country: p.country || null,
    ccy: currencyOf(sym, p.currency), exch: isTSX(sym) ? 'TSX' : 'US', exchName: p.exchangeFullName || p.exchange || null,
    price, mcap: pick(p, 'marketCap', 'mktCap') ?? pick(k, 'marketCap'),
    beta: num(p.beta),
    pe: round(pe), pb: round(pick(r, 'priceToBookRatioTTM', 'pbRatioTTM')),
    div: round(pct(pick(r, 'dividendYieldTTM', 'dividendYielTTM'))),
    payout: round(pct(pick(r, 'dividendPayoutRatioTTM', 'payoutRatioTTM')), 1),
    roe: round(pct(pick(k, 'returnOnEquityTTM') ?? pick(r, 'returnOnEquityTTM')), 1),
    roic: round(pct(pick(k, 'returnOnInvestedCapitalTTM')), 1),
    gm: round(pct(pick(r, 'grossProfitMarginTTM')), 1),
    om: round(pct(pick(r, 'operatingProfitMarginTTM')), 1),
    de: round(pick(r, 'debtToEquityRatioTTM', 'debtEquityRatioTTM')),
    cr: round(pick(r, 'currentRatioTTM') ?? pick(k, 'currentRatioTTM')),
    fcfY: round(pct(pick(k, 'freeCashFlowYieldTTM')) ?? (fcfP > 0 ? 100 / fcfP : null), 1),
    epsG5: round(epsG5, 1), estG: round(estG, 1), estSrc, revG: round(revG, 1),
    chg: round(pick(c, '1Y')), chg5y: round(pick(c, '5Y')), chgYtd: round(pick(c, 'ytd', 'YTD')),
    desc: p.description ? String(p.description).slice(0, 700) : null,
    web: p.website || null, image: p.image || null,
  };
}

async function fetchFund(fmp, sym, meta, profile, chg) {
  const [pr, info, ch] = await Promise.all([
    profile ? Promise.resolve(profile) : fmp.try('profile', { symbol: sym }),
    fmp.try('etf/info', { symbol: sym }),
    chg ? Promise.resolve(chg) : fmp.try('stock-price-change', { symbol: sym }),
  ]);
  const p = first(pr), i = first(info), c = first(ch);
  let exp = meta?.exp ?? pick(i, 'expenseRatio');
  if (!meta && exp != null && exp < 0.01) exp *= 100; // some feeds give a decimal
  const kind = meta?.kind || (/bond|aggregate|treasury|fixed/i.test(p.companyName || i.name || '') ? 'bond' : 'equity');
  return {
    t: sym, n: meta?.n || p.companyName || i.name || sym, type: 'Fund', sec: 'Funds',
    ccy: currencyOf(sym, p.currency), exch: isTSX(sym) ? 'TSX' : 'US',
    price: num(p.price), mcap: pick(i, 'assetsUnderManagement', 'aum') ?? pick(p, 'marketCap'),
    beta: num(p.beta), div: num(p.lastDividend) > 0 && num(p.price) > 0 ? round(num(p.lastDividend) / num(p.price) * 100) : null,
    exp: round(exp, 2), broad: meta ? meta.broad : false, kind, expRet: meta?.expRet ?? (kind === 'bond' ? 3.5 : 7),
    chg: round(pick(c, '1Y')), chg5y: round(pick(c, '5Y')), chgYtd: round(pick(c, 'ytd', 'YTD')),
    holdings: num(i.holdingsCount),
    desc: (p.description || i.description) ? String(p.description || i.description).slice(0, 700) : null,
  };
}

/* ---------- other feeds ---------- */
export function normNews(a) {
  return (Array.isArray(a) ? a : []).filter(x => x && x.title && x.url).map(x => ({
    t: x.symbol || null, title: x.title, url: x.url, site: x.site || x.publisher || null,
    date: x.publishedDate || x.date || null, text: x.text ? String(x.text).slice(0, 260) : null,
  }));
}

export function normHistory(a) {
  const rows = Array.isArray(a) ? a : (a && Array.isArray(a.historical) ? a.historical : []);
  return rows.map(x => [x.date, pick(x, 'price', 'close', 'adjClose')]).filter(x => x[0] && x[1] != null)
    .sort((a, b) => a[0].localeCompare(b[0]));
}

export function normTarget(a) {
  const x = first(a);
  return x.symbol ? { high: num(x.targetHigh), low: num(x.targetLow), mid: pick(x, 'targetConsensus', 'targetMedian'), median: num(x.targetMedian) } : null;
}

export function normGrades(a) {
  const x = first(a);
  if (!x.symbol) return null;
  return { strongBuy: num(x.strongBuy) || 0, buy: num(x.buy) || 0, hold: num(x.hold) || 0, sell: num(x.sell) || 0, strongSell: num(x.strongSell) || 0, consensus: x.consensus || null };
}
