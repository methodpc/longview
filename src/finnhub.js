// Finnhub adapter (free plan, used for the beta). Produces the same normalized shapes as src/fmp.js.
//
// Free-plan facts this file is built around:
//   - 60 calls/minute, US-listed securities only, no batch quotes, no price history (candles are paid).
//   - So: quotes are refreshed in the background by the Worker's 1-minute cron and kept in D1,
//     Canadian companies are covered through their US (NYSE/Nasdaq) listings, and world markets
//     are tracked with US-listed country ETFs.
//   - USD/CAD comes from the Bank of Canada's free Valet API (daily rate).
//   - Price history uses Twelve Data's free plan when TWELVEDATA_API_KEY is set (optional).

const BASE = 'https://finnhub.io/api/v1/';

export class FinnhubError extends Error {
  constructor(path, status, msg) { super(`Finnhub ${path} → ${status}: ${msg}`); this.status = status || null; }
}

export class Finnhub {
  constructor(key, base) { this.key = key; this.base = base || BASE; this.calls = 0; this.limited = false; }
  async get(path, params = {}) {
    const u = new URL(path, this.base);
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, v);
    this.calls++;
    let r;
    try { r = await fetch(u.toString(), { headers: { 'X-Finnhub-Token': this.key, accept: 'application/json' } }); }
    catch (e) { throw new FinnhubError(path, 0, String(e.message || e)); }
    if (r.status === 429) this.limited = true;
    const text = await r.text();
    let j; try { j = JSON.parse(text); } catch { throw new FinnhubError(path, r.status, text.slice(0, 160)); }
    if (!r.ok || (j && j.error)) throw new FinnhubError(path, r.status, (j && j.error) || text.slice(0, 160));
    return j;
  }
  async try(path, params) {
    try { return await this.get(path, params); }
    catch (e) { if (!e.status || e.status === 429 || e.status >= 500) this.transient = true; return null; }
  }
}

/* ---------------- universe for the free plan ---------------- */
// Largest US companies (kept a little smaller than the FMP list to fit 60 calls/minute).
export const FH_US = [
  'AAPL','MSFT','NVDA','GOOGL','AMZN','META','AVGO','TSLA','BRK.B','JPM','LLY','V','UNH','XOM','MA','JNJ','PG','HD',
  'COST','ABBV','MRK','WMT','NFLX','BAC','CVX','KO','ORCL','CRM','AMD','PEP','ADBE','TMO','LIN','MCD','CSCO','ABT',
  'TXN','QCOM','IBM','AMGN','CAT','GE','NOW','ISRG','VZ','UNP','GS','NEE','HON','LOW','T','PFE','AXP','BLK','DE',
  'LMT','SBUX','ADP','PLD','NKE','MO','DUK','SO','UPS','TGT','O','PYPL','INTC','UBER','PLTR',
];
// Canadian companies with US listings (prices in USD). Their TSX listings need a paid plan.
export const FH_CA = [
  'RY','TD','BMO','BNS','CM','SHOP','ENB','CNQ','CP','CNI','BN','BAM','TRI','SU','TRP','MFC','SLF','WCN','NTR','CVE',
  'FTS','GIB','QSR','BCE','TU','RCI','AEM','WPM','FNV','TECK','CCJ','IMO','PBA','OTEX','CAE','CLS','KGC','GIL','STN',
];
export const FH_FUNDS = ['VOO','VTI','VXUS','QQQ','SCHD','BND','EWC'];

// World markets via US-listed ETFs (moves happen during US hours and include currency swings).
export const FH_PROXIES = [
  { s: '^GSPC',   via: 'SPY', n: 'S&P 500',           r: 'United States', mkt: 'NYSE' },
  { s: '^IXIC',   via: 'QQQ', n: 'Nasdaq-100',        r: 'United States', mkt: 'NYSE' },
  { s: '^DJI',    via: 'DIA', n: 'Dow Jones',         r: 'United States', mkt: 'NYSE' },
  { s: '^RUT',    via: 'IWM', n: 'Russell 2000',      r: 'United States', mkt: 'NYSE' },
  { s: '^GSPTSE', via: 'EWC', n: 'Canada (MSCI)',     r: 'Canada',        mkt: 'TSX' },
  { s: '^FTSE',   via: 'EWU', n: 'United Kingdom (MSCI)', r: 'United Kingdom', mkt: 'LSE' },
  { s: '^GDAXI',  via: 'EWG', n: 'Germany (MSCI)',    r: 'Germany',       mkt: 'XETRA' },
  { s: '^N225',   via: 'EWJ', n: 'Japan (MSCI)',      r: 'Japan',         mkt: 'TSE' },
  { s: '^HSI',    via: 'EWH', n: 'Hong Kong (MSCI)',  r: 'Hong Kong',     mkt: 'HKEX' },
];
export const FH_MACRO = [
  { s: 'USDCAD', n: 'USD / CAD', src: 'boc' },
  { s: 'GLD', n: 'Gold (GLD)' },
  { s: 'USO', n: 'Crude oil (USO)' },
  { s: 'BINANCE:BTCUSDT', n: 'Bitcoin' },
];
export const FH_QUOTE_SYMBOLS = [...new Set([...FH_PROXIES.map(p => p.via), ...FH_MACRO.filter(m => !m.src).map(m => m.s)])];
export const FH_CURATED = [...FH_US, ...FH_CA, ...FH_FUNDS];
const CA_SET = new Set(FH_CA);

/* ---------------- normalization ---------------- */
const num = v => { const n = typeof v === 'string' ? parseFloat(v) : v; return typeof n === 'number' && isFinite(n) ? n : null; };
const round = (v, d = 2) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const clamp = (v, a, b) => (v == null ? null : Math.max(a, Math.min(b, v)));

export function normQuote(sym, q) {
  if (!q || !num(q.c)) return null; // Finnhub returns zeros for unknown symbols
  return { t: sym, price: num(q.c), dchg: num(q.dp), dchgAbs: num(q.d), dayHigh: num(q.h), dayLow: num(q.l), open: num(q.o), prevClose: num(q.pc), ts: num(q.t) };
}

// Finnhub uses its own industry names; fold them into standard sectors so maps and strategy rules work.
const SECTOR_MAP = [
  [/bank|insurance|financial|capital markets|diversified fin/i, 'Financial Services'],
  [/pharma|biotech|health|medical|life sciences/i, 'Healthcare'],
  [/semiconductor|technology|software|hardware|electronic|communications equipment|it services/i, 'Technology'],
  [/media|telecom|entertainment|interactive|communication/i, 'Communication Services'],
  [/oil|gas|energy|pipeline/i, 'Energy'],
  [/utilit/i, 'Utilities'],
  [/real estate|reit/i, 'Real Estate'],
  [/metal|mining|chemical|material|paper|forest|gold|steel/i, 'Basic Materials'],
  [/beverage|food|tobacco|household|personal|retail.*(staple|grocer)|consumer staple/i, 'Consumer Defensive'],
  [/retail|auto|hotel|restaurant|leisure|textile|apparel|consumer/i, 'Consumer Cyclical'],
  [/aerospace|defense|airline|machinery|industrial|construction|logistics|transport|road|rail|professional services|building|electrical equipment/i, 'Industrials'],
];
const sectorOf = ind => { if (!ind) return null; for (const [re, s] of SECTOR_MAP) if (re.test(ind)) return s; return ind; };

export async function fetchFundamentals(fh, sym, fundMeta) {
  const [p, m] = await Promise.all([fh.try('stock/profile2', { symbol: sym }), fh.try('stock/metric', { symbol: sym, metric: 'all' })]);
  if ((p === null || m === null) && fh.transient) return null; // rate-limited or outage: retry later, don't store a half record
  const M = m?.metric || {};
  if ((!p || !p.ticker) && !Object.keys(M).length) return null;
  const P = p || {};
  const home = CA_SET.has(sym) || P.country === 'CA' ? 'CA' : 'US';
  const ccy = P.currency || 'USD';
  const mcap = num(P.marketCapitalization) != null ? num(P.marketCapitalization) * 1e6 : (num(M.marketCapitalization) != null ? num(M.marketCapitalization) * 1e6 : null);
  const base = {
    t: sym, n: P.name || fundMeta?.n || sym, ccy, exch: 'US', home, exchName: P.exchange || null,
    mcap, beta: num(M.beta), div: round(num(M.dividendYieldIndicatedAnnual ?? M.currentDividendYieldTTM)),
    chg: round(num(M['52WeekPriceReturnDaily'])), chgYtd: round(num(M.yearToDatePriceReturnDaily)),
    yearHigh: num(M['52WeekHigh']), yearLow: num(M['52WeekLow']),
    web: P.weburl || null, image: P.logo || null,
  };
  if (fundMeta) {
    return { ...base, n: fundMeta.n || base.n, type: 'Fund', sec: 'Funds', exp: fundMeta.exp, broad: fundMeta.broad, kind: fundMeta.kind, expRet: fundMeta.expRet };
  }
  let pe = num(M.peTTM ?? M.peBasicExclExtraTTM ?? M.peExclExtraTTM);
  if (pe != null && pe <= 0) pe = null;
  const epsG5 = num(M.epsGrowth5Y);
  const epsG3 = num(M.epsGrowth3Y);
  // The free plan has no analyst estimates: expected growth falls back to history, capped at 15%.
  let estG = epsG5 != null ? epsG5 : epsG3;
  if (epsG5 != null && epsG3 != null) estG = (epsG5 + epsG3) / 2;
  estG = estG == null ? null : clamp(estG, 0, 15);
  const pfcf = num(M.pfcfShareTTM ?? M.pfcfShareAnnual);
  const de = num(M['totalDebt/totalEquityQuarterly'] ?? M['totalDebt/totalEquityAnnual']);
  return {
    ...base, type: 'Stock', sec: sectorOf(P.finnhubIndustry), ind: P.finnhubIndustry || null, country: P.country || null,
    pe: round(pe), pb: round(num(M.pbQuarterly ?? M.pbAnnual)),
    payout: round(num(M.payoutRatioTTM ?? M.payoutRatioAnnual), 1),
    roe: round(num(M.roeTTM ?? M.roeRfy), 1), roic: round(num(M.roiTTM ?? M.roiAnnual), 1),
    gm: round(num(M.grossMarginTTM), 1), om: round(num(M.operatingMarginTTM), 1),
    de: de == null ? null : round(de > 20 ? de / 100 : de), // guard against percent-style values
    cr: round(num(M.currentRatioQuarterly ?? M.currentRatioAnnual)),
    fcfY: pfcf > 0 ? round(100 / pfcf, 1) : null,
    epsG5: round(epsG5 ?? epsG3, 1), estG: round(estG, 1), estSrc: estG == null ? null : 'history',
    revG: round(num(M.revenueGrowthTTMYoy ?? M.revenueGrowthQuarterlyYoy), 1),
  };
}

export function normGrades(a) {
  const x = Array.isArray(a) ? a[0] : null;
  if (!x) return null;
  const g = { strongBuy: x.strongBuy || 0, buy: x.buy || 0, hold: x.hold || 0, sell: x.sell || 0, strongSell: x.strongSell || 0 };
  const tot = g.strongBuy + g.buy + g.hold + g.sell + g.strongSell;
  if (!tot) return null;
  const score = (g.strongBuy * 2 + g.buy - g.sell - g.strongSell * 2) / tot;
  g.consensus = score > 1.1 ? 'Strong buy' : score > 0.4 ? 'Buy' : score > -0.4 ? 'Hold' : score > -1.1 ? 'Sell' : 'Strong sell';
  g.period = x.period || null;
  return g;
}

export function normNews(a) {
  return (Array.isArray(a) ? a : []).filter(x => x && x.headline && x.url).map(x => ({
    t: x.related && !x.related.includes(',') ? x.related : null, title: x.headline, url: x.url, site: x.source || null,
    date: x.datetime ? new Date(x.datetime * 1000).toISOString() : null, text: x.summary ? String(x.summary).slice(0, 260) : null,
  }));
}

/* ---------------- free side sources ---------------- */
export async function bocUsdCad() {
  const r = await fetch('https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?recent=2', { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error('Bank of Canada FX ' + r.status);
  const j = await r.json();
  const obs = (j.observations || []).map(o => ({ d: o.d, v: num(o.FXUSDCAD?.v) })).filter(o => o.v).sort((a, b) => a.d.localeCompare(b.d));
  if (!obs.length) throw new Error('No FX data');
  const last = obs[obs.length - 1], prev = obs.length > 1 ? obs[obs.length - 2] : null;
  return { t: 'USDCAD', price: last.v, prevClose: prev?.v ?? null, dchgAbs: prev ? last.v - prev.v : null, dchg: prev ? (last.v / prev.v - 1) * 100 : null, asOf: last.d, src: 'Bank of Canada' };
}

export async function twelveHistory(key, sym, days) {
  const size = Math.min(5000, Math.ceil(days * 0.7) + 5);
  const u = new URL('https://api.twelvedata.com/time_series');
  u.searchParams.set('symbol', sym);
  u.searchParams.set('interval', '1day'); u.searchParams.set('outputsize', String(size)); u.searchParams.set('apikey', key);
  const r = await fetch(u.toString());
  const j = await r.json().catch(() => ({}));
  if (j.status === 'error' || !Array.isArray(j.values)) throw new Error(j.message || 'No history');
  return j.values.map(v => [v.datetime.slice(0, 10), num(v.close)]).filter(x => x[1] != null).sort((a, b) => a[0].localeCompare(b[0]));
}
