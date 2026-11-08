# Longview

A long-term investing dashboard on Cloudflare Workers. It covers US and TSX stocks with live prices, global indices (S&P 500, TSX, FTSE, DAX, Nikkei, Hang Seng), USD/CAD, strategy scoring (Buffett, Graham, Lynch, Greenblatt, dividend growth, Fisher, Bogle), fair-value and 5-year projections, and a portfolio and watchlist saved in D1.

- **Front end:** `public/` (static HTML and JS, served by Workers Assets)
- **Back end:** `src/index.js` (JSON API under `/api/*`, cron refresh)
- **Data providers:** `src/finnhub.js` + `src/live-finnhub.js` (Finnhub free plan, current beta) and `src/fmp.js` (Financial Modeling Prep). Vendor fields are normalized in these files, so the front end doesn't change between providers.
- **Database:** D1 `longview` (already created, with its schema applied)
- **Domain:** `invest.cameronmedialab.com`. You can change it in `wrangler.jsonc`.

Without any API key, the site runs in **demo mode** on an illustrative sample.

## Data providers

`DATA_PROVIDER` in `wrangler.jsonc` chooses where the data comes from. The matching API key must be stored as a Worker secret.

| | **finnhub** (current beta) | **fmp** (planned) |
|---|---|---|
| Cost | Free | FMP Premium |
| Stocks | US-listed only. Canadian companies appear through their New York listings, in USD. | US and TSX (`.TO`) |
| World markets | US-listed country ETFs (SPY, EWC, EWU, EWG, EWJ, EWH) | Real indices (^GSPTSE, ^N225, ^HSI…) |
| USD/CAD | Bank of Canada daily rate | Live quote |
| Price charts | Only with an optional free Twelve Data key | Included |
| Analyst data | Buy/hold/sell counts | Counts, price targets and EPS estimates |
| Expected growth | Past 5-year EPS growth, capped at 15% | Analyst EPS estimates |
| Quote freshness | Refreshed in the background every 2 to 4 minutes during market hours | Up to 60 seconds old |

Switching to FMP later takes three steps, and nothing else changes:
1. Set `"DATA_PROVIDER": "fmp"` in `wrangler.jsonc`.
2. Run `npx wrangler secret put FMP_API_KEY`.
3. Redeploy.

## Deploy

1. **Get a free Finnhub key** at finnhub.io/register.
   - Optional: get a free Twelve Data key at twelvedata.com to turn on price charts.
2. **Install and log in.** Use Node 20 or later.
   ```bash
   npm install
   npx wrangler login
   ```
3. **Add the secrets.**
   ```bash
   npx wrangler secret put FINNHUB_API_KEY
   npx wrangler secret put ADMIN_TOKEN          # any long random string
   npx wrangler secret put TWELVEDATA_API_KEY   # optional
   ```
4. **Deploy.**
   ```bash
   npx wrangler deploy
   ```
   Wrangler creates the `invest.cameronmedialab.com` DNS record and certificate automatically, because the zone's DNS is in Cloudflare.
   - If deploy says the zone isn't found, the domain lives in your other Cloudflare account. Change `account_id` in `wrangler.jsonc`, then recreate the D1 database there with `npx wrangler d1 create longview` and `npm run db:init`.
   - **Auto-deploy from GitHub:** in the Cloudflare dashboard, go to Workers & Pages, open `longview`, then Settings, then Builds, and connect `methodpc/longview`. Every push to `main` then deploys automatically.
5. **Wait about 10 minutes for the first fill.** A cron job runs every minute and uses up to `FINNHUB_BUDGET` calls (default 40 of the free plan's 60 per minute). The rest is left for people browsing the site.
   - While the database is empty, it loads about 12 companies' fundamentals a minute.
   - During US market hours, it then cycles through all quotes every 2 to 4 minutes.
   - Holdings and watchlist symbols are refreshed first.
   - To run one refresh immediately: `curl -X POST -H "x-admin-token: YOUR_TOKEN" https://invest.cameronmedialab.com/api/admin/refresh`.

## Keep it private (recommended)

Free and personal data plans (Finnhub's free plan, FMP's personal plans) don't cover public display, so keep the site behind **Cloudflare Access**, which is free for up to 50 users:

1. Open Zero Trust, then Access, then Applications, and choose Add an application, then Self-hosted.
2. Set the domain to `invest.cameronmedialab.com`.
3. Add a policy that allows your email address, plus anyone you want to share with.

Access also gives each signed-in person their own portfolio, watchlist and settings, keyed by their email. Without Access, everyone shares one portfolio.

## Local development

```bash
npm run db:init:local
npx wrangler dev                                   # demo mode
npx wrangler dev --var FINNHUB_API_KEY:yourkey     # live beta data locally
npx wrangler dev --test-scheduled                 # then GET /__scheduled to run the cron once
```

## API

| Route | What it returns |
|---|---|
| `GET /api/status` | live/demo mode, stored symbol count |
| `GET /api/markets` | global indices + USD/CAD, gold, oil, bitcoin (cached 60 s) |
| `GET /api/universe` | all followed symbols: fundamentals + live quotes |
| `GET /api/stock/:sym` | full report data, analyst targets and grades, news |
| `GET /api/history/:sym?range=1m\|6m\|1y\|5y` | daily closes |
| `GET /api/news?symbols=` | company or market news |
| `GET /api/earnings` | next 14 days for followed companies |
| `GET /api/search?q=` | North American symbol search |
| `GET/PUT /api/portfolio`, `/api/watchlist`, `/api/settings` | per-user data |
| `POST /api/admin/refresh?n=` | refresh stalest fundamentals |

## Notes

- **Symbols:** TSX symbols end in `.TO` (for example `RY.TO`, `XEQT.TO`). Indices start with `^`.
- **Followed universe:** about 100 large US companies, the TSX 60, 14 popular US/Canadian ETFs, and anything in a portfolio or watchlist. Edit `src/universe.js` to change it.
- **Quote freshness:** quotes refresh every 60 seconds while the page is open. Server caches are 20 to 60 seconds for quotes, 10 minutes for news and about 20 hours for fundamentals.
- **Fund return assumptions:** each fund's long-run return assumption (`expRet`) is set in `src/universe.js`.
- **Not advice:** fair values and projections are deliberately simple models for learning, not financial advice.
