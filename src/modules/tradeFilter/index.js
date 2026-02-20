/**
 * Trade Filter Module
 * Filters out micro trades unprofitable due to fees.
 * No lookahead: uses only entry, SL, TP, ATR from signal.
 */

const { roundTo } = require('../../utils/helpers');

// Minimum stop loss as % of entry (SL = max(ATR-based SL, 0.7%))
const MIN_SL_PERCENT = 0.7;

// Minimum risk-reward ratio (TP distance = SL distance * 2) - for full TP; scalp uses 1R partial
const MIN_RR = 2;

// Skip trades where SL% < 0.68% (aligns with 0.7% min SL, small margin for rounding)
const MIN_SL_FILTER_PERCENT = 0.68;

// Total round-trip fees (entry + exit)
const TOTAL_FEES_PERCENT = 0.2;

// Only allow trades where expected TP% > 0.6% (net of fees)
const MIN_TP_PERCENT_FEE_AWARE = 0.6;

// ATR% must be > 0.25% for sufficient volatility
const MIN_ATR_PERCENT = 0.25;

/**
 * Apply minimum SL floor: SL distance = max(ATR-based distance, 0.5% of price)
 * @param {number} price - Entry price
 * @param {number} atrBasedSlDistance - Distance from ATR (positive number)
 * @returns {number} Enforced SL distance
 */
function enforceMinSlDistance(price, atrBasedSlDistance) {
  const minDistance = price * (MIN_SL_PERCENT / 100);
  return Math.max(atrBasedSlDistance, minDistance);
}

/**
 * Enforce minimum RR: TP distance = SL distance * MIN_RR
 * @param {number} slDistance - Stop loss distance (positive)
 * @returns {number} Take profit distance
 */
function enforceMinTpDistance(slDistance) {
  return slDistance * MIN_RR;
}

/**
 * Check if trade passes SL filter (SL% >= 0.4%)
 * @param {number} entryPrice - Entry price
 * @param {number} slDistance - Stop loss distance
 * @returns {{ pass: boolean, slPercent: number }}
 */
function checkSlFilter(entryPrice, slDistance) {
  const slPercent = entryPrice > 0 ? (slDistance / entryPrice) * 100 : 0;
  return {
    pass: slPercent >= MIN_SL_FILTER_PERCENT,
    slPercent: roundTo(slPercent, 4),
  };
}

/**
 * Check fee-aware filter: TP% > 0.6%
 * @param {number} entryPrice - Entry price
 * @param {number} tpDistance - Take profit distance
 * @returns {{ pass: boolean, tpPercent: number, feeImpact: number }}
 */
function checkFeeAwareFilter(entryPrice, tpDistance) {
  const tpPercent = entryPrice > 0 ? (tpDistance / entryPrice) * 100 : 0;
  const feeImpact = TOTAL_FEES_PERCENT;
  const netExpected = tpPercent - feeImpact;
  return {
    pass: tpPercent > MIN_TP_PERCENT_FEE_AWARE,
    tpPercent: roundTo(tpPercent, 4),
    feeImpact,
    netExpectedPercent: roundTo(netExpected, 4),
  };
}

/**
 * Check ATR filter: ATR% > 0.4%
 * @param {number} price - Entry price
 * @param {number} atr - ATR value
 * @returns {{ pass: boolean, atrPercent: number }}
 */
function checkAtrFilter(price, atr) {
  const atrPercent = price > 0 && atr != null ? (atr / price) * 100 : 0;
  return {
    pass: atrPercent > MIN_ATR_PERCENT,
    atrPercent: roundTo(atrPercent, 4),
  };
}

/**
 * Apply all trade filters. Returns { pass, reason, metrics }.
 * @param {Object} params
 * @param {number} params.entryPrice
 * @param {number} params.stopLoss
 * @param {number} params.takeProfit - or takeProfit1 for scalp
 * @param {number} params.atr
 * @param {string} params.side - 'BUY' or 'SELL'
 */
function applyTradeFilters({ entryPrice, stopLoss, takeProfit, atr, side }) {
  const slDistance = Math.abs(entryPrice - stopLoss);
  const tpPrice = takeProfit != null ? takeProfit : null;
  const tpDistance = tpPrice != null ? Math.abs(tpPrice - entryPrice) : slDistance * MIN_RR;

  const slCheck = checkSlFilter(entryPrice, slDistance);
  const feeCheck = checkFeeAwareFilter(entryPrice, tpDistance);
  const atrCheck = atr != null ? checkAtrFilter(entryPrice, atr) : { pass: true, atrPercent: null };

  const rr = slDistance > 0 ? roundTo(tpDistance / slDistance, 2) : 0;

  const metrics = {
    slPercent: slCheck.slPercent,
    tpPercent: feeCheck.tpPercent,
    rr,
    feeImpact: feeCheck.feeImpact,
    atrPercent: atrCheck.atrPercent,
  };

  if (!slCheck.pass) {
    return { pass: false, reason: 'SL_TOO_TIGHT', metrics };
  }
  if (!feeCheck.pass) {
    return { pass: false, reason: 'TP_TOO_LOW_FOR_FEES', metrics };
  }
  if (!atrCheck.pass) {
    return { pass: false, reason: 'ATR_TOO_LOW', metrics };
  }

  return { pass: true, reason: null, metrics };
}

/**
 * Build adjusted stops with min SL and min RR enforced.
 * @param {number} price - Entry price
 * @param {number} atr - ATR value
 * @param {string} side - 'BUY' or 'SELL'
 * @param {number} [atrSlDistance] - Raw ATR-based SL distance
 * @returns {{ stopLoss, takeProfit, takeProfit1, slDistance, tpDistance, slPercent, tpPercent, rr }}
 */
function buildAdjustedStops(price, atr, side, atrSlDistance) {
  const rawSlDistance = atrSlDistance != null ? atrSlDistance : (atr || 0);
  const slDistance = enforceMinSlDistance(price, rawSlDistance);
  const tpDistance = enforceMinTpDistance(slDistance);

  let stopLoss;
  let takeProfit;

  if (side === 'BUY') {
    stopLoss = roundTo(price - slDistance, 8);
    takeProfit = roundTo(price + tpDistance, 8);
  } else {
    stopLoss = roundTo(price + slDistance, 8);
    takeProfit = roundTo(price - tpDistance, 8);
  }

  const slPercent = (slDistance / price) * 100;
  const tpPercent = (tpDistance / price) * 100;
  const rr = slDistance > 0 ? tpDistance / slDistance : MIN_RR;

  return {
    stopLoss,
    takeProfit,
    takeProfit1: takeProfit, // For scalp compatibility
    slDistance,
    tpDistance,
    slPercent: roundTo(slPercent, 4),
    tpPercent: roundTo(tpPercent, 4),
    rr: roundTo(rr, 2),
  };
}

module.exports = {
  MIN_SL_PERCENT,
  MIN_RR,
  MIN_SL_FILTER_PERCENT,
  TOTAL_FEES_PERCENT,
  MIN_TP_PERCENT_FEE_AWARE,
  MIN_ATR_PERCENT,
  enforceMinSlDistance,
  enforceMinTpDistance,
  checkSlFilter,
  checkFeeAwareFilter,
  checkAtrFilter,
  applyTradeFilters,
  buildAdjustedStops,
};
