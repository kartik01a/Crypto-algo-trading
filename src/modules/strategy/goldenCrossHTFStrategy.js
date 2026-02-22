/**
 * Golden Cross HTF Strategy
 *
 * Multi-timeframe trend-following strategy with EMA crossover, ADX filter, and trailing stop.
 * Based on Pine Script strategy.
 *
 * LTF: configurable (default 4H) - entry & exit
 * HTF: configurable (default 1D) - trend filter
 *
 * Indicators:
 *   LTF: EMA fast (20), EMA slow (50), ADX (14), +DI, -DI
 *   HTF: EMA (50), HTF close
 *
 * Entry: EMA crossover + HTF trend + ADX filter + DI filter
 * Exit: Percentage-based trailing stop or max hold
 * No lookahead - uses closed candles only.
 */

const { EMA, ADX } = require('technicalindicators');
const { roundTo } = require('../../utils/helpers');
const logger = require('../../utils/logger');
const config = require('../../config');

const getConfig = () => ({
  emaFast: config.strategy?.goldenCrossHTF?.emaFast ?? 20,
  emaSlow: config.strategy?.goldenCrossHTF?.emaSlow ?? 50,
  htfEma: config.strategy?.goldenCrossHTF?.htfEma ?? 50,
  adxThreshold: config.strategy?.goldenCrossHTF?.adxThreshold ?? 15,
  trailPercent: config.strategy?.goldenCrossHTF?.trailPercent ?? 0.02,
  minHoldBars: config.strategy?.goldenCrossHTF?.minHoldBars ?? 3,
  maxHoldBars: config.strategy?.goldenCrossHTF?.maxHoldBars ?? 30,
});

const ADX_PERIOD = 14;
const MIN_LTF_CANDLES = 55; // max(emaSlow, ADX) + buffer
const MIN_HTF_CANDLES = 55; // htfEma + buffer

function last(arr) {
  return arr && arr.length ? arr[arr.length - 1] : undefined;
}

function lastN(arr, n) {
  if (!arr || arr.length < n) return null;
  return arr.slice(-n);
}

/**
 * Clip HTF candles to those with timestamp <= ts (no lookahead)
 */
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

/**
 * Get ADX, +DI, -DI for last candle
 */
function calculateAdxLast(ohlcv, period) {
  const high = ohlcv.map((c) => c[2]);
  const low = ohlcv.map((c) => c[3]);
  const close = ohlcv.map((c) => c[4]);
  const values = ADX.calculate({ high, low, close, period });
  const lastVal = last(values);
  if (!lastVal || typeof lastVal.adx !== 'number') return null;
  return {
    adx: lastVal.adx,
    pdi: typeof lastVal.pdi === 'number' ? lastVal.pdi : null,
    mdi: typeof lastVal.mdi === 'number' ? lastVal.mdi : null,
  };
}

/**
 * Get HTF metrics: latest closed HTF candle close and HTF EMA50
 */
function getHtfMetrics(htfOhlcv) {
  if (!htfOhlcv || htfOhlcv.length < MIN_HTF_CANDLES) return null;
  const closes = htfOhlcv.map((c) => c[4]);
  const cfg = getConfig();
  const htfEma = calculateEmaLast(closes, cfg.htfEma);
  const htfClose = last(closes);
  if ([htfEma, htfClose].some((v) => typeof v !== 'number' || Number.isNaN(v))) return null;
  return { htfClose, htfEma };
}

/**
 * Generate trading signal
 * @param {Array<Array>} ltfCandles - LTF candles [ts, open, high, low, close, vol]
 * @param {Array<Array>} htfCandles - HTF candles
 * @param {number} currentIndex - Index of current candle (inclusive, no lookahead)
 * @param {Array} openTrades - Currently open trades
 * @param {string} [symbol] - Symbol for multi-symbol (filters openTrades by symbol)
 * @returns {Object} { signal, action, price, stopLoss, confidence, emaDistance, metadata, ... }
 */
function generateSignal(ltfCandles, htfCandles, currentIndex, openTrades = [], symbol = null) {
  const cfg = getConfig();

  if (!ltfCandles || currentIndex < 0 || currentIndex >= ltfCandles.length) {
    return {
      signal: 'HOLD',
      action: 'HOLD',
      price: 0,
      timestamp: 0,
      stopLoss: null,
      confidence: 0,
      debug: { reason: 'INVALID_INPUT' },
    };
  }

  const currentCandle = ltfCandles[currentIndex];
  const price = currentCandle[4];
  const timestamp = currentCandle[0];

  // One trade per symbol: filter by symbol when provided (multi-symbol)
  const openForSymbol = symbol
    ? openTrades.filter((t) => t.symbol === symbol)
    : openTrades;
  if (openForSymbol.length >= 1) {
    return {
      signal: 'HOLD',
      action: 'HOLD',
      price,
      timestamp,
      stopLoss: null,
      confidence: 0,
      debug: { reason: 'POSITION_EXISTS_FOR_SYMBOL', symbol: symbol || 'single' },
    };
  }

  const ltfSlice = ltfCandles.slice(0, currentIndex + 1);
  if (ltfSlice.length < MIN_LTF_CANDLES) {
    return {
      signal: 'HOLD',
      action: 'HOLD',
      price,
      timestamp,
      stopLoss: null,
      debug: { reason: 'INSUFFICIENT_LTF_CANDLES', have: ltfSlice.length, need: MIN_LTF_CANDLES },
    };
  }

  // HTF: use latest closed candle for this LTF timestamp
  const htfAligned = clipToTimestamp(htfCandles || [], timestamp);
  if (htfAligned.length < MIN_HTF_CANDLES) {
    return {
      signal: 'HOLD',
      action: 'HOLD',
      price,
      timestamp,
      stopLoss: null,
      debug: { reason: 'INSUFFICIENT_HTF_CANDLES', have: htfAligned.length, need: MIN_HTF_CANDLES },
    };
  }

  const htfMetrics = getHtfMetrics(htfAligned);
  if (!htfMetrics) {
    return {
      signal: 'HOLD',
      action: 'HOLD',
      price,
      timestamp,
      stopLoss: null,
      debug: { reason: 'HTF_METRICS_NAN' },
    };
  }

  const { htfClose, htfEma } = htfMetrics;

  // LTF indicators
  const closes = ltfSlice.map((c) => c[4]);
  const emaFast = calculateEmaLast(closes, cfg.emaFast);
  const emaSlow = calculateEmaLast(closes, cfg.emaSlow);
  const adxResult = calculateAdxLast(ltfSlice, ADX_PERIOD);

  if ([emaFast, emaSlow].some((v) => typeof v !== 'number' || Number.isNaN(v))) {
    return {
      signal: 'HOLD',
      action: 'HOLD',
      price,
      timestamp,
      stopLoss: null,
      debug: { reason: 'LTF_EMA_NAN' },
    };
  }

  if (!adxResult || adxResult.adx < cfg.adxThreshold) {
    return {
      signal: 'HOLD',
      action: 'HOLD',
      price,
      timestamp,
      stopLoss: null,
      adx: adxResult?.adx ?? null,
      debug: { reason: 'ADX_BELOW_THRESHOLD', adx: adxResult?.adx, threshold: cfg.adxThreshold },
    };
  }

  const { adx, pdi, mdi } = adxResult;

  // LONG: EMA20 > EMA50, HTF close > HTF EMA50, ADX > 15, +DI > -DI
  const longEmaOk = emaFast > emaSlow;
  const longHtfOk = htfClose > htfEma;
  const longDiOk = pdi != null && mdi != null && pdi > mdi;

  // EMA distance (trend strength) for ranking: |emaFast - emaSlow| / price
  const emaDistance = price > 0 ? Math.abs(emaFast - emaSlow) / price : 0;
  // Confidence: ADX normalized (0-1 scale, cap at 50) + DI spread
  const adxNorm = Math.min(adx / 50, 1);
  const diSpread = (pdi != null && mdi != null) ? Math.abs(pdi - mdi) / 50 : 0;
  const confidence = Math.min(0.95, 0.5 + adxNorm * 0.3 + diSpread * 0.2);

  if (longEmaOk && longHtfOk && longDiOk) {
    const initialStop = price * (1 - cfg.trailPercent);
    logger.signal('GoldenCrossHTF LONG entry', {
      price,
      emaFast: roundTo(emaFast, 2),
      emaSlow: roundTo(emaSlow, 2),
      htfClose: roundTo(htfClose, 2),
      htfEma: roundTo(htfEma, 2),
      adx: roundTo(adx, 2),
      pdi: roundTo(pdi, 2),
      mdi: roundTo(mdi, 2),
    });
    return {
      signal: 'BUY',
      action: 'BUY',
      price,
      timestamp,
      stopLoss: roundTo(initialStop, 8),
      adx,
      confidence,
      emaDistance,
      suggestedRiskPercent: 0.01,
      metadata: { adx, emaDistance, emaFast, emaSlow, htfClose, htfEma },
      debug: { reason: 'EMA_CROSSOVER_HTF_UPTREND', adx },
    };
  }

  // SHORT: EMA20 < EMA50, HTF close < HTF EMA50, ADX > 15, -DI > +DI
  const shortEmaOk = emaFast < emaSlow;
  const shortHtfOk = htfClose < htfEma;
  const shortDiOk = pdi != null && mdi != null && mdi > pdi;

  if (shortEmaOk && shortHtfOk && shortDiOk) {
    const initialStop = price * (1 + cfg.trailPercent);
    logger.signal('GoldenCrossHTF SHORT entry', {
      price,
      emaFast: roundTo(emaFast, 2),
      emaSlow: roundTo(emaSlow, 2),
      htfClose: roundTo(htfClose, 2),
      htfEma: roundTo(htfEma, 2),
      adx: roundTo(adx, 2),
      pdi: roundTo(pdi, 2),
      mdi: roundTo(mdi, 2),
    });
    return {
      signal: 'SELL',
      action: 'SELL',
      price,
      timestamp,
      stopLoss: roundTo(initialStop, 8),
      adx,
      confidence,
      emaDistance,
      suggestedRiskPercent: 0.01,
      metadata: { adx, emaDistance, emaFast, emaSlow, htfClose, htfEma },
      debug: { reason: 'EMA_CROSSOVER_HTF_DOWNTREND', adx },
    };
  }

  return {
    signal: 'HOLD',
    action: 'HOLD',
    price,
    timestamp,
    stopLoss: null,
    adx,
    debug: {
      reason: 'NO_ENTRY',
      longEmaOk,
      longHtfOk,
      longDiOk,
      shortEmaOk,
      shortHtfOk,
      shortDiOk,
    },
  };
}

/**
 * Update percentage-based trailing stop
 * LONG: trailingStop = highestPrice * (1 - trailPercent)
 * SHORT: trailingStop = lowestPrice * (1 + trailPercent)
 * Track highest/lowest from entry; do not tighten stop until minHoldBars reached.
 */
function updateTrailingStop(trade, currentCandle, prevHigh, prevLow) {
  if (!trade || trade.status !== 'OPEN') return trade;

  const cfg = getConfig();
  const side = trade.side || 'BUY';
  const barsInTrade = trade.candleCount ?? 0;

  const [, , high, low] = currentCandle;

  // Always track highest/lowest since entry (for trailing calculation)
  const highestPrice = Math.max(
    trade.highestPrice ?? trade.entryPrice,
    prevHigh ?? high ?? trade.entryPrice
  );
  const lowestPrice = Math.min(
    trade.lowestPrice ?? trade.entryPrice,
    prevLow ?? low ?? trade.entryPrice
  );

  // Min hold: don't tighten trailing stop until minHoldBars
  let newStop = trade.stopLoss;
  if (barsInTrade >= cfg.minHoldBars) {
    const trailStop = side === 'BUY'
      ? highestPrice * (1 - cfg.trailPercent)
      : lowestPrice * (1 + cfg.trailPercent);
    if (side === 'BUY') {
      newStop = Math.max(newStop, trailStop);
    } else {
      newStop = Math.min(newStop, trailStop);
    }
  }

  if (newStop !== trade.stopLoss) {
    logger.trade('GoldenCrossHTF trailing stop update', {
      tradeId: trade.id,
      oldStop: trade.stopLoss,
      newStop,
      highestPrice: side === 'BUY' ? highestPrice : undefined,
      lowestPrice: side === 'SELL' ? lowestPrice : undefined,
      barsInTrade,
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
 * Check if trade should exit (trailing stop hit or max hold)
 * Uses candle high/low for trailing stop check (no lookahead)
 */
function shouldExitTrade(trade, currentCandle) {
  if (!trade || !currentCandle) return null;

  const [, , high, low] = currentCandle;
  const side = trade.side || 'BUY';
  const cfg = getConfig();
  const barsInTrade = trade.candleCount ?? 0;

  // Max hold: close after maxHoldBars
  if (barsInTrade >= cfg.maxHoldBars) {
    const exitPrice = currentCandle[4];
    logger.trade('GoldenCrossHTF exit: MAX_HOLD', {
      tradeId: trade.id,
      price: exitPrice,
      barsInTrade,
      duration: barsInTrade,
    });
    return { exitPrice, reason: 'MAX_HOLD' };
  }

  // Trailing stop hit (only check after minHoldBars)
  if (barsInTrade >= cfg.minHoldBars) {
    if (side === 'BUY' && low <= trade.stopLoss) {
      logger.trade('GoldenCrossHTF exit: TRAILING_STOP', {
        tradeId: trade.id,
        price: trade.stopLoss,
        low,
        barsInTrade,
      });
      return { exitPrice: trade.stopLoss, reason: 'TRAILING_STOP' };
    }
    if (side === 'SELL' && high >= trade.stopLoss) {
      logger.trade('GoldenCrossHTF exit: TRAILING_STOP', {
        tradeId: trade.id,
        price: trade.stopLoss,
        high,
        barsInTrade,
      });
      return { exitPrice: trade.stopLoss, reason: 'TRAILING_STOP' };
    }
  }

  return null;
}

/**
 * Main strategy wrapper
 */
function goldenCrossHTFStrategy({ ltfOhlcv, htfOhlcv, openTrades = [], symbol = null }) {
  if (!ltfOhlcv || ltfOhlcv.length === 0) {
    return {
      signal: 'HOLD',
      price: 0,
      timestamp: 0,
      stopLoss: null,
      confidence: 0,
      debug: { reason: 'NO_LTF_CANDLES' },
    };
  }
  const currentIndex = ltfOhlcv.length - 1;
  return generateSignal(ltfOhlcv, htfOhlcv || [], currentIndex, openTrades, symbol);
}

module.exports = {
  generateSignal,
  updateTrailingStop,
  shouldExitTrade,
  goldenCrossHTFStrategy,
  getConfig,
  MIN_LTF_CANDLES,
  MIN_HTF_CANDLES,
};
