/**
 * Backtest API Service
 */

const { runBacktest } = require('../modules/backtest');

/**
 * Execute backtest with request parameters
 * @param {Object} body - Request body
 * @returns {Promise<Object>} Backtest result
 */
async function executeBacktest(body) {
  const {
    symbol = null,
    symbols: symbolsParam = null,
    timeframe = '5m',
    from,
    to,
    initialBalance = 10000,
    strategy = null,
    debug = true,
    maxOpenTrades = null,
  } = body;

  if (!from || !to) {
    throw new Error('Missing required parameters: from and to dates (YYYY-MM-DD)');
  }

  // Support symbols[] or single symbol (convert to array)
  const symbols = symbolsParam && symbolsParam.length > 0
    ? symbolsParam
    : symbol
      ? [symbol]
      : ['BTC/USDT'];

  return runBacktest({
    symbol: symbols[0],
    symbols,
    timeframe,
    from,
    to,
    initialBalance,
    strategy,
    debug,
    maxOpenTrades,
  });
}

module.exports = {
  executeBacktest,
};
