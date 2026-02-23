// scripts/fetch-data.js
// Runs in GitHub Actions — server-side, no CORS, full API access
// Output: docs/data/data.json (committed back to repo, served by GitHub Pages)

import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

const FRED_KEY = process.env.FRED_KEY;
const AV_KEY   = process.env.AV_KEY;

async function get(url, label) {
  try {
    console.log(`  Fetching ${label}...`);
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j?.['Note'] || j?.['Information']) {
      console.warn(`  ✗ ${label}: AV rate limit`);
      return null;
    }
    if (j?.['Error Message']) {
      console.warn(`  ✗ ${label}: AV error — ${j['Error Message'].slice(0,60)}`);
      return null;
    }
    console.log(`  ✓ ${label}`);
    return j;
  } catch (e) {
    console.warn(`  ✗ ${label}: ${e.message}`);
    return null;
  }
}

async function fredSeries(series, limit = 80) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${series}&sort_order=desc&limit=${limit}&file_type=json&api_key=${FRED_KEY}`;
  const j = await get(url, `FRED ${series}`);
  if (!j?.observations) return null;
  return j.observations
    .filter(o => o.value !== '.')
    .map(o => ({ date: o.date, value: parseFloat(o.value) }))
    .reverse();
}

async function avCommodity(fn, label) {
  const url = `https://www.alphavantage.co/query?function=${fn}&interval=monthly&apikey=${AV_KEY}`;
  const j = await get(url, label);
  if (!j?.data) return null;
  return j.data
    .map(r => ({ date: r.date, value: parseFloat(r.value) }))
    .filter(r => !isNaN(r.value) && r.value > 0)
    .sort((a, b) => a.date < b.date ? -1 : 1);
}

async function avGoldSpot() {
  const series = await avCommodity('GOLD', 'AV Gold monthly');
  if (!series || !series.length) return null;
  const silverSeries = await avCommodity('SILVER', 'AV Silver monthly');
  const latest = series[series.length - 1];
  const latestSilver = silverSeries?.[silverSeries.length - 1];
  return {
    gold:       latest.value,
    silver:     latestSilver?.value || 0,
    date:       latest.date,
    goldHist:   series,
    silverHist: silverSeries || [],
  };
}

async function avBitcoin() {
  const url = `https://www.alphavantage.co/query?function=DIGITAL_CURRENCY_MONTHLY&symbol=BTC&market=USD&apikey=${AV_KEY}`;
  const j = await get(url, 'AV Bitcoin monthly');
  const ts = j?.['Time Series (Digital Currency Monthly)'];
  if (ts && Object.keys(ts).length > 0) {
    const entries = Object.entries(ts)
      .sort((a, b) => a[0] < b[0] ? -1 : 1)
      .map(([date, v]) => {
        const close = v['4a. close (USD)'] || v['4. close'] || v['4b. close (USD)'] || v['close'];
        return { date, value: parseFloat(close || 0) };
      })
      .filter(r => r.value > 0);
    if (entries.length > 0) return entries.slice(-60);
  }
  return null;
}

async function dxy() {
  const j = await get('https://api.frankfurter.app/latest?from=USD&to=EUR,JPY,GBP,CAD,SEK,CHF', 'Frankfurter DXY');
  if (!j?.rates) return null;
  const { EUR, JPY, GBP, CAD, SEK, CHF } = j.rates;
  // Frankfurter gives foreign units per USD — invert to get USD per foreign unit
  const val = 50.14348
    * Math.pow(1/EUR, 0.576)
    * Math.pow(1/JPY, 0.136)
    * Math.pow(1/GBP, 0.119)
    * Math.pow(1/CAD, 0.091)
    * Math.pow(1/SEK, 0.042)
    * Math.pow(1/CHF, 0.036);
  console.log(`  DXY: EUR=${EUR} JPY=${JPY} → ${val.toFixed(2)}`);
  return { value: Math.round(val * 100) / 100, date: j.date };
}

async function main() {
  console.log(`\n=== Fetch — ${new Date().toUTCString()} ===\n`);

  const [m2Raw, cpiRaw, hpiRaw, goldData, btcRaw, cpiAV, m2AV, dxyLive] = await Promise.all([
    fredSeries('M2SL',       80),
    fredSeries('CPIAUCSL',   80),
    fredSeries('CSUSHPINSA', 80),
    avGoldSpot(),
    avBitcoin(),
    avCommodity('CPI', 'AV CPI'),
    avCommodity('M2',  'AV M2'),
    dxy(),
  ]);

  const goldSilver = goldData ? { gold: goldData.gold, silver: goldData.silver, date: goldData.date } : null;
  const goldHist   = goldData?.goldHist || null;
  const finalCPI   = cpiRaw || cpiAV;
  const finalM2    = m2Raw  || m2AV;

  const data = {
    fetchedAt: new Date().toISOString(),
    goldSilver,
    goldHist:  goldHist?.slice(-300),
    btcRaw:    btcRaw?.slice(-60),
    cpiRaw:    finalCPI?.slice(-80),
    m2Raw:     finalM2?.slice(-80),
    hpiRaw:    hpiRaw?.slice(-80),
    dxyLive,
    sources: {
      gold: goldSilver ? 'alpha_vantage' : 'fallback',
      btc:  btcRaw     ? 'alpha_vantage' : 'fallback',
      cpi:  cpiRaw     ? 'fred' : (cpiAV ? 'alpha_vantage' : 'fallback'),
      m2:   m2Raw      ? 'fred' : (m2AV  ? 'alpha_vantage' : 'fallback'),
      hpi:  hpiRaw     ? 'fred' : 'fallback',
      dxy:  dxyLive    ? 'frankfurter' : 'fallback',
    }
  };

  const outPath = path.join(process.cwd(), 'docs', 'data', 'data.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));

  console.log('\n=== Summary ===');
  console.log('Sources:', data.sources);
  console.log(`Gold:    ${data.goldSilver?.gold ?? 'fallback'}`);
  console.log(`Silver:  ${data.goldSilver?.silver ?? 'fallback'}`);
  console.log(`BTC pts: ${data.btcRaw?.length ?? 0}`);
  console.log(`CPI pts: ${data.cpiRaw?.length ?? 0}`);
  console.log(`M2 pts:  ${data.m2Raw?.length ?? 0}`);
  console.log(`HPI pts: ${data.hpiRaw?.length ?? 0}`);
  console.log(`DXY:     ${data.dxyLive?.value ?? 'fallback'}`);
}

main().catch(e => { console.error(e); process.exit(1); });

