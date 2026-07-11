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
// Docs: https://secopendata.sec.or.th (product group "Fund", base host api.sec.or.th)
// Auth: header "Ocp-Apim-Subscription-Key: <key>" on every request.
// Confirmed against the current published spec (categories/fund.json):
//   GET /v2/fund/general-info/profiles?project_info=<name-or-proj_id>  -> fund profiles,
//     `project_info` does an exact match on proj_id and a partial match on proj_abbr_name /
//     proj_name_th / proj_name_en. This is how we resolve a trading name (e.g. "KFINDIARMF",
//     what investors actually recognize) to its proj_id (e.g. "M0076_2561", what NAV lookups
//     require) without needing a separate AMC-crawl product/subscription.
//   GET /v2/fund/daily-info/nav?proj_id=..&start_nav_date=..&end_nav_date=..  -> NAV history;
//     there is no "latest" flag, so we request a short trailing window and take the newest
//     item (skips weekends/holidays automatically since those dates just aren't in the result).
const SEC_BASE = "https://api.sec.or.th";

function secHeaders(apiKey) {
  return { "Ocp-Apim-Subscription-Key": apiKey };
}

async function secGet(path, apiKey) {
  const res = await fetch(`${SEC_BASE}${path}`, { headers: secHeaders(apiKey) });
  if (res.status === 204) return { items: [] }; // no matching records
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`SEC ${path} -> ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

// A proj_id already looks like "M0076_2561" - letter + digits + underscore + year.
// If the stored symbol already matches that shape, use it directly (skips the name search).
function looksLikeProjId(symbol) {
  return /^[A-Za-z]?\d{3,6}_\d{4}$/.test(symbol);
}

export async function resolveSecProjId(symbol, apiKey) {
  if (looksLikeProjId(symbol)) return symbol;
  if (!apiKey) throw new Error("SEC_API_KEY ยังไม่ได้ตั้งค่า (wrangler secret put SEC_API_KEY)");
  const data = await secGet(`/v2/fund/general-info/profiles?project_info=${encodeURIComponent(symbol)}&page_size=20`, apiKey);
  const items = data?.items || [];
  const target = symbol.trim().toUpperCase();
  const exactMatches = items.filter((f) => (f.proj_abbr_name || "").toUpperCase() === target);
  // A trading name can be reused after a fund is reorganized/renamed, leaving old Canceled/
  // Liquidated registrations in the search results alongside the current one - prefer the
  // still-Registered project so we don't pick a defunct proj_id.
  const best =
    exactMatches.find((f) => f.fund_status === "Registered") || exactMatches[0] || items[0];
  return best?.proj_id || null;
}

export async function fetchSecFundNav(projId, apiKey) {
  if (!apiKey) throw new Error("SEC_API_KEY ยังไม่ได้ตั้งค่า (wrangler secret put SEC_API_KEY)");
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 45); // some AMCs report to this dataset less frequently
  const startStr = start.toISOString().slice(0, 10);
  const endStr = end.toISOString().slice(0, 10);

  const data = await secGet(
    `/v2/fund/daily-info/nav?proj_id=${encodeURIComponent(projId)}&start_nav_date=${startStr}&end_nav_date=${endStr}&page_size=100`,
    apiKey
  );
  const items = data?.items || [];
  if (items.length === 0) {
    throw new Error(`SEC ไม่มี NAV ของ ${projId} ในช่วง ${startStr}..${endStr}`);
  }

  // Prefer the plain/"main" share class when a fund has multiple classes, then take the newest date.
  const preferred = items.filter((i) => !i.fund_class_name || ["main", "-"].includes(i.fund_class_name));
  const pool = preferred.length > 0 ? preferred : items;
  const latest = pool.reduce((a, b) => (a.nav_date > b.nav_date ? a : b));

  return {
    symbol: projId,
    price: Number(latest.last_val),
    currency: "THB",
    name: projId,
    updatedAt: new Date().toISOString(),
    source: "sec",
  };
}

// Refresh every tracked symbol and return the updated cache plus any symbols that failed
// to fetch (so the caller/UI can flag stale prices instead of silently keeping old data).
// `secDirectory` is the cached { byAbbr: { SYMBOL: proj_id } } map from storage.js;
// `onDirectoryUpdate` persists it whenever a new symbol gets resolved, so future refreshes
// skip the name-search call for symbols we've already looked up.
export async function refreshAllPrices(holdings, existingCache, secApiKey, secDirectory, onDirectoryUpdate) {
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

  // Thai mutual funds via SEC Open API: resolve each trading name to its proj_id (cached after
  // the first lookup), then fetch NAV.
  const directory = { byAbbr: { ...(secDirectory?.byAbbr || {}) } };
  let directoryChanged = false;
  for (const h of thaiFunds) {
    try {
      const key = h.symbol.trim().toUpperCase();
      let projId = looksLikeProjId(h.symbol) ? h.symbol : directory.byAbbr[key];
      if (!projId) {
        projId = await resolveSecProjId(h.symbol, secApiKey);
        if (projId) {
          directory.byAbbr[key] = projId;
          directoryChanged = true;
        }
      }
      if (!projId) {
        throw new Error(`ไม่พบกองทุน "${h.symbol}" ใน SEC (ลองค้นด้วยชื่อย่อกองทุน หรือใส่ proj_id โดยตรง)`);
      }
      cache[h.symbol] = await fetchSecFundNav(projId, secApiKey);
    } catch (e) {
      console.error("SEC NAV refresh failed for", h.symbol, e);
      failures.push(h.symbol);
    }
  }
  if (directoryChanged && onDirectoryUpdate) {
    await onDirectoryUpdate({ byAbbr: directory.byAbbr, updatedAt: new Date().toISOString() });
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
