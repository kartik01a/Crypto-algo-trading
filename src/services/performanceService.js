/**
 * Performance Analytics Service
 * Calculates: totalTrades, winRate, profitFactor, maxDrawdown, totalPnL
 */

const { roundTo } = require('../utils/helpers');
const tradeRepository = require('../db/tradeRepository');

/**
 * Calculate performance metrics from trades
 * @param {Array} trades - Array of closed trades
 * @param {number} [initialBalance] - For drawdown calculation
 * @returns {Object} Performance metrics
 */
function calculatePerformance(trades, initialBalance = 10000) {
  const closedTrades = trades.filter((t) => t.status === 'CLOSED' && t.pnl != null);

  if (closedTrades.length === 0) {
    return {
      totalTrades: 0,
      winRate: 0,
      profitFactor: 0,
      maxDrawdown: 0,
      totalPnL: 0,
      totalPnLPercent: 0,
    };
  }

  const winningTrades = closedTrades.filter((t) => t.pnl > 0);
  const losingTrades = closedTrades.filter((t) => t.pnl < 0);

  const grossProfit = winningTrades.reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0));

  const totalPnL = closedTrades.reduce((sum, t) => sum + t.pnl, 0);
  const totalPnLPercent = initialBalance > 0 ? (totalPnL / initialBalance) * 100 : 0;

  const winRate = roundTo((winningTrades.length / closedTrades.length) * 100, 2);
  const profitFactor = grossLoss > 0 ? roundTo(grossProfit / grossLoss, 4) : grossProfit > 0 ? Infinity : 0;

  // Calculate max drawdown from equity curve
  let peak = initialBalance;
  let maxDrawdown = 0;
  let equity = initialBalance;

  for (const t of closedTrades.sort((a, b) => new Date(a.closedAt) - new Date(b.closedAt))) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const drawdown = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  return {
    totalTrades: closedTrades.length,
    winRate,
    profitFactor,
    maxDrawdown: roundTo(maxDrawdown, 4),
    totalPnL: roundTo(totalPnL, 8),
    totalPnLPercent: roundTo(totalPnLPercent, 4),
    winningTrades: winningTrades.length,
    losingTrades: losingTrades.length,
  };
}

/**
 * Get performance from DB
 * @param {string} [mode] - backtest | paper | real
 */
async function getPerformance(mode = null) {
  const trades = await tradeRepository.getClosedTrades(mode);
  return calculatePerformance(trades);
}

module.exports = {
  calculatePerformance,
  getPerformance,
};
