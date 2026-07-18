// All application data is stored as JSON objects inside a single R2 bucket.
// Keys:
//   users/index.json                              -> [{id, username, passwordHash, passwordSalt, role, createdAt}]
//   users/{userId}/meta/portfolios.json            -> [{id, name, parentId, createdAt}]
//   users/{userId}/portfolios/{id}/transactions.json -> [transaction, ...]
//   prices/cache.json             -> {symbol: {price, currency, name, assetType, updatedAt}}  (shared across users)
//   fx/cache.json                 -> {"USDTHB": 36.2, updatedAt}                                (shared across users)

async function readJSON(bucket, key, fallback) {
  const obj = await bucket.get(key);
  if (!obj) return fallback;
  try {
    return await obj.json();
  } catch (e) {
    return fallback;
  }
}

async function writeJSON(bucket, key, value) {
  await bucket.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json" },
  });
  return value;
}

export async function getPortfolios(bucket, userId) {
  return readJSON(bucket, `users/${userId}/meta/portfolios.json`, []);
}

export async function savePortfolios(bucket, userId, list) {
  return writeJSON(bucket, `users/${userId}/meta/portfolios.json`, list);
}

export async function getTransactions(bucket, userId, portfolioId) {
  return readJSON(bucket, `users/${userId}/portfolios/${portfolioId}/transactions.json`, []);
}

export async function saveTransactions(bucket, userId, portfolioId, list) {
  return writeJSON(bucket, `users/${userId}/portfolios/${portfolioId}/transactions.json`, list);
}

export async function deleteTransactions(bucket, userId, portfolioId) {
  await bucket.delete(`users/${userId}/portfolios/${portfolioId}/transactions.json`);
}

export async function getAllTransactions(bucket, userId) {
  const portfolios = await getPortfolios(bucket, userId);
  const out = {};
  for (const p of portfolios) {
    out[p.id] = await getTransactions(bucket, userId, p.id);
  }
  return out;
}

// Users (flat list - this app realistically has a handful of accounts, so no indexing needed).
export async function getUsers(bucket) {
  return readJSON(bucket, "users/index.json", []);
}

export async function saveUsers(bucket, users) {
  return writeJSON(bucket, "users/index.json", users);
}

// Deletes every portfolio/transaction object under a user's namespace (used when removing an
// account). R2 has no recursive delete, so list-then-delete every key under the prefix.
export async function deleteAllUserData(bucket, userId) {
  const prefix = `users/${userId}/`;
  let cursor;
  do {
    const listing = await bucket.list({ prefix, cursor });
    if (listing.objects.length > 0) {
      await Promise.all(listing.objects.map((o) => bucket.delete(o.key)));
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
}

export async function getPriceCache(bucket) {
  return readJSON(bucket, "prices/cache.json", {});
}

export async function savePriceCache(bucket, cache) {
  return writeJSON(bucket, "prices/cache.json", cache);
}

export async function getFxCache(bucket) {
  return readJSON(bucket, "fx/cache.json", { rates: {}, updatedAt: null });
}

export async function saveFxCache(bucket, cache) {
  return writeJSON(bucket, "fx/cache.json", cache);
}

// Maps a Thai fund's trading abbreviation (e.g. "KFINDIARMF") to its SEC proj_id, since
// SEC's NAV endpoint is indexed by proj_id, not the name investors actually recognize.
export async function getSecFundDirectory(bucket) {
  return readJSON(bucket, "prices/sec-fund-directory.json", { byAbbr: {}, updatedAt: null });
}

export async function saveSecFundDirectory(bucket, directory) {
  return writeJSON(bucket, "prices/sec-fund-directory.json", directory);
}

// App-level display settings (currently just the app name, editable in the UI).
export async function getSettings(bucket) {
  return readJSON(bucket, "meta/settings.json", { appName: "SabaiPort" });
}

export async function saveSettings(bucket, settings) {
  return writeJSON(bucket, "meta/settings.json", settings);
}

// Per-symbol NAV/price history: { [symbol]: [{date: "YYYY-MM-DD", price, currency}, ...] },
// each array sorted ascending by date. This is what lets the UI show "last known price as of
// <date>" when a fund's NAV for today hasn't been published yet, and survives independently of
// the point-in-time price cache.
export async function getPriceHistory(bucket) {
  return readJSON(bucket, "prices/history.json", {});
}

export async function savePriceHistory(bucket, history) {
  return writeJSON(bucket, "prices/history.json", history);
}

export function uid() {
  return crypto.randomUUID();
}
