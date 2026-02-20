/**
 * Scalp Momentum Strategy (Structure-Based Breakout)
 *
 * Entry: Structure-based breakout (no RSI)
 * - BUY: Price breaks above highest high of last 2 candles
 * - SELL: Price breaks below lowest low of last 2 candles
 *
 * Filters:
 * - Pullback: Price within 1 ATR of EMA20 (current or last 2 candles)
 * - ADX(14) > 15
 * - HTF trend: Reject BUY when HTF DOWN, reject SELL when HTF UP (allow NONE)
 * - ATR% > 0.25
 * - Volume filter: DISABLED
 * - Late entry filter: DISABLED
 *
 * Exits:
 * - SL = recent swing low/high or 1 ATR (min 0.7%)
 * - TP1 = 1R (close 50% position)
 * - No fixed TP; remaining position runs with trailing stop
 *
 * Trailing:
 * - At 1R: move SL to breakeven, partial close 50%, start trailing
 * - Trail using EMA20 or ATR-based
 *
 * No lookahead: uses only closed candles, correct candle alignment.
 */

const { EMA, ATR, ADX } = require('technicalindicators');
const { roundTo } = require('../../utils/helpers');
const {
  enforceMinSlDistance,
  enforceMinTpDistance,
  MIN_ATR_PERCENT,
  applyTradeFilters,
} = require('../tradeFilter');

const LTF_EMA_PERIOD = 20;
const LTF_ATR_PERIOD = 14;
const ADX_PERIOD = 14;
const BREAKOUT_LOOKBACK = 2;
const PULLBACK_LOOKBACK = 2;
const PULLBACK_ATR_MULT = 1; // Allow trade if price within 1 ATR of EMA20 (per user spec)

const MIN_ADX = 15;
const STRATEGY_MIN_ATR_PERCENT = 0.25; // Relaxed from 0.4% to allow more trades; tradeFilter still enforces fee-aware TP

const HTF_EMA_FAST = 20;
const HTF_EMA_SLOW = 50;
const HTF_PERIOD_MS = 60 * 60 * 1000; // 1h - only use closed HTF candles (no lookahead)

const SL_ATR_MULT = 1;
const TP1_R_MULT = 1; // 1R partial close 50%
const TP1_CLOSE_PERCENT = 0.5;
const BREAKEVEN_R_MULT = 1;
const TRAIL_EMA_R_MULT = 1; // Start trailing at 1R (same as breakeven)

function last(arr) {
  return arr && arr.length ? arr[arr.length - 1] : undefined;
}

function clipToTimestamp(ohlcv, ts) {
  if (!ohlcv || ohlcv.length === 0) return [];
  let end = ohlcv.length - 1;
  while (end >= 0 && ohlcv[end][0] > ts) end--;
  return end >= 0 ? ohlcv.slice(0, end + 1) : [];
}

/**
 * Clip HTF to only closed candles (no lookahead).
 * An HTF candle with open time T closes at T + HTF_PERIOD_MS.
 */
function clipToClosedHtf(ohlcv, ltfTimestamp) {
  if (!ohlcv || ohlcv.length === 0) return [];
  const result = [];
  for (let i = 0; i < ohlcv.length; i++) {
    const candleOpen = ohlcv[i][0];
    if (candleOpen + HTF_PERIOD_MS <= ltfTimestamp) {
      result.push(ohlcv[i]);
    }
  }
  return result;
}

/**
 * Get HTF trend from closed candles: { ema20, ema50, trend: 'UP'|'DOWN'|'NONE' }
 * BUY: trend === 'UP' (ema20 > ema50), SELL: trend === 'DOWN' (ema20 < ema50)
 */
function getHtfTrend(htfOhlcv, ltfTimestamp) {
  const closed = clipToClosedHtf(htfOhlcv || [], ltfTimestamp);
  const minCandles = HTF_EMA_SLOW + 1;
  if (closed.length < minCandles) {
    return { trend: 'NONE', reason: 'INSUFFICIENT_HTF_CANDLES', ema20: null, ema50: null };
  }
  const closes = closed.map((c) => c[4]);
  const ema20Arr = calculateEma(closes, HTF_EMA_FAST);
  const ema50Arr = calculateEma(closes, HTF_EMA_SLOW);
  const ema20 = last(ema20Arr);
  const ema50 = last(ema50Arr);
  if (ema20 == null || ema50 == null || Number.isNaN(ema20) || Number.isNaN(ema50)) {
    return { trend: 'NONE', reason: 'HTF_INDICATOR_NAN', ema20, ema50 };
  }
  if (ema20 > ema50) return { trend: 'UP', ema20, ema50 };
  if (ema20 < ema50) return { trend: 'DOWN', ema20, ema50 };
  return { trend: 'NONE', ema20, ema50, reason: 'HTF_EMA_FLAT' };
}

function calculateEma(values, period) {
  return EMA.calculate({ values, period });
}

function calculateAtr(ohlcv, period) {
  const high = ohlcv.map((c) => c[2]);
  const low = ohlcv.map((c) => c[3]);
  const close = ohlcv.map((c) => c[4]);
  return ATR.calculate({ high, low, close, period });
}

function calculateAdx(ohlcv, period) {
  const high = ohlcv.map((c) => c[2]);
  const low = ohlcv.map((c) => c[3]);
  const close = ohlcv.map((c) => c[4]);
  return ADX.calculate({ high, low, close, period });
}

/**
 * Build stops: SL = max(swing/ATR-based, 0.7% min), TP1 = 1R (partial close 50%)
 * No fixed TP; remaining position trails with EMA20.
 */
function buildStops(price, atr, side, swingLow, swingHigh) {
  const rawSlDistance = SL_ATR_MULT * atr;
  const slDistance = enforceMinSlDistance(price, rawSlDistance);
  const tp1Distance = slDistance * TP1_R_MULT; // 1R for partial
  const minSlPrice = price * 0.007; // 0.7% minimum distance

  if (side === 'BUY') {
    const atrSl = price - slDistance;
    const swingSl = swingLow != null ? swingLow : atrSl;
    const candidateSl = Math.max(swingSl, atrSl);
    const stopLoss = Math.min(price - minSlPrice, candidateSl);
    const takeProfit1 = price + tp1Distance;
    return {
      stopLoss: roundTo(stopLoss, 8),
      takeProfit1: roundTo(takeProfit1, 8),
      takeProfit: null,
    };
  }
  const atrSl = price + slDistance;
  const swingSl = swingHigh != null ? swingHigh : atrSl;
  const candidateSl = Math.min(swingSl, atrSl);
  const stopLoss = Math.max(price + minSlPrice, candidateSl);
  const takeProfit1 = price - tp1Distance;
  return {
    stopLoss: roundTo(stopLoss, 8),
    takeProfit1: roundTo(takeProfit1, 8),
    takeProfit: null,
  };
}

/**
 * Structure-based breakout strategy.
 * Uses last closed candle only - no lookahead bias.
 *
 * @param {Object} params
 * @param {Array<Array>} params.ltfOhlcv - 5m candles [ts, open, high, low, close, vol]
 * @param {Array<Array>} params.htfOhlcv - 15m candles (unused, kept for API compat)
 */
function scalpMomentumStrategy({ ltfOhlcv, htfOhlcv }) {
  const minLtfCandles = Math.max(
    50,
    LTF_EMA_PERIOD,
    LTF_ATR_PERIOD + 2,
    ADX_PERIOD + 10,
    BREAKOUT_LOOKBACK + PULLBACK_LOOKBACK + 2
  );
  if (!ltfOhlcv || ltfOhlcv.length < minLtfCandles) {
    return {
      signal: 'HOLD',
      price: 0,
      entryPrice: null,
      stopLoss: null,
      takeProfit: null,
      takeProfit1: null,
      riskReward: null,
      atr: null,
      ema20: null,
      debug: { signalReason: 'INSUFFICIENT_LTF_CANDLES' },
    };
  }

  const current = last(ltfOhlcv);
  const price = current[4];
  const timestamp = current[0];

  const ltfCloses = ltfOhlcv.map((c) => c[4]);

  const ema20Arr = calculateEma(ltfCloses, LTF_EMA_PERIOD);
  const atrArr = calculateAtr(ltfOhlcv, LTF_ATR_PERIOD);
  const adxArr = calculateAdx(ltfOhlcv, ADX_PERIOD);

  if (
    ema20Arr.length < 2 ||
    atrArr.length < 1 ||
    adxArr.length < 1
  ) {
    return {
      signal: 'HOLD',
      price,
      entryPrice: null,
      stopLoss: null,
      takeProfit: null,
      takeProfit1: null,
      riskReward: null,
      atr: null,
      ema20: null,
      debug: { signalReason: 'INSUFFICIENT_INDICATORS', logMessage: 'REJECTED: INSUFFICIENT_INDICATORS' },
    };
  }

  const ema20 = last(ema20Arr);
  const atr = last(atrArr);
  const adxLast = last(adxArr);
  const adx = typeof adxLast === 'object' ? adxLast.adx : adxLast;

  const atrPercent = (atr / price) * 100;

  const htfTrend = getHtfTrend(htfOhlcv, timestamp);

  const baseDebug = {
    atrPercent,
    adx,
    htfTrend: htfTrend.trend,
    htfEma20: htfTrend.ema20,
    htfEma50: htfTrend.ema50,
    signalReason: null,
  };

  if (adx == null || Number.isNaN(adx) || adx <= MIN_ADX) {
    return {
      signal: 'HOLD',
      price,
      entryPrice: null,
      stopLoss: null,
      takeProfit: null,
      takeProfit1: null,
      riskReward: null,
      atr,
      ema20,
      debug: { ...baseDebug, signalReason: 'ADX_TOO_LOW', logMessage: `REJECTED: ADX_TOO_LOW (adx=${adx}, min=${MIN_ADX})` },
    };
  }

  if (atrPercent <= STRATEGY_MIN_ATR_PERCENT) {
    return {
      signal: 'HOLD',
      price,
      entryPrice: null,
      stopLoss: null,
      takeProfit: null,
      takeProfit1: null,
      riskReward: null,
      atr,
      ema20,
      debug: { ...baseDebug, signalReason: 'ATR_TOO_LOW', logMessage: `REJECTED: ATR_TOO_LOW (atr%=${roundTo(atrPercent, 2)}%, min=${STRATEGY_MIN_ATR_PERCENT}%)` },
    };
  }

  const prevCandles = ltfOhlcv.slice(-(BREAKOUT_LOOKBACK + 1), -1);
  if (prevCandles.length < BREAKOUT_LOOKBACK) {
    return {
      signal: 'HOLD',
      price,
      entryPrice: null,
      stopLoss: null,
      takeProfit: null,
      takeProfit1: null,
      riskReward: null,
      atr,
      ema20,
      debug: { ...baseDebug, signalReason: 'INSUFFICIENT_BREAKOUT_DATA', logMessage: 'REJECTED: INSUFFICIENT_BREAKOUT_DATA' },
    };
  }

  const highestHigh = Math.max(...prevCandles.map((c) => c[2]));
  const lowestLow = Math.min(...prevCandles.map((c) => c[3]));

  const pullbackCandles = ltfOhlcv.slice(-(BREAKOUT_LOOKBACK + 1), -1);

  if (price > highestHigh) {
    // HTF filter: BUY only when HTF EMA20 > EMA50 (trend UP or NONE when insufficient data)
    if (htfTrend.trend === 'DOWN') {
      return {
        signal: 'HOLD',
        price,
        entryPrice: null,
        stopLoss: null,
        takeProfit: null,
        takeProfit1: null,
        riskReward: null,
        atr,
        ema20,
        debug: { ...baseDebug, signalReason: `HTF_TREND_NOT_UP_${htfTrend.trend}`, logMessage: `REJECTED: HTF_TREND_NOT_UP (htfTrend=${htfTrend.trend}, need EMA20>EMA50)` },
      };
    }
    // Pullback: allow if price within PULLBACK_ATR_MULT * ATR of EMA20 (use current price or any of last N candles)
    const pullbackNearEma = Math.abs(price - ema20) <= PULLBACK_ATR_MULT * atr
      || pullbackCandles.some((c, j) => {
        const candleIdx = ltfOhlcv.length - BREAKOUT_LOOKBACK - 1 + j;
        const emaAtCandle = ema20Arr[candleIdx];
        if (emaAtCandle == null || Number.isNaN(emaAtCandle)) return false;
        const distFromEma = Math.abs(c[3] - emaAtCandle); // low for BUY
        return distFromEma <= PULLBACK_ATR_MULT * atr;
      });
    if (!pullbackNearEma) {
      return {
        signal: 'HOLD',
        price,
        entryPrice: null,
        stopLoss: null,
        takeProfit: null,
        takeProfit1: null,
        riskReward: null,
        atr,
        ema20,
        debug: { ...baseDebug, signalReason: 'NO_PULLBACK_NEAR_EMA20', logMessage: `REJECTED: NO_PULLBACK_NEAR_EMA20 (price not within ${PULLBACK_ATR_MULT} ATR of EMA20 in last ${BREAKOUT_LOOKBACK} candles)` },
      };
    }
    const { stopLoss, takeProfit1 } = buildStops(price, atr, 'BUY', lowestLow, null);
    const filterResult = applyTradeFilters({
      entryPrice: price,
      stopLoss,
      takeProfit: takeProfit1,
      atr,
      side: 'BUY',
    });
    if (!filterResult.pass) {
      return {
        signal: 'HOLD',
        price,
        entryPrice: null,
        stopLoss: null,
        takeProfit: null,
        takeProfit1: null,
        riskReward: null,
        atr,
        ema20,
        debug: { ...baseDebug, signalReason: `TRADE_FILTER_${filterResult.reason}`, tradeMetrics: filterResult.metrics, logMessage: `REJECTED: TRADE_FILTER_${filterResult.reason}` },
      };
    }
    const riskDistance = price - stopLoss;
    const tpDistance = takeProfit1 - price;
    const rr = riskDistance > 0 ? tpDistance / riskDistance : 0;
    return {
      signal: 'BUY',
      price,
      entryPrice: price,
      stopLoss,
      takeProfit: null,
      takeProfit1,
      riskReward: rr,
      atr,
      ema20,
      tradeMetrics: filterResult.metrics,
      debug: { ...baseDebug, signalReason: 'BUY_STRUCTURE_BREAKOUT', tradeMetrics: filterResult.metrics, logMessage: `ACCEPTED: BUY_STRUCTURE_BREAKOUT price=${roundTo(price, 2)} rr=${roundTo(rr, 2)} sl=${roundTo(stopLoss, 2)}` },
    };
  }

  if (price < lowestLow) {
    // HTF filter: SELL only when HTF EMA20 < EMA50 (trend DOWN or NONE when insufficient data)
    if (htfTrend.trend === 'UP') {
      return {
        signal: 'HOLD',
        price,
        entryPrice: null,
        stopLoss: null,
        takeProfit: null,
        takeProfit1: null,
        riskReward: null,
        atr,
        ema20,
        debug: { ...baseDebug, signalReason: `HTF_TREND_NOT_DOWN_${htfTrend.trend}`, logMessage: `REJECTED: HTF_TREND_NOT_DOWN (htfTrend=${htfTrend.trend}, need EMA20<EMA50)` },
      };
    }
    // Pullback: allow if price within PULLBACK_ATR_MULT * ATR of EMA20 (use current price or any of last N candles)
    const pullbackNearEma = Math.abs(price - ema20) <= PULLBACK_ATR_MULT * atr
      || pullbackCandles.some((c, j) => {
        const candleIdx = ltfOhlcv.length - BREAKOUT_LOOKBACK - 1 + j;
        const emaAtCandle = ema20Arr[candleIdx];
        if (emaAtCandle == null || Number.isNaN(emaAtCandle)) return false;
        const distFromEma = Math.abs(c[2] - emaAtCandle); // high for SELL
        return distFromEma <= PULLBACK_ATR_MULT * atr;
      });
    if (!pullbackNearEma) {
      return {
        signal: 'HOLD',
        price,
        entryPrice: null,
        stopLoss: null,
        takeProfit: null,
        takeProfit1: null,
        riskReward: null,
        atr,
        ema20,
        debug: { ...baseDebug, signalReason: 'NO_PULLBACK_NEAR_EMA20', logMessage: 'REJECTED: NO_PULLBACK_NEAR_EMA20 (price not within 1 ATR of EMA20 in last 2 candles)' },
      };
    }
    const { stopLoss, takeProfit1 } = buildStops(price, atr, 'SELL', null, highestHigh);
    const filterResult = applyTradeFilters({
      entryPrice: price,
      stopLoss,
      takeProfit: takeProfit1,
      atr,
      side: 'SELL',
    });
    if (!filterResult.pass) {
      return {
        signal: 'HOLD',
        price,
        entryPrice: null,
        stopLoss: null,
        takeProfit: null,
        takeProfit1: null,
        riskReward: null,
        atr,
        ema20,
        debug: { ...baseDebug, signalReason: `TRADE_FILTER_${filterResult.reason}`, tradeMetrics: filterResult.metrics, logMessage: `REJECTED: TRADE_FILTER_${filterResult.reason}` },
      };
    }
    const riskDistance = stopLoss - price;
    const tpDistance = price - takeProfit1;
    const rr = riskDistance > 0 ? tpDistance / riskDistance : 0;
    return {
      signal: 'SELL',
      price,
      entryPrice: price,
      stopLoss,
      takeProfit: null,
      takeProfit1,
      riskReward: rr,
      atr,
      ema20,
      tradeMetrics: filterResult.metrics,
      debug: { ...baseDebug, signalReason: 'SELL_STRUCTURE_BREAKOUT', tradeMetrics: filterResult.metrics, logMessage: `ACCEPTED: SELL_STRUCTURE_BREAKOUT price=${roundTo(price, 2)} rr=${roundTo(rr, 2)} sl=${roundTo(stopLoss, 2)}` },
    };
  }

  return {
    signal: 'HOLD',
    price,
    entryPrice: null,
    stopLoss: null,
    takeProfit: null,
    takeProfit1: null,
    riskReward: null,
    atr,
    ema20,
    debug: { ...baseDebug, signalReason: 'ENTRY_CONDITION_FAILED', logMessage: 'REJECTED: ENTRY_CONDITION_FAILED (no breakout: price within range)' },
  };
}

/**
 * Trailing stop:
 * - At 1R: move SL to breakeven, partial close 50%, start trailing
 * - Trail using EMA20 (or ATR-based if EMA unavailable)
 */
function applyScalpMomentumTrailingStop(trade, currentPrice, atr, ema20) {
  const result = { trade };
  if (!trade || trade.status !== 'OPEN') return result;
  if (!trade.entryPrice || !trade.stopLoss) return result;

  const side = trade.side || 'BUY';
  const riskDistance =
    trade.initialRiskDistance ||
    trade.riskDistance ||
    (trade.initialStopLoss ? Math.abs(trade.entryPrice - trade.initialStopLoss) : Math.abs(trade.entryPrice - trade.stopLoss));
  if (!riskDistance || riskDistance <= 0) return result;

  const profit = side === 'BUY' ? currentPrice - trade.entryPrice : trade.entryPrice - currentPrice;
  const rMultiple = profit / riskDistance;

  let newSL = trade.stopLoss;

  if (rMultiple >= BREAKEVEN_R_MULT) {
    if (side === 'BUY') {
      newSL = Math.max(newSL, trade.entryPrice);
    } else {
      newSL = Math.min(newSL, trade.entryPrice);
    }
  }

  // Trail using EMA20 or ATR-based (lock in 0.5R) when EMA unavailable
  if (rMultiple >= TRAIL_EMA_R_MULT) {
    if (typeof ema20 === 'number' && !Number.isNaN(ema20)) {
      if (side === 'BUY') {
        newSL = Math.max(newSL, ema20);
      } else {
        newSL = Math.min(newSL, ema20);
      }
    } else {
      const trailLockIn = 0.5 * riskDistance; // Lock in 0.5R when EMA unavailable
      if (side === 'BUY') {
        newSL = Math.max(newSL, trade.entryPrice + trailLockIn);
      } else {
        newSL = Math.min(newSL, trade.entryPrice - trailLockIn);
      }
    }
  }

  if (rMultiple >= TP1_R_MULT && !trade.partialCloseDone) {
    result.partialCloseQuantity = roundTo(trade.quantity * TP1_CLOSE_PERCENT, 8);
    result.partialClosePrice = side === 'BUY'
      ? trade.entryPrice + riskDistance
      : trade.entryPrice - riskDistance;
  }

  if (newSL !== trade.stopLoss) {
    result.trade = {
      ...trade,
      stopLoss: roundTo(newSL, 8),
      initialRiskDistance: trade.initialRiskDistance || riskDistance,
      initialStopLoss: trade.initialStopLoss || trade.stopLoss,
    };
  } else {
    result.trade = trade;
  }

  return result;
}

module.exports = {
  scalpMomentumStrategy,
  applyScalpMomentumTrailingStop,
  SL_ATR_MULT,
  TP1_R_MULT,
  TP1_CLOSE_PERCENT,
  BREAKEVEN_R_MULT,
  TRAIL_EMA_R_MULT,
  GAP_THRESHOLD_PERCENT: 0.3,
};
