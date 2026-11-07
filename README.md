# Longview

A long-term investing dashboard on Cloudflare Workers. It covers US and TSX stocks with live prices, global indices (S&P 500, TSX, FTSE, DAX, Nikkei, Hang Seng), USD/CAD, strategy scoring (Buffett, Graham, Lynch, Greenblatt, dividend growth, Fisher, Bogle), fair-value and 5-year projections, and a portfolio and watchlist saved in D1.

- **Front end:** `public/` (static HTML and JS, served by Workers Assets)
- **Back end:** `src/index.js` (JSON API under `/api/*`, cron refresh)
- **Data provider:** `src/fmp.js` (Financial Modeling Prep). Every vendor field is normalized here, so a different provider means replacing only this file.
- **Database:** D1 `longview` (already created, with its schema applied)
- **Domain:** `invest.cameronmedialab.com`. You can change it in `wrangler.jsonc`.

Without an API key, the site runs in **demo mode** on an illustrative sample.

## Deploy (about 10 minutes)

1. **Get an FMP key.** Sign up at financialmodelingprep.com.
   - **Premium** is the tier that adds Canadian (TSX) coverage and 30+ years of history.
   - **Ultimate** adds global stock listings. You don't need it for global *indices*.
2. **Install and log in.** Use Node 20 or later.
   ```bash
   npm install
   npx wrangler login
   ```
3. **Add the secrets.**
   ```bash
   npx wrangler secret put FMP_API_KEY
   npx wrangler secret put ADMIN_TOKEN   # any long random string; lets you trigger refreshes
   ```
4. **Deploy.**
   ```bash
   npx wrangler deploy
   ```
   Because cameronmedialab.com's DNS is managed in Cloudflare, Wrangler creates the `invest` record and certificate automatically. GoDaddy only needs to keep pointing the nameservers at Cloudflare, which it already does.
   - If deploy says the zone isn't found, the domain lives in your other Cloudflare account. Change `account_id` in `wrangler.jsonc`, then recreate the D1 database there with `npx wrangler d1 create longview` and `npm run db:init`.
5. **Fill the fundamentals database.** Prices are live immediately. Scores need each company's fundamentals, about 6 API calls per company for ~170 symbols.
   - **Automatic:** the cron job loads 7 symbols every 10 minutes, so it's full after about 4 hours. After that it refreshes daily.
   - **Faster:** run this a few times. Each run loads 7 symbols, the Workers Free plan's limit per request.
     ```bash
     curl -X POST -H "x-admin-token: YOUR_TOKEN" "https://invest.cameronmedialab.com/api/admin/refresh?n=7"
     ```
   - On **Workers Paid** ($5/mo), set `REFRESH_BATCH` to `"40"` in `wrangler.jsonc` and use `n=40`.

## Keep it private (recommended)

FMP's personal plans don't cover displaying their data publicly. Showing it to the public needs FMP's separate data display licence. Put the site behind **Cloudflare Access**, which is free for up to 50 users:

1. Open Zero Trust, then Access, then Applications, and choose Add an application, then Self-hosted.
2. Set the domain to `invest.cameronmedialab.com`.
3. Add a policy that allows your email address, plus anyone you want to share with.

Access also gives each signed-in person their own portfolio, watchlist and settings, keyed by their email. Without Access, everyone shares one portfolio.

## Local development

```bash
npm run db:init:local
npx wrangler dev                                   # demo mode
npx wrangler dev --var FMP_API_KEY:yourkey         # live data locally
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
