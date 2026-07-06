// Weighted-average cost method, applied in chronological order.
// This naturally handles DCA: every BUY re-weights the average cost by time and size.
// Every SELL realizes P/L against the current average cost but does NOT change the
// average cost of the remaining shares (standard moving-average / weighted-average method).
export function computePositions(transactions) {
  const sorted = [...transactions].sort((a, b) => new Date(a.date) - new Date(b.date));
  const bySymbol = {};

  for (const tx of sorted) {
    const key = tx.symbol;
    if (!bySymbol[key]) {
      bySymbol[key] = {
        symbol: tx.symbol,
        assetType: tx.assetType,
        currency: tx.currency,
        quantity: 0,
        avgCost: 0, // per unit, in tx.currency
        investedCost: 0, // total cost basis currently held, in tx.currency
        realizedPnL: 0,
        totalFees: 0,
        totalDividends: 0,
        lots: [], // history for transparency
      };
    }
    const pos = bySymbol[key];
    pos.totalFees += tx.fees || 0;

    if (tx.type === "buy") {
      const cost = tx.quantity * tx.price + (tx.fees || 0);
      const newQty = pos.quantity + tx.quantity;
      pos.investedCost += cost;
      pos.quantity = newQty;
      pos.avgCost = newQty > 0 ? pos.investedCost / newQty : 0;
    } else if (tx.type === "sell") {
      const sellQty = Math.min(tx.quantity, pos.quantity);
      const costOfSold = sellQty * pos.avgCost;
      const proceeds = sellQty * tx.price - (tx.fees || 0);
      pos.realizedPnL += proceeds - costOfSold;
      pos.quantity -= sellQty;
      pos.investedCost -= costOfSold;
      if (pos.quantity <= 0) {
        pos.quantity = 0;
        pos.investedCost = 0;
        pos.avgCost = 0;
      }
    } else if (tx.type === "dividend") {
      pos.totalDividends += tx.quantity * tx.price; // quantity*price used as amount received
    }
    pos.lots.push({ date: tx.date, type: tx.type, avgCostAfter: pos.avgCost, qtyAfter: pos.quantity });
  }

  return Object.values(bySymbol);
}

// Combine positions with live prices + fx rates to produce the final dashboard numbers,
// all converted into `baseCurrency`.
export function buildSummary(positions, priceCache, fxRates, baseCurrency) {
  const rows = [];
  let totalValue = 0;
  let totalCost = 0;
  let totalRealized = 0;
  let totalDividends = 0;

  for (const pos of positions) {
    if (pos.quantity <= 0 && pos.realizedPnL === 0 && pos.totalDividends === 0) continue;

    const quote = priceCache[pos.symbol];
    const currentPrice = quote?.price ?? null;
    const quoteCurrency = quote?.currency || pos.currency;

    const fxToBase = getRate(fxRates, quoteCurrency, baseCurrency);
    const fxCostToBase = getRate(fxRates, pos.currency, baseCurrency);

    const marketValueBase = currentPrice != null ? pos.quantity * currentPrice * fxToBase : null;
    const costBasisBase = pos.investedCost * fxCostToBase;
    const unrealizedPnLBase = marketValueBase != null ? marketValueBase - costBasisBase : null;
    const unrealizedPnLPct = costBasisBase > 0 && unrealizedPnLBase != null ? (unrealizedPnLBase / costBasisBase) * 100 : null;

    if (marketValueBase != null) totalValue += marketValueBase;
    totalCost += costBasisBase;
    totalRealized += pos.realizedPnL * fxCostToBase;
    totalDividends += pos.totalDividends * fxCostToBase;

    rows.push({
      symbol: pos.symbol,
      assetType: pos.assetType,
      quantity: pos.quantity,
      avgCost: pos.avgCost,
      currency: pos.currency,
      currentPrice,
      quoteCurrency,
      marketValueBase,
      costBasisBase,
      unrealizedPnLBase,
      unrealizedPnLPct,
      realizedPnLBase: pos.realizedPnL * fxCostToBase,
      dividendsBase: pos.totalDividends * fxCostToBase,
      priceUpdatedAt: quote?.updatedAt || null,
      name: quote?.name || pos.symbol,
    });
  }

  const allocation = rows
    .filter((r) => r.marketValueBase != null && r.marketValueBase > 0)
    .map((r) => ({
      symbol: r.symbol,
      assetType: r.assetType,
      value: r.marketValueBase,
      pct: totalValue > 0 ? (r.marketValueBase / totalValue) * 100 : 0,
    }))
    .sort((a, b) => b.value - a.value);

  const byAssetType = {};
  for (const a of allocation) {
    byAssetType[a.assetType] = (byAssetType[a.assetType] || 0) + a.value;
  }
  const allocationByType = Object.entries(byAssetType).map(([assetType, value]) => ({
    assetType,
    value,
    pct: totalValue > 0 ? (value / totalValue) * 100 : 0,
  }));

  return {
    baseCurrency,
    totalValue,
    totalCost,
    totalUnrealizedPnL: totalValue - totalCost,
    totalUnrealizedPnLPct: totalCost > 0 ? ((totalValue - totalCost) / totalCost) * 100 : 0,
    totalRealizedPnL: totalRealized,
    totalDividends,
    positions: rows.sort((a, b) => (b.marketValueBase || 0) - (a.marketValueBase || 0)),
    allocationBySymbol: allocation,
    allocationByType,
  };
}

function getRate(fxRates, from, to) {
  if (from === to) return 1;
  const key = `${from}${to}`;
  if (fxRates[key] != null) return fxRates[key];
  const inverseKey = `${to}${from}`;
  if (fxRates[inverseKey] != null && fxRates[inverseKey] !== 0) return 1 / fxRates[inverseKey];
  return 1; // fallback: assume parity if rate unavailable, better than crashing
}
