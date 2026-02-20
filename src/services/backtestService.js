/**
 * Backtest API Service
 */

const { runBacktest, runBacktestMultiSymbol } = require('../modules/backtest');

/**
 * Execute backtest with request parameters
 * @param {Object} body - Request body
 * @param {string} [body.symbol] - Single symbol (e.g. 'BTC/USDT')
 * @param {Array<string>} [body.symbols] - Multiple symbols for multi-symbol backtest
 * @returns {Promise<Object>} Backtest result
 */
async function executeBacktest(body) {
  const { symbol = 'BTC/USDT', symbols, timeframe = '5m', from, to, initialBalance = 10000, strategy = null, debug = true } = body;

  if (!from || !to) {
    throw new Error('Missing required parameters: from and to dates (YYYY-MM-DD)');
  }

  if (symbols && Array.isArray(symbols) && symbols.length > 0) {
    return runBacktestMultiSymbol({
      symbols,
      timeframe,
      from,
      to,
      initialBalance,
      strategy,
      debug,
    });
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
