/**
 * Paper Trading API Service
 */

const {
  startPaperTrading,
  stopPaperTrading,
  getPaperStatus,
  getPaperPortfolio,
  getPaperTrades,
} = require('../modules/paper');
const { getSummary } = require('../modules/portfolio');

/**
 * Start paper trading
 * @param {Object} [options]
 * @returns {Promise<Object>}
 */
async function start(options = {}) {
  return startPaperTrading(options);
}

/**
 * Stop paper trading
 * @returns {Object}
 */
function stop() {
  return stopPaperTrading();
}

/**
 * Get paper trading status
 * @returns {Object}
 */
function getStatus() {
  return getPaperStatus();
}

/**
 * Get portfolio summary
 * @returns {Object|null}
 */
function getPortfolio() {
  const portfolio = getPaperPortfolio();
  if (!portfolio) return null;
  return getSummary(portfolio);
}

/**
 * Get full portfolio with equity curve
 * @returns {Object|null}
 */
function getPortfolioFull() {
  const portfolio = getPaperPortfolio();
  if (!portfolio) return null;
  const summary = getSummary(portfolio);
  return {
    ...summary,
    openTrades: portfolio.openTrades,
    closedTrades: portfolio.closedTrades,
    equityCurve: portfolio.equityCurve,
  };
}

/**
 * Get trades (open and closed)
 * @returns {Object}
 */
function getTrades() {
  return getPaperTrades();
}

module.exports = {
  start,
  stop,
  getStatus,
  getPortfolio,
  getPortfolioFull,
  getTrades,
};
