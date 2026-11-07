/* Longview front end. Talks only to this site's /api/* (the Worker), never to data vendors directly. */
'use strict';

/* ================= helpers ================= */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ok = v => v != null && isFinite(v);
const pct = (v, d = 1, sign = false) => !ok(v) ? '—' : (sign && v > 0 ? '+' : '') + v.toFixed(d) + '%';
const x2 = (v, d = 1) => !ok(v) ? '—' : v.toFixed(d);
const cls = v => !ok(v) ? '' : v >= 0 ? 'pos' : 'neg';
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

const NF = {};
function money(v, ccy = 'USD', compact = false) {
  if (!ok(v)) return '—';
  const big = Math.abs(v) >= 100000;
  const key = ccy + (compact && big ? 'c' : Math.abs(v) >= 1000 ? 'k' : 'd');
  NF[key] ||= new Intl.NumberFormat('en-CA', compact && big
    ? { style: 'currency', currency: ccy, notation: 'compact', maximumFractionDigits: 2 }
    : { style: 'currency', currency: ccy, minimumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2, maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2 });
  return NF[key].format(v);
}
const plain = (v, d = 2) => !ok(v) ? '—' : v.toLocaleString('en-CA', { minimumFractionDigits: d, maximumFractionDigits: d });
const capFmt = (v, ccy) => !ok(v) ? '—' : money(v, ccy, true);
const fmtDate = s => { if (!s) return ''; const d = new Date(s.length <= 10 ? s + 'T12:00:00' : s.replace(' ', 'T')); return isNaN(d) ? s : d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }); };
const ago = s => { const d = new Date(String(s).replace(' ', 'T') + (String(s).length > 10 && !/Z|[+-]\d\d:?\d\d$/.test(s) ? 'Z' : '')); const m = (Date.now() - d) / 6e4; if (!isFinite(m)) return ''; if (m < 60) return Math.max(1, Math.round(m)) + 'm ago'; if (m < 1440) return Math.round(m / 60) + 'h ago'; return Math.round(m / 1440) + 'd ago'; };

async function api(path, opts = {}) {
  const r = await fetch('/api/' + path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || 'Request failed (' + r.status + ')'), { status: r.status });
  return j;
}

/* ================= state ================= */
const S = {
  live: false, user: 'me', fx: null,
  base: store.get('lv_base', 'CAD'), strat: store.get('lv_strat', 'buffett'),
  monthly: store.get('lv_monthly', 500), years: store.get('lv_years', 10),
  U: {},           // symbol -> item
  port: [],        // {t, sh, c}
  watch: [],       // symbols
  markets: { indices: [], macro: [] },
  pending: 0, view: 'markets',
};

/* ================= glossary & strategies ================= */
const GLOSS = {
  pe: ['P/E ratio', 'Price divided by a year of earnings. A P/E of 20 means you pay $20 for every $1 the company earns. Lower is cheaper, but fast growers usually carry higher P/Es.'],
  peg: ['PEG ratio', "P/E divided by the expected earnings growth rate. Peter Lynch's favourite: under 1 suggests you are not overpaying for growth."],
  pb: ['P/B ratio', 'Price divided by book value (assets minus debts). Graham liked buying near book value as a safety cushion.'],
  div: ['Dividend yield', 'Cash the company pays you each year, as a % of the share price.'],
  payout: ['Payout ratio', 'The share of profits paid out as dividends. Under ~60% leaves room for the dividend to keep growing.'],
  roe: ['Return on equity', "Profit as a % of shareholders' money in the business. Buffett looks for 15%+ year after year."],
  roic: ['Return on invested capital', 'Profit as a % of all money (equity and debt) put to work. High ROIC is a sign of a durable advantage, or "moat".'],
  gm: ['Gross margin', "What's left of each sales dollar after the direct cost of making the product. High margins usually mean pricing power."],
  om: ['Operating margin', 'Profit from operations as a % of sales, after salaries, rent and marketing.'],
  de: ['Debt / equity', 'How much the company owes compared with what shareholders own. Under 0.5 is conservative.'],
  cr: ['Current ratio', 'Short-term assets divided by short-term bills. Above 1.5 means bills are easily covered.'],
  fcfY: ['Free cash flow yield', "Cash left after running and investing in the business, as a % of the company's market value."],
  estG: ['Expected EPS growth', "Yearly earnings-per-share growth expected over the next few years, from analysts' estimates (or past growth when there are none). Estimates are often wrong."],
  epsG5: ['Past EPS growth', 'How fast earnings per share grew per year over the last 5 years.'],
  revG: ['Revenue growth', 'How fast sales grew in the latest year.'],
  beta: ['Beta', 'How much the stock tends to swing compared with the whole market. 1.0 moves with the market; 1.5 swings 50% more.'],
  exp: ['Expense ratio / MER', 'The yearly fee a fund charges, as a % of what you have invested. 0.20% is $20 a year on $10,000.'],
  ey: ['Earnings yield', 'Earnings divided by price (the P/E flipped). Lets you compare a stock with a bond yield.'],
  mcap: ['Market cap', "The total value of all the company's shares."],
  chg: ['1-year change', 'How much the price moved over the past 12 months.'],
  dchg: ["Today's change", 'Price move since the last close.'],
  range: ['52-week range', 'Where today\'s price sits between the lowest and highest price of the past year.'],
};

const hi = (v, t, n) => !ok(v) ? null : v >= t ? 1 : v >= n ? 0.5 : 0;
const lo = (v, t, n) => !ok(v) ? null : v <= t ? 1 : v <= n ? 0.5 : 0;
const band = (v, a, b, na, nb) => !ok(v) ? null : (v >= a && v <= b) ? 1 : (v >= na && v <= nb) ? 0.5 : 0;
const STRATS = [
  { id: 'buffett', name: 'Warren Buffett', short: 'Quality', style: 'Wonderful companies at a fair price',
    idea: 'Buy businesses with a lasting edge that earn high returns without much debt, then hold them for decades. Price matters, but quality matters more.',
    best: 'Patient investors who want a short list of great companies to hold for a long time.',
    rules: [
      { l: 'Return on equity 15%+', m: 'roe', f: s => hi(s.roe, 15, 12), why: 'Earns a lot on the money it keeps.' },
      { l: 'Operating margin 20%+', m: 'om', f: s => hi(s.om, 20, 15), why: 'Pricing power, a sign of a moat.' },
      { l: 'Debt/equity 0.5 or less', m: 'de', f: s => s.fin ? null : lo(s.de, 0.5, 1), why: 'Can survive bad years without lenders calling.' },
      { l: 'Earnings grew 8%+ a year', m: 'epsG5', f: s => hi(s.epsG5, 8, 4), why: 'A record of steady growth.' },
      { l: 'P/E 25 or less', m: 'pe', f: s => s.pe == null ? 0 : lo(s.pe, 25, 32), why: 'A fair, not crazy, price.' },
      { l: 'Free cash flow yield 3%+', m: 'fcfY', f: s => hi(s.fcfY, 3, 2), why: 'Real cash backs up the profits.' },
    ] },
  { id: 'graham', name: 'Benjamin Graham', short: 'Deep value', style: 'The defensive investor',
    idea: "Buffett's teacher. Buy solid, dividend-paying companies only when they trade cheaply against earnings and assets, leaving a \"margin of safety\".",
    best: 'Cautious investors who care most about not overpaying.',
    rules: [
      { l: 'P/E 15 or less', m: 'pe', f: s => s.pe == null ? 0 : lo(s.pe, 15, 20), why: 'Cheap against what it earns.' },
      { l: 'P/E × P/B 22.5 or less', m: 'pb', f: s => s.pe == null || s.pb == null || s.pb <= 0 ? null : lo(s.pe * s.pb, 22.5, 40), why: "Graham's combined price test." },
      { l: 'Current ratio 1.5+', m: 'cr', f: s => s.fin ? null : hi(s.cr, 1.5, 1.0), why: 'Easily pays its near-term bills.' },
      { l: 'Debt/equity 1 or less', m: 'de', f: s => s.fin ? null : lo(s.de, 1, 1.5), why: 'Not overloaded with debt.' },
      { l: 'Pays a dividend', m: 'div', f: s => s.div == null ? 0 : s.div > 0 ? 1 : 0, why: 'A habit of returning cash.' },
      { l: 'Market cap $10B+ (USD)', m: 'mcap', f: s => hi(s.mcapUSD / 1e9, 10, 2), why: 'Large, established company.' },
      { l: 'Earnings grew over 5 years', m: 'epsG5', f: s => hi(s.epsG5, 3, 0), why: 'Not shrinking.' },
    ] },
  { id: 'lynch', name: 'Peter Lynch', short: 'Growth at a fair price', style: 'Growth at a reasonable price (GARP)',
    idea: "Find companies growing earnings 10–25% a year, and don't pay more than the growth is worth. PEG under 1 is his rule of thumb.",
    best: 'Investors who want growth but hate overpaying for hype.',
    rules: [
      { l: 'PEG 1.0 or less', m: 'peg', f: s => s.pe == null ? 0 : lo(s.peg, 1.0, 1.6), why: 'Price is reasonable for the growth.' },
      { l: 'Expected growth 10–25%', m: 'estG', f: s => band(s.estG, 10, 25, 7, 35), why: 'Fast but sustainable. 30%+ rarely lasts.' },
      { l: 'Debt/equity 0.6 or less', m: 'de', f: s => s.fin ? null : lo(s.de, 0.6, 1), why: "Growth isn't bought with borrowed money." },
      { l: '(Growth + dividend) ÷ P/E of 1.5+', m: 'pe', f: s => s.pe == null || !ok(s.estG) ? 0 : hi((s.estG + (s.div || 0)) / s.pe, 1.5, 1), why: "Lynch's total-return check." },
    ] },
  { id: 'greenblatt', name: 'Joel Greenblatt', short: 'Magic formula', style: 'Good business, cheap price',
    idea: 'Rank companies on two numbers only: how cheap they are (earnings yield) and how good they are (return on capital). Buy the best combination and rebalance yearly.',
    best: 'Rules-based investors who want a simple, repeatable checklist.',
    rules: [
      { l: 'Earnings yield 6%+', m: 'ey', f: s => s.pe == null ? 0 : hi(s.ey, 6, 4), why: 'Cheap: lots of earnings per dollar.' },
      { l: 'Return on capital 20%+', m: 'roic', f: s => hi(s.roic, 20, 12), why: 'Good: earns a lot on what it invests.' },
      { l: 'Not a bank or utility', m: '', f: s => (s.fin || s.sec === 'Utilities') ? 0 : 1, why: "The formula excludes them; their numbers aren't comparable." },
    ] },
  { id: 'dividend', name: 'Dividend growth', short: 'Income', style: 'In the spirit of Geraldine Weiss',
    idea: 'Own companies that pay a healthy dividend they can afford and keep raising. Reinvested dividends do much of the work over decades.',
    best: 'Investors who want rising cash income and steadier holdings.',
    rules: [
      { l: 'Yield between 2.5% and 6%', m: 'div', f: s => band(s.div, 2.5, 6, 1.5, 8), why: 'Meaningful income without a red-flag yield.' },
      { l: 'Payout ratio 60% or less', m: 'payout', f: s => s.type === 'Fund' ? null : lo(s.payout, 60, 75), why: 'Room to keep raising the dividend.' },
      { l: 'Expected growth 5%+', m: 'estG', f: s => s.type === 'Fund' ? null : hi(s.estG, 5, 3), why: 'Earnings growth funds dividend growth.' },
      { l: 'Debt/equity 1 or less', m: 'de', f: s => (s.fin || s.type === 'Fund') ? null : lo(s.de, 1, 2), why: "Debt can't crowd out the dividend." },
      { l: 'Free cash flow yield 4%+', m: 'fcfY', f: s => s.type === 'Fund' ? null : hi(s.fcfY, 4, 2.5), why: 'Dividends are paid from cash, not accounting profit.' },
    ] },
  { id: 'fisher', name: 'Philip Fisher', short: 'Growth', style: 'Common stocks, uncommon profits',
    idea: 'Own a few outstanding growth companies with high margins and strong returns, and let them compound. Accept a higher price for higher-quality growth.',
    best: 'Investors comfortable with bigger price swings in exchange for growth.',
    rules: [
      { l: 'Revenue growth 12%+', m: 'revG', f: s => hi(s.revG, 12, 7), why: 'The business is getting bigger fast.' },
      { l: 'Gross margin 50%+', m: 'gm', f: s => hi(s.gm, 50, 35), why: 'A product customers pay up for.' },
      { l: 'Return on capital 15%+', m: 'roic', f: s => hi(s.roic, 15, 10), why: 'Growth that earns its keep.' },
      { l: 'Expected EPS growth 12%+', m: 'estG', f: s => hi(s.estG, 12, 8), why: 'Profits should follow sales.' },
    ] },
  { id: 'bogle', name: 'John Bogle', short: 'Index', style: 'Own the whole haystack',
    idea: "Don't look for the needle, buy the haystack. Low-cost index funds that own the entire market beat most stock pickers over time.",
    best: 'Beginners and anyone who wants the least time spent for market returns.',
    rules: [
      { l: 'Is a broad index fund', m: '', f: s => s.type === 'Fund' ? (s.broad ? 1 : 0.5) : 0, why: 'Thousands of companies, no single bet.' },
      { l: 'Fee (expense ratio) 0.25% or less', m: 'exp', f: s => s.type === 'Fund' ? lo(s.exp, 0.25, 0.5) : 0, why: 'Fees compound against you.' },
    ] },
];
const SMAP = Object.fromEntries(STRATS.map(s => [s.id, s]));
if (!SMAP[S.strat]) S.strat = 'buffett';

function evaluate(s, sid = S.strat) {
  if (!s || s.type === 'Index' || s.type === 'Macro') return { score: null, res: [] };
  if (s.partial && s.type === 'Stock') return { score: null, res: [] };
  if (s.type === 'Fund' && sid !== 'bogle' && !(sid === 'dividend' && /dividend/i.test(s.n || ''))) return { score: null, res: [] };
  let w = 0, got = 0; const res = [];
  for (const r of SMAP[sid].rules) { const v = r.f(s); res.push({ r, v }); if (v != null) { w++; got += v; } }
  return { score: w >= 2 || (w && sid === 'bogle') ? Math.round(got / w * 100) : null, res };
}
const scoreCls = v => v == null ? 's-na' : v >= 70 ? 's-good' : v >= 40 ? 's-warn' : 's-bad';
const scorePill = v => `<span class="score ${scoreCls(v)}">${v == null ? 'n/a' : v}</span>`;

/* ================= currency ================= */
const fxRate = () => S.fx || 1.38;
function toBase(v, ccy) {
  if (!ok(v)) return null;
  if (!ccy || ccy === S.base) return v;
  if (ccy === 'USD' && S.base === 'CAD') return v * fxRate();
  if (ccy === 'CAD' && S.base === 'USD') return v / fxRate();
  return v;
}
const toUSD = (v, ccy) => !ok(v) ? null : ccy === 'CAD' ? v / fxRate() : v;

/* ================= derive, valuation, projection ================= */
function derive(s) {
  s.ccy ||= /\.(TO|V|NE)$/.test(s.t) ? 'CAD' : 'USD';
  s.eps = s.pe > 0 && s.price ? s.price / s.pe : null;
  s.peg = s.pe > 0 && s.estG > 0 ? s.pe / s.estG : null;
  s.ey = s.pe > 0 ? 100 / s.pe : null;
  s.fin = s.sec === 'Financial Services' || s.sec === 'Financials';
  s.mcapUSD = toUSD(s.mcap, s.ccy);
  return s;
}
const FV = new Map();
function fair(s) {
  if (!s || s.type !== 'Stock' || !(s.eps > 0)) return null;
  const k = s.t + s.price + s.estG; if (FV.has(k)) return FV.get(k);
  const gr = ok(s.estG) ? s.estG : 5;
  const g = clamp(gr, 0, 20) / 100, r = 0.08, pay = clamp(s.payout || 0, 0, 100) / 100;
  let e = s.eps, pvDiv = 0;
  for (let t = 1; t <= 10; t++) { e *= 1 + (t <= 5 ? g : g / 2); pvDiv += e * pay / Math.pow(1 + r, t); }
  const dcf = pvDiv + e * 17 / Math.pow(1 + r, 10);
  const graham = s.eps * (8.5 + 2 * clamp(gr, 0, 15));
  const fv = (dcf + graham) / 2;
  const out = { dcf, graham, fv, up: (fv / s.price - 1) * 100 };
  FV.set(k, out); return out;
}
function project(s, years = 5) {
  const d = (s.div || 0) / 100;
  const path = rates => { const o = {}; for (const k in rates) { const a = []; for (let t = 0; t <= years; t++) a.push(s.price * Math.pow(1 + rates[k], t)); o[k] = a; } return o; };
  if (s.type === 'Fund') {
    const b = (s.expRet ?? 7) / 100, spread = s.kind === 'bond' ? [0.025, 0.015] : [0.06, 0.04];
    const ann = { bear: b - spread[0], base: b, bull: b + spread[1] };
    const o = path({ bear: ann.bear - d, base: ann.base - d, bull: ann.bull - d });
    o.ann = { bear: ann.bear * 100, base: ann.base * 100, bull: ann.bull * 100 };
    o.note = `Funds use a long-run return assumption of ${pct(s.expRet, 1)} a year for ${s.kind === 'bond' ? 'this bond fund' : 'broad stock funds like this one'}, with a ${s.kind === 'bond' ? 'narrow' : 'wide'} range around it. Fees are not deducted.`;
    return o;
  }
  if (!(s.pe > 0) || !s.eps) {
    const o = path({ bear: -0.10, base: 0.05, bull: 0.18 });
    o.ann = { bear: -10, base: 5, bull: 18 };
    o.note = "Earnings are negative or missing, so earnings can't anchor a projection. These are wide placeholder ranges.";
    return o;
  }
  const gEst = ok(s.estG) ? s.estG : 5;
  const g0 = clamp(gEst, -10, 40) / 100;
  const normal = 10 + 1.5 * clamp(gEst, 0, 25);
  const sc = { bear: { g: g0 * 0.5, pe: Math.min(s.pe, normal) * 0.8 }, base: { g: g0, pe: (s.pe + normal) / 2 }, bull: { g: g0 * 1.3, pe: Math.max(s.pe, normal) } };
  const out = { ann: {}, sc };
  for (const k in sc) {
    const arr = [];
    for (let t = 0; t <= years; t++) arr.push(s.eps * Math.pow(1 + sc[k].g, t) * (s.pe + (sc[k].pe - s.pe) * Math.min(t, 5) / 5));
    out[k] = arr; out.ann[k] = (Math.pow(arr[years] / s.price, 1 / years) - 1 + d) * 100;
  }
  return out;
}

/* ================= portfolio maths ================= */
function holdings() {
  const rows = S.port.map(h => {
    const s = S.U[h.t]; const ccy = s?.ccy || (/\.(TO|V|NE)$/.test(h.t) ? 'CAD' : 'USD');
    const price = s?.price ?? h.c;
    return { ...h, s, ccy, price, val: toBase(price * h.sh, ccy), cost: toBase(h.c * h.sh, ccy), day: s && ok(s.dchg) ? toBase(price * h.sh, ccy) * s.dchg / (100 + s.dchg) : 0 };
  });
  const tot = rows.reduce((a, r) => a + (r.val || 0), 0) || 0;
  rows.forEach(r => r.w = tot ? r.val / tot * 100 : 0);
  return { rows, tot };
}
const savePort = debounce(async () => {
  try { await api('portfolio', { method: 'PUT', body: JSON.stringify({ holdings: S.port }) }); $('#syncMsg').textContent = 'Saved.'; }
  catch (e) { $('#syncMsg').textContent = 'Could not save: ' + e.message; }
  store.set('lv_port_backup', S.port);
}, 600);
const saveWatch = debounce(() => api('watchlist', { method: 'PUT', body: JSON.stringify({ symbols: S.watch }) }).catch(() => {}), 400);
const saveSettings = debounce(() => {
  store.set('lv_base', S.base); store.set('lv_strat', S.strat); store.set('lv_monthly', S.monthly); store.set('lv_years', S.years);
  api('settings', { method: 'PUT', body: JSON.stringify({ base: S.base, strat: S.strat, monthly: S.monthly, years: S.years }) }).catch(() => {});
}, 500);

async function ensure(sym) {
  sym = sym.trim().toUpperCase();
  if (S.U[sym] && !S.U[sym].partial) return S.U[sym];
  const j = await api('stock/' + encodeURIComponent(sym));
  S.U[sym] = derive(j.item);
  return S.U[sym];
}
function addHolding(t, sh, c) {
  const ex = S.port.find(p => p.t === t);
  if (ex) { const tot = ex.sh + sh; ex.c = +((ex.c * ex.sh + c * sh) / tot).toFixed(4); ex.sh = tot; }
  else S.port.push({ t, sh, c });
}

/* ================= rendering: shell ================= */
function renderShell() {
  $('#badge').className = 'badge ' + (S.live ? 'live' : 'demo');
  $('#badge').textContent = S.live ? 'Live' : 'Demo data';
  $$('.seg [data-ccy]').forEach(b => b.setAttribute('aria-pressed', b.dataset.ccy === S.base));
  $('#pills').innerHTML = STRATS.map(s => `<button class="pill" type="button" data-s="${s.id}" aria-pressed="${s.id === S.strat}">${esc(s.name)}<small>${esc(s.short)}</small></button>`).join('');
  const st = SMAP[S.strat]; $('#tagline').innerHTML = `<b>${esc(st.style)}.</b> ${esc(st.idea)}`;
  const n = [];
  if (!S.live) n.push('Demo mode: showing an illustrative sample of US companies, not live quotes. Add your FMP API key to the Worker to switch on live North American and global data.');
  else if (S.pending > 20) n.push(`Building the fundamentals database: ${S.pending} symbols still to load. Prices are live now; scores fill in over the next few hours.`);
  n.push('Fair values, scores and projections come from simple, transparent models for learning. They are not financial advice.');
  $('#notice').textContent = n.join(' ');
}

/* ================= MARKETS ================= */
const SESS = {
  NYSE: { tz: 'America/New_York', o: [[570, 960]] }, TSX: { tz: 'America/Toronto', o: [[570, 960]] },
  LSE: { tz: 'Europe/London', o: [[480, 990]] }, XETRA: { tz: 'Europe/Berlin', o: [[540, 1050]] },
  TSE: { tz: 'Asia/Tokyo', o: [[540, 690], [750, 930]] }, HKEX: { tz: 'Asia/Hong_Kong', o: [[570, 720], [780, 960]] },
};
function isOpen(mkt) {
  const s = SESS[mkt]; if (!s) return null;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: s.tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const g = t => parts.find(p => p.type === t)?.value;
  if (['Sat', 'Sun'].includes(g('weekday'))) return false;
  const m = +g('hour') * 60 + +g('minute');
  return s.o.some(([a, b]) => m >= a && m < b);
}
function renderIndices() {
  const I = S.markets.indices || [], Mc = S.markets.macro || [];
  if (!S.live) { $('#indices').innerHTML = `<div class="empty">Global indices (S&amp;P 500, TSX, Nikkei, Hang Seng and more) appear here once live data is on.</div>`; $('#macro').innerHTML = ''; return; }
  $('#indices').innerHTML = I.map(i => {
    const o = isOpen(i.mkt);
    return `<button type="button" class="ix" data-open="${esc(i.s)}"><div class="r"><span>${esc(i.r)}</span><span>${o == null ? '' : `<i class="dot ${o ? 'open' : ''}"></i>${o ? 'Open' : 'Closed'}`}</span></div>
      <div class="nm">${esc(i.n)}</div><div class="v">${plain(i.price, 2)}</div><div class="c ${cls(i.dchg)}">${pct(i.dchg, 2, true)}</div></button>`;
  }).join('');
  $('#macro').innerHTML = Mc.map(m => `<button type="button" class="ix" data-open="${esc(m.s)}"><div class="r"><span>${m.s === 'USDCAD' ? 'Currency' : m.s === 'BTCUSD' ? 'Crypto' : 'Commodity'}</span></div>
    <div class="nm">${esc(m.n)}</div><div class="v">${m.s === 'USDCAD' ? plain(m.price, 4) : plain(m.price, 2)}</div><div class="c ${cls(m.dchg)}">${pct(m.dchg, 2, true)}</div></button>`).join('');
}
function items() { return Object.values(S.U); }
function renderOpps() {
  const st = SMAP[S.strat];
  $('#oppTitle').textContent = `Opportunities for ${st.name}`;
  const all = items().filter(s => s.type === 'Stock').map(s => ({ s, sc: evaluate(s).score, f: fair(s) })).filter(x => x.sc != null);
  let list = all.filter(x => x.sc >= 70 && x.f && x.f.up >= 10).sort((a, b) => b.f.up - a.f.up).slice(0, 8);
  let note = '';
  if (!list.length) { list = all.sort((a, b) => b.sc - a.sc).slice(0, 6); note = `<p class="note">Nothing scores 70+ and trades 10% below fair value right now. These are the strongest fits.</p>`; }
  if (S.strat === 'bogle') { list = items().filter(s => s.type === 'Fund').map(s => ({ s, sc: evaluate(s).score, f: null })).sort((a, b) => b.sc - a.sc).slice(0, 8); note = '<p class="note">For Bogle, the opportunity is simply a cheap, broad fund held for decades.</p>'; }
  $('#opps').innerHTML = `<thead><tr><th>Ticker</th><th>Name</th><th class="n">Price</th><th class="n">Today</th><th class="n">Score</th><th class="n">To fair value</th></tr></thead><tbody>${list.map(x => `<tr class="click" data-open="${esc(x.s.t)}"><td class="tk">${esc(x.s.t)}</td><td class="nm">${esc(x.s.n)}</td><td class="n">${money(x.s.price, x.s.ccy)}</td><td class="n ${cls(x.s.dchg)}">${pct(x.s.dchg, 2, true)}</td><td class="n">${scorePill(x.sc)}</td><td class="n ${x.f ? cls(x.f.up) : ''}">${x.f ? pct(x.f.up, 0, true) : '—'}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">Scores appear once fundamentals load.</td></tr>'}</tbody>`;
  const n = $('#opps').parentElement.nextElementSibling; if (n && n.classList.contains('note')) n.remove();
  if (note) $('#opps').parentElement.insertAdjacentHTML('afterend', note);
}
let MOV = { m: 'US', k: 'up' };
function renderMovers() {
  let L = items().filter(s => s.type === 'Stock' && s.exch === MOV.m && ok(s.dchg));
  if (MOV.k === 'up') L.sort((a, b) => b.dchg - a.dchg); else if (MOV.k === 'down') L.sort((a, b) => a.dchg - b.dchg); else L.sort((a, b) => (toUSD(b.vol * b.price, b.ccy) || 0) - (toUSD(a.vol * a.price, a.ccy) || 0));
  L = L.slice(0, 8);
  $('#movers').innerHTML = `<thead><tr><th>Ticker</th><th>Name</th><th class="n">Price</th><th class="n">Today</th><th class="n" title="${esc(GLOSS.range[1])}">52-wk range</th><th class="n">Score</th></tr></thead><tbody>${L.map(s => `<tr class="click" data-open="${esc(s.t)}"><td class="tk">${esc(s.t)}</td><td class="nm">${esc(s.n)}</td><td class="n">${money(s.price, s.ccy)}</td><td class="n ${cls(s.dchg)}">${pct(s.dchg, 2, true)}</td><td class="n">${rangeBar(s)}</td><td class="n">${scorePill(evaluate(s).score)}</td></tr>`).join('') || `<tr><td colspan="6" class="empty">${S.live ? 'No quotes yet.' : 'Movers need live data.'}</td></tr>`}</tbody>`;
}
function rangeBar(s) {
  if (!ok(s.yearLow) || !ok(s.yearHigh) || s.yearHigh <= s.yearLow) return '—';
  const p = clamp((s.price - s.yearLow) / (s.yearHigh - s.yearLow), 0, 1) * 100;
  return `<span class="range" title="${money(s.yearLow, s.ccy)} – ${money(s.yearHigh, s.ccy)}"><i style="left:calc(${p}% - 1px)"></i></span>`;
}
async function renderEarnings() {
  if (!S.live) { $('#earn').innerHTML = '<tbody><tr><td class="empty">Earnings dates need live data.</td></tr></tbody>'; return; }
  try {
    const j = await api('earnings');
    const mine = new Set([...S.port.map(p => p.t), ...S.watch]);
    const L = j.items.sort((a, b) => (mine.has(b.t) - mine.has(a.t)) || a.date.localeCompare(b.date)).slice(0, 10);
    $('#earn').innerHTML = `<thead><tr><th>Date</th><th>Ticker</th><th>Name</th><th class="n">EPS estimate</th></tr></thead><tbody>${L.map(x => `<tr class="click" data-open="${esc(x.t)}"><td>${fmtDate(x.date)}</td><td class="tk">${esc(x.t)}${mine.has(x.t) ? ' <span class="ccy">yours</span>' : ''}</td><td class="nm">${esc(S.U[x.t]?.n || '')}</td><td class="n">${ok(x.epsEst) ? plain(x.epsEst, 2) : '—'}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">No reports from followed companies in the next two weeks.</td></tr>'}</tbody>`;
  } catch (e) { $('#earn').innerHTML = `<tbody><tr><td class="empty">${esc(e.message)}</td></tr></tbody>`; }
}
let NEWS = 'mine';
async function renderNews() {
  if (!S.live) { $('#news').innerHTML = '<li class="empty">News needs live data.</li>'; return; }
  const syms = NEWS === 'mine' ? [...new Set([...S.port.map(p => p.t), ...S.watch])].slice(0, 30) : [];
  try {
    const j = await api('news' + (syms.length ? '?symbols=' + encodeURIComponent(syms.join(',')) : ''));
    $('#news').innerHTML = j.items.slice(0, 12).map(n => `<li>${n.t ? `<span><button type="button" class="tkc" data-open="${esc(n.t)}">${esc(n.t)}</button></span>` : ''}<a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a><span class="meta">${esc(n.site || '')} · ${ago(n.date)}</span></li>`).join('') || '<li class="empty">No recent news.</li>';
  } catch (e) { $('#news').innerHTML = `<li class="empty">${esc(e.message)}</li>`; }
}
function renderHeat() {
  const el = $('#heat'); if (!window.d3) { el.innerHTML = '<p class="empty">Chart library failed to load.</p>'; return; }
  const w = Math.max(320, el.clientWidth || 900), h = Math.round(Math.min(640, Math.max(380, w * 0.56)));
  const metric = $('#hcolor').value, mkt = $('#hmkt').value;
  const val = s => metric === 'dchg' ? s.dchg : metric === 'chg' ? s.chg : metric === 'score' ? evaluate(s).score : (fair(s)?.up ?? null);
  const dom = metric === 'score' ? [0, 50, 100] : metric === 'chg' ? [-40, 0, 40] : metric === 'dchg' ? [-3, 0, 3] : [-50, 0, 50];
  const color = d3.scaleLinear().domain(dom).range(['#b8332a', '#5a6470', '#1f8a4c']).clamp(true);
  const L = items().filter(s => s.type === 'Stock' && s.mcapUSD > 0 && s.sec && (mkt === 'ALL' || s.exch === mkt));
  if (!L.length) { el.innerHTML = '<p class="empty">The map fills in as company data loads.</p>'; return; }
  const secs = d3.group(L, s => s.sec);
  const root = d3.hierarchy({ children: [...secs].map(([k, v]) => ({ name: k, children: v })) }).sum(d => d.mcapUSD || 0).sort((a, b) => b.value - a.value);
  d3.treemap().size([w, h]).paddingTop(18).paddingInner(2).paddingOuter(2).round(true)(root);
  const fmtv = v => metric === 'score' ? (v == null ? 'n/a' : v) : pct(v, metric === 'dchg' ? 1 : 0, true);
  let g = '';
  root.children.forEach(sc => {
    g += `<rect x="${sc.x0}" y="${sc.y0}" width="${sc.x1 - sc.x0}" height="${sc.y1 - sc.y0}" fill="var(--bg)" stroke="var(--line)"/>`;
    if (sc.x1 - sc.x0 > 60) g += `<text x="${sc.x0 + 5}" y="${sc.y0 + 13}" style="fill:var(--muted);font-size:11px;font-family:var(--body);font-weight:600">${esc(sc.data.name.toUpperCase().slice(0, Math.floor((sc.x1 - sc.x0) / 8)))}</text>`;
  });
  root.leaves().forEach(l => {
    const s = l.data, v = val(s), bw = l.x1 - l.x0, bh = l.y1 - l.y0, lab = s.t.replace(/\.TO$/, '');
    g += `<g data-open="${esc(s.t)}" style="cursor:pointer"><rect x="${l.x0}" y="${l.y0}" width="${bw}" height="${bh}" fill="${v == null ? '#4a525c' : color(v)}" rx="2"><title>${esc(s.n)} (${esc(s.t)}): ${fmtv(v)}</title></rect>`;
    if (bw > 30 && bh > 20) {
      const fs = clamp(Math.min(bw / (lab.length * 0.75 + 1), bh / 2.6), 9, 22);
      const two = bh > fs * 2.3;
      g += `<text x="${l.x0 + bw / 2}" y="${l.y0 + bh / 2 + (two ? -fs * 0.15 : fs * 0.35)}" text-anchor="middle" fill="#fff" style="font-size:${fs}px;font-weight:500">${esc(lab)}</text>`;
      if (two) g += `<text x="${l.x0 + bw / 2}" y="${l.y0 + bh / 2 + fs * 0.95}" text-anchor="middle" fill="#fff" opacity=".85" style="font-size:${Math.max(9, fs * 0.6)}px">${fmtv(v)}</text>`;
    }
    g += '</g>';
  });
  el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Market map">${g}</svg>`;
  const lab = { score: ['0', '100 score'], chg: ['-40%', '+40% over 1 year'], dchg: ['-3%', '+3% today'], up: ['-50%', '+50% vs fair value'] }[metric];
  $('#hleg').innerHTML = `<span>${lab[0]}</span><span class="ramp"></span><span>${lab[1]}</span>`;
}
function renderMarkets() { renderIndices(); renderOpps(); renderMovers(); renderHeat(); }

/* ================= PORTFOLIO ================= */
let ALLOC = 'sec';
function renderPortfolio() {
  const { rows, tot } = holdings();
  const B = S.base;
  const cost = rows.reduce((a, r) => a + (r.cost || 0), 0);
  const day = rows.reduce((a, r) => a + (r.day || 0), 0);
  const div = rows.reduce((a, r) => a + (r.s && r.val ? r.val * (r.s.div || 0) / 100 : 0), 0);
  const W = { bear: 0, base: 0, bull: 0 }; let fitW = 0, fitS = 0;
  rows.forEach(r => {
    const p = r.s && r.s.price ? project(r.s) : { ann: { bear: -10, base: 6, bull: 15 } };
    for (const k in W) W[k] += r.w / 100 * clamp(p.ann[k], -20, 30);
    const ev = r.s ? evaluate(r.s) : { score: null };
    if (ev.score != null) { fitW += r.w; fitS += r.w * ev.score; }
  });
  const fit = fitW ? Math.round(fitS / fitW) : null;
  const gain = tot - cost;
  $('#ptiles').innerHTML = `
   <div class="tile"><div class="k">Portfolio value (${B})</div><div class="v">${money(tot, B, true)}</div><div class="s ${cls(gain)}">${gain >= 0 ? '+' : ''}${money(gain, B, true)} (${pct(cost ? gain / cost * 100 : 0, 1, true)}) since bought</div></div>
   <div class="tile"><div class="k">Today</div><div class="v ${cls(day)}">${day >= 0 ? '+' : ''}${money(day, B, true)}</div><div class="s">${pct(tot ? day / (tot - day) * 100 : 0, 2, true)}</div></div>
   <div class="tile"><div class="k">Dividends per year</div><div class="v">${money(div, B, true)}</div><div class="s">${pct(tot ? div / tot * 100 : 0, 2)} yield</div></div>
   <div class="tile" title="Weighted average of each holding's 5-year base-case projection, including dividends."><div class="k">Projected yearly return</div><div class="v">${pct(W.base, 1)}</div><div class="s">range ${pct(W.bear, 1)} to ${pct(W.bull, 1)}</div></div>
   <div class="tile"><div class="k">Fit with ${esc(SMAP[S.strat].name)}</div><div class="v">${fit == null ? 'n/a' : fit + '<span style="font-size:13px;color:var(--muted)">/100</span>'}</div><div class="s">${fit != null && fitW < 99.5 ? `scored on ${Math.round(fitW)}% of holdings` : 'weighted by position size'}</div></div>`;

  if (!document.activeElement || !document.activeElement.closest('#htable')) {
    const sorted = [...rows].sort((a, b) => b.val - a.val);
    $('#htable').innerHTML = `<thead><tr><th>Ticker</th><th class="n">Shares</th><th class="n">Avg cost</th><th class="n">Price</th><th class="n">Today</th><th class="n">Value (${B})</th><th class="n">Gain</th><th class="n">Weight</th><th class="n">Score</th><th class="n" title="How far the price is from the model's fair value">To fair value</th><th></th></tr></thead><tbody>${
      sorted.map(r => { const ev = r.s ? evaluate(r.s) : { score: null }; const f = r.s ? fair(r.s) : null; const g = (r.price / r.c - 1) * 100; const i = S.port.findIndex(p => p.t === r.t);
        return `<tr><td><a href="#" class="tk" data-open="${esc(r.t)}">${esc(r.t)}</a></td>
        <td class="n"><input type="number" step="any" min="0" value="${r.sh}" data-i="${i}" data-f="sh" aria-label="Shares of ${esc(r.t)}"></td>
        <td class="n"><input type="number" step="any" min="0" value="${r.c}" data-i="${i}" data-f="c" aria-label="Average cost of ${esc(r.t)}"><span class="ccy">${r.ccy}</span></td>
        <td class="n">${money(r.price, r.ccy)}</td><td class="n ${cls(r.s?.dchg)}">${pct(r.s?.dchg, 2, true)}</td><td class="n">${money(r.val, B)}</td><td class="n ${cls(g)}">${pct(g, 0, true)}</td>
        <td class="n">${pct(r.w, 1)}</td><td class="n">${scorePill(ev.score)}</td><td class="n ${f ? cls(f.up) : ''}">${f ? pct(f.up, 0, true) : '—'}</td>
        <td><button type="button" class="x" data-del="${i}" aria-label="Remove ${esc(r.t)}">×</button></td></tr>`; }).join('') || '<tr><td colspan="11" class="empty">No holdings yet. Add one below or paste from your broker.</td></tr>'}</tbody>`;
  }

  // allocation
  const groups = {};
  rows.forEach(r => {
    const k = ALLOC === 'ccy' ? r.ccy : ALLOC === 'ex' ? (r.s?.exch === 'TSX' ? 'Canada (TSX)' : 'United States') : (r.s ? (r.s.type === 'Fund' ? (r.s.kind === 'bond' ? 'Bond funds' : 'Stock index funds') : r.s.sec || 'Other') : 'Loading…');
    groups[k] = (groups[k] || 0) + r.w;
  });
  const ge = Object.entries(groups).sort((a, b) => b[1] - a[1]);
  $('#alloc').innerHTML = ge.map(([k, v]) => `<div class="bar"><span>${esc(k)}</span><div class="track"><div class="fill ${ALLOC === 'sec' && v > 35 && !/fund/i.test(k) ? 'over' : ''}" style="width:${v}%"></div></div><span class="num" style="text-align:right">${pct(v, 0)}</span></div>`).join('') || '<p class="empty">Nothing to show yet.</p>';

  // checkup
  const F = [], st = SMAP[S.strat];
  const link = t => `<a data-open="${esc(t)}"><b>${esc(t)}</b></a>`;
  rows.filter(r => r.s?.type === 'Stock' && r.w > 15).forEach(r => F.push(['warn', `${link(r.t)} is ${pct(r.w, 0)} of your portfolio. Many long-term investors keep any single stock under 5–10% so one bad surprise can't sink the plan.`]));
  const secs = {}; rows.filter(r => r.s?.type === 'Stock').forEach(r => secs[r.s.sec] = (secs[r.s.sec] || 0) + r.w);
  Object.entries(secs).filter(([, v]) => v > 35).forEach(([k, v]) => F.push(['warn', `${pct(v, 0)} sits in <b>${esc(k)}</b> stocks. A slump in that sector would hit you hard.`]));
  const evs = rows.filter(r => r.s).map(r => ({ r, ev: evaluate(r.s) })).filter(x => x.ev.score != null);
  const pass = evs.filter(x => x.ev.score >= 70), fail = evs.filter(x => x.ev.score < 40);
  if (pass.length) F.push(['good', `${pass.map(x => link(x.r.t)).join(', ')} ${pass.length > 1 ? 'are strong fits' : 'is a strong fit'} for ${esc(st.name)}'s approach.`]);
  if (fail.length) F.push(['bad', `${fail.map(x => link(x.r.t)).join(', ')} ${fail.length > 1 ? "don't" : "doesn't"} match ${esc(st.name)}'s rules. Open ${fail.length > 1 ? 'each' : 'it'} to see which checks fail.`]);
  const rich = rows.filter(r => r.s && fair(r.s) && fair(r.s).up < -40);
  if (rich.length) F.push(['info', `${rich.map(r => link(r.t)).join(', ')} trade${rich.length > 1 ? '' : 's'} well above the model's fair value. The market expects more growth than these estimates assume.`]);
  const near = rows.filter(r => r.s && ok(r.s.yearHigh) && r.s.price >= r.s.yearHigh * 0.98);
  if (near.length) F.push(['info', `${near.map(r => link(r.t)).join(', ')} ${near.length > 1 ? 'are' : 'is'} at or near a 52-week high.`]);
  const cad = rows.filter(r => r.ccy === 'CAD').reduce((a, r) => a + r.w, 0);
  if (rows.length && (cad > 85 || cad < 5)) F.push(['info', `${pct(cad, 0)} of your money is in Canadian-dollar holdings. Canada is about 3% of world stock markets, so ${cad > 85 ? 'many Canadian investors add US and international funds' : 'some Canadians keep a Canadian slice to reduce currency swings'}.`]);
  if (!rows.some(r => r.s?.broad && r.s.kind !== 'bond')) F.push(['info', 'You hold no broad index fund. Even stock pickers often keep a core of the whole market (for example XEQT.TO, VFV.TO or VOO) and pick stocks around it.']);
  if (S.strat === 'bogle') { const ind = rows.filter(r => r.s?.type === 'Fund').reduce((a, r) => a + r.w, 0); F.push([ind >= 80 ? 'good' : 'info', `${pct(ind, 0)} of your money is in funds. A pure Bogle portfolio is close to 100%, often one all-in-one ETF or a mix of Canadian, US, international and bond funds.`]); }
  if (!rows.length) F.push(['info', 'Add a holding to get a checkup.']);
  $('#flags').innerHTML = F.map(([c, t]) => `<li class="${c}">${t}</li>`).join('');

  // ideas
  const own = new Set(S.port.map(p => p.t));
  const ideas = items().filter(s => !own.has(s.t)).map(s => ({ s, ev: evaluate(s), f: fair(s) })).filter(x => x.ev.score != null)
    .sort((a, b) => b.ev.score - a.ev.score || ((b.f?.up ?? -99) - (a.f?.up ?? -99))).slice(0, 8);
  $('#ideas').innerHTML = `<thead><tr><th>Ticker</th><th>Name</th><th class="n">Score</th><th class="n">To fair value</th></tr></thead><tbody>${ideas.map(x => `<tr class="click" data-open="${esc(x.s.t)}"><td class="tk">${esc(x.s.t)}</td><td class="nm">${esc(x.s.n)}</td><td class="n">${scorePill(x.ev.score)}</td><td class="n ${x.f ? cls(x.f.up) : ''}">${x.f ? pct(x.f.up, 0, true) : '—'}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">Scores appear once fundamentals load.</td></tr>'}</tbody>`;

  renderGrowth(tot, W);
}
function renderGrowth(tot, W) {
  const H = S.years, Mo = S.monthly, B = S.base;
  $('#hz').value = String(H); if (document.activeElement !== $('#mc')) $('#mc').value = Mo;
  const ser = { bear: [], base: [], bull: [], paid: [] };
  for (let y = 0; y <= H; y++) {
    for (const k of ['bear', 'base', 'bull']) {
      const r = W[k] / 100, mr = Math.pow(1 + r, 1 / 12) - 1, n = y * 12;
      ser[k].push(tot * Math.pow(1 + r, y) + (mr ? Mo * ((Math.pow(1 + mr, n) - 1) / mr) : Mo * n));
    }
    ser.paid.push(tot + Mo * 12 * y);
  }
  const f = v => money(v, B, true);
  lineChart($('#pchart'), [
    { k: 'paid', v: ser.paid, c: 'var(--muted)', dash: '4 4' },
    { k: 'bear', v: ser.bear, c: 'var(--bad)' }, { k: 'base', v: ser.base, c: 'var(--accent)', w: 3 }, { k: 'bull', v: ser.bull, c: 'var(--good)' },
  ], { band: ['bear', 'bull'], fmt: f, xLabel: y => y === 0 ? 'Today' : 'Yr ' + y, aria: 'Portfolio growth projection' });
  $('#plegend').innerHTML = [['var(--accent)', 'Base ' + pct(W.base, 1) + '/yr'], ['var(--good)', 'Bull ' + pct(W.bull, 1) + '/yr'], ['var(--bad)', 'Bear ' + pct(W.bear, 1) + '/yr'], ['var(--muted)', 'Money you put in']].map(([c, l]) => `<span><i style="background:${c}"></i>${l}</span>`).join('');
  $('#pnote').textContent = `In the base case, ${f(ser.paid[H])} contributed grows to about ${f(ser.base[H])} after ${H} years; ${f(ser.base[H] - ser.paid[H])} of that is growth. Returns are applied evenly; real markets are bumpier, and taxes and fees are not included.`;
}

/* ================= WATCHLIST ================= */
function renderWatch() {
  const L = S.watch.map(t => S.U[t] || { t, n: 'Loading…', partial: true });
  $('#wtable').innerHTML = `<thead><tr><th>Ticker</th><th>Name</th><th class="n">Price</th><th class="n">Today</th><th class="n">1 year</th><th class="n" title="${esc(GLOSS.range[1])}">52-wk range</th><th class="n">P/E</th><th class="n">Score</th><th class="n">To fair value</th><th></th></tr></thead><tbody>${
    L.map(s => { const f = fair(s); return `<tr class="click" data-open="${esc(s.t)}"><td class="tk">${esc(s.t)}</td><td class="nm">${esc(s.n)}</td><td class="n">${money(s.price, s.ccy)}</td><td class="n ${cls(s.dchg)}">${pct(s.dchg, 2, true)}</td><td class="n ${cls(s.chg)}">${pct(s.chg, 0, true)}</td><td class="n">${rangeBar(s)}</td><td class="n">${x2(s.pe)}</td><td class="n">${scorePill(evaluate(s).score)}</td><td class="n ${f ? cls(f.up) : ''}">${f ? pct(f.up, 0, true) : '—'}</td><td><button type="button" class="x" data-unwatch="${esc(s.t)}" aria-label="Remove ${esc(s.t)} from watchlist">×</button></td></tr>`; }).join('')
    || '<tr><td colspan="10" class="empty">Nothing here yet. Add tickers below, or use Watch on any stock report.</td></tr>'}</tbody>`;
}

/* ================= SCREENER ================= */
let SORT = { k: 'score', d: -1 };
const COLS = [
  ['t', 'Ticker', 0], ['n', 'Name', 0], ['sec', 'Sector', 0], ['price', 'Price', 1], ['dchg', 'Today', 1, v => pct(v, 2, true), 'dchg'], ['mcapUSD', 'Mkt cap (USD)', 1, v => capFmt(v, 'USD'), 'mcap'],
  ['pe', 'P/E', 1, v => x2(v), 'pe'], ['peg', 'PEG', 1, v => x2(v, 2), 'peg'], ['div', 'Div %', 1, v => pct(v, 1), 'div'], ['roe', 'ROE', 1, v => pct(v, 0), 'roe'],
  ['de', 'Debt/Eq', 1, v => x2(v, 2), 'de'], ['estG', 'Exp. growth', 1, v => pct(v, 0), 'estG'], ['chg', '1Y', 1, v => pct(v, 0, true), 'chg'],
  ['score', 'Score', 1], ['up', 'To fair value', 1, v => pct(v, 0, true)],
];
function renderScreener() {
  const q = $('#fq').value.trim().toLowerCase(), ex = $('#fex').value, sec = $('#fsec').value, ty = $('#ftype').value;
  const mpe = parseFloat($('#fpe').value), mdiv = parseFloat($('#fdiv').value), mup = parseFloat($('#fup').value), pass = $('#fpass').checked;
  const all = items().filter(s => s.type === 'Stock' || s.type === 'Fund');
  const secs = [...new Set(all.map(s => s.sec).filter(Boolean))].sort();
  const cur = $('#fsec').value; $('#fsec').innerHTML = '<option value="">All sectors</option>' + secs.map(s => `<option ${s === cur ? 'selected' : ''}>${esc(s)}</option>`).join('');
  const rows = all.map(s => { const f = fair(s); return { s, score: evaluate(s).score, up: f ? f.up : null }; })
    .filter(({ s, score, up }) => (!q || s.t.toLowerCase().includes(q) || (s.n || '').toLowerCase().includes(q)) && (!ex || s.exch === ex) && (!sec || s.sec === sec) && (!ty || s.type === ty)
      && (isNaN(mpe) || (s.pe != null && s.pe <= mpe)) && (isNaN(mdiv) || (s.div || 0) >= mdiv) && (isNaN(mup) || (up != null && up >= mup)) && (!pass || (score != null && score >= 70)));
  const k = SORT.k, get = r => k === 'score' ? r.score : k === 'up' ? r.up : r.s[k];
  rows.sort((a, b) => { const A = get(a), B = get(b); if (A == null && B == null) return 0; if (A == null) return 1; if (B == null) return -1; return (typeof A === 'string' ? A.localeCompare(B) : A - B) * SORT.d; });
  $('#scount').textContent = `${rows.length} of ${all.length} shown · scored by ${SMAP[S.strat].name}`;
  $('#stable').innerHTML = `<thead><tr>${COLS.map(c => `<th class="sort ${c[2] ? 'n' : ''}" data-k="${c[0]}" ${SORT.k === c[0] ? `aria-sort="${SORT.d > 0 ? 'ascending' : 'descending'}"` : ''} ${c[4] && GLOSS[c[4]] ? `title="${esc(GLOSS[c[4]][1])}"` : ''}>${c[1]}</th>`).join('')}</tr></thead><tbody>${
    rows.slice(0, 400).map(({ s, score, up }) => `<tr class="click" data-open="${esc(s.t)}">${COLS.map(c => {
      if (c[0] === 't') return `<td class="tk">${esc(s.t)}</td>`;
      if (c[0] === 'n') return `<td class="nm" title="${esc(s.n)}">${esc(s.n)}</td>`;
      if (c[0] === 'sec') return `<td>${esc(s.sec || '')}</td>`;
      if (c[0] === 'price') return `<td class="n">${money(s.price, s.ccy)}</td>`;
      if (c[0] === 'score') return `<td class="n">${scorePill(score)}</td>`;
      if (c[0] === 'up') return `<td class="n ${cls(up)}">${c[3](up)}</td>`;
      const v = s[c[0]]; return `<td class="n ${c[0] === 'chg' || c[0] === 'dchg' ? cls(v) : ''}">${c[3](v)}</td>`;
    }).join('')}</tr>`).join('')}</tbody>`;
}

/* ================= LEARN ================= */
function renderLearn() {
  $('#stratcards').innerHTML = STRATS.map(st => {
    const top = items().map(s => ({ s, sc: evaluate(s, st.id).score })).filter(x => x.sc != null).sort((a, b) => b.sc - a.sc).slice(0, 8);
    return `<div class="card strat" style="${st.id === S.strat ? 'border-color:var(--accent)' : ''}">
     <h3>${esc(st.name)}</h3><p class="who">${esc(st.style)}</p><p>${esc(st.idea)}</p><p><b>Suits:</b> ${esc(st.best)}</p>
     <ul class="rules">${st.rules.map(r => `<li>${esc(r.l)} <span>· ${esc(r.why)}</span></li>`).join('')}</ul>
     <div class="note" style="margin-bottom:6px">Top matches right now</div>
     <div class="chips">${top.map(x => `<button type="button" class="chip" data-open="${esc(x.s.t)}">${esc(x.s.t)} ${x.sc}</button>`).join('') || '<span class="empty">Loading…</span>'}</div>
     ${st.id !== S.strat ? `<div style="margin-top:12px"><button class="btn ghost" type="button" data-use="${st.id}">Use this strategy</button></div>` : '<p class="note" style="margin-top:12px">Your current strategy</p>'}
    </div>`; }).join('');
  $('#gloss').innerHTML = Object.values(GLOSS).map(([t, d]) => `<dt>${esc(t)}</dt><dd>${esc(d)}</dd>`).join('');
}

/* ================= charts ================= */
function niceStep(r) { const p = Math.pow(10, Math.floor(Math.log10(r || 1))); const m = r / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p; }
function lineChart(el, series, opt = {}) {
  const W = 640, H = opt.h || 260, L = 70, R = opt.noEnds ? 14 : 92, T = 14, B = 28;
  const n = series[0].v.length; if (n < 2) { el.innerHTML = '<p class="empty">Not enough data to chart.</p>'; return; }
  const all = series.flatMap(s => s.v).filter(ok);
  let mn = opt.zero ? Math.min(0, ...all) : Math.min(...all), mx = Math.max(...all);
  if (mx === mn) { mx += 1; mn -= 1; }
  const step = niceStep((mx - mn) / 4); mx = Math.ceil(mx / step) * step; mn = Math.floor(mn / step) * step;
  const X = i => L + (W - L - R) * i / (n - 1), Y = v => T + (H - T - B) * (1 - (v - mn) / (mx - mn || 1));
  const fmt = opt.fmt || (v => plain(v, 0)), afmt = opt.axisFmt || fmt;
  let g = '<g class="grid">';
  for (let v = mn; v <= mx + 1e-9; v += step) g += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 8}" y="${Y(v) + 4}" text-anchor="end">${afmt(v)}</text>`;
  g += '</g>';
  [...new Set([0, Math.round((n - 1) / 2), n - 1])].forEach(i => g += `<text x="${X(i)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}">${esc((opt.xLabel || (i => i))(i))}</text>`);
  if (opt.band) {
    const a = series.find(s => s.k === opt.band[0]).v, b = series.find(s => s.k === opt.band[1]).v;
    g += `<path d="M${a.map((v, i) => X(i) + ',' + Y(v)).join('L')}L${b.map((v, i) => X(i) + ',' + Y(v)).reverse().join('L')}Z" fill="var(--accent)" opacity=".08"/>`;
  }
  if (opt.area) { const s = series[0]; g += `<path d="M${X(0)},${Y(mn)}L${s.v.map((v, i) => X(i).toFixed(1) + ',' + Y(v).toFixed(1)).join('L')}L${X(n - 1)},${Y(mn)}Z" fill="${s.c}" opacity=".1"/>`; }
  const ends = [];
  series.forEach(s => {
    g += `<path d="M${s.v.map((v, i) => X(i).toFixed(1) + ',' + Y(v).toFixed(1)).join('L')}" fill="none" stroke="${s.c}" stroke-width="${s.w || 1.75}" ${s.dash ? `stroke-dasharray="${s.dash}"` : ''} stroke-linejoin="round"/>`;
    g += `<circle cx="${X(n - 1)}" cy="${Y(s.v[n - 1])}" r="${s.w ? 4 : 3}" fill="${s.c}"/>`;
    ends.push({ y: Y(s.v[n - 1]), t: fmt(s.v[n - 1]), c: s.c });
  });
  if (!opt.noEnds) { ends.sort((a, b) => a.y - b.y); for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13; ends.forEach(e => g += `<text x="${W - R + 8}" y="${e.y + 4}" style="fill:${e.c};font-weight:500">${esc(e.t)}</text>`); }
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opt.aria || 'Chart')}">${g}</svg>`;
}

/* ================= STOCK REPORT (drawer) ================= */
let DRAWER = null;
async function openStock(t) {
  t = String(t).toUpperCase();
  DRAWER = t;
  $('#drawer').innerHTML = `<div class="dhead"><h2>${esc(t)}</h2><button type="button" class="x" id="dclose" aria-label="Close report" style="font-size:24px">×</button></div><p class="loading">Loading report…</p>`;
  showDrawer();
  let j;
  try { j = await api('stock/' + encodeURIComponent(t)); }
  catch (e) { if (DRAWER === t) $('#drawer').innerHTML = `<div class="dhead"><h2>${esc(t)}</h2><button type="button" class="x" id="dclose" aria-label="Close report" style="font-size:24px">×</button></div><p class="empty">${esc(e.message)}</p>`; bindDrawer(); return; }
  if (DRAWER !== t) return;
  const s = derive(j.item);
  if (s.type === 'Stock' || s.type === 'Fund') S.U[t] = s;
  renderReport(s, j);
}
function showDrawer() { $('#drawer').classList.add('on'); $('#scrim').classList.add('on'); $('#drawer').setAttribute('aria-hidden', 'false'); bindDrawer(); $('#dclose')?.focus(); }
function bindDrawer() { const c = $('#dclose'); if (c) c.onclick = closeDrawer; }
function closeDrawer() { DRAWER = null; $('#drawer').classList.remove('on'); $('#scrim').classList.remove('on'); $('#drawer').setAttribute('aria-hidden', 'true'); }

function renderReport(s, j) {
  const C = s.ccy, isEq = s.type === 'Stock' || s.type === 'Fund';
  const kv = (k, label, v) => `<div ${GLOSS[k] ? `title="${esc(GLOSS[k][1])}"` : ''}><div class="k">${label}</div><div class="v">${v}</div></div>`;
  const f = fair(s), p = isEq && s.price ? project(s) : null, ev = evaluate(s);
  const owned = S.port.find(h => h.t === s.t), watched = S.watch.includes(s.t);
  const conv = isEq && C !== S.base && s.price ? ` <span class="note">≈ ${money(toBase(s.price, C), S.base)}</span>` : '';
  const isFX = s.type === 'Macro' && s.t === 'USDCAD';
  const priceTxt = s.type === 'Index' || s.type === 'Macro' ? plain(s.price, isFX ? 4 : 2) : money(s.price, C);
  let h = `
   <div class="dhead"><div><h2>${esc(s.n || s.t)}</h2><div class="note" style="margin:2px 0 0"><span class="tk">${esc(s.t)}</span>${s.exchName ? ' · ' + esc(s.exchName) : s.exch ? ' · ' + esc(s.exch) : ''}${s.sec && s.type === 'Stock' ? ' · ' + esc(s.sec) : ''}${isEq ? ' · prices in ' + C : ''}</div></div>
     <button type="button" class="x" id="dclose" aria-label="Close report" style="font-size:24px">×</button></div>
   <div style="display:flex;align-items:baseline;gap:12px;margin-top:10px;flex-wrap:wrap"><span class="px">${priceTxt}</span><span class="num ${cls(s.dchg)}">${pct(s.dchg, 2, true)} today</span>${conv}</div>
   ${isEq ? `<div class="form" style="margin-top:10px"><label for="dsh">Shares<input id="dsh" type="number" min="0" step="any" size="6"></label><button class="btn" type="button" id="dadd">${owned ? 'Add more' : 'Add to portfolio'}</button><button class="btn ghost" type="button" id="dwatch">${watched ? 'Watching ✓' : 'Watch'}</button><span class="note" id="dmsg">${owned ? `You own ${owned.sh} shares.` : ''}</span></div>` : ''}
   <div class="sec"><h3>Price history <span class="seg" id="rng">${['1m', '6m', '1y', '5y'].map(r => `<button type="button" data-r="${r}" aria-pressed="${r === '1y'}">${r.toUpperCase()}</button>`).join('')}</span><span class="note" id="rngchg" style="margin:0"></span></h3><div class="chart" id="hchart"><p class="loading">Loading chart…</p></div></div>`;

  if (s.type === 'Stock' && !s.partial) {
    h += `<div class="kv">${[
      kv('mcap', 'Market cap', capFmt(s.mcap, C)), kv('pe', 'P/E', x2(s.pe)), kv('peg', 'PEG', x2(s.peg, 2)), kv('pb', 'P/B', x2(s.pb)),
      kv('div', 'Dividend', pct(s.div, 2)), kv('payout', 'Payout', pct(s.payout, 0)), kv('roe', 'ROE', pct(s.roe, 0)), kv('roic', 'ROIC', pct(s.roic, 0)),
      kv('om', 'Op. margin', pct(s.om, 0)), kv('de', 'Debt/equity', x2(s.de, 2)), kv('estG', 'Exp. EPS growth' + (s.estSrc === 'history' ? '*' : ''), pct(s.estG, 1)), kv('beta', 'Beta', x2(s.beta, 2)),
      kv('chg', '1 year', `<span class="${cls(s.chg)}">${pct(s.chg, 0, true)}</span>`), kv('chg', '5 years', `<span class="${cls(s.chg5y)}">${pct(s.chg5y, 0, true)}</span>`), kv('range', '52-wk low', money(s.yearLow, C)), kv('range', '52-wk high', money(s.yearHigh, C)),
    ].join('')}</div>${s.estSrc === 'history' ? '<p class="note">* No analyst estimates available, so expected growth uses the past 5 years, capped at 15%.</p>' : ''}`;
  } else if (s.type === 'Fund') {
    h += `<div class="kv">${[kv('exp', 'Fee (MER)', pct(s.exp, 2)), kv('div', 'Yield', pct(s.div, 2)), kv('chg', '1 year', pct(s.chg, 0, true)), kv('chg', '5 years', pct(s.chg5y, 0, true)), kv('mcap', 'Fund size', capFmt(s.mcap, C)), kv('', 'Holdings', s.holdings ? plain(s.holdings, 0) : '—'), kv('range', '52-wk low', money(s.yearLow, C)), kv('range', '52-wk high', money(s.yearHigh, C))].join('')}</div>`;
  } else if (s.type === 'Index' || s.type === 'Macro') {
    h += `<div class="kv">${[kv('', 'Previous close', plain(s.prevClose ?? (s.price - (s.dchgAbs || 0)), isFX ? 4 : 2)), kv('', 'Day change', plain(s.dchgAbs, isFX ? 4 : 2)), kv('range', '52-wk low', plain(s.yearLow, isFX ? 4 : 2)), kv('range', '52-wk high', plain(s.yearHigh, isFX ? 4 : 2)), kv('', '50-day avg', plain(s.avg50, isFX ? 4 : 2)), kv('', '200-day avg', plain(s.avg200, isFX ? 4 : 2))].join('')}</div>`;
  }

  if (j.grades || j.target) {
    const g = j.grades, tg = j.target;
    const tot = g ? g.strongBuy + g.buy + g.hold + g.sell + g.strongSell : 0;
    const seg = (n, c) => tot ? `<div style="background:${c};grid-column:span 1;width:100%;flex:${n}"></div>` : '';
    h += `<div class="sec"><h3>What analysts say</h3>
      ${tot ? `<div style="display:flex;height:12px;border-radius:6px;overflow:hidden;gap:2px">${[[g.strongBuy + g.buy, 'var(--good)'], [g.hold, 'var(--warn)'], [g.sell + g.strongSell, 'var(--bad)']].filter(x => x[0]).map(([n, c]) => `<div style="flex:${n};background:${c}"></div>`).join('')}</div>
      <p class="note">${g.strongBuy + g.buy} buy · ${g.hold} hold · ${g.sell + g.strongSell} sell${g.consensus ? ` · consensus: <b>${esc(g.consensus)}</b>` : ''}</p>` : ''}
      ${tg && tg.mid ? `<p class="note" style="font-size:14px;color:var(--ink)">12-month price target ${money(tg.mid, C)} (<span class="${cls(tg.mid / s.price - 1)}">${pct((tg.mid / s.price - 1) * 100, 0, true)}</span>), range ${money(tg.low, C)} to ${money(tg.high, C)}.</p>` : ''}
      <p class="note">Analysts are often wrong and tend to be optimistic. Use this as one input, not a verdict.</p></div>`;
  }

  if (s.type === 'Stock' && !s.partial) {
    h += f ? `<div class="sec"><h3>What is it worth?</h3>
      <div class="models"><div><div class="k">Earnings model</div><div class="v">${money(f.dcf, C)}</div></div><div><div class="k">Graham formula</div><div class="v">${money(f.graham, C)}</div></div><div class="main"><div class="k">Fair value (average)</div><div class="v ${cls(f.up)}">${money(f.fv, C)}</div></div></div>
      <p class="note">The price is ${f.up >= 0 ? pct(f.up, 0) + ' below' : pct(-f.up, 0) + ' above'} the model's fair value. ${f.up >= 20 ? "That gap is a margin of safety, in Graham's terms." : f.up <= -30 ? 'The market is paying for more growth than the ' + pct(s.estG, 0) + ' a year these models assume.' : 'Close to fairly priced by these models.'}</p></div>`
      : `<div class="sec"><h3>What is it worth?</h3><p class="note">Earnings are negative or missing, so earnings-based fair value models don't apply.</p></div>`;
  }
  if (p) {
    h += `<div class="sec"><h3>Next 5 years: three scenarios</h3><div class="chart" id="dchart"></div>
      <div class="legend"><span><i style="background:var(--good)"></i>Bull ${pct(p.ann.bull, 1)}/yr</span><span><i style="background:var(--accent)"></i>Base ${pct(p.ann.base, 1)}/yr</span><span><i style="background:var(--bad)"></i>Bear ${pct(p.ann.bear, 1)}/yr</span></div>
      <p class="note">${p.note ? esc(p.note) : `Yearly returns include the ${pct(s.div || 0, 1)} dividend. Base: earnings grow ${pct(p.sc.base.g * 100, 0)} a year and the P/E moves from ${x2(s.pe)} to ${x2(p.sc.base.pe)}. Bear: ${pct(p.sc.bear.g * 100, 0)} growth, P/E ${x2(p.sc.bear.pe)}. Bull: ${pct(p.sc.bull.g * 100, 0)} growth, P/E ${x2(p.sc.bull.pe)}.`}</p></div>`;
  }
  if (isEq && !s.partial) {
    const all = STRATS.map(st => ({ st, sc: evaluate(s, st.id).score }));
    h += `<div class="sec"><h3>${esc(SMAP[S.strat].name)} checklist ${scorePill(ev.score)}</h3>
      ${ev.score == null ? `<p class="note">${s.type === 'Fund' ? "This strategy is built for individual stocks, so it doesn't score funds. Switch to John Bogle to see how this fund fits." : 'Not enough data to score this one yet.'}</p>`
      : `<ul class="checklist">${ev.res.map(({ r, v }) => `<li><span class="${v == null ? 's-na' : v === 1 ? 'pos' : v === 0.5 ? '' : 'neg'}" style="${v === 0.5 ? 'color:var(--warn)' : ''}" aria-label="${v == null ? 'not applicable' : v === 1 ? 'pass' : v === 0.5 ? 'close' : 'fail'}">${v == null ? '–' : v === 1 ? '✓' : v === 0.5 ? '≈' : '✗'}</span><span ${r.m && GLOSS[r.m] ? `title="${esc(GLOSS[r.m][1])}"` : ''}>${esc(r.l)}</span><span class="val">${r.m ? metricText(s, r.m) : ''}</span></li>`).join('')}</ul>`}</div>
      <div class="sec"><h3>Across every strategy</h3><div class="mini">${all.map(a => `<div class="row ${a.st.id === S.strat ? 'cur' : ''}" data-use="${a.st.id}" title="Switch to ${esc(a.st.name)}"><span>${esc(a.st.name)}</span><div class="track"><div class="fill" style="width:${a.sc || 0}%;background:${a.sc == null ? 'transparent' : a.sc >= 70 ? 'var(--good)' : a.sc >= 40 ? 'var(--warn)' : 'var(--bad)'}"></div></div><span class="num" style="text-align:right">${a.sc == null ? 'n/a' : a.sc}</span></div>`).join('')}</div></div>`;
  }
  if (s.desc) h += `<div class="sec"><h3>About</h3><p style="font-size:14px;margin:0;max-width:72ch">${esc(s.desc)}${s.desc.length >= 700 ? '…' : ''}</p>${s.web ? `<p class="note"><a href="${esc(s.web)}" target="_blank" rel="noopener">${esc(s.web.replace(/^https?:\/\//, ''))}</a></p>` : ''}</div>`;
  if (j.news && j.news.length) h += `<div class="sec"><h3>Latest news</h3><ul class="news">${j.news.slice(0, 6).map(n => `<li><a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a><span class="meta">${esc(n.site || '')} · ${ago(n.date)}</span></li>`).join('')}</ul></div>`;

  $('#drawer').innerHTML = h;
  bindDrawer();
  if (p) lineChart($('#dchart'), [{ k: 'bear', v: p.bear, c: 'var(--bad)' }, { k: 'base', v: p.base, c: 'var(--accent)', w: 3 }, { k: 'bull', v: p.bull, c: 'var(--good)' }], { band: ['bear', 'bull'], fmt: v => money(v, C), axisFmt: v => money(v, C), xLabel: i => i === 0 ? 'Today' : 'Yr ' + i, aria: '5-year scenarios' });
  loadHistory(s, '1y');
  $('#rng').onclick = e => { const b = e.target.closest('[data-r]'); if (!b) return; $$('#rng button').forEach(x => x.setAttribute('aria-pressed', x === b)); loadHistory(s, b.dataset.r); };
  if (isEq) {
    $('#dadd').onclick = () => { const sh = parseFloat($('#dsh').value); if (!(sh > 0)) { $('#dsh').focus(); $('#dmsg').textContent = 'Enter how many shares.'; return; } addHolding(s.t, sh, s.price); savePort(); renderView(); $('#dmsg').textContent = `Added ${sh} shares at ${money(s.price, C)}.`; };
    $('#dwatch').onclick = e => { const i = S.watch.indexOf(s.t); if (i >= 0) S.watch.splice(i, 1); else S.watch.push(s.t); saveWatch(); e.target.textContent = i >= 0 ? 'Watch' : 'Watching ✓'; renderView(); };
  }
  $$('#drawer [data-use]').forEach(r => r.onclick = () => { setStrat(r.dataset.use); renderReport(s, j); });
}
async function loadHistory(s, range) {
  const el = $('#hchart'); if (!el) return;
  if (!S.live) { el.innerHTML = '<p class="empty">Price history needs live data.</p>'; return; }
  try {
    const j = await api(`history/${encodeURIComponent(s.t)}?range=${range}`);
    if (DRAWER !== s.t) return;
    const pts = j.points; if (pts.length < 2) { el.innerHTML = '<p class="empty">No price history available.</p>'; return; }
    const step = Math.max(1, Math.floor(pts.length / 260)); const P = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
    const ch = (P[P.length - 1][1] / P[0][1] - 1) * 100;
    const col = ch >= 0 ? 'var(--good)' : 'var(--bad)';
    const isIdx = s.type === 'Index' || s.type === 'Macro';
    const f = isIdx ? (v => plain(v, s.t === 'USDCAD' ? 4 : 0)) : (v => money(v, s.ccy));
    lineChart(el, [{ k: 'p', v: P.map(x => x[1]), c: col, w: 2 }], { area: true, noEnds: true, h: 220, fmt: f, axisFmt: f, xLabel: i => fmtDate(P[i][0]) + (range === '5y' ? ' ' + P[i][0].slice(0, 4) : ''), aria: 'Price history' });
    $('#rngchg').innerHTML = `<span class="${cls(ch)}">${pct(ch, 1, true)}</span> over ${range.replace('m', ' months').replace('y', range === '1y' ? ' year' : ' years')}`;
  } catch (e) { el.innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
}
function metricText(s, m) {
  const v = m === 'mcap' ? s.mcapUSD : s[m]; if (!ok(v)) return '—';
  return ({ pe: x2, pb: x2, peg: v => x2(v, 2), de: v => x2(v, 2), cr: v => x2(v, 1), mcap: v => capFmt(v, 'USD'), exp: v => pct(v, 2) })[m]?.(v) ?? pct(v, m === 'div' ? 1 : 0);
}

/* ================= search ================= */
let SUGG = [], HL = -1;
const doSearch = debounce(async q => {
  if (!q) { $('#sugg').classList.remove('on'); return; }
  try {
    const j = await api('search?q=' + encodeURIComponent(q));
    SUGG = j.items; HL = -1;
    $('#sugg').innerHTML = SUGG.map((x, i) => `<button type="button" role="option" data-pick="${esc(x.t)}" data-i="${i}"><span class="tk">${esc(x.t)}</span><span>${esc(x.n || '')}</span><span class="x2">${esc(x.exch || '')}</span></button>`).join('') || `<div class="empty" style="padding:8px 10px">No matches. TSX symbols end in .TO</div>`;
    $('#sugg').classList.add('on');
  } catch { }
}, 220);
$('#q').addEventListener('input', e => doSearch(e.target.value.trim()));
$('#q').addEventListener('keydown', e => {
  const btns = $$('#sugg button');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); HL = clamp(HL + (e.key === 'ArrowDown' ? 1 : -1), 0, btns.length - 1); btns.forEach((b, i) => b.classList.toggle('hl', i === HL)); }
  if (e.key === 'Enter') { e.preventDefault(); const pick = btns[HL]?.dataset.pick || SUGG[0]?.t || e.target.value.trim(); if (pick) { openStock(pick); $('#sugg').classList.remove('on'); e.target.value = ''; } }
  if (e.key === 'Escape') $('#sugg').classList.remove('on');
});
document.addEventListener('click', e => { if (!e.target.closest('.search')) $('#sugg').classList.remove('on'); });
$('#sugg').addEventListener('click', e => { const b = e.target.closest('[data-pick]'); if (b) { openStock(b.dataset.pick); $('#sugg').classList.remove('on'); $('#q').value = ''; } });

/* ================= events ================= */
function setStrat(id) { S.strat = id; saveSettings(); renderShell(); renderView(); }
$('#pills').addEventListener('click', e => { const b = e.target.closest('.pill'); if (b) setStrat(b.dataset.s); });
$$('.seg [data-ccy]').forEach(b => b.addEventListener('click', () => { S.base = b.dataset.ccy; saveSettings(); renderShell(); renderView(); }));
document.addEventListener('click', e => {
  const uw = e.target.closest('[data-unwatch]'); if (uw) { e.stopPropagation(); S.watch = S.watch.filter(x => x !== uw.dataset.unwatch); saveWatch(); renderWatch(); return; }
  if (e.target.closest('input,select,textarea,[data-del]')) return;
  const o = e.target.closest('[data-open]');
  if (o && !e.target.closest('#sugg')) { e.preventDefault(); openStock(o.dataset.open); return; }
  const u = e.target.closest('#stratcards [data-use]'); if (u) { setStrat(u.dataset.use); window.scrollTo(0, 0); }
}, true);
$('#scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && DRAWER) closeDrawer(); });

$('#moverMkt').addEventListener('click', e => { const b = e.target.closest('[data-m]'); if (!b) return; MOV.m = b.dataset.m; $$('#moverMkt button').forEach(x => x.setAttribute('aria-pressed', x === b)); renderMovers(); });
$('#moverKind').addEventListener('click', e => { const b = e.target.closest('[data-k]'); if (!b) return; MOV.k = b.dataset.k; $$('#moverKind button').forEach(x => x.setAttribute('aria-pressed', x === b)); renderMovers(); });
$('#newsSel').addEventListener('click', e => { const b = e.target.closest('[data-n]'); if (!b) return; NEWS = b.dataset.n; $$('#newsSel button').forEach(x => x.setAttribute('aria-pressed', x === b)); renderNews(); });
$('#allocBy').addEventListener('click', e => { const b = e.target.closest('[data-a]'); if (!b) return; ALLOC = b.dataset.a; $$('#allocBy button').forEach(x => x.setAttribute('aria-pressed', x === b)); renderPortfolio(); });
['#hcolor', '#hmkt'].forEach(id => $(id).addEventListener('change', renderHeat));
let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (S.view === 'markets') renderHeat(); }, 150); });

$('#hz').addEventListener('change', e => { S.years = +e.target.value; saveSettings(); renderPortfolio(); });
$('#mc').addEventListener('input', e => { S.monthly = Math.max(0, +e.target.value || 0); saveSettings(); renderPortfolio(); });
$('#htable').addEventListener('change', e => { const el = e.target; if (el.dataset.i == null) return; const v = parseFloat(el.value); if (!(v >= 0)) return; S.port[+el.dataset.i][el.dataset.f] = v; savePort(); el.blur(); renderPortfolio(); });
$('#htable').addEventListener('click', e => { const d = e.target.closest('[data-del]'); if (d) { S.port.splice(+d.dataset.del, 1); savePort(); renderPortfolio(); } });
$('#addform').addEventListener('submit', async e => {
  e.preventDefault();
  const t = $('#addT').value.trim().toUpperCase(), sh = parseFloat($('#addS').value); if (!t || !(sh > 0)) return;
  $('#addMsg').textContent = 'Looking up ' + t + '…';
  try {
    const s = await ensure(t);
    const c = parseFloat($('#addC').value) || s.price;
    if (!c) throw new Error('No price found. Enter your average cost.');
    addHolding(s.t, sh, c); e.target.reset(); $('#addMsg').textContent = ''; savePort(); renderPortfolio();
  } catch (err) { $('#addMsg').textContent = err.message; }
});
let clearArm = false;
$('#clearP').addEventListener('click', e => { if (!clearArm) { clearArm = true; e.target.textContent = 'Click again to clear'; setTimeout(() => { clearArm = false; e.target.textContent = 'Clear all'; }, 3000); return; } S.port = []; savePort(); clearArm = false; e.target.textContent = 'Clear all'; renderPortfolio(); });
async function doImport(replace) {
  const out = [], bad = [];
  $('#imp').value.split(/\n/).forEach(line => {
    const p = line.trim().split(/[\s,;\t]+/).filter(Boolean); if (!p.length) return;
    const t = p[0].toUpperCase().replace(/[^A-Z0-9.\-]/g, ''), sh = parseFloat(p[1]), c = parseFloat((p[2] || '').replace(/[$C]/g, ''));
    if (!t || !(sh > 0)) { bad.push(line.trim()); return; }
    out.push({ t, sh, c });
  });
  if (!out.length) { $('#impMsg').textContent = 'Nothing to add. Use: TICKER shares cost'; return; }
  $('#impMsg').textContent = 'Looking up ' + out.length + ' symbols…';
  const unknown = [];
  await Promise.all(out.map(async h => { try { const s = await ensure(h.t); if (!(h.c >= 0)) h.c = s.price; } catch { unknown.push(h.t); } }));
  const good = out.filter(h => !unknown.includes(h.t) && h.c >= 0);
  if (replace) S.port = [];
  good.forEach(h => addHolding(h.t, h.sh, h.c)); savePort(); renderPortfolio();
  $('#impMsg').textContent = `Added ${good.length}.` + (bad.length ? ` Skipped ${bad.length} unreadable line${bad.length > 1 ? 's' : ''}.` : '') + (unknown.length ? ` Not found: ${unknown.join(', ')}.` : '');
}
$('#impAdd').addEventListener('click', () => doImport(false));
$('#impRep').addEventListener('click', () => doImport(true));
$('#wform').addEventListener('submit', async e => {
  e.preventDefault(); const t = $('#wT').value.trim().toUpperCase(); if (!t) return;
  $('#wMsg').textContent = 'Looking up ' + t + '…';
  try { const s = await ensure(t); if (!S.watch.includes(s.t)) S.watch.push(s.t); saveWatch(); e.target.reset(); $('#wMsg').textContent = ''; renderWatch(); }
  catch (err) { $('#wMsg').textContent = err.message; }
});
$('#stable').addEventListener('click', e => { const th = e.target.closest('th.sort'); if (!th) return; e.stopPropagation(); const k = th.dataset.k; SORT = SORT.k === k ? { k, d: -SORT.d } : { k, d: ['t', 'n', 'sec', 'pe', 'peg', 'de'].includes(k) ? 1 : -1 }; renderScreener(); });
['#fq', '#fex', '#fsec', '#ftype', '#fpe', '#fdiv', '#fup', '#fpass'].forEach(id => $(id).addEventListener('input', renderScreener));

/* ================= routing & data loading ================= */
const VIEWS = ['markets', 'portfolio', 'watchlist', 'screener', 'learn'];
function route() {
  const h = (location.hash || '').slice(1);
  S.view = VIEWS.includes(h) ? h : 'markets';
  $$('.view').forEach(v => v.classList.toggle('on', v.id === 'view-' + S.view));
  $$('.tabs a').forEach(a => a.dataset.v === S.view ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
  renderView(true);
}
window.addEventListener('hashchange', route);
function renderView(first) {
  ({ markets: () => { renderMarkets(); if (first) { renderEarnings(); renderNews(); } }, portfolio: renderPortfolio, watchlist: renderWatch, screener: renderScreener, learn: renderLearn })[S.view]();
}

async function loadUniverse() {
  const j = await api('universe');
  for (const it of j.items) S.U[it.t] = derive(it);
  S.pending = (j.pending || []).length;
}
async function loadMarkets() {
  const j = await api('markets');
  S.markets = j;
  const fx = (j.macro || []).find(m => m.s === 'USDCAD');
  if (fx && fx.price) { S.fx = fx.price; Object.values(S.U).forEach(derive); FV.clear(); }
}
async function refreshLive() {
  if (document.hidden || !S.live) return;
  try { await Promise.all([loadMarkets(), loadUniverse()]); renderShell(); if (S.view !== 'learn') renderView(); } catch {}
}

(async function init() {
  renderShell();
  $$('.view').forEach(v => v.classList.toggle('on', v.id === 'view-markets'));
  try {
    const st = await api('status'); S.live = st.live; S.user = st.user;
    const [set, port, wl] = await Promise.all([api('settings').catch(() => ({ settings: {} })), api('portfolio').catch(() => null), api('watchlist').catch(() => null)]);
    const ss = set.settings || {};
    if (ss.base) S.base = ss.base; if (ss.strat && SMAP[ss.strat]) S.strat = ss.strat; if (ss.monthly != null) S.monthly = ss.monthly; if (ss.years) S.years = ss.years;
    S.port = port ? port.holdings : store.get('lv_port_backup', []);
    S.watch = wl ? wl.symbols : [];
    if (!port) $('#syncMsg').textContent = 'Could not reach the database, so changes are kept in this browser only.';
    if (!S.live && !S.port.length && !store.get('lv_seeded', false)) {
      S.port = [{ t: 'VOO', sh: 20, c: 480 }, { t: 'AAPL', sh: 15, c: 170 }, { t: 'MSFT', sh: 8, c: 330 }, { t: 'KO', sh: 40, c: 58 }, { t: 'JNJ', sh: 12, c: 160 }];
      S.watch = ['NVDA', 'COST', 'V']; store.set('lv_seeded', true);
    }
    await Promise.all([loadMarkets().catch(() => {}), loadUniverse()]);
  } catch (e) {
    $('#notice').textContent = 'Could not load data: ' + e.message;
  }
  if (!S.live) $('#hcolor').value = 'chg';
  renderShell();
  route();
  setInterval(refreshLive, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshLive(); });
})();
