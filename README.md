# Dollar Debasement Monitor
### dollar-debasement.com

Live USD debasement tracking dashboard with automated daily data updates.

---

## Architecture

```
GitHub Actions (runs 7am + 7pm UTC daily)
  → fetches FRED, Alpha Vantage, Frankfurter APIs server-side
  → commits data/data.json to this repo

GitHub Pages (serves docs/ folder)
  → index.html reads ./data/data.json — one fetch, no CORS, no rate limits
  → dollar-debasement.com → GitHub Pages (via Cloudflare DNS)
```

---

## Setup — Step by Step

### 1. Create GitHub repo

1. Go to https://github.com/new
2. Name it: `dollar-debasement`
3. Set to **Public** (required for free GitHub Pages)
4. Click **Create repository**

### 2. Upload files

On the new repo page, click **"uploading an existing file"** and drag in this entire folder, or use git:

```bash
git init
git remote add origin https://github.com/PelicanR/dollar-debasement.git
git add .
git commit -m "initial commit"
git branch -M main
git push -u origin main
```

### 3. Add API secrets

In your repo: **Settings → Secrets and variables → Actions → New repository secret**

Add two secrets:
- `FRED_KEY` → `56bb5505a19a7585d5f4d899992d1f48`
- `AV_KEY` → `W1WY1VJQ06V7AF1C`

### 4. Enable GitHub Pages

In your repo: **Settings → Pages**
- Source: **Deploy from a branch**
- Branch: `main` / folder: `/docs`
- Click **Save**

After ~60 seconds your site will be live at:
`https://pelicanr.github.io/dollar-debasement`

### 5. Set up custom domain (Cloudflare + GitHub Pages)

**In Cloudflare DNS** (dash.cloudflare.com → dollar-debasement.com → DNS):

Add these 4 A records pointing to GitHub Pages IPs:

| Type | Name | Content          | Proxy |
|------|------|------------------|-------|
| A    | @    | 185.199.108.153  | DNS only (grey cloud) |
| A    | @    | 185.199.109.153  | DNS only (grey cloud) |
| A    | @    | 185.199.110.153  | DNS only (grey cloud) |
| A    | @    | 185.199.111.153  | DNS only (grey cloud) |
| CNAME | www | pelicanr.github.io | DNS only (grey cloud) |

> ⚠️ **Important:** Set proxy to "DNS only" (grey cloud), not "Proxied" (orange).
> GitHub Pages handles HTTPS itself — Cloudflare proxying breaks it.

**In GitHub Pages settings:**
- Custom domain: `dollar-debasement.com`
- Check **Enforce HTTPS** (after DNS propagates, ~5 min with Cloudflare)

### 6. Trigger first data fetch

In your repo: **Actions → Fetch Market Data → Run workflow**

This runs the fetch immediately instead of waiting for the scheduled time.
Check the run log to confirm all APIs responded. The `data/data.json` file
will be updated and committed automatically.

---

## How updates work

GitHub Actions runs automatically at:
- **3:00 AM ET** (7:00 AM UTC)  
- **3:00 PM ET** (7:00 PM UTC)

You can also trigger manually any time: **Actions → Fetch Market Data → Run workflow**

The site always shows when data was last fetched (header timestamp).
If data is >25 hours old, a banner appears.

---

## API Keys

| Key | Service | Free Limit |
|-----|---------|-----------|
| `FRED_KEY` | Federal Reserve FRED | Unlimited (reasonable use) |
| `AV_KEY` | Alpha Vantage | 25 requests/day |

The fetch script uses ~9 API calls per run. At 2 runs/day = 18/day.
This is within the free tier **only if the site has one user**.
If you share widely, consider upgrading Alpha Vantage ($50/mo removes limits).

---

## File structure

```
dollar-debasement/
├── .github/
│   └── workflows/
│       └── fetch-data.yml    ← GitHub Actions schedule
├── scripts/
│   └── fetch-data.js         ← Node.js data fetcher
├── data/
│   └── data.json             ← auto-updated by Actions, read by frontend
├── docs/                     ← GitHub Pages serves this folder
│   ├── index.html            ← the dashboard
│   └── CNAME                 ← custom domain config
└── package.json
```
