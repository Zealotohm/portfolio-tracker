// Free data sources (no API key required):
//  - Stocks / ETFs / mutual funds -> Yahoo Finance "chart" endpoint (unofficial, works for most
//    global exchanges when the ticker includes the Yahoo suffix, e.g. AAPL, VOO, PTT.BK, 0700.HK, VOD.L)
//  - Crypto -> CoinGecko public API (symbol must be the CoinGecko "id", e.g. bitcoin, ethereum)
//  - FX conversion -> Frankfurter.app (ECB rates, free, no key)
//
// NOTE: these free endpoints have rate limits. The Worker caches results in R2 (see storage.js)
// and only a daily cron + manual "Refresh" button trigger new fetches, keeping usage well within limits.

const YAHOO_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
};

export async function fetchYahooQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?interval=1d&range=1d`;
  const res = await fetch(url, { headers: YAHOO_HEADERS });
  if (!res.ok) throw new Error(`Yahoo fetch failed for ${symbol}: ${res.status}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`No data for symbol ${symbol}`);
  const meta = result.meta;
  return {
    symbol,
    price: meta.regularMarketPrice,
    currency: meta.currency,
    name: meta.longName || meta.shortName || symbol,
    updatedAt: new Date().toISOString(),
    source: "yahoo",
  };
}

export async function fetchCoingeckoQuotes(ids, vsCurrency = "usd") {
  if (ids.length === 0) return {};
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(
    ids.join(",")
  )}&vs_currencies=${vsCurrency}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko fetch failed: ${res.status}`);
  const data = await res.json();
  const out = {};
  for (const id of ids) {
    if (data[id]) {
      out[id] = {
        symbol: id,
        price: data[id][vsCurrency],
        currency: vsCurrency.toUpperCase(),
        name: id,
        updatedAt: new Date().toISOString(),
        source: "coingecko",
      };
    }
  }
  return out;
}

export async function fetchFxRate(from, to) {
  if (from === to) return 1;
  const url = `https://api.frankfurter.app/latest?from=${from}&to=${to}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FX fetch failed: ${from}->${to}`);
  const data = await res.json();
  return data.rates?.[to];
}

// ---- SEC Thailand Open Data API (fund NAV) ----
// Docs: https://api-portal.sec.or.th (products: "Fund Factsheet API", "Fund Daily Info API")
// Auth: header "Ocp-Apim-Subscription-Key: <key>" on every request.
//
// Two things investors don't know up front but the API requires:
// 1. NAV lookups are indexed by proj_id (e.g. "M0076_2561"), not the fund's trading name
//    (e.g. "KFINDIARMF") that appears everywhere else (Settrade, AMC sites, statements).
// 2. The NAV endpoint is date-specific (no "give me the latest" shortcut) and returns 204
//    on non-trading days (weekends/holidays), so the caller must walk backward from today.
//
// To keep the UX the same as every other asset type (type the ticker you already know),
// resolveSecProjId() below builds a name -> proj_id directory once (via the AMC + fund-list
// endpoints) and caches it, so callers can keep using the trading name.
const SEC_BASE = "https://api.sec.or.th";

function secHeaders(apiKey) {
  return { "Ocp-Apim-Subscription-Key": apiKey };
}

// Builds a fresh { byAbbr: { "KFINDIARMF": "M0076_2561", ... }, updatedAt } directory by
// walking every AMC's fund list. Costs ~20-30 subrequests, so callers should cache the result
// (see storage.js getSecFundDirectory/saveSecFundDirectory) and only rebuild occasionally.
export async function buildSecFundDirectory(apiKey) {
  if (!apiKey) throw new Error("SEC_API_KEY ยังไม่ได้ตั้งค่า (wrangler secret put SEC_API_KEY)");
  const headers = secHeaders(apiKey);

  const amcRes = await fetch(`${SEC_BASE}/FundFactsheet/fund/amc`, { headers });
  if (!amcRes.ok) throw new Error(`SEC amc list fetch failed: ${amcRes.status}`);
  const amcList = await amcRes.json();

  const byAbbr = {};
  const fundLists = await Promise.all(
    amcList.map((amc) =>
      fetch(`${SEC_BASE}/FundFactsheet/fund/amc/${amc.unique_id}`, { headers })
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => [])
    )
  );
  for (const funds of fundLists) {
    for (const f of funds || []) {
      if (f.proj_abbr_name && f.proj_id) byAbbr[f.proj_abbr_name.toUpperCase()] = f.proj_id;
    }
  }
  return { byAbbr, updatedAt: new Date().toISOString() };
}

// A proj_id already looks like "M0076_2561" - letter + digits + underscore + year.
// If the stored symbol already matches that shape, use it directly (skips directory lookup).
function looksLikeProjId(symbol) {
  return /^[A-Za-z]?\d{3,6}_\d{4}$/.test(symbol);
}

export async function resolveSecProjId(symbol, directory) {
  if (looksLikeProjId(symbol)) return symbol;
  return directory.byAbbr[symbol.toUpperCase()] || null;
}

export async function fetchSecFundNav(projId, apiKey) {
  if (!apiKey) throw new Error("SEC_API_KEY ยังไม่ได้ตั้งค่า (wrangler secret put SEC_API_KEY)");
  const headers = secHeaders(apiKey);
  let lastStatus = null;
  let lastBody = "";

  // NAV is published per trading day only; walk back up to 10 days to skip weekends/holidays.
  for (let daysBack = 0; daysBack <= 10; daysBack++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - daysBack);
    const dateStr = d.toISOString().slice(0, 10);
    const res = await fetch(`${SEC_BASE}/FundDailyInfo/${encodeURIComponent(projId)}/dailynav/${dateStr}`, {
      headers,
    });
    if (res.status === 204) continue; // no NAV published for this date, try an earlier day
    if (!res.ok) {
      lastStatus = res.status;
      lastBody = await res.text().catch(() => "");
      continue;
    }
    const data = await res.json();
    const record = Array.isArray(data) ? data[0] : data;
    const nav = record?.last_val ?? record?.sell_price ?? record?.nav ?? record?.value;
    if (nav == null) continue;
    return {
      symbol: projId,
      price: Number(nav),
      currency: "THB",
      name: record?.proj_name_th || record?.proj_name_en || projId,
      updatedAt: new Date().toISOString(),
      source: "sec",
    };
  }
  throw new Error(
    lastStatus != null
      ? `SEC dailynav fetch failed for ${projId}: ${lastStatus} ${lastBody.slice(0, 200)}`
      : `SEC ไม่มี NAV ของ ${projId} ในช่วง 10 วันล่าสุด`
  );
}

// Refresh every tracked symbol and return the updated cache plus any symbols that failed
// to fetch (so the caller/UI can flag stale prices instead of silently keeping old data).
// `secDirectory` is the cached name->proj_id map from storage.js; `onDirectoryStale` is called
// (at most once) if a Thai fund symbol can't be resolved, so the caller can rebuild and retry.
export async function refreshAllPrices(holdings, existingCache, secApiKey, secDirectory, onDirectoryStale) {
  const cache = { ...existingCache };
  const failures = [];
  const cryptoIds = holdings.filter((h) => h.assetType === "crypto").map((h) => h.symbol);
  const thaiFunds = holdings.filter((h) => h.assetType === "thai_fund");
  const others = holdings.filter((h) => h.assetType !== "crypto" && h.assetType !== "thai_fund");

  // Crypto in one batched call
  try {
    const cryptoQuotes = await fetchCoingeckoQuotes(cryptoIds, "usd");
    Object.assign(cache, cryptoQuotes);
    for (const id of cryptoIds) if (!cryptoQuotes[id]) failures.push(id);
  } catch (e) {
    console.error("crypto refresh failed", e);
    failures.push(...cryptoIds);
  }

  // Thai mutual funds via SEC Open API: resolve each trading name to its proj_id first
  // (rebuilding the directory once if a symbol isn't found in the cached one), then fetch NAV.
  let directory = secDirectory;
  let rebuiltDirectory = false;
  for (const h of thaiFunds) {
    try {
      let projId = await resolveSecProjId(h.symbol, directory);
      if (!projId && !rebuiltDirectory) {
        rebuiltDirectory = true;
        directory = await buildSecFundDirectory(secApiKey);
        if (onDirectoryStale) await onDirectoryStale(directory);
        projId = await resolveSecProjId(h.symbol, directory);
      }
      if (!projId) {
        throw new Error(`ไม่พบกองทุน "${h.symbol}" ใน SEC fund directory - ตรวจสอบชื่อย่อกองทุนอีกครั้ง`);
      }
      cache[h.symbol] = await fetchSecFundNav(projId, secApiKey);
    } catch (e) {
      console.error("SEC NAV refresh failed for", h.symbol, e);
      failures.push(h.symbol);
    }
  }

  // Stocks/ETF/global funds one call each (Yahoo has no clean batch endpoint on the public chart API)
  for (const h of others) {
    try {
      cache[h.symbol] = await fetchYahooQuote(h.symbol);
    } catch (e) {
      console.error("yahoo refresh failed for", h.symbol, e);
      failures.push(h.symbol);
    }
  }

  return { cache, failures };
}
