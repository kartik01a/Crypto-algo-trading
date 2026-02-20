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
 * @param {number} [partialQuantity] - If set, close only this quantity (partial close)
 * @returns {Object} Updated trade object (or partial close record)
 */
function closeTrade(trade, exitPrice, timestamp = Date.now(), partialQuantity = null) {
  const qty = partialQuantity != null ? partialQuantity : trade.quantity;
  const adjustedPrice = applySlippage(exitPrice, slippage, trade.side === 'BUY' ? 'sell' : 'buy');
  const exitFee = calculateFee(adjustedPrice * qty, fee);

  const entryFeeProrated = partialQuantity != null
    ? (trade.entryFee || 0) * (qty / trade.quantity)
    : (trade.entryFee || 0);

  let pnl;
  if (trade.side === 'BUY') {
    pnl = (adjustedPrice - trade.entryPrice) * qty - entryFeeProrated - exitFee;
  } else {
    pnl = (trade.entryPrice - adjustedPrice) * qty - entryFeeProrated - exitFee;
  }

  const pnlPercent = (pnl / (trade.entryPrice * qty)) * 100;

  const closedRecord = {
    ...trade,
    quantity: qty,
    exitPrice: roundTo(adjustedPrice, 8),
    pnl: roundTo(pnl, 8),
    pnlPercent: roundTo(pnlPercent, 4),
    status: partialQuantity != null ? 'PARTIAL_CLOSE' : 'CLOSED',
    exitFee,
    closedAt: timestamp,
  };

  return closedRecord;
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
 * Check if TP1 (partial) is hit - for strategies with takeProfit1
 * @param {Object} trade - Open trade
 * @param {number} low - Candle low
 * @param {number} high - Candle high
 * @returns {boolean}
 */
function isTakeProfit1Hit(trade, low, high) {
  const tp1 = trade.takeProfit1;
  if (tp1 == null || trade.partialCloseDone) return false;
  if (trade.side === 'BUY') return high >= tp1;
  return low <= tp1;
}

/**
 * Check if trade should be closed this candle (SL or TP hit)
 * Uses candle high/low for realistic execution (no lookahead)
 * Order: SL first (conservative), then TP1 partial, then TP
 * @param {Object} trade - Open trade
 * @param {Array} candle - [timestamp, open, high, low, close, volume]
 * @returns {Object|null} { exitPrice, reason, partialCloseQuantity?, partialClosePrice? } or null
 */
function checkExitConditions(trade, candle) {
  const [, open, high, low, close] = candle;

  if (isStopLossHit(trade, low, high)) {
    return { exitPrice: trade.stopLoss, reason: 'STOP_LOSS' };
  }
  if (trade.takeProfit1 != null && isTakeProfit1Hit(trade, low, high)) {
    const partialPct = trade.partialClosePercent ?? 0.5;
    const partialQty = trade.quantity * partialPct;
    const exitPrice = trade.takeProfit1;
    return {
      exitPrice,
      reason: 'PARTIAL_TP1',
      partialCloseQuantity: partialQty,
      partialClosePrice: exitPrice,
    };
  }
  if (trade.takeProfit != null && isTakeProfitHit(trade, low, high)) {
    return { exitPrice: trade.takeProfit, reason: 'TAKE_PROFIT' };
  }

  return null;
}

module.exports = {
  openTrade,
  closeTrade,
  isStopLossHit,
  isTakeProfitHit,
  isTakeProfit1Hit,
  checkExitConditions,
};
