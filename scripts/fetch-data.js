// scripts/fetch-data.js
// Runs in GitHub Actions — server-side, no CORS, full API access
// Output: docs/data/data.json (committed back to repo, served by GitHub Pages)

import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

const FRED_KEY = process.env.FRED_KEY;
const AV_KEY   = process.env.AV_KEY;

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

// ── FRED ──────────────────────────────────────────────────────────────────────
async function fredSeries(series, limit=80) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${series}&sort_order=desc&limit=${limit}&file_type=json&api_key=${FRED_KEY}`;
  const j = await get(url, `FRED ${series}`);
  if (!j?.observations) return null;
  return j.observations
    .filter(o => o.value !== '.')
    .map(o => ({ date: o.date, value: parseFloat(o.value) }))
    .reverse();
}

// ── gold-api.com — free, no key, no rate limits, CORS enabled ───────────────
// Endpoint: GET https://api.gold-api.com/price/{symbol}
async function goldApiPrice(symbol) {
  const j = await get(`https://api.gold-api.com/price/${symbol}`, `gold-api.com ${symbol}`);
  if (!j?.price) return null;
  console.log(`  gold-api.com ${symbol}: $${j.price}`);
  return j.price;
}

// ── Kraken — BTC spot + history (no key needed) ───────────────────────────────
async function krakenBtcSpot() {
  const j = await get('https://api.kraken.com/0/public/Ticker?pair=XBTUSD', 'Kraken BTC spot');
  if (j?.error?.length) { console.warn(`  ✗ Kraken BTC: ${j.error[0]}`); return null; }
  const key = Object.keys(j?.result || {})[0];
  const close = parseFloat(j?.result?.[key]?.c?.[0]);
  console.log(`  Kraken BTC: $${close}`);
  return close > 0 ? close : null;
}

async function btcHistory() {
  const j = await get('https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1440', 'Kraken BTC history');
  const candles = j?.result?.XXBTZUSD || j?.result?.XBTUSD;
  if (!candles?.length) return null;
  const monthly = {};
  for (const c of candles) {
    const date = new Date(c[0] * 1000).toISOString().split('T')[0];
    monthly[date.slice(0,7)] = { date, value: parseFloat(c[4]) };
  }
  return Object.values(monthly).sort((a,b) => a.date < b.date ? -1 : 1).slice(-60);
}

// ── DXY from Frankfurter ──────────────────────────────────────────────────────
async function dxy() {
  const j = await get('https://api.frankfurter.app/latest?from=USD&to=EUR,JPY,GBP,CAD,SEK,CHF', 'Frankfurter DXY');
  if (!j?.rates) return null;
  const { EUR, JPY, GBP, CAD, SEK, CHF } = j.rates;
  const val = 62.57
    * Math.pow(1/EUR, -0.576)
    * Math.pow(JPY,    0.136)
    * Math.pow(1/GBP, -0.119)
    * Math.pow(CAD,   -0.091)
    * Math.pow(SEK,   -0.042)
    * Math.pow(CHF,   -0.036);
  console.log(`  DXY: EURUSD=${(1/EUR).toFixed(4)} USDJPY=${JPY.toFixed(2)} -> ${val.toFixed(2)}`);
  return { value: Math.round(val * 100) / 100, date: j.date };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== Fetch — ${new Date().toUTCString()} ===\n`);

  const [
    goldSpot,   // gold-api.com XAU spot price
    silverSpot, // gold-api.com XAG spot price
    m2Raw,      // FRED M2SL
    cpiRaw,     // FRED CPIAUCSL
    hpiRaw,     // FRED CSUSHPINSA
    btcHist,    // Kraken monthly candles
    btcSpot,    // Kraken live spot
    cpiAV,      // AV CPI fallback
    m2AV,       // AV M2 fallback
    dxyLive,    // Frankfurter DXY
  ] = await Promise.all([
    goldApiPrice('XAU'),
    goldApiPrice('XAG'),
    fredSeries('M2SL',              80),
    fredSeries('CPIAUCSL',          80),
    fredSeries('CSUSHPINSA',        80),
    btcHistory(),
    krakenBtcSpot(),
    avCommodity('CPI', 'AV CPI'),
    avCommodity('M2',  'AV M2'),
    dxy(),
  ]);

  // Gold/silver spot from gold-api.com
  const today      = new Date().toISOString().split('T')[0];
  const goldSilver = goldSpot ? {
    gold:   goldSpot,
    silver: silverSpot || null,
    date:   today,
  } : null;

  // BTC: history + append live spot as today's point
  let btcRaw = btcHist || null;
  if (btcSpot) {
    const today = new Date().toISOString().split('T')[0];
    const hist  = btcRaw ? btcRaw.filter(r => r.date < today) : [];
    btcRaw = [...hist, { date: today, value: btcSpot }];
  }

  const finalCPI = cpiRaw || cpiAV;
  const finalM2  = m2Raw  || m2AV;

  const data = {
    fetchedAt: new Date().toISOString(),
    goldSilver,
    goldHist:  null,  // no free historical gold data source currently
    btcRaw:    btcRaw?.slice(-60),
    cpiRaw:    finalCPI?.slice(-80),
    m2Raw:     finalM2?.slice(-80),
    hpiRaw:    hpiRaw?.slice(-80),
    dxyLive,
    sources: {
      gold:   goldSilver ? 'gold-api.com' : 'fallback',
      silver: silverSpot  ? 'gold-api.com' : 'fallback',
      btc:    btcRaw     ? 'kraken'      : 'fallback',
      cpi:    cpiRaw     ? 'fred'        : (cpiAV ? 'alpha_vantage' : 'fallback'),
      m2:     m2Raw      ? 'fred'        : (m2AV  ? 'alpha_vantage' : 'fallback'),
      hpi:    hpiRaw     ? 'fred'        : 'fallback',
      dxy:    dxyLive    ? 'frankfurter' : 'fallback',
    }
  };

  const outPath = path.join(process.cwd(), 'docs', 'data', 'data.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));

  console.log('\n=== Summary ===');
  console.log('Sources:', data.sources);
  console.log(`Gold:    $${data.goldSilver?.gold   ?? 'fallback'}`);
  console.log(`Silver:  $${data.goldSilver?.silver ?? 'fallback'}`);
  console.log(`BTC:     $${btcSpot                 ?? 'fallback'}`);
  console.log(`BTC pts: ${data.btcRaw?.length      ?? 0}`);
  console.log(`CPI pts: ${data.cpiRaw?.length      ?? 0}`);
  console.log(`M2 pts:  ${data.m2Raw?.length       ?? 0}`);
  console.log(`HPI pts: ${data.hpiRaw?.length      ?? 0}`);
  console.log(`DXY:     ${data.dxyLive?.value      ?? 'fallback'}`);
  console.log(`\nWrote ${fs.statSync(outPath).size} bytes -> ${outPath}`);
}

// ── AV fallback for CPI/M2 only ───────────────────────────────────────────────
async function avCommodity(fn, label) {
  const url = `https://www.alphavantage.co/query?function=${fn}&interval=monthly&apikey=${AV_KEY}`;
  const j = await get(url, label);
  if (!j?.data) return null;
  return j.data
    .map(r => ({ date: r.date, value: parseFloat(r.value) }))
    .filter(r => !isNaN(r.value) && r.value > 0)
    .sort((a,b) => a.date < b.date ? -1 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
