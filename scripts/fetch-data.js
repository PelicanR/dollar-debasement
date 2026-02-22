// scripts/fetch-data.js
// Runs in GitHub Actions — server-side, no CORS, full API access
// Output: data/data.json (committed back to repo, served as static file)

import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

const FRED_KEY = process.env.FRED_KEY;
const AV_KEY   = process.env.AV_KEY;

// ── Helpers ──────────────────────────────────────────────────────────────────
async function get(url, label) {
  try {
    console.log(`  Fetching ${label}...`);
    const r = await fetch(url, { timeout: 20000 });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    console.log(`  ✓ ${label}`);
    return j;
  } catch (e) {
    console.warn(`  ✗ ${label}: ${e.message}`);
    return null;
  }
}

// ── FRED ─────────────────────────────────────────────────────────────────────
async function fredSeries(series, limit = 80) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${series}&sort_order=desc&limit=${limit}&file_type=json&api_key=${FRED_KEY}`;
  const j = await get(url, `FRED ${series}`);
  if (!j?.observations) return null;
  return j.observations
    .filter(o => o.value !== '.')
    .map(o => ({ date: o.date, value: parseFloat(o.value) }))
    .reverse();
}

// ── Alpha Vantage ─────────────────────────────────────────────────────────────
async function avCommodity(fn, label) {
  const url = `https://www.alphavantage.co/query?function=${fn}&interval=monthly&apikey=${AV_KEY}`;
  const j = await get(url, label);
  if (!j?.data) return null;
  return j.data
    .map(r => ({ date: r.date, value: parseFloat(r.value) }))
    .filter(r => !isNaN(r.value))
    .sort((a, b) => a.date < b.date ? -1 : 1);
}

async function avGoldSilverSpot() {
  const url = `https://www.alphavantage.co/query?function=GOLD_SILVER_SPOT&apikey=${AV_KEY}`;
  const j = await get(url, 'AV Gold/Silver Spot');
  if (!j) return null;
  // Try multiple possible response shapes
  const gold   = parseFloat(j.gold   || j['Gold Price']   || j['1. Gold Price']   || 0);
  const silver = parseFloat(j.silver || j['Silver Price'] || j['2. Silver Price'] || 0);
  return gold > 0 ? { gold, silver: silver||0, date: j.date || new Date().toISOString().split('T')[0] } : null;
}

async function avGoldHistory() {
  const url = `https://www.alphavantage.co/query?function=GOLD_SILVER_HISTORY&interval=monthly&apikey=${AV_KEY}`;
  const j = await get(url, 'AV Gold History');
  if (!j) return null;
  // Try array format
  if (Array.isArray(j.data)) {
    return j.data.map(r => ({
      date: r.date || r.Date,
      value: parseFloat(r.value || r.gold || r.Gold || r.price || 0)
    })).filter(r => r.value > 0).sort((a,b) => a.date < b.date ? -1 : 1);
  }
  return null;
}

async function avBitcoin() {
  const url = `https://www.alphavantage.co/query?function=DIGITAL_CURRENCY_DAILY&symbol=BTC&market=USD&apikey=${AV_KEY}`;
  const j = await get(url, 'AV Bitcoin');
  const ts = j?.['Time Series (Digital Currency Daily)'];
  if (!ts) return null;
  return Object.entries(ts)
    .sort((a, b) => a[0] < b[0] ? -1 : 1)
    .map(([date, v]) => ({ date, value: parseFloat(v['4a. close (USD)'] || v['4. close'] || 0) }))
    .filter(r => r.value > 0)
    .slice(-730); // last 2 years
}

// ── Frankfurter FX → DXY ─────────────────────────────────────────────────────
async function dxy() {
  const j = await get('https://api.frankfurter.app/latest?from=USD&to=EUR,JPY,GBP,CAD,SEK,CHF', 'Frankfurter DXY');
  if (!j?.rates) return null;
  const { EUR, JPY, GBP, CAD, SEK, CHF } = j.rates;
  const val = 50.14348
    * Math.pow(EUR, -0.576)
    * Math.pow(1/JPY, 0.136)
    * Math.pow(GBP, -0.119)
    * Math.pow(CAD,  0.091)
    * Math.pow(SEK,  0.042)
    * Math.pow(CHF,  0.036);
  return { value: Math.round(val * 100) / 100, date: j.date };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== Dollar Debasement Data Fetch — ${new Date().toUTCString()} ===\n`);

  // Run all fetches in parallel
  const [
    m2Raw,
    cpiRaw,
    hpiRaw,
    goldSilver,
    goldHist,
    btcRaw,
    cpiAV,
    m2AV,
    dxyLive,
  ] = await Promise.all([
    fredSeries('M2SL',   80),
    fredSeries('CPIAUCSL', 80),
    fredSeries('CSUSHPINSA', 80),
    avGoldSilverSpot(),
    avGoldHistory(),
    avBitcoin(),
    avCommodity('CPI',   'AV CPI'),
    avCommodity('M2',    'AV M2'),
    dxy(),
  ]);

  // Prefer FRED data where available, fall back to Alpha Vantage
  const finalCPI = cpiRaw || cpiAV;
  const finalM2  = m2Raw  || m2AV;
  const finalHPI = hpiRaw;

  const data = {
    fetchedAt:   new Date().toISOString(),
    goldSilver,                        // { gold, silver, date }
    goldHist:    goldHist?.slice(-300),// monthly series
    btcRaw:      btcRaw?.slice(-730),  // daily, 2 years
    cpiRaw:      finalCPI?.slice(-80), // monthly
    m2Raw:       finalM2?.slice(-80),  // monthly
    hpiRaw:      finalHPI?.slice(-80), // monthly
    dxyLive,                           // { value, date }
    sources: {
      gold:   goldSilver ? 'alpha_vantage' : 'fallback',
      btc:    btcRaw     ? 'alpha_vantage' : 'fallback',
      cpi:    cpiRaw     ? 'fred'          : (cpiAV ? 'alpha_vantage' : 'fallback'),
      m2:     m2Raw      ? 'fred'          : (m2AV  ? 'alpha_vantage' : 'fallback'),
      hpi:    hpiRaw     ? 'fred'          : 'fallback',
      dxy:    dxyLive    ? 'frankfurter'   : 'fallback',
    }
  };

  // Write output — docs/data/data.json is served by GitHub Pages
  const outPath = path.join(process.cwd(), 'docs', 'data', 'data.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));

  console.log('\n=== Summary ===');
  console.log('Sources used:', data.sources);
  console.log(`Gold:    ${data.goldSilver?.gold ?? 'fallback'}`);
  console.log(`Silver:  ${data.goldSilver?.silver ?? 'fallback'}`);
  console.log(`BTC pts: ${data.btcRaw?.length ?? 0}`);
  console.log(`CPI pts: ${data.cpiRaw?.length ?? 0}`);
  console.log(`M2 pts:  ${data.m2Raw?.length ?? 0}`);
  console.log(`HPI pts: ${data.hpiRaw?.length ?? 0}`);
  console.log(`DXY:     ${data.dxyLive?.value ?? 'fallback'}`);
  console.log(`\nWrote ${fs.statSync(outPath).size} bytes → ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
