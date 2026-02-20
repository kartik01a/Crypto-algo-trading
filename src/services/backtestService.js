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
    symbol = 'BTC/USDT',
    symbols,
    timeframe = '15m',
    from,
    to,
    initialBalance = 10000,
    strategy = null,
    debug = true,
    minTrades = 100,
  } = body;

  if (!from || !to) {
    throw new Error('Missing required parameters: from and to dates (YYYY-MM-DD)');
  }

  return runBacktest({
    symbol: symbols ? undefined : symbol,
    symbols,
    timeframe,
    from,
    to,
    initialBalance,
    strategy,
    debug,
    minTrades,
  });
}

module.exports = {
  executeBacktest,
};
