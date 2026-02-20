/**
 * Risk Management Module
 *
 * Rules:
 * - Risk per trade: 1% of balance
 * - Max trades per day: 3
 * - Max daily loss: 5%
 * - Max drawdown: 10%
 * - Stop Loss: 1.5% from entry
 * - Take Profit: 3% from entry
 * - Position size: riskAmount / stopLossDistance
 */

const config = require('../../config');
const { roundTo, getStartOfDay } = require('../../utils/helpers');

const {
  riskPerTrade,
  maxTradesPerDay,
  maxDailyLoss,
  maxDrawdown,
  stopLossPercent,
  takeProfitPercent,
  tradeCooldownMs,
} = config.risk;

/**
 * Check if we can open a new trade based on risk rules
 * @param {Object} state - Current trading state
 * @param {number} state.balance - Current balance
 * @param {number} state.peakBalance - Peak balance (for drawdown)
 * @param {number} state.initialBalance - Starting balance
 * @param {Array} state.tradesToday - Trades executed today
 * @param {number} state.dailyStartBalance - Balance at start of day
 * @param {number} [state.lastTradeClosedAt] - Timestamp of last closed trade (for cooldown)
 * @param {Object} [overrides]
 * @param {number} [overrides.maxTradesPerDay] - Optional override for max trades/day
 * @param {number} [overrides.tradeCooldownMs] - Optional override for cooldown (ms)
 * @param {number} [overrides.now] - Optional timestamp override (ms) for cooldown timing
 * @returns {Object} { allowed: boolean, reason?: string }
 */
function canOpenTrade(state, overrides = null) {
  const { balance, peakBalance, tradesToday, dailyStartBalance, lastTradeClosedAt } = state;
  const maxTrades = overrides && typeof overrides.maxTradesPerDay === 'number'
    ? overrides.maxTradesPerDay
    : maxTradesPerDay;
  const cooldownMs = overrides && typeof overrides.tradeCooldownMs === 'number'
    ? overrides.tradeCooldownMs
    : tradeCooldownMs;
  const now = overrides && typeof overrides.now === 'number' ? overrides.now : Date.now();

  // Trade cooldown: 10 minutes between trades
  if (lastTradeClosedAt && cooldownMs) {
    const elapsed = now - lastTradeClosedAt;
    if (elapsed < cooldownMs) {
      return { allowed: false, reason: 'Trade cooldown active' };
    }
  }

  // Max trades per day
  if (tradesToday && tradesToday.length >= maxTrades) {
    return { allowed: false, reason: 'Max trades per day reached' };
  }

  // Max drawdown check
  const currentDrawdown = peakBalance > 0 ? (peakBalance - balance) / peakBalance : 0;
  if (currentDrawdown >= maxDrawdown) {
    return { allowed: false, reason: 'Max drawdown exceeded' };
  }

  // Max daily loss check
  const dailyLoss = dailyStartBalance > 0 ? (dailyStartBalance - balance) / dailyStartBalance : 0;
  if (dailyLoss >= maxDailyLoss) {
    return { allowed: false, reason: 'Max daily loss exceeded' };
  }

  return { allowed: true };
}

/**
 * Calculate stop loss price
 * @param {number} entryPrice - Entry price
 * @param {string} side - 'BUY' or 'SELL'
 * @returns {number} Stop loss price
 */
function calculateStopLoss(entryPrice, side) {
  if (side === 'BUY') {
    return roundTo(entryPrice * (1 - stopLossPercent), 8);
  }
  return roundTo(entryPrice * (1 + stopLossPercent), 8);
}

/**
 * Calculate take profit price
 * @param {number} entryPrice - Entry price
 * @param {string} side - 'BUY' or 'SELL'
 * @returns {number} Take profit price
 */
function calculateTakeProfit(entryPrice, side) {
  if (side === 'BUY') {
    return roundTo(entryPrice * (1 + takeProfitPercent), 8);
  }
  return roundTo(entryPrice * (1 - takeProfitPercent), 8);
}

/**
 * Calculate position size based on risk
 * positionSize = riskAmount / stopLossDistance
 *
 * @param {number} balance - Current balance
 * @param {number} entryPrice - Entry price
 * @param {string} side - 'BUY' or 'SELL'
 * @returns {number} Position size in base currency (e.g., BTC amount)
 */
function calculatePositionSize(balance, entryPrice, side) {
  const riskAmount = balance * riskPerTrade;
  const stopLossPrice = calculateStopLoss(entryPrice, side);

  let stopLossDistance;
  if (side === 'BUY') {
    stopLossDistance = entryPrice - stopLossPrice;
  } else {
    stopLossDistance = stopLossPrice - entryPrice;
  }

  if (stopLossDistance <= 0) {
    return 0;
  }

  // Position size (in base currency) = riskAmount / stopLossDistance
  // riskAmount in quote (USDT), stopLossDistance in price units
  // Loss = quantity * stopLossDistance = riskAmount => quantity = riskAmount / stopLossDistance
  const positionSize = riskAmount / stopLossDistance;

  return roundTo(Math.max(0, positionSize), 8);
}

/**
 * Calculate position size when stop loss is provided (dynamic SL).
 * Useful for ATR-based strategies.
 *
 * @param {number} balance - Current balance
 * @param {number} entryPrice - Entry price
 * @param {number} stopLoss - Stop loss price
 * @param {number} [riskPercentOverride] - Override risk per trade (e.g. 0.015 for 1.5%)
 * @returns {number} Position size in base currency
 */
function calculatePositionSizeWithStop(balance, entryPrice, stopLoss, riskPercentOverride = null) {
  const riskPct = riskPercentOverride != null ? riskPercentOverride : riskPerTrade;
  const riskAmount = balance * riskPct;
  const stopLossDistance = Math.abs(entryPrice - stopLoss);
  if (!stopLossDistance || stopLossDistance <= 0) return 0;
  const positionSize = riskAmount / stopLossDistance;
  return roundTo(Math.max(0, positionSize), 8);
}

/**
 * Get risk parameters for a trade
 * @param {number} entryPrice - Entry price
 * @param {string} side - 'BUY' or 'SELL'
 * @param {number} balance - Current balance
 * @returns {Object} { stopLoss, takeProfit, positionSize }
 */
function getTradeRiskParams(entryPrice, side, balance) {
  return {
    stopLoss: calculateStopLoss(entryPrice, side),
    takeProfit: calculateTakeProfit(entryPrice, side),
    positionSize: calculatePositionSize(balance, entryPrice, side),
  };
}

/**
 * Get risk params when SL/TP are supplied by strategy (dynamic).
 * @param {number} entryPrice
 * @param {string} side - 'BUY' or 'SELL'
 * @param {number} stopLoss
 * @param {number} takeProfit
 * @param {number} balance
 * @param {number} [riskPercentOverride] - Override risk per trade (e.g. 0.018 for 1.8%)
 */
function getTradeRiskParamsCustom(entryPrice, side, stopLoss, takeProfit, balance, riskPercentOverride = null) {
  return {
    stopLoss,
    takeProfit,
    positionSize: calculatePositionSizeWithStop(balance, entryPrice, stopLoss, riskPercentOverride),
    side,
  };
}

module.exports = {
  canOpenTrade,
  calculateStopLoss,
  calculateTakeProfit,
  calculatePositionSize,
  calculatePositionSizeWithStop,
  getTradeRiskParams,
  getTradeRiskParamsCustom,
};
