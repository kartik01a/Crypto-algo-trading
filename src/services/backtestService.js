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
  const { symbol = 'BTC/USDT', timeframe = '5m', from, to, initialBalance = 10000, strategy = null, debug = false } = body;

  if (!from || !to) {
    throw new Error('Missing required parameters: from and to dates (YYYY-MM-DD)');
  }

  return runBacktest({
    symbol,
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
