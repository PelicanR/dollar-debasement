// scripts/fetch-data.js
// Runs in GitHub Actions — server-side, no CORS, full API access
// Output: docs/data/data.json (committed back to repo, served by GitHub Pages)

import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

const FRED_KEY    = process.env.FRED_KEY;
const AV_KEY      = process.env.AV_KEY;
const GOLDAPI_KEY = process.env.GOLDAPI_KEY;

// ── Helpers ───────────────────────────────────────────────────────────────────
async function get(url, label, headers={}) {
  try {
    console.log(`  Fetching ${label}...`);
    const r = await fetch(url, { signal: AbortSignal.timeout(20000), headers });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j?.['Note'] || j?.['Information']) { console.warn(`  ✗ ${label}: AV rate limit`); return null; }
    if (j?.['Error Message'])              { console.warn(`  ✗ ${label}: ${j['Error Message'].slice(0,60)}`); return null; }
    console.log(`  ✓ ${label}`);
    return j;
  } catch (e) {
    console.warn(`  ✗ ${label}: ${e.message}`);
    return null;
  }
}

// ── Gold-API.com — gold, silver, BTC spot prices ──────────────────────────────
async function goldApiSpot(symbol) {
  const url = `https://www.goldapi.io/api/${symbol}/USD`;
  const j = await get(url, `GoldAPI ${symbol}`, {
    'x-access-token': GOLDAPI_KEY,
    'Content-Type': 'application/json'
  });
  return j?.price ?? null;
}

async function getSpotPrices() {
  const [gold, silver, btc] = await Promise.all([
    goldApiSpot('XAU'),
    goldApiSpot('XAG'),
    goldApiSpot('BTC'),
  ]);
  return { gold, silver, btc };
}

// ── Alpha Vantage — monthly history series ────────────────────────────────────
async function avCommodity(fn, label) {
  const url = `https://www.alphavantage.co/query?function=${fn}&interval=monthly&apikey=${AV_KEY}`;
  const j = await get(url, label);
  if (!j?.data) return null;
  return j.data
    .map(r => ({ date: r.date, value: parseFloat(r.value) }))
    .filter(r => !isNaN(r.value) && r.value > 0)
    .sort((a, b) => a.date < b.date ? -1 : 1);
}

// ── CoinCap — BTC price history (no key needed) ───────────────────────────────
async function btcHistory() {
  // Monthly close prices via CoinCap history endpoint (last 5 years)
  const end   = Date.now();
  const start = end - 5 * 365 * 24 * 60 * 60 * 1000;
  const url   = `https://api.coincap.io/v2/assets/bitcoin/history?interval=m1&start=${start}&end=${end}`;
  // m1 = monthly — too granular, use daily and downsample
  const url2  = `https://api.coincap.io/v2/assets/bitcoin/history?interval=d1&start=${start}&end=${end}`;
  const j = await get(url2, 'CoinCap BTC history');
  if (!j?.data?.length) return null;
  // Take last data point of each month
  const monthly = {};
  for (const pt of j.data) {
    const mo = pt.date.slice(0, 7); // "YYYY-MM"
    monthly[mo] = { date: pt.date.slice(0, 10), value: parseFloat(pt.priceUsd) };
  }
  return Object.values(monthly).sort((a, b) => a.date < b.date ? -1 : 1).slice(-60);
}

// ── FRED ──────────────────────────────────────────────────────────────────────
async function fredSeries(series, limit = 80) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${series}&sort_order=desc&limit=${limit}&file_type=json&api_key=${FRED_KEY}`;
  const j = await get(url, `FRED ${series}`);
  if (!j?.observations) return null;
  return j.observations
    .filter(o => o.value !== '.')
    .map(o => ({ date: o.date, value: parseFloat(o.value) }))
    .reverse();
}

// ── DXY from Frankfurter ──────────────────────────────────────────────────────
async function dxy() {
  const j = await get('https://api.frankfurter.app/latest?from=USD&to=EUR,JPY,GBP,CAD,SEK,CHF', 'Frankfurter DXY');
  if (!j?.rates) return null;
  const { EUR, JPY, GBP, CAD, SEK, CHF } = j.rates;
  const EURUSD = 1 / EUR;
  const USDJPY = JPY;
  const GBPUSD = 1 / GBP;
  const USDCAD = CAD;
  const USDSEK = SEK;
  const USDCHF = CHF;
  // Constant 62.57 calibrated for modern rate levels (Feb 2025, DXY~97)
  const val = 62.57
    * Math.pow(EURUSD, -0.576)
    * Math.pow(USDJPY,  0.136)
    * Math.pow(GBPUSD, -0.119)
    * Math.pow(USDCAD, -0.091)
    * Math.pow(USDSEK, -0.042)
    * Math.pow(USDCHF, -0.036);
  console.log(`  DXY: EURUSD=${EURUSD.toFixed(4)} USDJPY=${USDJPY.toFixed(2)} -> ${val.toFixed(2)}`);
  return { value: Math.round(val * 100) / 100, date: j.date };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== Fetch — ${new Date().toUTCString()} ===\n`);

  const [spot, m2Raw, cpiRaw, hpiRaw, goldHistAV, btcHist, cpiAV, m2AV, dxyLive] = await Promise.all([
    getSpotPrices(),
    fredSeries('M2SL',       80),
    fredSeries('CPIAUCSL',   80),
    fredSeries('CSUSHPINSA', 80),
    avCommodity('GOLD', 'AV Gold history'),
    btcHistory(),
    avCommodity('CPI',  'AV CPI'),
    avCommodity('M2',   'AV M2'),
    dxy(),
  ]);

  const goldSilver = (spot.gold && spot.silver)
    ? { gold: spot.gold, silver: spot.silver, date: new Date().toISOString().split('T')[0] }
    : null;

  // Build BTC series: history + today's spot price appended
  let btcRaw = btcHist || null;
  if (btcRaw && spot.btc) {
    const today = new Date().toISOString().split('T')[0];
    btcRaw = [...btcRaw.filter(r => r.date < today), { date: today, value: spot.btc }];
  } else if (spot.btc) {
    btcRaw = [{ date: new Date().toISOString().split('T')[0], value: spot.btc }];
  }

  const finalCPI = cpiRaw || cpiAV;
  const finalM2  = m2Raw  || m2AV;

  const data = {
    fetchedAt: new Date().toISOString(),
    goldSilver,
    goldHist:  goldHistAV?.slice(-300) || null,
    btcRaw:    btcRaw?.slice(-60),
    cpiRaw:    finalCPI?.slice(-80),
    m2Raw:     finalM2?.slice(-80),
    hpiRaw:    hpiRaw?.slice(-80),
    dxyLive,
    sources: {
      gold: goldSilver  ? 'goldapi'      : 'fallback',
      btc:  btcRaw      ? 'coincap'      : 'fallback',
      cpi:  cpiRaw      ? 'fred'         : (cpiAV ? 'alpha_vantage' : 'fallback'),
      m2:   m2Raw       ? 'fred'         : (m2AV  ? 'alpha_vantage' : 'fallback'),
      hpi:  hpiRaw      ? 'fred'         : 'fallback',
      dxy:  dxyLive     ? 'frankfurter'  : 'fallback',
    }
  };

  const outPath = path.join(process.cwd(), 'docs', 'data', 'data.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));

  console.log('\n=== Summary ===');
  console.log('Sources:', data.sources);
  console.log(`Gold:    ${data.goldSilver?.gold    ?? 'fallback'}`);
  console.log(`Silver:  ${data.goldSilver?.silver  ?? 'fallback'}`);
  console.log(`BTC:     ${spot.btc                 ?? 'fallback'}`);
  console.log(`BTC pts: ${data.btcRaw?.length      ?? 0}`);
  console.log(`CPI pts: ${data.cpiRaw?.length      ?? 0}`);
  console.log(`M2 pts:  ${data.m2Raw?.length       ?? 0}`);
  console.log(`HPI pts: ${data.hpiRaw?.length      ?? 0}`);
  console.log(`DXY:     ${data.dxyLive?.value      ?? 'fallback'}`);
  console.log(`\nWrote ${fs.statSync(outPath).size} bytes -> ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
