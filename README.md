# CSE Portfolio · Share Tracker & Calculator

A share-portfolio tracker for the **Colombo Stock Exchange**. It shows live prices, break-even sell signals, dividends, English and Sinhala news, fundamentals and technicals.

It runs as a static website plus a few small **serverless functions**, hosted for free on **Vercel** with no server to look after. Users **create an account and sign in**. Each person's portfolio is saved privately to a free database (Upstash Redis) and synced across all their devices.

> This is v3 of `cse_portfolio.html` + `portfolio_server.py`. The Python server has been replaced by free serverless functions that do the same job.

---

## Features

| Section | What you get |
|---|---|
| **Portfolio** | Editable holdings table. Live CSE prices, B.E.S (break-even sell incl. commission), and SELL / NEAR / WAIT signals. Allocation bars, search and sort. ATrade Excel/CSV import (replace or merge). CSV export. |
| **Calculator** | Buy/Sell cost with commission, break-even price, and a profit check against your buy cost. |
| **Dividends** | Symbol research, a seasonality heat map, likely payers by month, and live dividend announcements. Per-holding DPS setup, a 12-month income forecast and an event log. |
| **Charts** | Portfolio value over time (daily snapshots), gain/loss per share, allocation, sector mix and concentration risk. |
| **History** | Buy/sell log with realized P/L (average-cost method). Holdings update automatically. CSV export. |
| **News** | CSE disclosures, official announcements and 12 English/Sinhala outlets. Filters, search, a keyword tone hint, and your holdings highlighted. |
| **Fundamentals** | Market movers (top gainers, losers, most active) and a full company snapshot for any CSE symbol, with related news. |
| **Technical** | TradingView chart, CSE price/volume chart, 52-week position, relative volume, beta and pivots. |

**New in v3:**
- **Accounts:** sign up, sign in, sign out, change password, recovery-code reset, delete account.
- **Cloud saving:** every change is saved to your account and synced across devices. It also works offline and syncs when you're back online.
- Market ticker: ASPI, S&P SL20, market status and turnover.
- Light and dark theme.
- Installable app (PWA) that works offline.
- JSON backup/restore.
- Keyboard shortcuts (press `?`).
- Browser notifications for SELL signals.
- Auto-refresh that pauses outside CSE hours and when the tab is hidden.
- Accessible dialogs and tabs.
- Hardened security: whitelisted proxy, escaped data, pinned libraries with integrity hashes, CSP headers.

---

## Project structure

```
cse-portfolio/
├── public/                  ← the website (static files, no build step)
│   ├── index.html
│   ├── sw.js                ← service worker (offline + install)
│   ├── manifest.webmanifest
│   ├── 404.html, robots.txt
│   └── assets/
│       ├── css/styles.css
│       ├── icons/
│       └── js/
│           ├── main.js      ← entry point
│           ├── core/        ← state, API client, router, maths, UI helpers
│           ├── data/reference.js  ← sector map + dividend seasonality (edit freely)
│           └── views/       ← one module per tab
├── lib/                     ← server logic shared by every platform
│   ├── auth.js              ← accounts, sessions, passwords, recovery codes
│   ├── userdata.js          ← each user's saved portfolio
│   ├── db.js                ← Upstash Redis (deployed) / local file (dev)
│   ├── cse.js               ← CSE API (whitelisted endpoints, validated params)
│   ├── news.js              ← Google News RSS aggregator
│   └── http.js
├── api/                     ← Vercel functions (/api/auth, /api/data, /api/cse, /api/news)
├── netlify/functions/       ← same functions for Netlify (optional)
├── scripts/dev-server.mjs   ← local server (runs the same server code)
├── tests/                   ← unit tests (accounts, data, proxy)
└── vercel.json, netlify.toml
```

---

## 1. Run it locally

You need **Node.js 18.17 or newer** (download the LTS from <https://nodejs.org>). There are no packages to install.

```bash
cd cse-portfolio
npm run dev
```

Open **http://127.0.0.1:8765** and create an account. Live prices, news and accounts all work locally. Local accounts are stored in `.data/dev-db.json`, which is ignored by git and never deployed.

- Use another port with `PORT=3000 npm run dev`. In Windows PowerShell: `$env:PORT=3000; npm run dev`.
- Run the unit tests with `npm test`.

> **Moving your existing data:** the old version also ran on `http://127.0.0.1:8765`. The first time you create an account there, the app offers to **import the portfolio already saved in that browser** into your account. After that, sign in on the deployed site and it's all there. Alternatively, use **⚙ Settings → Export backup** and then **Import backup** after signing in online.

---

## 2. Put it on GitHub

```bash
cd cse-portfolio
git init
git add .
git commit -m "CSE Portfolio v3"
git branch -M main
# create an empty repo on github.com first, then:
git remote add origin https://github.com/<you>/cse-portfolio.git
git push -u origin main
```

---

## 3. Deploy for free

### Option A — Vercel (recommended)

1. Sign in at <https://vercel.com> with GitHub.
2. Click **Add New → Project** and import your `cse-portfolio` repo.
3. Leave every setting at its default. `vercel.json` already sets the output folder (`public`), the functions and the security headers. Click **Deploy**.
4. **Connect the database (one time, free).** This is required for accounts:
   1. Open your project in Vercel and go to the **Storage** tab.
   2. Click **Create Database**, choose **Upstash for Redis** (free plan), pick a region near Singapore, and create it.
   3. Click **Connect Project** and select this project, for all environments. Vercel adds the connection settings automatically; you don't copy any keys.
   4. Go to **Deployments**, then **⋯ → Redeploy** on the latest deployment, so the functions pick up the new settings.
5. Your site is live at `https://<project>.vercel.app`. Every `git push` redeploys it automatically.

Until the database is connected, the sign-in page says "Accounts are not set up on this site yet" and the forms are disabled. No data can be lost in that state.

`vercel.json` runs the functions in **Singapore (`sin1`)**, the closest free region to Sri Lanka, so CSE requests are fast.

CLI alternative: `npm i -g vercel` then `vercel --prod` inside the folder.

### Alternative — Netlify

1. Sign in at <https://app.netlify.com> with GitHub.
2. Click **Add new site → Import an existing project** and pick the repo.
3. Netlify reads `netlify.toml` (publish `public`, functions in `netlify/functions`). Leave the build command empty and click **Deploy**.
4. Your site is live at `https://<name>.netlify.app`.

CLI alternative: `npm i -g netlify-cli` then `netlify deploy --prod`.

### Free-tier usage

Market data is cached at the CDN edge (prices 30–60 s, news 3 min). Auto-refresh only runs during CSE trading hours while the tab is visible. Saves are batched, so one user typically uses only a few thousand database commands a month. That is far inside Upstash's free allowance (500,000/month) and Vercel's free function limits, even for a few dozen users.

---

## Configuration

| What | Where |
|---|---|
| Commission rate (default 1.12 %) | Header field. Saved automatically. |
| Auto-refresh interval, trading-hours only, notifications | ⚙ Settings |
| Check that live data is reachable | ⚙ Settings → Check connection |
| Account: sync now, change password, new recovery code, sign out | ⚙ Settings → Account (or click your initial, top right) |
| Backup / restore / clear portfolio / delete account | ⚙ Settings → Your data |
| Dividend seasonality & sector mapping | `public/assets/js/data/reference.js` |
| Allow search engines to index the site | Remove the `robots` meta tag in `index.html` and edit `public/robots.txt` |
| Add a CSE API endpoint | Add it to `CSE_ENDPOINTS` in `lib/cse.js` (it is a whitelist) |

After changing files in `public/assets`, bump `VERSION` in `public/sw.js` so installed copies refresh their offline cache. Online visitors always get the latest files either way.

### Keyboard shortcuts

`1`–`8` switch sections · `R` update prices · `/` search · `T` theme · `?` help · `Esc` close dialog

---

## Privacy & security

- **Each portfolio is private to its account.** The server only returns a portfolio to the signed-in owner; other users and anonymous visitors get `401`.
- **Passwords are never stored.** Only a salted **scrypt** hash is kept, and recovery codes are hashed the same way.
- **Sessions** use a random token in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie, so JavaScript can't read it. Only a SHA-256 of the token is stored. Sessions last 30 days, and signing out revokes them immediately.
- **Attack protection:** sign-in, sign-up and reset attempts are rate-limited per IP address and per e-mail. Every state-changing request needs a custom header, which blocks cross-site request forgery (CSRF). "Wrong password" and "no such account" return the same message.
- **Forgot password:** use the recovery code shown at sign-up (also downloadable as a `.txt`). Vercel has no free e-mail sending, so there are no e-mail reset links. If both the password and the recovery code are lost, the account can't be recovered. Download backups occasionally.
- **On this device:** a copy of your portfolio is kept in the browser so the app opens instantly and works offline. Signing out deletes that copy.
- **Two devices editing at once?** If both changed the portfolio before syncing, the app asks which version to keep; nothing is replaced silently.
- The proxy only forwards a fixed list of read-only CSE endpoints with validated parameters, so it can't be used as an open proxy.
- All external text (news titles, links, CSE fields) is escaped, and only `http(s)` links are rendered.
- Third-party libraries (Chart.js, SheetJS) load lazily, at pinned versions, with Subresource Integrity hashes.
- Vercel/Netlify serve strict security headers (CSP, `X-Frame-Options`, `nosniff`, `Referrer-Policy`).

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Yellow **"Live data unavailable"** banner | The `/api` functions aren't running. On Vercel, check the project's **Functions/Logs** tab; locally, start the site with `npm run dev` (not by opening `index.html` directly). |
| Status shows **"Manual OK"** | The CSE didn't answer (holiday, maintenance or network). Type Market Price manually; it refreshes again later. |
| News is empty | Press **Refresh now**. Google News occasionally rate-limits; try again in a minute. |
| Sign-in page says **"Accounts are not set up"** | Connect **Upstash for Redis** in Vercel → Storage, then redeploy (step 4 above). |
| **"Too many attempts"** | The brute-force limit kicked in. Wait 15 minutes (sign-in) or an hour (sign-up/reset). |
| Forgot password | **Forgot password?** on the sign-in page, then enter your e-mail and recovery code. |
| Settings shows **"Not synced"** | Press **↻ Sync now**. If you were offline, changes upload automatically when the connection returns. |
| Old version still showing after a deploy | Reload once. The service worker fetches fresh files whenever you're online. |
| ATrade import says it can't find columns | Export the **Portfolio** sheet from ATrade (Excel or CSV). It needs a Security/Symbol column and a Quantity/Balance column. |

---

**Not investment advice.** SELL/NEAR/WAIT, tone and pivots are rule-based hints. Always confirm with the CSE and your broker. Market data © Colombo Stock Exchange; news via Google News; charts by TradingView.
