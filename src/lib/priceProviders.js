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
// Docs: https://secopendata.sec.or.th/sec-open-apis  (product group: fund)
// Endpoint: GET https://api.sec.or.th/v2/fund/daily-info/nav
// Auth: header "Ocp-Apim-Subscription-Key: <key>"
// `symbol` for a Thai fund must be its SEC proj_id (project id, format like "M0001_2560"),
// NOT its trading name (e.g. "KFINDIARMF") - the SEC API is indexed by proj_id.
// You can look up a fund's proj_id via the SEC/AIMC mutual fund search:
// https://www.thaimutualfund.com/AIMC/mutualFundCenter.jsp
const SEC_BASE = "https://api.sec.or.th";

export async function fetchSecFundNav(projId, apiKey) {
  if (!apiKey) throw new Error("SEC_API_KEY ยังไม่ได้ตั้งค่า (wrangler secret put SEC_API_KEY)");
  const url = `${SEC_BASE}/v2/fund/daily-info/nav?proj_id=${encodeURIComponent(projId)}&latest=true`;
  const res = await fetch(url, { headers: { "Ocp-Apim-Subscription-Key": apiKey } });
  if (!res.ok) throw new Error(`SEC NAV fetch failed for ${projId}: ${res.status}`);
  const data = await res.json();

  // The public spec for this endpoint's exact response shape isn't fully documented,
  // so we defensively handle a few plausible shapes/field names here.
  const record = Array.isArray(data?.data) ? data.data[0] : Array.isArray(data) ? data[0] : data;
  const nav = record?.last_val ?? record?.sell_price ?? record?.nav ?? record?.value;
  if (nav == null) {
    throw new Error(
      `SEC NAV response for ${projId} ไม่มี field ราคาที่รู้จัก (${JSON.stringify(record)}) — ` +
        `อาจต้องแก้ชื่อ field ใน fetchSecFundNav() ให้ตรงกับ response จริง`
    );
  }
  return {
    symbol: projId,
    price: Number(nav),
    currency: "THB",
    name: record?.proj_name_th || record?.proj_name_en || projId,
    updatedAt: new Date().toISOString(),
    source: "sec",
  };
}

// Refresh every tracked symbol and return the updated cache plus any symbols that failed
// to fetch (so the caller/UI can flag stale prices instead of silently keeping old data).
export async function refreshAllPrices(holdings, existingCache, secApiKey) {
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

  // Thai mutual funds via SEC Open API (one call per fund; no public batch endpoint)
  for (const h of thaiFunds) {
    try {
      cache[h.symbol] = await fetchSecFundNav(h.symbol, secApiKey);
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
