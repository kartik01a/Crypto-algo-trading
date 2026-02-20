/**
 * Strategy Engine - EMA + RSI strategy
 *
 * BUY: EMA9 > EMA21 AND RSI < 30 AND price > EMA50 (trend) AND ATR above threshold
 * SELL: EMA9 < EMA21 AND RSI > 70 AND price < EMA50 (trend)
 * HOLD: Otherwise
 */

const { EMA, RSI, ATR } = require('technicalindicators');
const config = require('../../config');
const { trendPullbackStrategy } = require('./trendPullbackStrategy');

const {
  emaShort,
  emaLong,
  emaTrend,
  rsiPeriod,
  rsiOversold,
  rsiOverbought,
  atrPeriod,
  atrThresholdPercent,
} = config.strategy;

/**
 * Calculate EMA values for a price series
 * @param {Array<number>} closes - Array of close prices
 * @param {number} period - EMA period
 * @returns {Array<number>} EMA values (same length as input, NaN for warmup)
 */
function calculateEMA(closes, period) {
  return EMA.calculate({ values: closes, period });
}

function last(arr) {
  return arr && arr.length ? arr[arr.length - 1] : undefined;
}

/**
 * Calculate RSI for a price series
 * @param {Array<number>} closes - Array of close prices
 * @param {number} period - RSI period
 * @returns {Array<number>} RSI values (same length as input, NaN for warmup)
 */
function calculateRSI(closes, period) {
  return RSI.calculate({ values: closes, period });
}

/**
 * Calculate ATR for OHLCV data
 * @param {Array<Array>} ohlcv - [timestamp, open, high, low, close, volume]
 * @param {number} period - ATR period
 * @returns {Array<number>} ATR values
 */
function calculateATR(ohlcv, period = atrPeriod) {
  const high = ohlcv.map((c) => c[2]);
  const low = ohlcv.map((c) => c[3]);
  const close = ohlcv.map((c) => c[4]);
  return ATR.calculate({ high, low, close, period });
}

/**
 * Generate trading signal from OHLCV data (base logic, no filters)
 * Uses only data up to and including current candle (no lookahead)
 *
 * @param {Array<Array>} ohlcv - Array of [timestamp, open, high, low, close, volume]
 * @returns {Object} { signal, price, timestamp, ema50, atr, ... }
 */
function generateSignalBase(ohlcv) {
  if (!ohlcv || ohlcv.length < emaLong + rsiPeriod) {
    return {
      signal: 'HOLD',
      price: ohlcv && ohlcv.length > 0 ? ohlcv[ohlcv.length - 1][4] : 0,
      timestamp: ohlcv && ohlcv.length > 0 ? ohlcv[ohlcv.length - 1][0] : Date.now(),
    };
  }

  const closes = ohlcv.map((c) => c[4]);
  const ema9Values = calculateEMA(closes, emaShort);
  const ema21Values = calculateEMA(closes, emaLong);
  const rsiValues = calculateRSI(closes, rsiPeriod);

  const lastIdx = closes.length - 1;
  const ema9 = last(ema9Values);
  const ema21 = last(ema21Values);
  const rsi = last(rsiValues);
  const price = closes[lastIdx];
  const timestamp = ohlcv[lastIdx][0];

  if (isNaN(ema9) || isNaN(ema21) || isNaN(rsi)) {
    return { signal: 'HOLD', price, timestamp };
  }

  let signal = 'HOLD';
  if (ema9 > ema21 && rsi < rsiOversold) signal = 'BUY';
  else if (ema9 < ema21 && rsi > rsiOverbought) signal = 'SELL';

  const result = { signal, price, timestamp, ema9, ema21, rsi };

  // Add EMA50 and ATR if enough data
  if (ohlcv.length >= emaTrend) {
    const ema50Values = calculateEMA(closes, emaTrend);
    result.ema50 = last(ema50Values);
  }
  if (ohlcv.length >= atrPeriod + 1) {
    const atrValues = calculateATR(ohlcv, atrPeriod);
    result.atr = last(atrValues);
  }

  return result;
}

/**
 * Apply ATR filter: only trade if ATR above threshold (% of price)
 */
function applyATRFilter(signalResult) {
  if (signalResult.signal === 'HOLD') return signalResult;
  if (signalResult.atr == null || isNaN(signalResult.atr)) return { ...signalResult, signal: 'HOLD' };

  const atrPercent = (signalResult.atr / signalResult.price) * 100;
  if (atrPercent < atrThresholdPercent) {
    return { ...signalResult, signal: 'HOLD', atrFilterRejected: true };
  }
  return signalResult;
}

/**
 * Apply trend filter (EMA50): BUY only if price > EMA50, SELL only if price < EMA50
 */
function applyTrendFilter(signalResult) {
  if (signalResult.signal === 'HOLD') return signalResult;
  if (signalResult.ema50 == null || isNaN(signalResult.ema50)) return signalResult;

  if (signalResult.signal === 'BUY' && signalResult.price <= signalResult.ema50) {
    return { ...signalResult, signal: 'HOLD', trendFilterRejected: true };
  }
  if (signalResult.signal === 'SELL' && signalResult.price >= signalResult.ema50) {
    return { ...signalResult, signal: 'HOLD', trendFilterRejected: true };
  }
  return signalResult;
}

/**
 * Generate trading signal with all filters (ATR, EMA50 trend)
 * @param {Array<Array>} ohlcv - OHLCV data
 * @returns {Object} Signal object
 */
function generateSignal(ohlcv) {
  let result = generateSignalBase(ohlcv);
  result = applyATRFilter(result);
  result = applyTrendFilter(result);
  return result;
}

/**
 * Generate signal from single candle (for paper trading with accumulated history)
 * @param {Array<Array>} ohlcvHistory - Full OHLCV history including latest
 * @returns {Object} Signal object
 */
function getSignal(ohlcvHistory) {
  return generateSignal(ohlcvHistory);
}

module.exports = {
  generateSignal,
  /**
   * Strategy selector. Defaults to existing EMA+RSI strategy.
   *
   * @param {Array<Array>} ohlcvHistory - LTF OHLCV history (5m)
   * @param {Object} [options]
   * @param {string} [options.strategy] - "trendPullback" to use the new strategy
   * @param {Array<Array>} [options.htfOhlcv] - HTF OHLCV history (15m) for trendPullback
   */
  getSignal: (ohlcvHistory, options = {}) => {
    try {
      if (options.strategy === 'trendPullback') {
        return trendPullbackStrategy({
          ltfOhlcv: ohlcvHistory,
          htfOhlcv: options.htfOhlcv || [],
        });
      }
      return generateSignal(ohlcvHistory);
    } catch (err) {
      return {
        signal: 'HOLD',
        price: ohlcvHistory && ohlcvHistory.length ? ohlcvHistory[ohlcvHistory.length - 1][4] : 0,
        timestamp: ohlcvHistory && ohlcvHistory.length ? ohlcvHistory[ohlcvHistory.length - 1][0] : Date.now(),
        error: err.message,
      };
    }
  },
  generateSignalBase,
  calculateEMA,
  calculateRSI,
  calculateATR,
  applyATRFilter,
  applyTrendFilter,
  trendPullbackStrategy,
};
