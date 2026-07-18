import { requireAuth, unauthorized, createPasswordRecord, verifyPassword, createSessionToken } from "./lib/auth.js";
import {
  getPortfolios,
  savePortfolios,
  getTransactions,
  saveTransactions,
  deleteTransactions,
  getAllTransactions,
  getUsers,
  saveUsers,
  deleteAllUserData,
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

function publicUser(u) {
  return { id: u.id, username: u.username, role: u.role, createdAt: u.createdAt };
}

// Collect every distinct symbol/assetType/currency across a set of transactions, for price+fx
// refresh. `currency` here is the currency the user declared on their transactions - carried
// through so the price fetch can sanity-check the quote it gets back actually matches (see
// priceProviders.js).
function collectHoldings(allTx) {
  const map = new Map();
  const currencies = new Set();
  for (const list of Object.values(allTx)) {
    for (const tx of list) {
      currencies.add(tx.currency);
      if (!map.has(tx.symbol)) {
        map.set(tx.symbol, { symbol: tx.symbol, assetType: tx.assetType, currency: tx.currency });
      }
    }
  }
  return { holdings: Array.from(map.values()), currencies: Array.from(currencies) };
}

// The price/FX cache is shared across every user (market data doesn't depend on who's asking),
// so a refresh has to gather holdings across every user's portfolios, not just one.
async function collectAllUsersTransactions(bucket) {
  const users = await getUsers(bucket);
  const allTx = {};
  for (const u of users) {
    Object.assign(allTx, await getAllTransactions(bucket, u.id));
  }
  return allTx;
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
  const allTx = await collectAllUsersTransactions(bucket);
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
async function getTransactionsIncludingChildren(bucket, userId, portfolioId, allPortfolios) {
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
    const tx = await getTransactions(bucket, userId, id);
    all.push(...tx);
  }
  return all;
}

// One-time legacy migration: this app used to be single-tenant, storing portfolios/transactions
// under fixed global keys. The first bootstrapped admin inherits whatever's there.
async function migrateLegacyDataToUser(bucket, userId) {
  const legacy = await bucket.get("meta/portfolios.json");
  if (!legacy) return;
  const portfolios = await legacy.json().catch(() => []);
  if (!Array.isArray(portfolios) || portfolios.length === 0) {
    await bucket.delete("meta/portfolios.json");
    return;
  }
  await savePortfolios(bucket, userId, portfolios);
  for (const p of portfolios) {
    const legacyTx = await bucket.get(`portfolios/${p.id}/transactions.json`);
    if (!legacyTx) continue;
    const list = await legacyTx.json().catch(() => []);
    await saveTransactions(bucket, userId, p.id, list);
    await bucket.delete(`portfolios/${p.id}/transactions.json`);
  }
  await bucket.delete("meta/portfolios.json");
}

const routes = [
  // ---- Auth ----
  {
    method: "GET",
    pattern: /^\/api\/auth\/status$/,
    handler: async (req, env) => {
      const users = await getUsers(env.DATA_BUCKET);
      return json({ bootstrapped: users.length > 0 });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/auth\/bootstrap$/,
    // Creates the very first (admin) account. Only works while no users exist yet, and requires
    // the APP_PASSWORD secret as proof of ownership - after that, this route stays as a
    // disaster-recovery path (still gated by APP_PASSWORD) if users/index.json is ever emptied.
    handler: async (req, env) => {
      if (!env.APP_PASSWORD) {
        return json({ error: "ยังไม่ได้ตั้งค่า APP_PASSWORD (wrangler secret put APP_PASSWORD)" }, { status: 500 });
      }
      if (!env.SESSION_SECRET) {
        return json({ error: "ยังไม่ได้ตั้งค่า SESSION_SECRET (wrangler secret put SESSION_SECRET)" }, { status: 500 });
      }
      const bucket = env.DATA_BUCKET;
      const users = await getUsers(bucket);
      if (users.length > 0) {
        return json({ error: "มีบัญชีผู้ใช้อยู่แล้ว ไม่สามารถตั้งค่าเริ่มต้นซ้ำได้" }, { status: 403 });
      }
      const body = await req.json().catch(() => ({}));
      if (body.appPassword !== env.APP_PASSWORD) {
        return json({ error: "รหัสผ่านแอปไม่ถูกต้อง" }, { status: 401 });
      }
      const username = (body.username || "").trim();
      const password = body.password || "";
      if (username.length < 3) return json({ error: "ชื่อผู้ใช้ต้องมีอย่างน้อย 3 ตัวอักษร" }, { status: 400 });
      if (password.length < 6) return json({ error: "รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร" }, { status: 400 });

      const { salt, hash } = await createPasswordRecord(password);
      const user = {
        id: uid(),
        username,
        passwordSalt: salt,
        passwordHash: hash,
        role: "admin",
        createdAt: new Date().toISOString(),
      };
      await saveUsers(bucket, [user]);
      await migrateLegacyDataToUser(bucket, user.id);

      const token = await createSessionToken(user.id, env.SESSION_SECRET);
      return json({ token, user: publicUser(user) }, { status: 201 });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/auth\/login$/,
    handler: async (req, env) => {
      if (!env.SESSION_SECRET) {
        return json({ error: "ยังไม่ได้ตั้งค่า SESSION_SECRET (wrangler secret put SESSION_SECRET)" }, { status: 500 });
      }
      const body = await req.json().catch(() => ({}));
      const username = (body.username || "").trim().toLowerCase();
      const users = await getUsers(env.DATA_BUCKET);
      const user = users.find((u) => u.username.toLowerCase() === username);
      if (!user) return json({ error: "ไม่พบผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" }, { status: 401 });
      const ok = await verifyPassword(body.password || "", user.passwordSalt, user.passwordHash);
      if (!ok) return json({ error: "ไม่พบผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" }, { status: 401 });
      const token = await createSessionToken(user.id, env.SESSION_SECRET);
      return json({ token, user: publicUser(user) });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/admin\/users$/,
    handler: async (req, env, params, auth) => {
      if (auth.role !== "admin") return json({ error: "ต้องเป็น admin เท่านั้น" }, { status: 403 });
      const body = await req.json().catch(() => ({}));
      const username = (body.username || "").trim();
      const password = body.password || "";
      if (username.length < 3) return json({ error: "ชื่อผู้ใช้ต้องมีอย่างน้อย 3 ตัวอักษร" }, { status: 400 });
      if (password.length < 6) return json({ error: "รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร" }, { status: 400 });

      const bucket = env.DATA_BUCKET;
      const users = await getUsers(bucket);
      if (users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
        return json({ error: "มีชื่อผู้ใช้นี้อยู่แล้ว" }, { status: 409 });
      }
      const { salt, hash } = await createPasswordRecord(password);
      const user = {
        id: uid(),
        username,
        passwordSalt: salt,
        passwordHash: hash,
        role: "user",
        createdAt: new Date().toISOString(),
      };
      await saveUsers(bucket, [...users, user]);
      return json(publicUser(user), { status: 201 });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/admin\/users$/,
    handler: async (req, env, params, auth) => {
      if (auth.role !== "admin") return json({ error: "ต้องเป็น admin เท่านั้น" }, { status: 403 });
      const users = await getUsers(env.DATA_BUCKET);
      return json(users.map(publicUser));
    },
  },
  {
    method: "DELETE",
    pattern: /^\/api\/admin\/users\/([^/]+)$/,
    handler: async (req, env, [id], auth) => {
      if (auth.role !== "admin") return json({ error: "ต้องเป็น admin เท่านั้น" }, { status: 403 });
      if (id === auth.userId) return json({ error: "ลบบัญชีตัวเองไม่ได้" }, { status: 400 });
      const bucket = env.DATA_BUCKET;
      const users = await getUsers(bucket);
      const target = users.find((u) => u.id === id);
      if (!target) return json({ error: "not found" }, { status: 404 });
      const remainingAdmins = users.filter((u) => u.role === "admin" && u.id !== id);
      if (target.role === "admin" && remainingAdmins.length === 0) {
        return json({ error: "ต้องมี admin เหลืออย่างน้อย 1 คน" }, { status: 400 });
      }
      await saveUsers(bucket, users.filter((u) => u.id !== id));
      await deleteAllUserData(bucket, id);
      return json({ ok: true });
    },
  },
  {
    method: "PUT",
    pattern: /^\/api\/admin\/users\/([^/]+)\/password$/,
    // Admin-initiated password reset (no need to know the old password) - for helping a user
    // who's locked out, or rotating a temporary password after creating an account.
    handler: async (req, env, [id], auth) => {
      if (auth.role !== "admin") return json({ error: "ต้องเป็น admin เท่านั้น" }, { status: 403 });
      const body = await req.json().catch(() => ({}));
      const password = body.password || "";
      if (password.length < 6) return json({ error: "รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร" }, { status: 400 });
      const bucket = env.DATA_BUCKET;
      const users = await getUsers(bucket);
      const idx = users.findIndex((u) => u.id === id);
      if (idx === -1) return json({ error: "not found" }, { status: 404 });
      const { salt, hash } = await createPasswordRecord(password);
      users[idx] = { ...users[idx], passwordSalt: salt, passwordHash: hash };
      await saveUsers(bucket, users);
      return json({ ok: true });
    },
  },
  // ---- Portfolios ----
  {
    method: "GET",
    pattern: /^\/api\/portfolios$/,
    handler: async (req, env, params, auth) => json(await getPortfolios(env.DATA_BUCKET, auth.userId)),
  },
  {
    method: "POST",
    pattern: /^\/api\/portfolios$/,
    handler: async (req, env, params, auth) => {
      const body = await req.json();
      const list = await getPortfolios(env.DATA_BUCKET, auth.userId);
      const portfolio = {
        id: uid(),
        name: body.name || "Untitled",
        parentId: body.parentId || null,
        createdAt: new Date().toISOString(),
      };
      list.push(portfolio);
      await savePortfolios(env.DATA_BUCKET, auth.userId, list);
      return json(portfolio, { status: 201 });
    },
  },
  {
    method: "PUT",
    pattern: /^\/api\/portfolios\/([^/]+)$/,
    handler: async (req, env, [id], auth) => {
      const body = await req.json();
      const list = await getPortfolios(env.DATA_BUCKET, auth.userId);
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
      await savePortfolios(env.DATA_BUCKET, auth.userId, list);
      return json(list[idx]);
    },
  },
  {
    method: "DELETE",
    pattern: /^\/api\/portfolios\/([^/]+)$/,
    handler: async (req, env, [id], auth) => {
      const list = await getPortfolios(env.DATA_BUCKET, auth.userId);
      const hasChildren = list.some((p) => p.parentId === id);
      if (hasChildren) return json({ error: "ลบไม่ได้: มี sub-portfolio อยู่ข้างใน" }, { status: 400 });
      const filtered = list.filter((p) => p.id !== id);
      await savePortfolios(env.DATA_BUCKET, auth.userId, filtered);
      await deleteTransactions(env.DATA_BUCKET, auth.userId, id);
      return json({ ok: true });
    },
  },
  // ---- Transactions ----
  {
    method: "GET",
    pattern: /^\/api\/transactions\/([^/]+)$/,
    handler: async (req, env, [portfolioId], auth) => json(await getTransactions(env.DATA_BUCKET, auth.userId, portfolioId)),
  },
  {
    method: "POST",
    pattern: /^\/api\/transactions\/([^/]+)$/,
    handler: async (req, env, [portfolioId], auth) => {
      const body = await req.json();
      const list = await getTransactions(env.DATA_BUCKET, auth.userId, portfolioId);
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
      await saveTransactions(env.DATA_BUCKET, auth.userId, portfolioId, list);
      return json(tx, { status: 201 });
    },
  },
  {
    method: "PUT",
    pattern: /^\/api\/transactions\/([^/]+)\/([^/]+)$/,
    handler: async (req, env, [portfolioId, txId], auth) => {
      const body = await req.json();
      const list = await getTransactions(env.DATA_BUCKET, auth.userId, portfolioId);
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
      await saveTransactions(env.DATA_BUCKET, auth.userId, portfolioId, list);
      return json(list[idx]);
    },
  },
  {
    method: "DELETE",
    pattern: /^\/api\/transactions\/([^/]+)\/([^/]+)$/,
    handler: async (req, env, [portfolioId, txId], auth) => {
      const list = await getTransactions(env.DATA_BUCKET, auth.userId, portfolioId);
      const filtered = list.filter((t) => t.id !== txId);
      await saveTransactions(env.DATA_BUCKET, auth.userId, portfolioId, filtered);
      return json({ ok: true });
    },
  },
  // ---- Summaries ----
  {
    method: "GET",
    pattern: /^\/api\/summary\/([^/]+)$/,
    handler: async (req, env, [portfolioId], auth) => {
      const bucket = env.DATA_BUCKET;
      const allPortfolios = await getPortfolios(bucket, auth.userId);
      const url = new URL(req.url);
      const includeSub = url.searchParams.get("includeSub") !== "false";

      const transactions = includeSub
        ? await getTransactionsIncludingChildren(bucket, auth.userId, portfolioId, allPortfolios)
        : await getTransactions(bucket, auth.userId, portfolioId);

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
    handler: async (req, env, params, auth) => {
      const bucket = env.DATA_BUCKET;
      const allTx = await getAllTransactions(bucket, auth.userId);
      const flat = Object.values(allTx).flat();
      const positions = computePositions(flat);
      const priceCache = await getPriceCache(bucket);
      const fxCache = await getFxCache(bucket);
      const base = env.BASE_CURRENCY || "USD";
      const summary = buildSummary(positions, priceCache, fxCache.rates || {}, base);
      return json({ ...summary, priceUpdatedAt: fxCache.updatedAt });
    },
  },
  // ---- Prices (shared across all users) ----
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
    method: "PUT",
    pattern: /^\/api\/prices\/([^/]+)$/,
    // Manually set a symbol's current price - for assets that can't be auto-fetched (e.g. a
    // Thai fund whose trading name doesn't resolve on SEC). Persists like any other quote: the
    // automated refresh will overwrite it again once/if that symbol starts resolving on its own.
    handler: async (req, env, [symbolEncoded]) => {
      const symbol = decodeURIComponent(symbolEncoded);
      const body = await req.json();
      const price = Number(body.price);
      if (!Number.isFinite(price) || price <= 0) {
        return json({ error: "ราคาต้องเป็นตัวเลขมากกว่า 0" }, { status: 400 });
      }
      const bucket = env.DATA_BUCKET;
      const priceCache = await getPriceCache(bucket);
      const quote = {
        symbol,
        price,
        currency: (body.currency || priceCache[symbol]?.currency || "THB").toUpperCase(),
        name: priceCache[symbol]?.name || symbol,
        date: body.date || new Date().toISOString().slice(0, 10),
        updatedAt: new Date().toISOString(),
        source: "manual",
      };
      priceCache[symbol] = quote;
      await savePriceCache(bucket, priceCache);
      const priceHistory = await getPriceHistory(bucket);
      await savePriceHistory(bucket, mergePriceHistory(priceHistory, { [symbol]: quote }));
      return json(quote);
    },
  },
  // ---- Settings (shared across all users; app name is instance-level branding) ----
  {
    method: "GET",
    pattern: /^\/api\/settings$/,
    handler: async (req, env) => json(await getSettings(env.DATA_BUCKET)),
  },
  {
    method: "PUT",
    pattern: /^\/api\/settings$/,
    handler: async (req, env, params, auth) => {
      if (auth.role !== "admin") return json({ error: "ต้องเป็น admin เท่านั้น" }, { status: 403 });
      const body = await req.json();
      const current = await getSettings(env.DATA_BUCKET);
      const updated = { ...current, appName: body.appName?.trim() || current.appName };
      await saveSettings(env.DATA_BUCKET, updated);
      return json(updated);
    },
  },
];

const PUBLIC_ROUTES = new Set(["GET /api/auth/status", "POST /api/auth/bootstrap", "POST /api/auth/login", "GET /api/settings"]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      const isPublicRoute = PUBLIC_ROUTES.has(`${request.method} ${url.pathname}`);
      let auth = null;
      if (!isPublicRoute) {
        auth = await requireAuth(request, env);
        if (!auth) return unauthorized();
      }
      for (const route of routes) {
        if (route.method === request.method) {
          const match = url.pathname.match(route.pattern);
          if (match) {
            try {
              return await route.handler(request, env, match.slice(1), auth);
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
