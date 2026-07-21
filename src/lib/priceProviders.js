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
  const date = meta.regularMarketTime
    ? new Date(meta.regularMarketTime * 1000).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  return {
    symbol,
    price: meta.regularMarketPrice,
    currency: meta.currency,
    name: meta.longName || meta.shortName || symbol,
    date,
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
  const today = new Date().toISOString().slice(0, 10);
  for (const id of ids) {
    if (data[id]) {
      out[id] = {
        symbol: id,
        price: data[id][vsCurrency],
        currency: vsCurrency.toUpperCase(),
        name: id,
        date: today,
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

// Brokers often display a fund's trading symbol with a share-class marker glued on
// (e.g. "SCBSEMI(A)", "KFAEQ-THAIESGX-L", "SCBTAPX(LTFA)") that isn't part of the base name
// SEC's own database searches against - only the underlying project's proj_abbr_name is. This
// generates progressively shorter candidates by stripping trailing class markers, so the base
// project can still be found even when the exact decorated string can't be.
function symbolSearchCandidates(symbol) {
  const candidates = [symbol];
  const parenMatch = symbol.match(/^(.*?)\s*\([^)]*\)\s*$/);
  if (parenMatch && parenMatch[1]) candidates.push(parenMatch[1].trim());
  let base = symbol;
  while (base.includes("-")) {
    base = base.slice(0, base.lastIndexOf("-")).trim();
    if (base) candidates.push(base);
  }
  return [...new Set(candidates)].filter(Boolean);
}

// Last-resort candidate for a single share-class letter glued directly onto the name with no
// delimiter (e.g. "SCBCHAA" = "SCBCHA" + "A" for Accumulation). Riskier than the delimited
// cases above since we can't tell "a real trailing letter" from "a class marker" - only tried
// after every safer candidate has failed, one letter at a time.
function glueLetterCandidate(symbol) {
  if (symbol.length > 4 && /[A-Za-z]$/.test(symbol)) return symbol.slice(0, -1);
  return null;
}

// Searches one candidate term and picks the best project match from the results, requiring an
// exact proj_abbr_name match when `requireExactAbbr` is set (used for the riskier glued-letter
// fallback, where a loose partial match is too likely to be a wrong fund entirely).
async function searchSecProject(term, apiKey, { requireExactAbbr } = {}) {
  const data = await secGet(`/v2/fund/general-info/profiles?project_info=${encodeURIComponent(term)}&page_size=50`, apiKey);
  const items = data?.items || [];
  if (items.length === 0) return null;

  const target = term.trim().toUpperCase();
  const exactMatches = items.filter((f) => (f.proj_abbr_name || "").toUpperCase() === target);
  if (requireExactAbbr && exactMatches.length === 0) return null;
  // A trading name can be reused after a fund is reorganized/renamed, leaving old Canceled/
  // Liquidated registrations in the search results alongside the current one - prefer the
  // still-Registered project so we don't pick a defunct proj_id.
  const pool = exactMatches.length > 0 ? exactMatches : items;
  const best = pool.find((f) => f.fund_status === "Registered") || pool[0];
  return best ? { best, items } : null;
}

// Returns { projId, fundClassName } (fundClassName is null when the match was unambiguous or a
// specific class couldn't be pinned down) or null if nothing in SEC's database matches at all.
export async function resolveSecProjId(symbol, apiKey) {
  if (looksLikeProjId(symbol)) return { projId: symbol, fundClassName: null };
  if (!apiKey) throw new Error("SEC_API_KEY ยังไม่ได้ตั้งค่า (wrangler secret put SEC_API_KEY)");

  const attempt = async (term) => {
    const found = await searchSecProject(term, apiKey);
    if (!found) return null;
    const { best, items } = found;
    // If this project has multiple share classes and the original (undecorated) symbol hints
    // at which one, try to match it; otherwise leave fundClassName null and let fetchSecFundNav
    // fall back to the plain/"main" class.
    const classCandidates = items.filter((f) => f.proj_id === best.proj_id);
    const decoratedTarget = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const classMatch = classCandidates.find((f) => {
      const cls = (f.fund_class_name || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      return cls && cls !== "MAIN" && decoratedTarget.endsWith(cls);
    });
    return { projId: best.proj_id, fundClassName: classMatch?.fund_class_name || null };
  };

  for (const term of symbolSearchCandidates(symbol)) {
    const result = await attempt(term);
    if (result) return result;
  }

  const glued = glueLetterCandidate(symbol);
  if (glued) {
    const found = await searchSecProject(glued, apiKey, { requireExactAbbr: true });
    if (found) return { projId: found.best.proj_id, fundClassName: null };
  }

  return null;
}

export async function fetchSecFundNav(projId, apiKey, fundClassName = null) {
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

  // If a specific share class was identified (e.g. from a decorated symbol like "...(A)"), use
  // that class's NAV; otherwise prefer the plain/"main" class, then take the newest date.
  const preferred = fundClassName
    ? items.filter((i) => i.fund_class_name === fundClassName)
    : items.filter((i) => !i.fund_class_name || ["main", "-"].includes(i.fund_class_name));
  const pool = preferred.length > 0 ? preferred : items;
  const latest = pool.reduce((a, b) => (a.nav_date > b.nav_date ? a : b));

  return {
    symbol: projId,
    price: Number(latest.last_val),
    currency: "THB",
    name: projId,
    date: latest.nav_date,
    updatedAt: new Date().toISOString(),
    source: "sec",
  };
}

// ---- ThaiFundsToday (unofficial, no key required) ----
// A second, independent Thai fund NAV source (api.thaifundstoday.com), used alongside SEC's
// Open API so we can compare freshness and use whichever actually has the newer NAV date -
// some AMCs report to one faster than the other. Confirmed working and unauthenticated:
//   GET /api/v3/funds/search?q=<symbol>  -> [{symbol, slug, name, ...}], exact symbol match
//   GET /api/v3/funds/<slug>             -> {fund: {performance: {price, last_updated}}}
// Unlike SEC, this handles decorated symbols (e.g. "SCBS&P500A", "SCBCHAA") as literal exact
// matches with no stripping/guessing needed - it's a third-party site (not a regulator), so
// treat it as a freshness cross-check rather than the sole source of truth.
const TFT_BASE = "https://api.thaifundstoday.com/api/v3";

async function tftGet(path) {
  const res = await fetch(`${TFT_BASE}${path}`, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`ThaiFundsToday ${path} -> ${res.status}`);
  return res.json();
}

export async function resolveThaiFundsTodaySlug(symbol) {
  const data = await tftGet(`/funds/search?q=${encodeURIComponent(symbol)}`);
  const funds = data?.funds || [];
  const target = symbol.trim().toUpperCase();
  const match = funds.find((f) => (f.symbol || "").toUpperCase() === target);
  return match?.slug || null;
}

export async function fetchThaiFundsTodayNav(slug) {
  const data = await tftGet(`/funds/${encodeURIComponent(slug)}`);
  const perf = data?.fund?.performance;
  const props = data?.fund?.properties;
  if (!perf || perf.price == null || !perf.last_updated) {
    throw new Error(`ThaiFundsToday: ไม่มีข้อมูลราคาสำหรับ ${slug}`);
  }
  return {
    symbol: props?.symbol || slug,
    price: Number(perf.price),
    currency: "THB",
    name: props?.name || slug,
    date: perf.last_updated,
    updatedAt: new Date().toISOString(),
    source: "thaifundstoday",
  };
}

// Refresh every tracked symbol and return the updated cache plus any symbols that failed
// to fetch (so the caller/UI can flag stale prices instead of silently keeping old data).
// `secDirectory` is the cached { byAbbr: { SYMBOL: proj_id } } map from storage.js;
// `onDirectoryUpdate` persists it whenever a new symbol gets resolved, so future refreshes
// skip the name-search call for symbols we've already looked up. `priceHistory` is the
// { [symbol]: [{date, price, currency}] } archive from storage.js: when a symbol fails outright
// (e.g. a fund's NAV hasn't been published yet, or a provider is briefly down), we fall back to
// its most recent historical entry instead of showing nothing.
export async function refreshAllPrices(
  holdings,
  existingCache,
  secApiKey,
  secDirectory,
  onDirectoryUpdate,
  priceHistory = {},
  tftDirectory,
  onTftDirectoryUpdate
) {
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

  // Thai mutual funds: query SEC's Open API (authoritative regulator data) and ThaiFundsToday
  // (an independent third-party source) in parallel, and keep whichever NAV date is newer -
  // some AMCs publish to one faster than the other, and this also lets ThaiFundsToday fill in
  // for the handful of funds whose decorated symbol never resolves against SEC's database.
  const directory = { byAbbr: { ...(secDirectory?.byAbbr || {}) } };
  let directoryChanged = false;
  const tftDir = { byAbbr: { ...(tftDirectory?.byAbbr || {}) } };
  let tftDirChanged = false;

  const fetchFromSec = async (h) => {
    const key = h.symbol.trim().toUpperCase();
    let resolved = directory.byAbbr[key];
    if (typeof resolved === "string") resolved = { projId: resolved, fundClassName: null }; // old cache shape

    // A cached "unresolved" marker (with a cooldown) means don't burn subrequests re-running
    // the multi-candidate search every single refresh for a symbol that's never found anyway -
    // Workers has a per-invocation subrequest cap, and a growing portfolio adds up fast.
    const onCooldown =
      resolved?.unresolved && Date.now() - new Date(resolved.checkedAt).getTime() < 24 * 60 * 60 * 1000;
    if (resolved?.unresolved && !onCooldown) resolved = null;

    if (!resolved) {
      const found = await resolveSecProjId(h.symbol, secApiKey);
      resolved = found || { unresolved: true, checkedAt: new Date().toISOString() };
      directory.byAbbr[key] = resolved;
      directoryChanged = true;
    }
    if (!resolved.projId) return null;
    return fetchSecFundNav(resolved.projId, secApiKey, resolved.fundClassName);
  };

  const fetchFromTft = async (h) => {
    const key = h.symbol.trim().toUpperCase();
    let slug = tftDir.byAbbr[key];
    // Unlike SEC's directory, an unresolved slug has no cooldown - the search call is cheap and
    // reliable enough that it's fine to just cache "null" permanently once tried.
    if (slug === undefined) {
      slug = (await resolveThaiFundsTodaySlug(h.symbol)) || null;
      tftDir.byAbbr[key] = slug;
      tftDirChanged = true;
    }
    if (!slug) return null;
    return fetchThaiFundsTodayNav(slug);
  };

  for (const h of thaiFunds) {
    const [secResult, tftResult] = await Promise.allSettled([fetchFromSec(h), fetchFromTft(h)]);
    const secQuote = secResult.status === "fulfilled" ? secResult.value : null;
    const tftQuote = tftResult.status === "fulfilled" ? tftResult.value : null;
    if (secResult.status === "rejected") console.error("SEC NAV refresh failed for", h.symbol, secResult.reason);
    if (tftResult.status === "rejected") console.error("ThaiFundsToday refresh failed for", h.symbol, tftResult.reason);

    if (!secQuote && !tftQuote) {
      failures.push(h.symbol);
      continue;
    }
    // Prefer whichever has the newer NAV date; SEC wins ties as the authoritative source.
    const best = !tftQuote || (secQuote && secQuote.date >= tftQuote.date) ? secQuote : tftQuote;
    cache[h.symbol] = best;
  }
  if (directoryChanged && onDirectoryUpdate) {
    await onDirectoryUpdate({ byAbbr: directory.byAbbr, updatedAt: new Date().toISOString() });
  }
  if (tftDirChanged && onTftDirectoryUpdate) {
    await onTftDirectoryUpdate({ byAbbr: tftDir.byAbbr, updatedAt: new Date().toISOString() });
  }

  // Stocks/ETF/global funds one call each (Yahoo has no clean batch endpoint on the public chart API)
  for (const h of others) {
    try {
      const quote = await fetchYahooQuote(h.symbol);
      // A bare ticker without its exchange suffix (e.g. a Thai stock entered as "SAT" instead of
      // "SAT.BK") can silently collide with an unrelated stock on another exchange - Yahoo just
      // returns that instead of erroring. If the user's declared transaction currency doesn't
      // match what came back, it's almost certainly the wrong company, so reject it rather than
      // showing a confidently wrong price.
      if (h.currency && quote.currency && h.currency.toUpperCase() !== quote.currency.toUpperCase()) {
        throw new Error(
          `Yahoo ส่งราคากลับมาเป็น ${quote.currency} แต่ transaction ระบุสกุลเงิน ${h.currency} - ` +
            `ticker "${h.symbol}" อาจชนกับหุ้นตลาดอื่น (เช่น หุ้นไทยต้องมี .BK ต่อท้าย เช่น SAT.BK)`
        );
      }
      cache[h.symbol] = quote;
    } catch (e) {
      console.error("yahoo refresh failed for", h.symbol, e);
      failures.push(h.symbol);
    }
  }

  // If a symbol failed outright and we have no usable cached quote for it at all, fall back to
  // the most recent historical price rather than showing nothing.
  for (const symbol of failures) {
    if (cache[symbol]) continue;
    const hist = priceHistory[symbol];
    if (hist && hist.length > 0) {
      const last = hist[hist.length - 1];
      cache[symbol] = { symbol, price: last.price, currency: last.currency, name: symbol, date: last.date, updatedAt: new Date().toISOString(), source: "history", stale: true };
    }
  }

  return { cache, failures };
}
