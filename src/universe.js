// Curated symbol lists. Symbols use FMP format: TSX listings end in ".TO", indices start with "^".

export const INDICES = [
  { s: '^GSPC',   n: 'S&P 500',           r: 'United States', mkt: 'NYSE' },
  { s: '^IXIC',   n: 'Nasdaq Composite',  r: 'United States', mkt: 'NYSE' },
  { s: '^DJI',    n: 'Dow Jones',         r: 'United States', mkt: 'NYSE' },
  { s: '^RUT',    n: 'Russell 2000',      r: 'United States', mkt: 'NYSE' },
  { s: '^GSPTSE', n: 'S&P/TSX Composite', r: 'Canada',        mkt: 'TSX' },
  { s: '^FTSE',   n: 'FTSE 100',          r: 'United Kingdom', mkt: 'LSE' },
  { s: '^GDAXI',  n: 'DAX',               r: 'Germany',       mkt: 'XETRA' },
  { s: '^N225',   n: 'Nikkei 225',        r: 'Japan',         mkt: 'TSE' },
  { s: '^HSI',    n: 'Hang Seng',         r: 'Hong Kong',     mkt: 'HKEX' },
  { s: '^VIX',    n: 'VIX volatility',    r: 'United States', mkt: 'NYSE' },
];

export const MACRO = [
  { s: 'USDCAD', n: 'USD / CAD' },
  { s: 'GCUSD',  n: 'Gold' },
  { s: 'CLUSD',  n: 'Crude oil (WTI)' },
  { s: 'BTCUSD', n: 'Bitcoin' },
];

// ~100 of the largest, most-followed US companies
export const US_LARGE = [
  'AAPL','MSFT','NVDA','GOOGL','AMZN','META','AVGO','TSLA','BRK-B','JPM','LLY','V','UNH','XOM','MA','JNJ','PG','HD',
  'COST','ABBV','MRK','WMT','NFLX','BAC','CVX','KO','ORCL','CRM','AMD','PEP','ADBE','TMO','LIN','MCD','CSCO','ACN','ABT',
  'WFC','DHR','TXN','INTU','QCOM','IBM','AMGN','CAT','GE','PM','NOW','ISRG','VZ','UNP','SPGI','GS','NEE','HON','RTX',
  'LOW','T','PFE','BKNG','AXP','BLK','SYK','MS','DE','LMT','ELV','TJX','SBUX','MDT','ADP','PLD','MMC','CB','GILD','VRTX',
  'NKE','MO','DUK','SO','BMY','CVS','ZTS','CME','SHW','ICE','UPS','TGT','MMM','O','PYPL','INTC','UBER','PANW','ANET','PLTR',
];

// S&P/TSX 60 style list of Canada's largest companies
export const TSX60 = [
  'RY.TO','TD.TO','SHOP.TO','ENB.TO','CNQ.TO','CP.TO','CNR.TO','BMO.TO','BN.TO','BNS.TO','CM.TO','TRI.TO','CSU.TO','ATD.TO',
  'SU.TO','TRP.TO','MFC.TO','WCN.TO','NTR.TO','CVE.TO','SLF.TO','IFC.TO','FTS.TO','GIB-A.TO','QSR.TO','L.TO','POW.TO',
  'BCE.TO','T.TO','RCI-B.TO','AEM.TO','ABX.TO','WPM.TO','FNV.TO','TECK-B.TO','CCO.TO','IMO.TO','PPL.TO','H.TO','EMA.TO',
  'MRU.TO','WN.TO','DOL.TO','CTC-A.TO','SAP.TO','GIL.TO','NA.TO','FFH.TO','GWO.TO','BAM.TO','X.TO','TOU.TO','ARX.TO',
  'CAE.TO','WSP.TO','STN.TO','OTEX.TO','DSG.TO','CLS.TO','K.TO',
];

// Funds. exp = expense ratio / MER in %, expRet = long-run yearly return assumption in % (total return, before fees).
export const FUNDS = {
  'VOO':     { n: 'Vanguard S&P 500 ETF',              broad: true,  kind: 'equity', exp: 0.03, expRet: 7.5 },
  'VTI':     { n: 'Vanguard Total Stock Market ETF',   broad: true,  kind: 'equity', exp: 0.03, expRet: 7.5 },
  'VXUS':    { n: 'Vanguard Total International ETF',  broad: true,  kind: 'equity', exp: 0.05, expRet: 7.0 },
  'QQQ':     { n: 'Invesco Nasdaq-100 ETF',            broad: false, kind: 'equity', exp: 0.20, expRet: 8.5 },
  'SCHD':    { n: 'Schwab US Dividend Equity ETF',     broad: false, kind: 'equity', exp: 0.06, expRet: 7.0 },
  'BND':     { n: 'Vanguard Total Bond Market ETF',    broad: true,  kind: 'bond',   exp: 0.03, expRet: 4.0 },
  'XEQT.TO': { n: 'iShares Core Equity ETF Portfolio', broad: true,  kind: 'equity', exp: 0.20, expRet: 7.0 },
  'VEQT.TO': { n: 'Vanguard All-Equity ETF Portfolio', broad: true,  kind: 'equity', exp: 0.24, expRet: 7.0 },
  'XIC.TO':  { n: 'iShares Core S&P/TSX Capped Composite', broad: true, kind: 'equity', exp: 0.06, expRet: 7.0 },
  'XIU.TO':  { n: 'iShares S&P/TSX 60 Index ETF',      broad: true,  kind: 'equity', exp: 0.18, expRet: 7.0 },
  'VFV.TO':  { n: 'Vanguard S&P 500 Index ETF (CAD)',  broad: true,  kind: 'equity', exp: 0.09, expRet: 7.5 },
  'ZSP.TO':  { n: 'BMO S&P 500 Index ETF (CAD)',       broad: true,  kind: 'equity', exp: 0.09, expRet: 7.5 },
  'VDY.TO':  { n: 'Vanguard FTSE Canadian High Dividend', broad: false, kind: 'equity', exp: 0.22, expRet: 6.5 },
  'ZAG.TO':  { n: 'BMO Aggregate Bond Index ETF',      broad: true,  kind: 'bond',   exp: 0.09, expRet: 3.5 },
};

export const CURATED = [...US_LARGE, ...TSX60, ...Object.keys(FUNDS)];

export const isTSX = s => /\.(TO|V|NE|CN)$/i.test(s);
