/**
 * Swing Trend Strategy
 *
 * Designed for 4H candles with 1D HTF confirmation.
 * HTF: 1 Day (trend filter)
 * LTF: 4 Hour (entry & exit)
 *
 * Indicators: EMA50, EMA200 (trend), RSI(14), ATR(14)
 * No lookahead - uses closed candles only.
 */

const { EMA, RSI, ATR, ADX } = require('technicalindicators');
const { roundTo } = require('../../utils/helpers');
const logger = require('../../utils/logger');
const config = require('../../config');

// Optimization flags (from config or defaults)
const getConfig = () => ({
  atrMultiplier: config.strategy?.swingTrend?.atrMultiplier ?? 1.5,
  trailAtrMultiplier: config.strategy?.swingTrend?.trailAtrMultiplier ?? 2.5,
  takeProfitR: config.strategy?.swingTrend?.takeProfitR ?? 3.5,
  cooldownCandles: config.strategy?.swingTrend?.cooldownCandles ?? 2,
  buyScoreThreshold: config.strategy?.swingTrend?.buyScoreThreshold ?? 7,
  sellScoreThreshold: config.strategy?.swingTrend?.sellScoreThreshold ?? 7,
  timeExitCandles: config.strategy?.swingTrend?.timeExitCandles ?? 15,
  adxMin: config.strategy?.swingTrend?.adxMin ?? 20,
  adxStrongThreshold: config.strategy?.swingTrend?.adxStrongThreshold ?? 25,
  atrPercentMin: config.strategy?.swingTrend?.atrPercentMin ?? 0.5,
  earlyExitRThreshold: config.strategy?.swingTrend?.earlyExitRThreshold ?? -0.5,
});

// Constants
const HTF_EMA_FAST = 50;
const HTF_EMA_SLOW = 200;
const LTF_EMA_PERIOD = 50;
const RSI_PERIOD = 14;
const ATR_PERIOD = 14;
const ADX_PERIOD = 14;
const ATR_AVG_PERIOD = 20;
const PRICE_NEAR_EMA_PERCENT = 0.025;
const PULLBACK_DISTANCE = 0.025;
const RSI_BUY_MIN = 35;
const RSI_BUY_MAX = 60;
const RSI_SELL_MIN = 40;
const RSI_SELL_MAX = 65;
const SIDEWAYS_THRESHOLD = 0.005; // EMA50 ~ EMA200 within 0.5%

const MIN_LTF_CANDLES = 220; // EMA200 + buffer
const MIN_HTF_CANDLES = 210; // EMA200 + buffer

// 1 day = 6 candles of 4H
const LTF_PER_HTF = 6;

const DEBUG_TRADES = process.env.DEBUG_TRADES === 'true';

function last(arr) {
  return arr && arr.length ? arr[arr.length - 1] : undefined;
}

function lastN(arr, n) {
  if (!arr || arr.length < n) return null;
  return arr.slice(-n);
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

function calculateRsiLast(closes, period) {
  const values = RSI.calculate({ values: closes, period });
  return last(values);
}

function calculateAtrLast(ohlcv, period) {
  const high = ohlcv.map((c) => c[2]);
  const low = ohlcv.map((c) => c[3]);
  const close = ohlcv.map((c) => c[4]);
  const values = ATR.calculate({ high, low, close, period });
  return last(values);
}

function calculateAtrSma(ohlcv, atrPeriod, avgPeriod) {
  const high = ohlcv.map((c) => c[2]);
  const low = ohlcv.map((c) => c[3]);
  const close = ohlcv.map((c) => c[4]);
  const atrValues = ATR.calculate({ high, low, close, period: atrPeriod });
  if (atrValues.length < avgPeriod) return null;
  const recent = atrValues.slice(-avgPeriod);
  return recent.reduce((a, b) => a + b, 0) / avgPeriod;
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
 * Get HTF metrics from 1D candles (for scoring)
 */
function getHtfMetrics(htfOhlcv) {
  const candles = lastN(htfOhlcv, Math.max(MIN_HTF_CANDLES, HTF_EMA_SLOW));
  if (!candles || candles.length < HTF_EMA_SLOW) {
    return null;
  }
  const closes = candles.map((c) => c[4]);
  const ema50 = calculateEmaLast(closes, HTF_EMA_FAST);
  const ema200 = calculateEmaLast(closes, HTF_EMA_SLOW);
  const price = last(closes);
  if ([ema50, ema200, price].some((v) => typeof v !== 'number' || Number.isNaN(v))) return null;
  return { htfClose: price, htfEma50: ema50, htfEma200: ema200 };
}

/**
 * Calculate BUY score (0-9+)
 */
function calculateBuyScore(htfMetrics, ltfPrice, ltfEma50, rsi, adx, atrPercent, close, open, currentLow, prevLow) {
  let score = 0;
  if (!htfMetrics) return 0;
  const cfg = getConfig();

  const { htfClose, htfEma50, htfEma200 } = htfMetrics;

  // TREND
  if (htfClose > htfEma200) score += 2;
  if (htfEma50 > htfEma200) score += 2;
  if (adx != null && adx > cfg.adxMin) score += 1;

  // PULLBACK
  const distanceFromEma = ltfEma50 != null ? Math.abs(ltfPrice - ltfEma50) / ltfPrice : 1;
  if (distanceFromEma < PULLBACK_DISTANCE) score += 2;
  if (rsi != null && rsi >= 40 && rsi <= 50) score += 1;

  // MOMENTUM
  if (close > open) score += 1;
  if (prevLow != null && currentLow > prevLow) score += 1;

  // VOLATILITY
  if (atrPercent > 0.5) score += 1;

  // STRONG TREND BONUS
  if (adx != null && adx > cfg.adxStrongThreshold) score += 1;

  return score;
}

/**
 * Calculate SELL score (0-9+) - mirror logic
 */
function calculateSellScore(htfMetrics, ltfPrice, ltfEma50, rsi, adx, atrPercent, close, open, currentHigh, prevHigh) {
  let score = 0;
  if (!htfMetrics) return 0;
  const cfg = getConfig();

  const { htfClose, htfEma50, htfEma200 } = htfMetrics;

  // TREND (bearish)
  if (htfClose < htfEma200) score += 2;
  if (htfEma50 < htfEma200) score += 2;
  if (adx != null && adx > cfg.adxMin) score += 1;

  // PULLBACK (price near EMA50 for short)
  const distanceFromEma = ltfEma50 != null ? Math.abs(ltfPrice - ltfEma50) / ltfPrice : 1;
  if (distanceFromEma < PULLBACK_DISTANCE) score += 2;
  if (rsi != null && rsi >= 45 && rsi <= 60) score += 1;

  // MOMENTUM (bearish)
  if (close < open) score += 1;
  if (prevHigh != null && currentHigh < prevHigh) score += 1;

  // VOLATILITY
  if (atrPercent > 0.5) score += 1;

  // STRONG TREND BONUS
  if (adx != null && adx > cfg.adxStrongThreshold) score += 1;

  return score;
}

function getHtfTrend(htfOhlcv) {
  if (DEBUG_TRADES && htfOhlcv && htfOhlcv.length > 0) {
    return { trend: 'UP', reason: 'DEBUG_TRADES', ema50: null, ema200: null, price: last(htfOhlcv.map((c) => c[4])) };
  }
  const m = getHtfMetrics(htfOhlcv);
  if (!m) return { trend: 'NONE', reason: 'INSUFFICIENT_HTF_CANDLES' };
  const { htfClose, htfEma50, htfEma200 } = m;
  if (htfClose > htfEma200 && htfEma50 > htfEma200) return { trend: 'UP', ema50: htfEma50, ema200: htfEma200, price: htfClose };
  if (htfClose < htfEma200 && htfEma50 < htfEma200) return { trend: 'DOWN', ema50: htfEma50, ema200: htfEma200, price: htfClose };
  return { trend: 'NONE', reason: 'NO_CLEAR_TREND', ema50: htfEma50, ema200: htfEma200, price: htfClose };
}

/**
 * Generate trading signal
 * @param {Array<Array>} ltfCandles - 4H candles [ts, open, high, low, close, vol]
 * @param {Array<Array>} htfCandles - 1D candles
 * @param {number} currentIndex - Index of current candle (inclusive, no lookahead)
 * @param {Array} openTrades - Currently open trades (for max open limit)
 * @returns {Object} { signal, action, confidence, price, stopLoss, takeProfit, ... }
 */
function generateSignal(ltfCandles, htfCandles, currentIndex, openTrades = []) {
  const cfg = getConfig();
  const maxOpenTrades = 2;

  if (!ltfCandles || currentIndex < 0 || currentIndex >= ltfCandles.length) {
    return {
      signal: 'HOLD',
      action: 'HOLD',
      confidence: 0,
      price: 0,
      timestamp: 0,
      stopLoss: null,
      takeProfit1: null,
      takeProfit2: null,
      takeProfit: null,
      atr: null,
      debug: { reason: 'INVALID_INPUT' },
    };
  }

  const currentCandle = ltfCandles[currentIndex];
  const price = currentCandle[4];
  const timestamp = currentCandle[0];
  const open = currentCandle[1];

  // Block new entries if at max open trades
  if (openTrades.length >= maxOpenTrades) {
    return {
      signal: 'HOLD',
      action: 'HOLD',
      confidence: 0,
      price,
      timestamp,
      stopLoss: null,
      takeProfit1: null,
      takeProfit2: null,
      takeProfit: null,
      atr: null,
      debug: { reason: 'MAX_OPEN_TRADES', openCount: openTrades.length },
    };
  }

  // Need enough LTF data
  const ltfSlice = ltfCandles.slice(0, currentIndex + 1);
  if (ltfSlice.length < MIN_LTF_CANDLES) {
    return {
      signal: 'HOLD',
      action: 'HOLD',
      confidence: 0,
      price,
      timestamp,
      stopLoss: null,
      takeProfit1: null,
      takeProfit2: null,
      takeProfit: null,
      atr: null,
      debug: { reason: 'INSUFFICIENT_LTF_CANDLES', have: ltfSlice.length, need: MIN_LTF_CANDLES },
    };
  }

  // HTF mapping: 1 day = 6 candles of 4H; use htfIndex for corresponding 1D candle
  const htfIndex = Math.floor(currentIndex / LTF_PER_HTF);
  // Use timestamp-based alignment for trend (full history needed for EMA200)
  const htfAligned = clipToTimestamp(htfCandles || [], timestamp);
  const htfAlignedByIndex = htfCandles && htfIndex < htfCandles.length
    ? htfCandles.slice(0, htfIndex + 1)
    : htfAligned;

  const htfForTrend = htfAligned.length >= MIN_HTF_CANDLES ? htfAligned : htfAlignedByIndex;

  if (htfForTrend.length < (DEBUG_TRADES ? 1 : MIN_HTF_CANDLES)) {
    return {
      signal: 'HOLD',
      action: 'HOLD',
      confidence: 0,
      price,
      timestamp,
      stopLoss: null,
      takeProfit1: null,
      takeProfit2: null,
      takeProfit: null,
      atr: null,
      debug: { reason: 'INSUFFICIENT_HTF_CANDLES', have: htfForTrend.length, need: MIN_HTF_CANDLES, htfIndex },
    };
  }

  const htfMetrics = getHtfMetrics(htfForTrend);

  // LTF indicators
  const closes = ltfSlice.map((c) => c[4]);
  const ema50 = calculateEmaLast(closes, LTF_EMA_PERIOD);
  const rsi = calculateRsiLast(closes, RSI_PERIOD);
  const atr = calculateAtrLast(ltfSlice, ATR_PERIOD);
  const atrSma = calculateAtrSma(ltfSlice, ATR_PERIOD, ATR_AVG_PERIOD);
  const adx = calculateAdxLast(ltfSlice, ADX_PERIOD);

  // Market structure: BUY = current low > prev low, SELL = current high < prev high
  const prevCandle = currentIndex >= 1 ? ltfCandles[currentIndex - 1] : null;
  const currentLow = currentCandle[3];
  const currentHigh = currentCandle[2];
  const prevLow = prevCandle ? prevCandle[3] : null;
  const prevHigh = prevCandle ? prevCandle[2] : null;

  const atrPercent = atr != null && price > 0 ? (atr / price) * 100 : 0;
  const buyScore = calculateBuyScore(htfMetrics, price, ema50, rsi, adx, atrPercent, price, open, currentLow, prevLow);
  const sellScore = calculateSellScore(htfMetrics, price, ema50, rsi, adx, atrPercent, price, open, currentHigh, prevHigh);

  const debugPayload = {
    index: currentIndex,
    htfIndex,
    htfCandlesLength: (htfCandles || []).length,
    htfAlignedLength: htfAligned.length,
    price,
    ema50: ema50 != null ? roundTo(ema50, 2) : null,
    rsi: rsi != null ? roundTo(rsi, 2) : null,
    atr: atr != null ? roundTo(atr, 4) : null,
    adx: adx != null ? roundTo(adx, 2) : null,
    atrPercent: atr != null ? roundTo(atrPercent, 4) : null,
    buyScore,
    sellScore,
  };
  if (process.env.DEBUG_SWING === 'true' && (currentIndex % 100 === 0 || buyScore >= cfg.buyScoreThreshold || sellScore >= cfg.sellScoreThreshold)) {
    console.log('[SwingTrend] debug', debugPayload);
  }

  if ([ema50, rsi, atr].some((v) => typeof v !== 'number' || Number.isNaN(v))) {
    return {
      signal: 'HOLD',
      action: 'HOLD',
      confidence: 0,
      price,
      timestamp,
      stopLoss: null,
      takeProfit1: null,
      takeProfit2: null,
      takeProfit: null,
      atr: atr ?? null,
      ema50: typeof ema50 === 'number' ? ema50 : null,
      rsi: typeof rsi === 'number' ? rsi : null,
      debug: { reason: 'LTF_INDICATOR_NAN', ...debugPayload },
    };
  }

  // ATR filter: ATR > 0
  if (!DEBUG_TRADES && (atr == null || atr <= 0)) {
    return {
      signal: 'HOLD',
      action: 'HOLD',
      confidence: 0,
      price,
      timestamp,
      stopLoss: null,
      takeProfit1: null,
      takeProfit2: null,
      takeProfit: null,
      atr,
      ema50,
      rsi,
      debug: { reason: 'ATR_INVALID', atr, atrSma, ...debugPayload },
    };
  }

  const suggestedRiskPercent = adx != null && adx < cfg.adxStrongThreshold ? 0.005 : 0.01;

  // BUY: score >= threshold
  if (buyScore >= cfg.buyScoreThreshold || (DEBUG_TRADES && buyScore === 0)) {
    const stopLoss = calculateStopLoss(price, atr, 'BUY', cfg);
    const { takeProfit } = calculateTakeProfit(price, stopLoss, 'BUY', cfg);
    const confidence = Math.min(0.9, 0.5 + buyScore * 0.05);

    if (process.env.DEBUG_SWING !== 'false') {
      console.log('TRADE SIGNAL:', { type: 'BUY', price, buyScore, rsi, adx, confidence });
    }
    logger.signal('SwingTrend BUY entry', { price, stopLoss, takeProfit, atr, rsi, adx, score: buyScore });

    return {
      signal: 'BUY',
      action: 'BUY',
      confidence,
      price,
      timestamp,
      stopLoss,
      takeProfit1: null,
      takeProfit2: null,
      takeProfit,
      atr,
      score: buyScore,
      suggestedRiskPercent,
      ema50,
      rsi,
      debug: { reason: 'SCORE_BUY', score: buyScore, ...debugPayload },
    };
  }

  // SELL: score >= threshold
  if (sellScore >= cfg.sellScoreThreshold || (DEBUG_TRADES && sellScore === 0)) {
    const stopLoss = calculateStopLoss(price, atr, 'SELL', cfg);
    const { takeProfit } = calculateTakeProfit(price, stopLoss, 'SELL', cfg);
    const confidence = Math.min(0.9, 0.5 + sellScore * 0.05);

    if (process.env.DEBUG_SWING !== 'false') {
      console.log('TRADE SIGNAL:', { type: 'SELL', price, sellScore, rsi, adx, confidence });
    }
    logger.signal('SwingTrend SELL entry', { price, stopLoss, takeProfit, atr, rsi, adx, score: sellScore });

    return {
      signal: 'SELL',
      action: 'SELL',
      confidence,
      price,
      timestamp,
      stopLoss,
      takeProfit1: null,
      takeProfit2: null,
      takeProfit,
      atr,
      score: sellScore,
      suggestedRiskPercent,
      ema50,
      rsi,
      debug: { reason: 'SCORE_SELL', score: sellScore, ...debugPayload },
    };
  }

  return {
    signal: 'HOLD',
    action: 'HOLD',
    confidence: 0,
    price,
    timestamp,
    stopLoss: null,
    takeProfit1: null,
    takeProfit2: null,
    takeProfit: null,
    atr,
    ema50,
    rsi,
    debug: { reason: 'NO_ENTRY', ...debugPayload },
  };
}

/**
 * Calculate stop loss
 * BUY: SL = entryPrice - (atrMultiplier * ATR)
 * SELL: SL = entryPrice + (atrMultiplier * ATR)
 */
function calculateStopLoss(entryPrice, atr, direction, cfg = null) {
  const c = cfg || getConfig();
  const mult = c.atrMultiplier;
  if (direction === 'BUY') {
    return roundTo(entryPrice - mult * atr, 8);
  }
  return roundTo(entryPrice + mult * atr, 8);
}

/**
 * Calculate single take profit at takeProfitR (3R or 4R)
 */
function calculateTakeProfit(entryPrice, stopLoss, direction, cfg = null) {
  const c = cfg || getConfig();
  const riskDist = Math.abs(entryPrice - stopLoss);
  const tpDist = (c.takeProfitR ?? 3.5) * riskDist;

  if (direction === 'BUY') {
    return { takeProfit: roundTo(entryPrice + tpDist, 8) };
  }
  return { takeProfit: roundTo(entryPrice - tpDist, 8) };
}

/**
 * Update trailing stop (always trail from entry)
 * BUY: trailingStop = highestPrice - (2.5 * ATR)
 * SELL: trailingStop = lowestPrice + (2.5 * ATR)
 */
function updateTrailingStop(trade, currentPrice, atr, prevHigh, prevLow) {
  if (!trade || !atr || Number.isNaN(atr)) return trade;
  if (trade.status && trade.status !== 'OPEN') return trade;

  const cfg = getConfig();
  const mult = cfg.trailAtrMultiplier ?? 2.5;
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
    logger.trade('SwingTrend trailing stop update', {
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
 * @param {Object} trade - Open trade
 * @param {Array} currentCandle - [timestamp, open, high, low, close, volume]
 * @param {number} atr - Current ATR
 * @param {Object} [context] - { ema50, rsi } for early exit
 * @returns {Object|null} { exitPrice, reason } or null
 */
function shouldExitTrade(trade, currentCandle, atr, context = {}) {
  if (!trade || !currentCandle) return null;
  const [, open, high, low, close] = currentCandle;
  const side = trade.side || 'BUY';
  const { ema50, rsi } = context;

  // Stop loss
  if (side === 'BUY' && low <= trade.stopLoss) {
    logger.trade('SwingTrend exit: STOP_LOSS', { tradeId: trade.id, price: trade.stopLoss });
    return { exitPrice: trade.stopLoss, reason: 'STOP_LOSS' };
  }
  if (side === 'SELL' && high >= trade.stopLoss) {
    logger.trade('SwingTrend exit: STOP_LOSS', { tradeId: trade.id, price: trade.stopLoss });
    return { exitPrice: trade.stopLoss, reason: 'STOP_LOSS' };
  }

  // Single take profit
  const tp = trade.takeProfit ?? trade.takeProfit2 ?? trade.takeProfit1;
  if (tp != null) {
    if (side === 'BUY' && high >= tp) {
      logger.trade('SwingTrend exit: TAKE_PROFIT', { tradeId: trade.id, price: tp });
      return { exitPrice: tp, reason: 'TAKE_PROFIT' };
    }
    if (side === 'SELL' && low <= tp) {
      logger.trade('SwingTrend exit: TAKE_PROFIT', { tradeId: trade.id, price: tp });
      return { exitPrice: tp, reason: 'TAKE_PROFIT' };
    }
  }

  // Trailing stop is applied when price hits stopLoss (updated by updateTrailingStop)

  // Early exit: trade below -0.5R and no momentum (BUY: RSI < 40 and price below EMA50)
  const cfg = getConfig();
  const riskDist = trade.initialRiskDistance || Math.abs(trade.entryPrice - trade.stopLoss);
  const profit = side === 'BUY' ? (close - trade.entryPrice) : (trade.entryPrice - close);
  const rMultiple = riskDist > 0 ? profit / riskDist : 0;
  if (rMultiple < (cfg.earlyExitRThreshold ?? -0.5)) {
    if (side === 'BUY' && rsi != null && rsi < 40 && ema50 != null && close < ema50) {
      logger.trade('SwingTrend exit: EARLY_EXIT', { tradeId: trade.id, price: close, rMultiple, rsi });
      return { exitPrice: close, reason: 'EARLY_EXIT' };
    }
    if (side === 'SELL' && rsi != null && rsi > 60 && ema50 != null && close > ema50) {
      logger.trade('SwingTrend exit: EARLY_EXIT', { tradeId: trade.id, price: close, rMultiple, rsi });
      return { exitPrice: close, reason: 'EARLY_EXIT' };
    }
  }

  // Time exit: close after 15 candles if profit < 1R
  const timeExitCandles = (() => { const c = getConfig(); return c.timeExitCandles ?? 15; })();
  const candleCount = trade.candleCount ?? 0;
  if (candleCount >= timeExitCandles) {
    if (rMultiple < 1) {
      logger.trade('SwingTrend exit: TIME_EXIT', { tradeId: trade.id, price: close, rMultiple });
      return { exitPrice: close, reason: 'TIME_EXIT' };
    }
  }

  return null;
}

/**
 * Log trade metrics (score, R-multiple, avg win, avg loss, expectancy)
 */
function logTradeMetrics(closedTrades) {
  if (!closedTrades || closedTrades.length === 0) return;
  const wins = closedTrades.filter((t) => t.pnl > 0);
  const losses = closedTrades.filter((t) => t.pnl < 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
  const winRate = closedTrades.length > 0 ? (wins.length / closedTrades.length) * 100 : 0;
  const expectancy = closedTrades.length > 0
    ? (wins.length / closedTrades.length) * avgWin - (losses.length / closedTrades.length) * avgLoss
    : 0;
  const tradesWithR = closedTrades.filter((t) => t.initialRiskDistance && t.initialRiskDistance > 0);
  const rMultiples = tradesWithR.map((t) => t.pnl / (t.initialRiskDistance * t.quantity));
  const avgRMultiple = rMultiples.length > 0 ? rMultiples.reduce((a, b) => a + b, 0) / rMultiples.length : null;

  const scores = closedTrades.filter((t) => t.score != null).map((t) => t.score);
  const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;

  for (const t of closedTrades) {
    const rMult = t.initialRiskDistance && t.initialRiskDistance > 0 && t.quantity > 0
      ? roundTo(t.pnl / (t.initialRiskDistance * t.quantity), 4)
      : null;
    logger.trade('SwingTrend trade summary', {
      tradeId: t.id,
      score: t.score ?? 'N/A',
      rMultiple: rMult,
      pnl: roundTo(t.pnl, 4),
    });
  }

  logger.trade('SwingTrend metrics', {
    totalTrades: closedTrades.length,
    winRate: roundTo(winRate, 2),
    avgWin: roundTo(avgWin, 4),
    avgLoss: roundTo(avgLoss, 4),
    expectancy: roundTo(expectancy, 4),
    avgRMultiple: avgRMultiple != null ? roundTo(avgRMultiple, 4) : null,
    avgScore: avgScore != null ? roundTo(avgScore, 2) : null,
    profitFactor: grossLoss > 0 ? roundTo(grossProfit / grossLoss, 4) : grossProfit > 0 ? Infinity : 0,
  });

  return null;
}

/**
 * Wrapper for strategy factory: getSignal(ohlcvHistory, options)
 * Uses ltfOhlcv and htfOhlcv from options.
 */
function swingTrendStrategy({ ltfOhlcv, htfOhlcv, openTrades = [] }) {
  if (!ltfOhlcv || ltfOhlcv.length === 0) {
    return {
      signal: 'HOLD',
      price: 0,
      timestamp: 0,
      stopLoss: null,
      takeProfit1: null,
      takeProfit2: null,
      atr: null,
      debug: { reason: 'NO_LTF_CANDLES' },
    };
  }
  const currentIndex = ltfOhlcv.length - 1;
  return generateSignal(ltfOhlcv, htfOhlcv || [], currentIndex, openTrades);
}

module.exports = {
  generateSignal,
  calculateStopLoss,
  calculateTakeProfit,
  updateTrailingStop,
  shouldExitTrade,
  swingTrendStrategy,
  getHtfTrend,
  logTradeMetrics,
  TIME_EXIT_CANDLES: getConfig().timeExitCandles ?? 15,
  COOLDOWN_CANDLES: getConfig().cooldownCandles,
};
