// All application data is stored as JSON objects inside a single R2 bucket.
// Keys:
//   meta/portfolios.json          -> [{id, name, parentId, createdAt}]
//   portfolios/{id}/transactions.json -> [transaction, ...]
//   prices/cache.json             -> {symbol: {price, currency, name, assetType, updatedAt}}
//   fx/cache.json                 -> {"USDTHB": 36.2, updatedAt}

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

export async function getPortfolios(bucket) {
  return readJSON(bucket, "meta/portfolios.json", []);
}

export async function savePortfolios(bucket, list) {
  return writeJSON(bucket, "meta/portfolios.json", list);
}

export async function getTransactions(bucket, portfolioId) {
  return readJSON(bucket, `portfolios/${portfolioId}/transactions.json`, []);
}

export async function saveTransactions(bucket, portfolioId, list) {
  return writeJSON(bucket, `portfolios/${portfolioId}/transactions.json`, list);
}

export async function getAllTransactions(bucket) {
  const portfolios = await getPortfolios(bucket);
  const out = {};
  for (const p of portfolios) {
    out[p.id] = await getTransactions(bucket, p.id);
  }
  return out;
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

export function uid() {
  return crypto.randomUUID();
}
