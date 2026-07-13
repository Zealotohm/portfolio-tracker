import { isAuthed, unauthorized } from "./lib/auth.js";
import {
  getPortfolios,
  savePortfolios,
  getTransactions,
  saveTransactions,
  getAllTransactions,
  getPriceCache,
  savePriceCache,
  getFxCache,
  saveFxCache,
  getSecFundDirectory,
  saveSecFundDirectory,
  getSettings,
  saveSettings,
  getPriceHistory,
  savePriceHistory,
  uid,
} from "./lib/storage.js";
import { refreshAllPrices, fetchFxRate } from "./lib/priceProviders.js";
import { computePositions, buildSummary } from "./lib/calc.js";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });
}

// Collect every distinct symbol/assetType/currency across all portfolios, for price+fx refresh.
function collectHoldings(allTx) {
  const map = new Map();
  const currencies = new Set();
  for (const list of Object.values(allTx)) {
    for (const tx of list) {
      currencies.add(tx.currency);
      if (!map.has(tx.symbol)) {
        map.set(tx.symbol, { symbol: tx.symbol, assetType: tx.assetType });
      }
    }
  }
  return { holdings: Array.from(map.values()), currencies: Array.from(currencies) };
}

// Merges freshly-fetched quotes into the { [symbol]: [{date, price, currency}] } history
// archive: one entry per symbol per date (a later fetch for the same date overwrites it),
// kept sorted ascending and capped so the file doesn't grow unbounded.
function mergePriceHistory(history, priceCache) {
  const next = { ...history };
  for (const [symbol, quote] of Object.entries(priceCache)) {
    if (!quote || quote.price == null || !quote.date || quote.source === "history") continue;
    const series = [...(next[symbol] || [])];
    const idx = series.findIndex((e) => e.date === quote.date);
    const entry = { date: quote.date, price: quote.price, currency: quote.currency };
    if (idx >= 0) series[idx] = entry;
    else series.push(entry);
    series.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    next[symbol] = series.slice(-500);
  }
  return next;
}

async function refreshPricesAndFx(env) {
  const bucket = env.DATA_BUCKET;
  const allTx = await getAllTransactions(bucket);
  const { holdings, currencies } = collectHoldings(allTx);

  const priceCache = await getPriceCache(bucket);
  const secDirectory = await getSecFundDirectory(bucket);
  const priceHistory = await getPriceHistory(bucket);
  const { cache: updatedPriceCache, failures } = await refreshAllPrices(
    holdings,
    priceCache,
    env.SEC_API_KEY,
    secDirectory,
    (rebuilt) => saveSecFundDirectory(bucket, rebuilt),
    priceHistory
  );
  await savePriceCache(bucket, updatedPriceCache);
  await savePriceHistory(bucket, mergePriceHistory(priceHistory, updatedPriceCache));

  // Build fx rates needed: every holding currency -> base, and every quote currency -> base
  const base = env.BASE_CURRENCY || "USD";
  const quoteCurrencies = new Set(currencies);
  for (const q of Object.values(updatedPriceCache)) if (q?.currency) quoteCurrencies.add(q.currency);

  const fxCache = await getFxCache(bucket);
  const rates = { ...(fxCache.rates || {}) };
  const fxFailures = [];
  for (const ccy of quoteCurrencies) {
    if (ccy === base) continue;
    try {
      const rate = await fetchFxRate(ccy, base);
      if (rate != null) rates[`${ccy}${base}`] = rate;
      else fxFailures.push(ccy);
    } catch (e) {
      console.error("fx fetch failed", ccy, base, e);
      fxFailures.push(ccy);
    }
  }
  await saveFxCache(bucket, { rates, updatedAt: new Date().toISOString() });

  return {
    priceCache: updatedPriceCache,
    fx: { rates, updatedAt: new Date().toISOString() },
    failedSymbols: failures,
    failedCurrencies: fxFailures,
  };
}

// Gather a portfolio + all its descendant sub-portfolios' transactions into one flat list.
async function getTransactionsIncludingChildren(bucket, portfolioId, allPortfolios) {
  const idsToInclude = new Set([portfolioId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of allPortfolios) {
      if (p.parentId && idsToInclude.has(p.parentId) && !idsToInclude.has(p.id)) {
        idsToInclude.add(p.id);
        changed = true;
      }
    }
  }
  const all = [];
  for (const id of idsToInclude) {
    const tx = await getTransactions(bucket, id);
    all.push(...tx);
  }
  return all;
}

const routes = [
  {
    method: "POST",
    pattern: /^\/api\/login$/,
    handler: async (req, env) => {
      const body = await req.json().catch(() => ({}));
      if (!env.APP_PASSWORD || body.password === env.APP_PASSWORD) {
        return json({ ok: true });
      }
      return json({ ok: false }, { status: 401 });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/portfolios$/,
    handler: async (req, env) => json(await getPortfolios(env.DATA_BUCKET)),
  },
  {
    method: "POST",
    pattern: /^\/api\/portfolios$/,
    handler: async (req, env) => {
      const body = await req.json();
      const list = await getPortfolios(env.DATA_BUCKET);
      const portfolio = {
        id: uid(),
        name: body.name || "Untitled",
        parentId: body.parentId || null,
        createdAt: new Date().toISOString(),
      };
      list.push(portfolio);
      await savePortfolios(env.DATA_BUCKET, list);
      return json(portfolio, { status: 201 });
    },
  },
  {
    method: "PUT",
    pattern: /^\/api\/portfolios\/([^/]+)$/,
    handler: async (req, env, [id]) => {
      const body = await req.json();
      const list = await getPortfolios(env.DATA_BUCKET);
      const idx = list.findIndex((p) => p.id === id);
      if (idx === -1) return json({ error: "not found" }, { status: 404 });

      const newParentId = body.parentId !== undefined ? body.parentId || null : list[idx].parentId;
      if (newParentId === id) return json({ error: "portfolio ไม่สามารถเป็น parent ของตัวเองได้" }, { status: 400 });
      // prevent creating a cycle (setting parent to one of its own descendants)
      let cursor = newParentId;
      while (cursor) {
        if (cursor === id) return json({ error: "ไม่สามารถย้ายไปอยู่ใต้ sub-portfolio ของตัวเองได้" }, { status: 400 });
        const parent = list.find((p) => p.id === cursor);
        cursor = parent ? parent.parentId : null;
      }

      list[idx] = {
        ...list[idx],
        name: body.name !== undefined ? body.name : list[idx].name,
        parentId: newParentId,
      };
      await savePortfolios(env.DATA_BUCKET, list);
      return json(list[idx]);
    },
  },
  {
    method: "DELETE",
    pattern: /^\/api\/portfolios\/([^/]+)$/,
    handler: async (req, env, [id]) => {
      const list = await getPortfolios(env.DATA_BUCKET);
      const hasChildren = list.some((p) => p.parentId === id);
      if (hasChildren) return json({ error: "ลบไม่ได้: มี sub-portfolio อยู่ข้างใน" }, { status: 400 });
      const filtered = list.filter((p) => p.id !== id);
      await savePortfolios(env.DATA_BUCKET, filtered);
      await env.DATA_BUCKET.delete(`portfolios/${id}/transactions.json`);
      return json({ ok: true });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/transactions\/([^/]+)$/,
    handler: async (req, env, [portfolioId]) => json(await getTransactions(env.DATA_BUCKET, portfolioId)),
  },
  {
    method: "POST",
    pattern: /^\/api\/transactions\/([^/]+)$/,
    handler: async (req, env, [portfolioId]) => {
      const body = await req.json();
      const list = await getTransactions(env.DATA_BUCKET, portfolioId);
      const tx = {
        id: uid(),
        date: body.date,
        type: body.type, // buy | sell | dividend
        symbol: body.symbol,
        assetType: body.assetType, // stock | etf | fund | crypto
        quantity: Number(body.quantity),
        price: Number(body.price),
        currency: body.currency,
        fees: Number(body.fees || 0),
        note: body.note || "",
        createdAt: new Date().toISOString(),
      };
      list.push(tx);
      await saveTransactions(env.DATA_BUCKET, portfolioId, list);
      return json(tx, { status: 201 });
    },
  },
  {
    method: "PUT",
    pattern: /^\/api\/transactions\/([^/]+)\/([^/]+)$/,
    handler: async (req, env, [portfolioId, txId]) => {
      const body = await req.json();
      const list = await getTransactions(env.DATA_BUCKET, portfolioId);
      const idx = list.findIndex((t) => t.id === txId);
      if (idx === -1) return json({ error: "not found" }, { status: 404 });
      // Coerce the same fields POST does - the edit form sends these as strings (HTML input
      // values), and leaving them uncoerced corrupts computePositions()'s arithmetic (JS's `+`
      // does string concatenation, not addition, once any operand is a string).
      list[idx] = {
        ...list[idx],
        ...body,
        id: txId,
        quantity: body.quantity !== undefined ? Number(body.quantity) : list[idx].quantity,
        price: body.price !== undefined ? Number(body.price) : list[idx].price,
        fees: body.fees !== undefined ? Number(body.fees) : list[idx].fees,
      };
      await saveTransactions(env.DATA_BUCKET, portfolioId, list);
      return json(list[idx]);
    },
  },
  {
    method: "DELETE",
    pattern: /^\/api\/transactions\/([^/]+)\/([^/]+)$/,
    handler: async (req, env, [portfolioId, txId]) => {
      const list = await getTransactions(env.DATA_BUCKET, portfolioId);
      const filtered = list.filter((t) => t.id !== txId);
      await saveTransactions(env.DATA_BUCKET, portfolioId, filtered);
      return json({ ok: true });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/summary\/([^/]+)$/,
    handler: async (req, env, [portfolioId]) => {
      const bucket = env.DATA_BUCKET;
      const allPortfolios = await getPortfolios(bucket);
      const url = new URL(req.url);
      const includeSub = url.searchParams.get("includeSub") !== "false";

      const transactions = includeSub
        ? await getTransactionsIncludingChildren(bucket, portfolioId, allPortfolios)
        : await getTransactions(bucket, portfolioId);

      const positions = computePositions(transactions);
      const priceCache = await getPriceCache(bucket);
      const fxCache = await getFxCache(bucket);
      const base = env.BASE_CURRENCY || "USD";
      const summary = buildSummary(positions, priceCache, fxCache.rates || {}, base);
      return json({ ...summary, priceUpdatedAt: fxCache.updatedAt });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/summary-all$/,
    // Overview across every top-level portfolio, for the "all portfolios" dashboard view
    handler: async (req, env) => {
      const bucket = env.DATA_BUCKET;
      const allTx = await getAllTransactions(bucket);
      const flat = Object.values(allTx).flat();
      const positions = computePositions(flat);
      const priceCache = await getPriceCache(bucket);
      const fxCache = await getFxCache(bucket);
      const base = env.BASE_CURRENCY || "USD";
      const summary = buildSummary(positions, priceCache, fxCache.rates || {}, base);
      return json({ ...summary, priceUpdatedAt: fxCache.updatedAt });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/refresh-prices$/,
    handler: async (req, env) => json(await refreshPricesAndFx(env)),
  },
  {
    method: "GET",
    pattern: /^\/api\/prices$/,
    handler: async (req, env) => {
      const priceCache = await getPriceCache(env.DATA_BUCKET);
      const fxCache = await getFxCache(env.DATA_BUCKET);
      return json({ prices: priceCache, fx: fxCache });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/settings$/,
    handler: async (req, env) => json(await getSettings(env.DATA_BUCKET)),
  },
  {
    method: "PUT",
    pattern: /^\/api\/settings$/,
    handler: async (req, env) => {
      const body = await req.json();
      const current = await getSettings(env.DATA_BUCKET);
      const updated = { ...current, appName: body.appName?.trim() || current.appName };
      await saveSettings(env.DATA_BUCKET, updated);
      return json(updated);
    },
  },
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      // Settings are exposed read-only pre-login too, since the login screen shows the app name.
      const isPublicRoute =
        url.pathname === "/api/login" || (url.pathname === "/api/settings" && request.method === "GET");
      if (!isPublicRoute && !isAuthed(request, env)) {
        return unauthorized();
      }
      for (const route of routes) {
        if (route.method === request.method) {
          const match = url.pathname.match(route.pattern);
          if (match) {
            try {
              return await route.handler(request, env, match.slice(1));
            } catch (e) {
              console.error(e);
              return json({ error: e.message || "internal error" }, { status: 500 });
            }
          }
        }
      }
      return json({ error: "not found" }, { status: 404 });
    }

    // Everything else -> static frontend
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshPricesAndFx(env));
  },
};
