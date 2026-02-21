/**
 * HyperWave Momentum Strategy (Optimized)
 *
 * Increased trade frequency: RSI 65/35, breakout OR continuation, relaxed MFI/ADX.
 * HTF 1D filter for trend alignment. Multi-symbol support.
 *
 * LONG: (RSI breakout OR continuation) AND EMA50>EMA200 AND MFI>45 AND ADX>18 AND 1D EMA50>EMA200
 * SHORT: (RSI breakout OR continuation) AND EMA50<EMA200 AND MFI<55 AND ADX>18 AND 1D EMA50<EMA200
 *
 * Uses closed candles only. No repainting.
 */

const { EMA, RSI, ATR, ADX, MFI } = require('technicalindicators');
const { roundTo } = require('../../utils/helpers');
const logger = require('../../utils/logger');
const config = require('../../config');

const getConfig = () => ({
  rsiHigh: config.strategy?.hyperWave?.rsiHigh ?? 65,
  rsiLow: config.strategy?.hyperWave?.rsiLow ?? 35,
  mfiLongMin: config.strategy?.hyperWave?.mfiLongMin ?? 45,
  mfiShortMax: config.strategy?.hyperWave?.mfiShortMax ?? 55,
  adxMin: config.strategy?.hyperWave?.adxMin ?? 18,
  atrSlMultiplier: config.strategy?.hyperWave?.atrSlMultiplier ?? 2,
  atrTrailMultiplier: config.strategy?.hyperWave?.atrTrailMultiplier ?? 3,
});

const RSI_PERIOD = 14;
const MFI_PERIOD = 14;
const EMA_FAST = 50;
const EMA_SLOW = 200;
const ATR_PERIOD = 14;
const ADX_PERIOD = 14;
const MIN_CANDLES = 220;
const MIN_HTF_CANDLES = 210;

function last(arr) {
  return arr && arr.length ? arr[arr.length - 1] : undefined;
}

function lastN(arr, n) {
  if (!arr || arr.length < n) return null;
  return arr.slice(-n);
}

function lastTwo(arr) {
  if (!arr || arr.length < 2) return null;
  return arr.slice(-2);
}

function clipToTimestamp(ohlcv, ts) {
  if (!ohlcv || ohlcv.length === 0) return [];
  let end = ohlcv.length - 1;
  while (end >= 0 && ohlcv[end][0] > ts) end -= 1;
  return end >= 0 ? ohlcv.slice(0, end + 1) : [];
}

function calculateEmaLast(closes, period) {
  const values = EMA.calculate({ values: closes, period });
  return last(values);
}

function getHtfMetrics(htfOhlcv) {
  const candles = lastN(htfOhlcv, Math.max(MIN_HTF_CANDLES, EMA_SLOW));
  if (!candles || candles.length < EMA_SLOW) return null;
  const closes = candles.map((c) => c[4]);
  const ema50 = calculateEmaLast(closes, EMA_FAST);
  const ema200 = calculateEmaLast(closes, EMA_SLOW);
  if ([ema50, ema200].some((v) => typeof v !== 'number' || Number.isNaN(v))) return null;
  return { htfEma50: ema50, htfEma200: ema200 };
}

function calculateRsiLastTwo(closes, period) {
  const values = RSI.calculate({ values: closes, period });
  return lastTwo(values);
}

function calculateMfiLast(ohlcv, period) {
  const high = ohlcv.map((c) => c[2]);
  const low = ohlcv.map((c) => c[3]);
  const close = ohlcv.map((c) => c[4]);
  const volume = ohlcv.map((c) => (c[5] != null ? c[5] : 0));
  const values = MFI.calculate({ high, low, close, volume, period });
  return last(values);
}

function calculateEmaLastTwo(closes, period) {
  const values = EMA.calculate({ values: closes, period });
  return lastTwo(values);
}

function calculateAtrLast(ohlcv, period) {
  const high = ohlcv.map((c) => c[2]);
  const low = ohlcv.map((c) => c[3]);
  const close = ohlcv.map((c) => c[4]);
  const values = ATR.calculate({ high, low, close, period });
  return last(values);
}

function calculateAdxLast(ohlcv, period) {
  const high = ohlcv.map((c) => c[2]);
  const low = ohlcv.map((c) => c[3]);
  const close = ohlcv.map((c) => c[4]);
  const values = ADX.calculate({ high, low, close, period });
  const lastVal = last(values);
  return lastVal && typeof lastVal.adx === 'number' ? lastVal.adx : null;
}

/**
 * Generate trading signal
 * @param {Array<Array>} candles - OHLCV [ts, open, high, low, close, vol]
 * @param {number} currentIndex - Index of current candle (closed, no lookahead)
 * @param {Array} openTrades - Currently open trades
 * @param {Array<Array>} [htfCandles] - 1D HTF candles for trend filter
 * @returns {Object} { signal, action, price, stopLoss, takeProfit, atr, entryReason, ... }
 */
function generateSignal(candles, currentIndex, openTrades = [], htfCandles = null) {
  const cfg = getConfig();
  const maxOpenTrades = 1;

  if (!candles || currentIndex < 0 || currentIndex >= candles.length) {
    return {
      signal: 'HOLD',
      action: 'HOLD',
      price: 0,
      timestamp: 0,
      stopLoss: null,
      takeProfit: null,
      atr: null,
      debug: { reason: 'INVALID_INPUT' },
    };
  }

  const currentCandle = candles[currentIndex];
  const price = currentCandle[4];
  const timestamp = currentCandle[0];

  if (openTrades.length >= maxOpenTrades) {
    return {
      signal: 'HOLD',
      action: 'HOLD',
      price,
      timestamp,
      stopLoss: null,
      takeProfit: null,
      atr: null,
      debug: { reason: 'MAX_OPEN_TRADES', openCount: openTrades.length },
    };
  }

  const slice = candles.slice(0, currentIndex + 1);
  if (slice.length < MIN_CANDLES) {
    return {
      signal: 'HOLD',
      action: 'HOLD',
      price,
      timestamp,
      stopLoss: null,
      takeProfit: null,
      atr: null,
      debug: { reason: 'INSUFFICIENT_CANDLES', have: slice.length, need: MIN_CANDLES },
    };
  }

  const closes = slice.map((c) => c[4]);
  const rsiPair = calculateRsiLastTwo(closes, RSI_PERIOD);
  const mfi = calculateMfiLast(slice, MFI_PERIOD);
  const ema50Pair = calculateEmaLastTwo(closes, EMA_FAST);
  const ema200Pair = calculateEmaLastTwo(closes, EMA_SLOW);
  const atr = calculateAtrLast(slice, ATR_PERIOD);
  const adx = calculateAdxLast(slice, ADX_PERIOD);

  const [prevRsi, currRsi] = rsiPair || [null, null];
  const [prevEma50, currEma50] = ema50Pair || [null, null];
  const [prevEma200, currEma200] = ema200Pair || [null, null];

  const open = currentCandle[1];
  const close = currentCandle[4];

  // HTF 1D filter (optional)
  let htfMetrics = null;
  if (htfCandles && htfCandles.length >= MIN_HTF_CANDLES) {
    const htfAligned = clipToTimestamp(htfCandles, timestamp);
    if (htfAligned.length >= MIN_HTF_CANDLES) {
      htfMetrics = getHtfMetrics(htfAligned);
    }
  }

  const debugPayload = {
    index: currentIndex,
    price,
    rsi: currRsi != null ? roundTo(currRsi, 2) : null,
    prevRsi: prevRsi != null ? roundTo(prevRsi, 2) : null,
    mfi: mfi != null ? roundTo(mfi, 2) : null,
    ema50: currEma50 != null ? roundTo(currEma50, 2) : null,
    ema200: currEma200 != null ? roundTo(currEma200, 2) : null,
    adx: adx != null ? roundTo(adx, 2) : null,
    atr: atr != null ? roundTo(atr, 4) : null,
  };

  if ([currRsi, prevRsi, mfi, currEma50, currEma200, atr, adx].some((v) => v == null || Number.isNaN(v))) {
    return {
      signal: 'HOLD',
      action: 'HOLD',
      price,
      timestamp,
      stopLoss: null,
      takeProfit: null,
      atr: atr ?? null,
      ema50: currEma50,
      ema200: currEma200,
      rsi: currRsi,
      mfi,
      adx,
      debug: { reason: 'INDICATOR_NAN', ...debugPayload },
    };
  }

  if (atr <= 0) {
    return {
      signal: 'HOLD',
      action: 'HOLD',
      price,
      timestamp,
      stopLoss: null,
      takeProfit: null,
      atr,
      ema50: currEma50,
      ema200: currEma200,
      rsi: currRsi,
      mfi,
      adx,
      debug: { reason: 'ATR_INVALID', ...debugPayload },
    };
  }

  // LONG: (breakout OR continuation) AND EMA50>EMA200 AND MFI>45 AND ADX>18 AND (1D EMA50>EMA200 if HTF)
  const longBreakout = currRsi > cfg.rsiHigh && prevRsi <= cfg.rsiHigh;
  const longContinuation = currRsi > 55 && currRsi < cfg.rsiHigh && close > open;
  const longRsiOk = longBreakout || longContinuation;
  const longTrend = currEma50 > currEma200;
  const longMfi = mfi > cfg.mfiLongMin;
  const longAdx = adx > cfg.adxMin;
  const longHtfOk = !htfMetrics || htfMetrics.htfEma50 > htfMetrics.htfEma200;

  if (longRsiOk && longTrend && longMfi && longAdx && longHtfOk) {
    const stopLoss = calculateStopLoss(price, atr, 'BUY', cfg);
    const entryReason = longBreakout ? 'LONG_BREAKOUT' : 'LONG_CONTINUATION';

    logger.signal('HyperWave LONG entry', {
      price,
      stopLoss,
      atr,
      rsi: currRsi,
      mfi,
      adx,
      entryReason,
    });

    return {
      signal: 'BUY',
      action: 'BUY',
      price,
      timestamp,
      stopLoss,
      takeProfit: null,
      atr,
      ema50: currEma50,
      ema200: currEma200,
      prevEma50,
      prevEma200,
      rsi: currRsi,
      mfi,
      adx,
      entryReason,
      suggestedRiskPercent: 0.01,
      debug: { reason: 'LONG_ENTRY', ...debugPayload },
    };
  }

  // SHORT: (breakout OR continuation) AND EMA50<EMA200 AND MFI<55 AND ADX>18 AND (1D EMA50<EMA200 if HTF)
  const shortBreakout = currRsi < cfg.rsiLow && prevRsi >= cfg.rsiLow;
  const shortContinuation = currRsi < 45 && currRsi > cfg.rsiLow && close < open;
  const shortRsiOk = shortBreakout || shortContinuation;
  const shortTrend = currEma50 < currEma200;
  const shortMfi = mfi < cfg.mfiShortMax;
  const shortAdx = adx > cfg.adxMin;
  const shortHtfOk = !htfMetrics || htfMetrics.htfEma50 < htfMetrics.htfEma200;

  if (shortRsiOk && shortTrend && shortMfi && shortAdx && shortHtfOk) {
    const stopLoss = calculateStopLoss(price, atr, 'SELL', cfg);
    const entryReason = shortBreakout ? 'SHORT_BREAKOUT' : 'SHORT_CONTINUATION';

    logger.signal('HyperWave SHORT entry', {
      price,
      stopLoss,
      atr,
      rsi: currRsi,
      mfi,
      adx,
      entryReason,
    });

    return {
      signal: 'SELL',
      action: 'SELL',
      price,
      timestamp,
      stopLoss,
      takeProfit: null,
      atr,
      ema50: currEma50,
      ema200: currEma200,
      prevEma50,
      prevEma200,
      rsi: currRsi,
      mfi,
      adx,
      entryReason,
      suggestedRiskPercent: 0.01,
      debug: { reason: 'SHORT_ENTRY', ...debugPayload },
    };
  }

  return {
    signal: 'HOLD',
    action: 'HOLD',
    price,
    timestamp,
    stopLoss: null,
    takeProfit: null,
    atr,
    ema50: currEma50,
    ema200: currEma200,
    prevEma50,
    prevEma200,
    rsi: currRsi,
    mfi,
    adx,
    debug: { reason: 'NO_ENTRY', ...debugPayload },
  };
}

function calculateStopLoss(entryPrice, atr, direction, cfg = null) {
  const c = cfg || getConfig();
  const mult = c.atrSlMultiplier;
  if (direction === 'BUY') {
    return roundTo(entryPrice - mult * atr, 8);
  }
  return roundTo(entryPrice + mult * atr, 8);
}

/**
 * Update trailing stop
 * LONG: trailingStop = highestPrice - (3 * ATR)
 * SHORT: trailingStop = lowestPrice + (3 * ATR)
 */
function updateTrailingStop(trade, currentPrice, atr, prevHigh, prevLow) {
  if (!trade || !atr || Number.isNaN(atr)) return trade;
  if (trade.status && trade.status !== 'OPEN') return trade;

  const cfg = getConfig();
  const mult = cfg.atrTrailMultiplier ?? 3;
  const side = trade.side || 'BUY';

  const highestPrice = Math.max(
    trade.highestPrice ?? trade.entryPrice,
    prevHigh ?? currentPrice
  );
  const lowestPrice = Math.min(
    trade.lowestPrice ?? trade.entryPrice,
    prevLow ?? currentPrice
  );

  const trailStop = side === 'BUY'
    ? highestPrice - mult * atr
    : lowestPrice + mult * atr;

  let newStop = trade.stopLoss;
  if (side === 'BUY') {
    newStop = Math.max(newStop, trailStop);
  } else {
    newStop = Math.min(newStop, trailStop);
  }

  if (newStop !== trade.stopLoss) {
    logger.trade('HyperWave trailing stop update', {
      tradeId: trade.id,
      oldStop: trade.stopLoss,
      newStop,
      highestPrice: side === 'BUY' ? highestPrice : undefined,
      lowestPrice: side === 'SELL' ? lowestPrice : undefined,
    });
  }

  return {
    ...trade,
    stopLoss: roundTo(newStop, 8),
    highestPrice: side === 'BUY' ? highestPrice : trade.highestPrice,
    lowestPrice: side === 'SELL' ? lowestPrice : trade.lowestPrice,
  };
}

/**
 * Check if trade should exit
 * Exit: 1) SL hit 2) Trailing stop hit 3) Opposite momentum (LONG: RSI<50, SHORT: RSI>50)
 * 4) Trend reversal (EMA50 crosses EMA200)
 */
function shouldExitTrade(trade, currentCandle, atr, context = {}) {
  if (!trade || !currentCandle) return null;
  const [, open, high, low, close] = currentCandle;
  const side = trade.side || 'BUY';
  const { ema50, ema200, rsi, prevEma50, prevEma200 } = context;

  // 1. Stop loss or trailing stop hit (both use trade.stopLoss)
  if (side === 'BUY' && low <= trade.stopLoss) {
    const isTrailing = trade.initialStopLoss != null
      && Math.abs(trade.stopLoss - trade.initialStopLoss) > 1e-8;
    const reason = isTrailing ? 'TRAILING_STOP' : 'STOP_LOSS';
    logger.trade(`HyperWave exit: ${reason}`, { tradeId: trade.id, price: trade.stopLoss });
    return { exitPrice: trade.stopLoss, reason };
  }
  if (side === 'SELL' && high >= trade.stopLoss) {
    const isTrailing = trade.initialStopLoss != null
      && Math.abs(trade.stopLoss - trade.initialStopLoss) > 1e-8;
    const reason = isTrailing ? 'TRAILING_STOP' : 'STOP_LOSS';
    logger.trade(`HyperWave exit: ${reason}`, { tradeId: trade.id, price: trade.stopLoss });
    return { exitPrice: trade.stopLoss, reason };
  }

  // 3. Opposite momentum
  if (rsi != null) {
    if (side === 'BUY' && rsi < 50) {
      logger.trade('HyperWave exit: OPPOSITE_MOMENTUM', { tradeId: trade.id, price: close, rsi });
      return { exitPrice: close, reason: 'OPPOSITE_MOMENTUM' };
    }
    if (side === 'SELL' && rsi > 50) {
      logger.trade('HyperWave exit: OPPOSITE_MOMENTUM', { tradeId: trade.id, price: close, rsi });
      return { exitPrice: close, reason: 'OPPOSITE_MOMENTUM' };
    }
  }

  // 4. Trend reversal: EMA50 crosses EMA200
  if (prevEma50 != null && prevEma200 != null && ema50 != null && ema200 != null) {
    if (side === 'BUY' && prevEma50 >= prevEma200 && ema50 < ema200) {
      logger.trade('HyperWave exit: TREND_REVERSAL', { tradeId: trade.id, price: close });
      return { exitPrice: close, reason: 'TREND_REVERSAL' };
    }
    if (side === 'SELL' && prevEma50 <= prevEma200 && ema50 > ema200) {
      logger.trade('HyperWave exit: TREND_REVERSAL', { tradeId: trade.id, price: close });
      return { exitPrice: close, reason: 'TREND_REVERSAL' };
    }
  }

  return null;
}

/**
 * Log trade metrics: entry reason, exit reason, R multiple, trade duration
 */
function logTradeMetrics(closedTrades) {
  if (!closedTrades || closedTrades.length === 0) return;

  for (const t of closedTrades) {
    const riskDist = t.initialRiskDistance || (t.entryPrice && t.initialStopLoss
      ? Math.abs(t.entryPrice - t.initialStopLoss)
      : null);
    const rMultiple = riskDist != null && riskDist > 0 && t.quantity > 0
      ? roundTo(t.pnl / (riskDist * t.quantity), 4)
      : null;
    const durationMs = t.openedAt && t.closedAt ? t.closedAt - t.openedAt : null;
    const durationHours = durationMs != null ? roundTo(durationMs / (60 * 60 * 1000), 2) : null;

    logger.trade('HyperWave trade summary', {
      tradeId: t.id,
      entryReason: t.entryReason ?? 'N/A',
      exitReason: t.exitReason ?? 'N/A',
      rMultiple,
      tradeDurationHours: durationHours,
      pnl: roundTo(t.pnl, 4),
    });
  }
}

/**
 * Wrapper for strategy: getSignal(ohlcvHistory, options)
 */
function hyperWaveStrategy({ ltfOhlcv, htfOhlcv = null, openTrades = [] }) {
  if (!ltfOhlcv || ltfOhlcv.length === 0) {
    return {
      signal: 'HOLD',
      price: 0,
      timestamp: 0,
      stopLoss: null,
      takeProfit: null,
      atr: null,
      debug: { reason: 'NO_CANDLES' },
    };
  }
  const currentIndex = ltfOhlcv.length - 1;
  return generateSignal(ltfOhlcv, currentIndex, openTrades, htfOhlcv);
}

module.exports = {
  generateSignal,
  calculateStopLoss,
  updateTrailingStop,
  shouldExitTrade,
  hyperWaveStrategy,
  logTradeMetrics,
  MIN_CANDLES,
};
