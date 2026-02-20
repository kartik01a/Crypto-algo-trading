/**
 * Backtest API Service
 */

const { runBacktest } = require('../modules/backtest');
const { roundTo } = require('../utils/helpers');

/**
 * Execute backtest with request parameters
 * @param {Object} body - Request body
 * @returns {Promise<Object>} Backtest result (or multi-coin aggregate)
 */
async function executeBacktest(body) {
  const {
    symbol,
    symbols,
    timeframe = '5m',
    from,
    to,
    initialBalance = 10000,
    strategy = null,
    debug = true,
    limit,
  } = body;

  if (!from || !to) {
    throw new Error('Missing required parameters: from and to dates (YYYY-MM-DD)');
  }

  // Default 20k candles (~70 days of 5m) for reasonable response time; pass limit: null for full range
  const effectiveLimit = limit === undefined ? 20000 : limit;

  const symbolList = symbols && Array.isArray(symbols) && symbols.length > 0
    ? symbols
    : [symbol || 'BTC/USDT'];

  if (symbolList.length === 1) {
    return runBacktest({
      symbol: symbolList[0],
      timeframe,
      from,
      to,
      initialBalance,
      strategy,
      debug,
      limit: effectiveLimit,
    });
  }

  // Multi-coin: run backtest for each symbol and aggregate
  const results = [];
  const balancePerSymbol = initialBalance / symbolList.length;

  for (const sym of symbolList) {
    const result = await runBacktest({
      symbol: sym,
      timeframe,
      from,
      to,
      initialBalance: balancePerSymbol,
      strategy,
      debug: false,
      limit: effectiveLimit,
    });
    results.push({ symbol: sym, ...result });
  }

  // Aggregate results
  const totalTrades = results.reduce((s, r) => s + r.totalTrades, 0);
  const totalPnl = results.reduce((s, r) => s + r.totalPnl, 0);
  const allTrades = results.flatMap((r) =>
    (r.tradeList || []).map((t) => ({ ...t, symbol: r.symbol || r.meta?.symbol }))
  );
  const winningTrades = allTrades.filter((t) => t.pnl > 0);
  const losingTrades = allTrades.filter((t) => t.pnl < 0);
  const winRate = totalTrades > 0
    ? roundTo((winningTrades.length / totalTrades) * 100, 2)
    : 0;
  const grossProfit = winningTrades.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losingTrades.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? roundTo(grossProfit / grossLoss, 4) : grossProfit > 0 ? Infinity : 0;
  const avgRMultiple = allTrades.filter((t) => t.rMultiple != null).length > 0
    ? roundTo(
        allTrades.filter((t) => t.rMultiple != null).reduce((s, t) => s + t.rMultiple, 0) /
        allTrades.filter((t) => t.rMultiple != null).length,
        4
      )
    : null;
  const avgMfe = allTrades.filter((t) => t.mfe != null).length > 0
    ? roundTo(
        allTrades.filter((t) => t.mfe != null).reduce((s, t) => s + t.mfe, 0) /
        allTrades.filter((t) => t.mfe != null).length,
        4
      )
    : null;

  return {
    multiCoin: true,
    symbols: symbolList,
    results,
    totalTrades,
    totalPnl,
    totalPnlPercent: roundTo((totalPnl / initialBalance) * 100, 4),
    winRate,
    profitFactor,
    avgRMultiple,
    avgMfe,
    tradeList: allTrades,
    meta: {
      strategy: strategy || 'default',
      symbols: symbolList,
    },
  };
}

module.exports = {
  executeBacktest,
};
