/**
 * Portfolio Module
 * Tracks balance, open/closed trades, and equity curve
 */

const config = require('../../config');
const { roundTo, getStartOfDay } = require('../../utils/helpers');

/**
 * Create a new portfolio state
 * @param {number} [initialBalance] - Starting balance
 * @returns {Object} Portfolio state
 */
function createPortfolio(initialBalance = config.risk.initialBalance) {
  return {
    balance: initialBalance,
    initialBalance,
    peakBalance: initialBalance,
    openTrades: [],
    closedTrades: [],
    equityCurve: [{ timestamp: Date.now(), balance: initialBalance, equity: initialBalance }],
    dailyStartBalance: initialBalance,
    lastDayReset: getStartOfDay(Date.now()),
  };
}

/**
 * Reset daily tracking (call at start of new day)
 * @param {Object} portfolio - Portfolio state
 */
function resetDailyIfNeeded(portfolio, now = Date.now()) {
  const currentDayStart = getStartOfDay(now);

  if (currentDayStart > portfolio.lastDayReset) {
    portfolio.dailyStartBalance = portfolio.balance;
    portfolio.lastDayReset = currentDayStart;
  }
}

/**
 * Get trades executed today
 * @param {Object} portfolio - Portfolio state
 * @returns {Array} Trades closed today
 */
function getTradesToday(portfolio, now = Date.now()) {
  const todayStart = getStartOfDay(now);
  return portfolio.closedTrades.filter((t) => t.closedAt >= todayStart);
}

/**
 * Add open trade to portfolio
 * @param {Object} portfolio - Portfolio state
 * @param {Object} trade - Trade to add (with entryPrice, quantity, entryFee)
 */
function addOpenTrade(portfolio, trade) {
  const entryNotional = trade.entryPrice * trade.quantity;
  const entryFee = trade.entryFee || 0;
  const cost = trade.side === 'SELL'
    ? -(entryNotional - entryFee) // short sale proceeds (increase balance)
    : (entryNotional + entryFee); // long cost (decrease balance)
  portfolio.openTrades.push(trade);
  portfolio.balance = roundTo(portfolio.balance - cost, 8);
  updateEquityCurve(portfolio);
}

/**
 * Remove open trade and add to closed
 * @param {Object} portfolio - Portfolio state
 * @param {Object} trade - Closed trade (with exitPrice, quantity, exitFee)
 */
function closeTradeInPortfolio(portfolio, trade) {
  const exitNotional = trade.exitPrice * trade.quantity;
  const exitFee = trade.exitFee || 0;
  const proceeds = trade.side === 'SELL'
    ? -(exitNotional + exitFee) // buy-to-cover (decrease balance)
    : (exitNotional - exitFee); // sell long (increase balance)
  const idx = portfolio.openTrades.findIndex((t) => t.id === trade.id);
  if (idx >= 0) {
    portfolio.openTrades.splice(idx, 1);
  }
  portfolio.closedTrades.push(trade);
  portfolio.balance = roundTo(portfolio.balance + proceeds, 8);

  if (portfolio.balance > portfolio.peakBalance) {
    portfolio.peakBalance = portfolio.balance;
  }

  updateEquityCurve(portfolio);
}

/**
 * Update equity curve with current state
 * @param {Object} portfolio - Portfolio state
 * @param {number} [timestamp] - Optional timestamp
 * @param {number} [markPrice] - Optional mark price for open positions (default: entry price)
 */
function updateEquityCurve(portfolio, timestamp = Date.now(), markPrice = null) {
  const openPositionValue = portfolio.openTrades.reduce((sum, t) => {
    const price = markPrice !== null ? markPrice : t.entryPrice;
    const positionValue = t.side === 'SELL' ? -(price * t.quantity) : (price * t.quantity);
    return sum + positionValue;
  }, 0);

  const equity = portfolio.balance + openPositionValue;

  portfolio.equityCurve.push({
    timestamp,
    balance: portfolio.balance,
    equity: roundTo(equity, 8),
  });
}

/**
 * Get portfolio summary
 * @param {Object} portfolio - Portfolio state
 * @returns {Object} Summary
 */
function getSummary(portfolio) {
  const totalPnl = portfolio.balance - portfolio.initialBalance;
  const totalPnlPercent = portfolio.initialBalance > 0
    ? (totalPnl / portfolio.initialBalance) * 100
    : 0;

  return {
    balance: portfolio.balance,
    initialBalance: portfolio.initialBalance,
    totalPnl: roundTo(totalPnl, 8),
    totalPnlPercent: roundTo(totalPnlPercent, 4),
    openTrades: portfolio.openTrades.length,
    closedTrades: portfolio.closedTrades.length,
    peakBalance: portfolio.peakBalance,
    maxDrawdown: portfolio.peakBalance > 0
      ? roundTo(((portfolio.peakBalance - portfolio.balance) / portfolio.peakBalance) * 100, 4)
      : 0,
  };
}

module.exports = {
  createPortfolio,
  resetDailyIfNeeded,
  getTradesToday,
  addOpenTrade,
  closeTradeInPortfolio,
  updateEquityCurve,
  getSummary,
};
