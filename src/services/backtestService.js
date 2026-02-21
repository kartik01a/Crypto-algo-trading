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
    symbols: symbolsParam = null,
    timeframe = '5m',
    from,
    to,
    initialBalance = 10000,
    strategy = null,
    debug = true,
  } = body;

  if (!from || !to) {
    throw new Error('Missing required parameters: from and to dates (YYYY-MM-DD)');
  }

  return runBacktest({
    symbol,
    symbols: symbolsParam,
    timeframe,
    from,
    to,
    initialBalance,
    strategy,
    debug,
  });
}

module.exports = {
  executeBacktest,
};
