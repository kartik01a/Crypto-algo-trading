const { EMA, RSI, ATR } = require('technicalindicators');
const { roundTo } = require('../../utils/helpers');
const {
  enforceMinSlDistance,
  enforceMinTpDistance,
  MIN_ATR_PERCENT,
  applyTradeFilters,
} = require('../tradeFilter');

const LTF_EMA_PERIOD = 20;
const LTF_RSI_PERIOD = 14;
const LTF_ATR_PERIOD = 14;

const HTF_EMA_FAST = 20;
const HTF_EMA_SLOW = 50;
const HTF_LOOKBACK = 60;

const MIN_CANDLES = 50;

// Filters (per spec)
const TREND_STRENGTH_MIN = 0.0015; // 0.15%
const ATR_VOL_THRESHOLD = MIN_ATR_PERCENT / 100; // 0.4%

// Strict pullback bands (relative to EMA20, normalized by price)
const PULLBACK_BUY_MIN = -0.015;
const PULLBACK_BUY_MAX = -0.002;
const PULLBACK_SELL_MIN = 0.002;
const PULLBACK_SELL_MAX = 0.015;

// RSI filters + no-trade zone
const RSI_BUY_MIN = 30;
const RSI_BUY_MAX = 55;
const RSI_SELL_MIN = 45;
const RSI_SELL_MAX = 70;

function last(arr) {
  return arr && arr.length ? arr[arr.length - 1] : undefined;
}

function lastN(arr, n) {
  if (!arr || arr.length < n) return null;
  return arr.slice(-n);
}

function calculateEmaLast(closes, period) {
  const values = EMA.calculate({ values: closes, period });
  return last(values);
}

function calculateRsiLastTwo(closes, period) {
  const values = RSI.calculate({ values: closes, period });
  if (values.length < 2) return null;
  return values.slice(-2);
}

function calculateAtrLast(ohlcv, period) {
  const high = ohlcv.map((c) => c[2]);
  const low = ohlcv.map((c) => c[3]);
  const close = ohlcv.map((c) => c[4]);
  const values = ATR.calculate({ high, low, close, period });
  return last(values);
}

function clipToTimestamp(ohlcv, ts) {
  if (!ohlcv || ohlcv.length === 0) return [];
  let end = ohlcv.length - 1;
  while (end >= 0 && ohlcv[end][0] > ts) end -= 1;
  return end >= 0 ? ohlcv.slice(0, end + 1) : [];
}

function inRangeInclusive(x, min, max) {
  return x >= min && x <= max;
}

function getTrendFromHtf(htfOhlcv) {
  const candles = lastN(htfOhlcv, Math.max(HTF_LOOKBACK, HTF_EMA_SLOW, MIN_CANDLES));
  if (!candles) return { trend: 'NONE', reason: 'INSUFFICIENT_HTF_CANDLES' };

  const closes = candles.map((c) => c[4]);
  const ema20 = calculateEmaLast(closes, HTF_EMA_FAST);
  const ema50 = calculateEmaLast(closes, HTF_EMA_SLOW);
  const price = last(closes);

  if ([ema20, ema50, price].some((v) => typeof v !== 'number' || Number.isNaN(v))) {
    return { trend: 'NONE', reason: 'HTF_INDICATOR_NAN', ema20, ema50, price };
  }

  const trendStrengthSigned = (ema20 - ema50) / price;
  const trendStrength = Math.abs(trendStrengthSigned);

  if (ema20 > ema50 && price > ema50) return { trend: 'UP', ema20, ema50, price, trendStrength, trendStrengthSigned };
  if (ema20 < ema50 && price < ema50) return { trend: 'DOWN', ema20, ema50, price, trendStrength, trendStrengthSigned };
  return { trend: 'NONE', ema20, ema50, price };
}

function buildStops(price, atr, side) {
  const rawSlDistance = 1.0 * atr;
  const slDistance = enforceMinSlDistance(price, rawSlDistance);
  const tpDistance = enforceMinTpDistance(slDistance);

  if (side === 'BUY') {
    return {
      stopLoss: roundTo(price - slDistance, 8),
      takeProfit: roundTo(price + tpDistance, 8),
    };
  }
  return {
    stopLoss: roundTo(price + slDistance, 8),
    takeProfit: roundTo(price - tpDistance, 8),
  };
}

/**
 * Multi-timeframe trend-following pullback strategy with confirmation.
 *
 * @param {Object} params
 * @param {Array<Array>} params.ltfOhlcv - 5m candles [ts, open, high, low, close, vol]
 * @param {Array<Array>} params.htfOhlcv - 15m candles [ts, open, high, low, close, vol]
 * @returns {{signal:"BUY"|"SELL"|"HOLD", price:number, stopLoss?:number, takeProfit?:number, atr?:number, trend:"UP"|"DOWN"|"NONE"}}
 */
function trendPullbackStrategy({ ltfOhlcv, htfOhlcv }) {
  const ltfLast = last(ltfOhlcv);
  if (!ltfLast) {
    return {
      signal: 'HOLD',
      price: 0,
      stopLoss: null,
      takeProfit: null,
      atr: null,
      trend: 'NONE',
      debug: { reason: 'NO_LTF_CANDLES' },
    };
  }

  const price = ltfLast[4];
  const timestamp = ltfLast[0];
  const htfAligned = clipToTimestamp(htfOhlcv || [], timestamp);

  const debug = {
    params: {
      minCandles: MIN_CANDLES,
      atrVolThreshold: ATR_VOL_THRESHOLD,
      trendStrengthMin: TREND_STRENGTH_MIN,
      pullbackBuy: [PULLBACK_BUY_MIN, PULLBACK_BUY_MAX],
      pullbackSell: [PULLBACK_SELL_MIN, PULLBACK_SELL_MAX],
      rsiBuy: [RSI_BUY_MIN, RSI_BUY_MAX],
      rsiSell: [RSI_SELL_MIN, RSI_SELL_MAX],
    },
    candles: {
      ltfLen: (ltfOhlcv || []).length,
      htfLen: (htfAligned || []).length,
      minRequired: MIN_CANDLES,
      ok: (ltfOhlcv || []).length >= MIN_CANDLES && (htfAligned || []).length >= MIN_CANDLES,
    },
    alignment: {
      ltfTimestamp: timestamp,
      htfLastTimestamp: htfAligned && htfAligned.length ? htfAligned[htfAligned.length - 1][0] : null,
      ok: htfAligned && htfAligned.length ? htfAligned[htfAligned.length - 1][0] <= timestamp : false,
    },
  };

  if (!debug.candles.ok) {
    const trendInfo = getTrendFromHtf(htfAligned || []);
    debug.trend = {
      trend: trendInfo.trend,
      ema20: trendInfo.ema20 ?? null,
      ema50: trendInfo.ema50 ?? null,
      price: trendInfo.price ?? null,
      trendStrength: trendInfo.trendStrength ?? null,
      ok: false,
      reason: trendInfo.reason || 'INSUFFICIENT_CANDLES',
    };
    return { signal: 'HOLD', price, timestamp, stopLoss: null, takeProfit: null, atr: null, trend: 'NONE', debug };
  }

  const ltfNeed = Math.max(
    MIN_CANDLES,
    LTF_EMA_PERIOD,
    LTF_RSI_PERIOD + 2,
    LTF_ATR_PERIOD + 2
  );
  const ltfCandles = lastN(ltfOhlcv, ltfNeed);
  if (!ltfCandles) {
    debug.reason = 'INSUFFICIENT_LTF_FOR_INDICATORS';
    const trendInfo = getTrendFromHtf(htfAligned || []);
    debug.trend = { trend: trendInfo.trend, ok: false, reason: trendInfo.reason || null };
    return { signal: 'HOLD', price, timestamp, stopLoss: null, takeProfit: null, atr: null, trend: 'NONE', debug };
  }

  const closes = ltfCandles.map((c) => c[4]);
  const ema20 = calculateEmaLast(closes, LTF_EMA_PERIOD);
  const rsiLastTwo = calculateRsiLastTwo(closes, LTF_RSI_PERIOD);
  const atr = calculateAtrLast(ltfCandles, LTF_ATR_PERIOD);

  const trendInfo = getTrendFromHtf(htfAligned || []);
  const trend = trendInfo.trend;
  const trendStrength = typeof trendInfo.trendStrength === 'number' ? trendInfo.trendStrength : null;
  debug.trend = {
    trend,
    ema20: trendInfo.ema20 ?? null,
    ema50: trendInfo.ema50 ?? null,
    price: trendInfo.price ?? null,
    trendStrength,
    ok: trend === 'UP' || trend === 'DOWN',
    reason: trendInfo.reason || null,
  };

  if ([ema20, atr].some((v) => typeof v !== 'number' || Number.isNaN(v)) || !rsiLastTwo) {
    debug.indicators = {
      ema20: typeof ema20 === 'number' && !Number.isNaN(ema20) ? ema20 : null,
      atr: typeof atr === 'number' && !Number.isNaN(atr) ? atr : null,
      rsiPrev: rsiLastTwo ? rsiLastTwo[0] : null,
      rsiNow: rsiLastTwo ? rsiLastTwo[1] : null,
      ok: false,
      reason: 'INDICATOR_NAN_OR_MISSING',
    };
    return {
      signal: 'HOLD',
      price,
      timestamp,
      stopLoss: null,
      takeProfit: null,
      atr: atr ?? null,
      trend,
      debug,
    };
  }

  const [rsiPrev, rsiNow] = rsiLastTwo;
  const atrPercent = atr / price;
  const pullback = (price - ema20) / price;
  const bullishCandle = ltfLast[4] > ltfLast[1];
  const bearishCandle = ltfLast[4] < ltfLast[1];
  const rsiIncreasing = rsiNow > rsiPrev;
  const rsiDecreasing = rsiNow < rsiPrev;

  // Compact debug output (requested)
  debug.trendStrength = trendStrength;
  debug.pullback = pullback;
  debug.rsi = rsiNow;
  debug.atrPercent = atrPercent;
  debug.confirmation = {
    bullishCandle,
    bearishCandle,
    rsiIncreasing,
    rsiDecreasing,
  };

  // Trend filter (HTF)
  if (trend === 'NONE') {
    debug.reason = 'NO_CLEAR_TREND';
    return { signal: 'HOLD', price, timestamp, stopLoss: null, takeProfit: null, atr, trend, debug };
  }

  // Trend strength filter
  const strengthOk = typeof trendStrength === 'number' && trendStrength > TREND_STRENGTH_MIN;
  debug.trendStrengthFilter = { ok: strengthOk, threshold: TREND_STRENGTH_MIN };
  if (!strengthOk) {
    debug.reason = 'TREND_TOO_WEAK';
    return { signal: 'HOLD', price, timestamp, stopLoss: null, takeProfit: null, atr, trend, debug };
  }

  // Volatility filter
  const volOk = atrPercent > ATR_VOL_THRESHOLD;
  debug.atrCondition = { ok: volOk, threshold: ATR_VOL_THRESHOLD };
  if (!volOk) {
    debug.reason = 'ATR_TOO_LOW';
    return { signal: 'HOLD', price, timestamp, stopLoss: null, takeProfit: null, atr, trend, debug };
  }

  // Strict pullback + RSI filter
  if (trend === 'UP') {
    const pullbackOk = pullback >= PULLBACK_BUY_MIN && pullback <= PULLBACK_BUY_MAX;
    const rsiOk = rsiNow >= RSI_BUY_MIN && rsiNow <= RSI_BUY_MAX;
    const confirmOk = bullishCandle || rsiIncreasing;
    debug.pullbackCondition = { side: 'BUY', ok: pullbackOk, min: PULLBACK_BUY_MIN, max: PULLBACK_BUY_MAX };
    debug.rsiCondition = { side: 'BUY', ok: rsiOk, min: RSI_BUY_MIN, max: RSI_BUY_MAX };
    debug.confirmationOk = confirmOk;
    if (pullbackOk && rsiOk && confirmOk) {
      const { stopLoss, takeProfit } = buildStops(price, atr, 'BUY');
      const filterResult = applyTradeFilters({
        entryPrice: price,
        stopLoss,
        takeProfit,
        atr,
        side: 'BUY',
      });
      if (!filterResult.pass) {
        debug.reason = `TRADE_FILTER_${filterResult.reason}`;
        debug.tradeMetrics = filterResult.metrics;
        return { signal: 'HOLD', price, timestamp, stopLoss: null, takeProfit: null, atr, trend, debug };
      }
      debug.signalReason = 'UPTREND_STRICT_PULLBACK';
      debug.tradeMetrics = filterResult.metrics;
      return { signal: 'BUY', price, timestamp, stopLoss, takeProfit, atr, trend, tradeMetrics: filterResult.metrics, debug };
    }
  }

  if (trend === 'DOWN') {
    const pullbackOk = pullback >= PULLBACK_SELL_MIN && pullback <= PULLBACK_SELL_MAX;
    const rsiOk = rsiNow >= RSI_SELL_MIN && rsiNow <= RSI_SELL_MAX;
    const confirmOk = bearishCandle || rsiDecreasing;
    debug.pullbackCondition = { side: 'SELL', ok: pullbackOk, min: PULLBACK_SELL_MIN, max: PULLBACK_SELL_MAX };
    debug.rsiCondition = { side: 'SELL', ok: rsiOk, min: RSI_SELL_MIN, max: RSI_SELL_MAX };
    debug.confirmationOk = confirmOk;
    if (pullbackOk && rsiOk && confirmOk) {
      const { stopLoss, takeProfit } = buildStops(price, atr, 'SELL');
      const filterResult = applyTradeFilters({
        entryPrice: price,
        stopLoss,
        takeProfit,
        atr,
        side: 'SELL',
      });
      if (!filterResult.pass) {
        debug.reason = `TRADE_FILTER_${filterResult.reason}`;
        debug.tradeMetrics = filterResult.metrics;
        return { signal: 'HOLD', price, timestamp, stopLoss: null, takeProfit: null, atr, trend, debug };
      }
      debug.signalReason = 'DOWNTREND_STRICT_PULLBACK';
      debug.tradeMetrics = filterResult.metrics;
      return { signal: 'SELL', price, timestamp, stopLoss, takeProfit, atr, trend, tradeMetrics: filterResult.metrics, debug };
    }
  }

  debug.reason = 'ENTRY_CONDITION_FAILED';
  return { signal: 'HOLD', price, timestamp, stopLoss: null, takeProfit: null, atr, trend, debug };
}

/**
 * Trailing stop rules for trend pullback strategy:
 * - At >= 1R: move stop to entry
 * - At >= 2R: trail stop using ATR
 *
 * This mutates and returns a trade-like object with updated stopLoss.
 */
function applyTrendPullbackTrailingStop(trade, currentPrice, atr) {
  if (!trade || !currentPrice || !atr || Number.isNaN(atr)) return trade;
  if (trade.status && trade.status !== 'OPEN') return trade;
  if (!trade.entryPrice || !trade.stopLoss) return trade;

  const side = trade.side || 'BUY';
  const riskDistance = trade.initialRiskDistance
    || trade.riskDistance
    || (trade.initialStopLoss ? Math.abs(trade.entryPrice - trade.initialStopLoss) : Math.abs(trade.entryPrice - trade.stopLoss));
  if (!riskDistance || riskDistance <= 0) return trade;

  const profit = side === 'BUY' ? (currentPrice - trade.entryPrice) : (trade.entryPrice - currentPrice);
  const rMultiple = profit / riskDistance;

  let newStop = trade.stopLoss;

  if (rMultiple >= 1) {
    if (side === 'BUY') newStop = Math.max(newStop, trade.entryPrice);
    else newStop = Math.min(newStop, trade.entryPrice);
  }

  if (rMultiple >= 2) {
    const trailCandidate = side === 'BUY' ? (currentPrice - atr) : (currentPrice + atr);
    if (side === 'BUY') newStop = Math.max(newStop, trailCandidate);
    else newStop = Math.min(newStop, trailCandidate);
  }

  if (newStop === trade.stopLoss) return trade;
  return {
    ...trade,
    stopLoss: roundTo(newStop, 8),
    initialRiskDistance: trade.initialRiskDistance || riskDistance,
    initialStopLoss: trade.initialStopLoss || trade.stopLoss,
  };
}

module.exports = {
  trendPullbackStrategy,
  applyTrendPullbackTrailingStop,
};
