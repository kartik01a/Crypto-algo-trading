/**
 * DMA Trend Strategy
 *
 * Simple trend-following strategy using Daily 200 Moving Average (SMA200).
 * Entry timeframe: configurable (default 4H)
 * Higher timeframe: 1 Day (for SMA200 calculation)
 *
 * Indicators: Daily SMA 200 (HTF), ATR(14), ADX(14)
 * No lookahead - uses closed candles only.
 */

const { SMA, ATR, ADX } = require('technicalindicators');
const { roundTo } = require('../../utils/helpers');
const logger = require('../../utils/logger');
const config = require('../../config');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const getConfig = () => ({
  atrMultiplier: config.strategy?.dmaTrend?.atrMultiplier ?? 2,
  takeProfitRR: config.strategy?.dmaTrend?.takeProfitRR ?? 3,
  adxThreshold: config.strategy?.dmaTrend?.adxThreshold ?? 20,
  entryTimeframe: config.strategy?.dmaTrend?.entryTimeframe ?? '4h',
});

const SMA_PERIOD = 200;
const ATR_PERIOD = 14;
const ADX_PERIOD = 14;
const MIN_HTF_CANDLES = 210; // SMA200 + buffer
const MIN_LTF_CANDLES = 50; // ATR/ADX warmup

function last(arr) {
  return arr && arr.length ? arr[arr.length - 1] : undefined;
}

/**
 * Clip daily candles to only include those that have closed (no lookahead).
 * A daily candle at timestamp T closes at T + 24h.
 */
function clipToClosedDailyCandles(ohlcv, currentTimestamp) {
  if (!ohlcv || ohlcv.length === 0) return [];
  const cutoff = currentTimestamp - MS_PER_DAY;
  let end = ohlcv.length - 1;
  while (end >= 0 && ohlcv[end][0] > cutoff) end -= 1;
  return end >= 0 ? ohlcv.slice(0, end + 1) : [];
}

function calculateSmaLast(closes, period) {
  const values = SMA.calculate({ values: closes, period });
  return last(values);
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
 * Get Daily SMA200 from closed daily candles (caller must pass already-clipped data)
 */
function getDailySma200(htfCandles) {
  if (!htfCandles || htfCandles.length < SMA_PERIOD) return null;
  const closes = htfCandles.map((c) => c[4]);
  return calculateSmaLast(closes, SMA_PERIOD);
}

/**
 * Generate trading signal
 * @param {Array<Array>} ltfCandles - Entry timeframe candles [ts, open, high, low, close, vol]
 * @param {Array<Array>} htfCandles - 1D candles
 * @param {number} currentIndex - Index of current candle (inclusive, no lookahead)
 * @param {Array} openTrades - Currently open trades
 * @param {string} [symbol] - Symbol for multi-symbol support
 * @returns {Object} { signal, action, price, stopLoss, takeProfit, ... }
 */
function generateSignal(ltfCandles, htfCandles, currentIndex, openTrades = [], symbol = null) {
  const cfg = getConfig();
  const maxOpenTrades = 2;

  if (!ltfCandles || currentIndex < 0 || currentIndex >= ltfCandles.length) {
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

  const currentCandle = ltfCandles[currentIndex];
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

  const ltfSlice = ltfCandles.slice(0, currentIndex + 1);
  if (ltfSlice.length < MIN_LTF_CANDLES) {
    return {
      signal: 'HOLD',
      action: 'HOLD',
      price,
      timestamp,
      stopLoss: null,
      takeProfit: null,
      atr: null,
      debug: { reason: 'INSUFFICIENT_LTF_CANDLES', have: ltfSlice.length, need: MIN_LTF_CANDLES },
    };
  }

  // HTF: use only closed daily candles (timestamp alignment)
  const htfClosed = clipToClosedDailyCandles(htfCandles || [], timestamp);
  if (htfClosed.length < MIN_HTF_CANDLES) {
    return {
      signal: 'HOLD',
      action: 'HOLD',
      price,
      timestamp,
      stopLoss: null,
      takeProfit: null,
      atr: null,
      debug: { reason: 'INSUFFICIENT_HTF_CANDLES', have: htfClosed.length, need: MIN_HTF_CANDLES },
    };
  }

  const sma200 = getDailySma200(htfClosed);
  const atr = calculateAtrLast(ltfSlice, ATR_PERIOD);
  const adx = calculateAdxLast(ltfSlice, ADX_PERIOD);

  const prevCandle = currentIndex >= 1 ? ltfCandles[currentIndex - 1] : null;
  const prevClose = prevCandle ? prevCandle[4] : null;
  const currentClose = price;

  if ([sma200, atr].some((v) => v == null || typeof v !== 'number' || Number.isNaN(v))) {
    return {
      signal: 'HOLD',
      action: 'HOLD',
      price,
      timestamp,
      stopLoss: null,
      takeProfit: null,
      atr: atr ?? null,
      debug: { reason: 'INDICATOR_NAN', sma200, atr, adx },
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
      debug: { reason: 'ATR_INVALID' },
    };
  }

  // LONG: price crosses above Daily SMA200
  // prevClose <= SMA200 AND currentClose > SMA200 AND ADX > 20
  const longCrossover =
    prevClose != null &&
    prevClose <= sma200 &&
    currentClose > sma200 &&
    adx != null &&
    adx > cfg.adxThreshold;

  // SHORT: price crosses below Daily SMA200
  // prevClose >= SMA200 AND currentClose < SMA200 AND ADX > 20
  const shortCrossover =
    prevClose != null &&
    prevClose >= sma200 &&
    currentClose < sma200 &&
    adx != null &&
    adx > cfg.adxThreshold;

  if (longCrossover) {
    const stopLoss = calculateStopLoss(price, atr, 'BUY', cfg);
    const takeProfit = calculateTakeProfit(price, stopLoss, 'BUY', cfg);

    logger.signal('DMA Trend LONG entry (DMA crossover)', {
      price,
      stopLoss,
      takeProfit,
      atr,
      adx,
      sma200,
      symbol: symbol || 'N/A',
    });

    return {
      signal: 'BUY',
      action: 'BUY',
      price,
      timestamp,
      stopLoss,
      takeProfit,
      atr,
      sma200,
      adx,
      entryReason: 'DMA_CROSSOVER',
      suggestedRiskPercent: 0.01,
      symbol,
      debug: { reason: 'LONG_CROSSOVER', prevClose, currentClose, sma200, adx },
    };
  }

  if (shortCrossover) {
    const stopLoss = calculateStopLoss(price, atr, 'SELL', cfg);
    const takeProfit = calculateTakeProfit(price, stopLoss, 'SELL', cfg);

    logger.signal('DMA Trend SHORT entry (DMA crossover)', {
      price,
      stopLoss,
      takeProfit,
      atr,
      adx,
      sma200,
      symbol: symbol || 'N/A',
    });

    return {
      signal: 'SELL',
      action: 'SELL',
      price,
      timestamp,
      stopLoss,
      takeProfit,
      atr,
      sma200,
      adx,
      entryReason: 'DMA_CROSSOVER',
      suggestedRiskPercent: 0.01,
      symbol,
      debug: { reason: 'SHORT_CROSSOVER', prevClose, currentClose, sma200, adx },
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
    sma200,
    adx,
    debug: { reason: 'NO_CROSSOVER', prevClose, currentClose, sma200, adx },
  };
}

function calculateStopLoss(entryPrice, atr, direction, cfg = null) {
  const c = cfg || getConfig();
  const mult = c.atrMultiplier;
  if (direction === 'BUY') {
    return roundTo(entryPrice - mult * atr, 8);
  }
  return roundTo(entryPrice + mult * atr, 8);
}

function calculateTakeProfit(entryPrice, stopLoss, direction, cfg = null) {
  const c = cfg || getConfig();
  const riskDist = Math.abs(entryPrice - stopLoss);
  const tpDist = (c.takeProfitRR ?? 3) * riskDist;

  if (direction === 'BUY') {
    return roundTo(entryPrice + tpDist, 8);
  }
  return roundTo(entryPrice - tpDist, 8);
}

/**
 * Update trailing stop: trailingStop = highestPrice - (2 * ATR) for LONG
 */
function updateTrailingStop(trade, currentPrice, atr, prevHigh, prevLow) {
  if (!trade || !atr || Number.isNaN(atr)) return trade;
  if (trade.status && trade.status !== 'OPEN') return trade;

  const cfg = getConfig();
  const mult = cfg.atrMultiplier ?? 2;
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
    logger.trade('DMA Trend trailing stop update', {
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
 * Exit: SL hit, TP hit, trailing stop hit, opposite crossover
 */
function shouldExitTrade(trade, currentCandle, atr, context = {}) {
  if (!trade || !currentCandle) return null;
  const [, open, high, low, close] = currentCandle;
  const side = trade.side || 'BUY';
  const { sma200 } = context;

  // 1. Stop loss
  if (side === 'BUY' && low <= trade.stopLoss) {
    logger.trade('DMA Trend exit: STOP_LOSS', { tradeId: trade.id, price: trade.stopLoss });
    return { exitPrice: trade.stopLoss, reason: 'STOP_LOSS' };
  }
  if (side === 'SELL' && high >= trade.stopLoss) {
    logger.trade('DMA Trend exit: STOP_LOSS', { tradeId: trade.id, price: trade.stopLoss });
    return { exitPrice: trade.stopLoss, reason: 'STOP_LOSS' };
  }

  // 2. Take profit
  const tp = trade.takeProfit;
  if (tp != null) {
    if (side === 'BUY' && high >= tp) {
      const riskDist = trade.initialRiskDistance || Math.abs(trade.entryPrice - trade.stopLoss);
      const rMultiple = riskDist > 0 ? roundTo((tp - trade.entryPrice) / riskDist, 4) : null;
      logger.trade('DMA Trend exit: TAKE_PROFIT', { tradeId: trade.id, price: tp, rMultiple });
      return { exitPrice: tp, reason: 'TAKE_PROFIT' };
    }
    if (side === 'SELL' && low <= tp) {
      const riskDist = trade.initialRiskDistance || Math.abs(trade.entryPrice - trade.stopLoss);
      const rMultiple = riskDist > 0 ? roundTo((trade.entryPrice - tp) / riskDist, 4) : null;
      logger.trade('DMA Trend exit: TAKE_PROFIT', { tradeId: trade.id, price: tp, rMultiple });
      return { exitPrice: tp, reason: 'TAKE_PROFIT' };
    }
  }

  // 3. Trailing stop (stopLoss is updated by updateTrailingStop, so SL check above covers it)

  // 4. Opposite crossover
  // LONG: price crosses below SMA200 (prevClose >= SMA200, currentClose < SMA200)
  // SHORT: price crosses above SMA200 (prevClose <= SMA200, currentClose > SMA200)
  if (sma200 != null) {
    // We need prevClose - use context if passed
    const { prevClose } = context;
    if (prevClose != null) {
      if (side === 'BUY' && prevClose >= sma200 && close < sma200) {
        logger.trade('DMA Trend exit: OPPOSITE_CROSSOVER (below SMA200)', { tradeId: trade.id, price: close });
        return { exitPrice: close, reason: 'OPPOSITE_CROSSOVER' };
      }
      if (side === 'SELL' && prevClose <= sma200 && close > sma200) {
        logger.trade('DMA Trend exit: OPPOSITE_CROSSOVER (above SMA200)', { tradeId: trade.id, price: close });
        return { exitPrice: close, reason: 'OPPOSITE_CROSSOVER' };
      }
    }
  }

  return null;
}

/**
 * Log trade metrics (R-multiple, exit reason)
 */
function logTradeMetrics(closedTrades) {
  if (!closedTrades || closedTrades.length === 0) return;

  for (const t of closedTrades) {
    const riskDist = t.initialRiskDistance || Math.abs(t.entryPrice - t.stopLoss);
    const rMultiple = riskDist > 0 && t.quantity > 0
      ? roundTo(t.pnl / (riskDist * t.quantity), 4)
      : null;
    logger.trade('DMA Trend trade summary', {
      tradeId: t.id,
      exitReason: t.exitReason ?? 'UNKNOWN',
      rMultiple,
      pnl: roundTo(t.pnl, 4),
    });
  }

  const wins = closedTrades.filter((t) => t.pnl > 0);
  const losses = closedTrades.filter((t) => t.pnl < 0);
  const winRate = closedTrades.length > 0 ? roundTo((wins.length / closedTrades.length) * 100, 2) : 0;
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? roundTo(grossProfit / grossLoss, 4) : grossProfit > 0 ? Infinity : 0;

  logger.trade('DMA Trend metrics', {
    totalTrades: closedTrades.length,
    winRate,
    profitFactor,
  });
}

/**
 * Wrapper for strategy: dmaTrendStrategy({ ltfOhlcv, htfOhlcv, openTrades, symbol })
 */
function dmaTrendStrategy({ ltfOhlcv, htfOhlcv, openTrades = [], symbol = null }) {
  if (!ltfOhlcv || ltfOhlcv.length === 0) {
    return {
      signal: 'HOLD',
      price: 0,
      timestamp: 0,
      stopLoss: null,
      takeProfit: null,
      atr: null,
      debug: { reason: 'NO_LTF_CANDLES' },
    };
  }
  const currentIndex = ltfOhlcv.length - 1;
  return generateSignal(ltfOhlcv, htfOhlcv || [], currentIndex, openTrades, symbol);
}

module.exports = {
  generateSignal,
  calculateStopLoss,
  calculateTakeProfit,
  updateTrailingStop,
  shouldExitTrade,
  dmaTrendStrategy,
  logTradeMetrics,
  clipToClosedDailyCandles,
  getDailySma200,
  MAX_OPEN_TRADES: 2,
  MAX_TRADES_PER_DAY: 3,
};
