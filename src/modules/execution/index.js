/**
 * Execution Engine
 * Handles opening/closing trades with SL/TP, fees, and slippage
 */

const config = require('../../config');
const { roundTo, applySlippage, calculateFee } = require('../../utils/helpers');

const { fee, slippage } = config.trading;

/**
 * Create a new trade object
 * @param {Object} params
 * @param {number} params.entryPrice - Entry price
 * @param {number} params.quantity - Position size
 * @param {string} params.side - 'BUY' or 'SELL'
 * @param {number} params.stopLoss - Stop loss price
 * @param {number} params.takeProfit - Take profit price
 * @param {number} params.timestamp - Trade timestamp
 * @param {string} [params.symbol] - Trading pair
 * @returns {Object} Trade object
 */
function openTrade(params) {
  const {
    entryPrice,
    quantity,
    side,
    stopLoss,
    takeProfit,
    timestamp,
    symbol,
    ...rest
  } = params || {};
  const adjustedPrice = applySlippage(entryPrice, slippage, side.toLowerCase());
  const entryFee = calculateFee(adjustedPrice * quantity, fee);

  return {
    ...rest,
    id: `trade_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    symbol: symbol || 'BTC/USDT',
    entryPrice: roundTo(adjustedPrice, 8),
    exitPrice: null,
    quantity: roundTo(quantity, 8),
    side,
    pnl: 0,
    pnlPercent: 0,
    status: 'OPEN',
    stopLoss,
    takeProfit,
    entryFee,
    exitFee: 0,
    openedAt: timestamp || Date.now(),
    closedAt: null,
  };
}

/**
 * Close a trade and calculate PnL
 * @param {Object} trade - Open trade object
 * @param {number} exitPrice - Exit price (current market price)
 * @param {number} timestamp - Close timestamp
 * @returns {Object} Updated trade object
 */
function closeTrade(trade, exitPrice, timestamp = Date.now()) {
  const adjustedPrice = applySlippage(exitPrice, slippage, trade.side === 'BUY' ? 'sell' : 'buy');
  const exitFee = calculateFee(adjustedPrice * trade.quantity, fee);

  let pnl;
  if (trade.side === 'BUY') {
    pnl = (adjustedPrice - trade.entryPrice) * trade.quantity - trade.entryFee - exitFee;
  } else {
    pnl = (trade.entryPrice - adjustedPrice) * trade.quantity - trade.entryFee - exitFee;
  }

  const pnlPercent = (pnl / (trade.entryPrice * trade.quantity)) * 100;

  return {
    ...trade,
    exitPrice: roundTo(adjustedPrice, 8),
    pnl: roundTo(pnl, 8),
    pnlPercent: roundTo(pnlPercent, 4),
    status: 'CLOSED',
    exitFee,
    closedAt: timestamp,
  };
}

/**
 * Check if stop loss is hit
 * @param {Object} trade - Open trade
 * @param {number} low - Candle low price
 * @param {number} high - Candle high price
 * @returns {boolean}
 */
function isStopLossHit(trade, low, high) {
  if (trade.side === 'BUY') {
    return low <= trade.stopLoss;
  }
  return high >= trade.stopLoss;
}

/**
 * Check if take profit is hit
 * @param {Object} trade - Open trade
 * @param {number} low - Candle low price
 * @param {number} high - Candle high price
 * @returns {boolean}
 */
function isTakeProfitHit(trade, low, high) {
  if (trade.side === 'BUY') {
    return high >= trade.takeProfit;
  }
  return low <= trade.takeProfit;
}

/**
 * Check if trade should be closed this candle (SL or TP hit)
 * Uses candle high/low for realistic execution
 * @param {Object} trade - Open trade
 * @param {Array} candle - [timestamp, open, high, low, close, volume]
 * @returns {Object|null} { exitPrice, reason } or null if no exit
 */
function checkExitConditions(trade, candle) {
  const [, open, high, low, close] = candle;

  // For BUY: SL hit when low touches stopLoss, TP when high touches takeProfit
  // Check SL first (conservative - assume worst fill)
  if (isStopLossHit(trade, low, high)) {
    return { exitPrice: trade.stopLoss, reason: 'STOP_LOSS' };
  }
  if (isTakeProfitHit(trade, low, high)) {
    return { exitPrice: trade.takeProfit, reason: 'TAKE_PROFIT' };
  }

  return null;
}

module.exports = {
  openTrade,
  closeTrade,
  isStopLossHit,
  isTakeProfitHit,
  checkExitConditions,
};
