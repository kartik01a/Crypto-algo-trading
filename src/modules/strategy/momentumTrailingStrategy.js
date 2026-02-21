/**
 * Momentum Trailing Strategy
 *
 * Momentum strategy with activation-based trailing stop.
 * Uses closed candles only - no lookahead bias.
 *
 * Indicators: Momentum (close - close[n]), Momentum Change, EMA50, ATR(14)
 * Entry: momentum + momentumChange alignment with EMA50 trend filter
 * Stop: 1.5 * ATR initial, activation-based trailing (1% activation, 0.5% trail)
 */

const { EMA, ATR } = require('technicalindicators');
const { roundTo } = require('../../utils/helpers');
const logger = require('../../utils/logger');
const config = require('../../config');

const getConfig = () => ({
  momentumLength: config.strategy?.momentumTrailing?.momentumLength ?? 12,
  activationPercent: config.strategy?.momentumTrailing?.activationPercent ?? 0.01,
  trailingPercent: config.strategy?.momentumTrailing?.trailingPercent ?? 0.005,
  atrMultiplier: config.strategy?.momentumTrailing?.atrMultiplier ?? 1.5,
  breakevenRR: config.strategy?.momentumTrailing?.breakevenRR ?? 2,
  partialTPRR: config.strategy?.momentumTrailing?.partialTPRR ?? 3,
  partialClosePercent: config.strategy?.momentumTrailing?.partialClosePercent ?? 0.5,
});

const EMA_PERIOD = 50;
const ATR_PERIOD = 14;
const MIN_CANDLES = 60; // EMA50 + buffer for momentum/ATR
const MAX_OPEN_TRADES = 2;
const MAX_TRADES_PER_DAY = 5;
const RISK_PER_TRADE = 0.01; // 1%

function last(arr) {
  return arr && arr.length ? arr[arr.length - 1] : undefined;
}

function calculateEmaLast(closes, period) {
  const values = EMA.calculate({ values: closes, period });
  return last(values);
}

function calculateAtrLast(ohlcv, period) {
  const high = ohlcv.map((c) => c[2]);
  const low = ohlcv.map((c) => c[3]);
  const close = ohlcv.map((c) => c[4]);
  const values = ATR.calculate({ high, low, close, period });
  return last(values);
}

/**
 * Calculate momentum: close - close[n]
 */
function getMomentum(closes, n) {
  if (!closes || closes.length < n + 1) return null;
  const current = closes[closes.length - 1];
  const prev = closes[closes.length - 1 - n];
  return current - prev;
}

/**
 * Calculate momentum change: momentum - previous momentum
 */
function getMomentumChange(closes, n) {
  if (!closes || closes.length < n + 2) return null;
  const currentMomentum = getMomentum(closes, n);
  const prevCloses = closes.slice(0, -1);
  const prevMomentum = getMomentum(prevCloses, n);
  if (currentMomentum == null || prevMomentum == null) return null;
  return currentMomentum - prevMomentum;
}

/**
 * Generate trading signal
 * @param {Array<Array>} candles - [ts, open, high, low, close, vol]
 * @param {number} currentIndex - Index of current candle (inclusive, no lookahead)
 * @param {Array} openTrades - Currently open trades
 * @returns {Object} { signal, action, price, stopLoss, ... }
 */
function generateSignal(candles, currentIndex, openTrades = []) {
  const cfg = getConfig();

  if (!candles || currentIndex < 0 || currentIndex >= candles.length) {
    return {
      signal: 'HOLD',
      action: 'HOLD',
      price: 0,
      timestamp: 0,
      stopLoss: null,
      atr: null,
      debug: { reason: 'INVALID_INPUT' },
    };
  }

  const currentCandle = candles[currentIndex];
  const price = currentCandle[4];
  const timestamp = currentCandle[0];

  if (openTrades.length >= MAX_OPEN_TRADES) {
    return {
      signal: 'HOLD',
      action: 'HOLD',
      price,
      timestamp,
      stopLoss: null,
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
      atr: null,
      debug: { reason: 'INSUFFICIENT_CANDLES', have: slice.length, need: MIN_CANDLES },
    };
  }

  const closes = slice.map((c) => c[4]);
  const momentum = getMomentum(closes, cfg.momentumLength);
  const momentumChange = getMomentumChange(closes, cfg.momentumLength);
  const ema50 = calculateEmaLast(closes, EMA_PERIOD);
  const atr = calculateAtrLast(slice, ATR_PERIOD);

  if ([momentum, momentumChange, ema50, atr].some((v) => v == null || typeof v !== 'number' || Number.isNaN(v))) {
    return {
      signal: 'HOLD',
      action: 'HOLD',
      price,
      timestamp,
      stopLoss: null,
      atr: atr ?? null,
      debug: { reason: 'INDICATOR_NAN', momentum, momentumChange, ema50, atr },
    };
  }

  if (atr <= 0) {
    return {
      signal: 'HOLD',
      action: 'HOLD',
      price,
      timestamp,
      stopLoss: null,
      atr,
      debug: { reason: 'ATR_INVALID' },
    };
  }

  // LONG: momentum > 0, momentumChange > 0, close > EMA50
  const longConditions = momentum > 0 && momentumChange > 0 && price > ema50;

  // SHORT: momentum < 0, momentumChange < 0, close < EMA50
  const shortConditions = momentum < 0 && momentumChange < 0 && price < ema50;

  if (longConditions) {
    const stopLoss = calculateStopLoss(price, atr, 'BUY', cfg);
    const entryReason = 'MOMENTUM_LONG';
    logger.signal('MomentumTrailing LONG entry', {
      entryReason,
      price,
      stopLoss,
      atr,
      momentum: roundTo(momentum, 4),
      momentumChange: roundTo(momentumChange, 4),
      ema50: roundTo(ema50, 2),
    });

    return {
      signal: 'BUY',
      action: 'BUY',
      price,
      timestamp,
      stopLoss,
      atr,
      ema50,
      entryReason,
      suggestedRiskPercent: RISK_PER_TRADE,
      debug: { reason: 'LONG_ENTRY', momentum, momentumChange, ema50 },
    };
  }

  if (shortConditions) {
    const stopLoss = calculateStopLoss(price, atr, 'SELL', cfg);
    const entryReason = 'MOMENTUM_SHORT';
    logger.signal('MomentumTrailing SHORT entry', {
      entryReason,
      price,
      stopLoss,
      atr,
      momentum: roundTo(momentum, 4),
      momentumChange: roundTo(momentumChange, 4),
      ema50: roundTo(ema50, 2),
    });

    return {
      signal: 'SELL',
      action: 'SELL',
      price,
      timestamp,
      stopLoss,
      atr,
      ema50,
      entryReason,
      suggestedRiskPercent: RISK_PER_TRADE,
      debug: { reason: 'SHORT_ENTRY', momentum, momentumChange, ema50 },
    };
  }

  return {
    signal: 'HOLD',
    action: 'HOLD',
    price,
    timestamp,
    stopLoss: null,
    atr,
    ema50,
    debug: { reason: 'NO_ENTRY', momentum, momentumChange, ema50 },
  };
}

/**
 * Calculate stop loss: SL = atrMultiplier * ATR
 * BUY: entryPrice - atrMultiplier * ATR
 * SELL: entryPrice + atrMultiplier * ATR
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
 * Get R-multiple for current price
 */
function getRMultiple(trade, currentPrice) {
  const riskDist = trade.initialRiskDistance || Math.abs(trade.entryPrice - (trade.initialStopLoss ?? trade.stopLoss));
  if (!riskDist || riskDist <= 0) return 0;
  const side = trade.side || 'BUY';
  const profit = side === 'BUY' ? (currentPrice - trade.entryPrice) : (trade.entryPrice - currentPrice);
  return profit / riskDist;
}

/**
 * Update activation-based trailing stop with breakeven
 *
 * Breakeven: If profit >= 2R, move stop to entry price
 *
 * LONG:
 * - Activate when currentPrice >= entryPrice * (1 + activationPercent)
 * - Track highestPrice
 * - trailingStop = highestPrice * (1 - trailingPercent)
 *
 * SHORT:
 * - Activate when currentPrice <= entryPrice * (1 - activationPercent)
 * - Track lowestPrice
 * - trailingStop = lowestPrice * (1 + trailingPercent)
 */
function updateTrailingStop(trade, currentPrice, atr, prevHigh, prevLow) {
  if (!trade || trade.status !== 'OPEN') return trade;

  const cfg = getConfig();
  const side = trade.side || 'BUY';
  const activationPercent = cfg.activationPercent;
  const trailingPercent = cfg.trailingPercent;
  const breakevenRR = cfg.breakevenRR;

  const entryPrice = trade.entryPrice;
  const riskDist = trade.initialRiskDistance || Math.abs(entryPrice - (trade.initialStopLoss ?? trade.stopLoss));
  let trailingActive = trade.trailingActive ?? false;
  let breakevenTriggered = trade.breakevenTriggered ?? false;
  let highestPrice = trade.highestPrice ?? entryPrice;
  let lowestPrice = trade.lowestPrice ?? entryPrice;

  // Update high/low from candle data
  if (prevHigh != null) highestPrice = Math.max(highestPrice, prevHigh);
  if (prevLow != null) lowestPrice = Math.min(lowestPrice, prevLow);
  if (side === 'BUY') highestPrice = Math.max(highestPrice, currentPrice);
  if (side === 'SELL') lowestPrice = Math.min(lowestPrice, currentPrice);

  let newStop = trade.stopLoss;

  // Step 2: Breakeven - if profit >= 2R, move stop to entry
  if (riskDist > 0 && !breakevenTriggered) {
    const rMultiple = getRMultiple(trade, currentPrice);
    if (rMultiple >= breakevenRR) {
      breakevenTriggered = true;
      if (side === 'BUY' && entryPrice > newStop) {
        newStop = entryPrice;
        logger.trade('MomentumTrailing BREAKEVEN (LONG)', {
          tradeId: trade.id,
          entryPrice,
          rMultiple: roundTo(rMultiple, 2),
        });
      }
      if (side === 'SELL' && entryPrice < newStop) {
        newStop = entryPrice;
        logger.trade('MomentumTrailing BREAKEVEN (SHORT)', {
          tradeId: trade.id,
          entryPrice,
          rMultiple: roundTo(rMultiple, 2),
        });
      }
    }
  }

  if (side === 'BUY') {
    const activationThreshold = entryPrice * (1 + activationPercent);
    if (!trailingActive && currentPrice >= activationThreshold) {
      trailingActive = true;
      logger.trade('MomentumTrailing trailing ACTIVATED (LONG)', {
        tradeId: trade.id,
        entryPrice,
        currentPrice,
        activationThreshold: roundTo(activationThreshold, 8),
      });
    }

    if (trailingActive) {
      const trailingStop = highestPrice * (1 - trailingPercent);
      if (trailingStop > newStop) {
        logger.trade('MomentumTrailing trailing UPDATE (LONG)', {
          tradeId: trade.id,
          oldStop: trade.stopLoss,
          newStop: roundTo(trailingStop, 8),
          highestPrice: roundTo(highestPrice, 8),
        });
        newStop = trailingStop;
      }
    }
  } else {
    const activationThreshold = entryPrice * (1 - activationPercent);
    if (!trailingActive && currentPrice <= activationThreshold) {
      trailingActive = true;
      logger.trade('MomentumTrailing trailing ACTIVATED (SHORT)', {
        tradeId: trade.id,
        entryPrice,
        currentPrice,
        activationThreshold: roundTo(activationThreshold, 8),
      });
    }

    if (trailingActive) {
      const trailingStop = lowestPrice * (1 + trailingPercent);
      if (trailingStop < newStop) {
        logger.trade('MomentumTrailing trailing UPDATE (SHORT)', {
          tradeId: trade.id,
          oldStop: trade.stopLoss,
          newStop: roundTo(trailingStop, 8),
          lowestPrice: roundTo(lowestPrice, 8),
        });
        newStop = trailingStop;
      }
    }
  }

  return {
    ...trade,
    stopLoss: roundTo(newStop, 8),
    highestPrice,
    lowestPrice,
    trailingActive,
    breakevenTriggered,
  };
}

/**
 * Check if trade should exit
 * Exit: 1. Stop loss hit, 2. Trailing stop hit, 3. Breakeven hit
 */
function shouldExitTrade(trade, currentCandle, atr, context = {}) {
  if (!trade || !currentCandle) return null;
  const [, open, high, low, close] = currentCandle;
  const side = trade.side || 'BUY';

  // Stop loss (includes trailing stop and breakeven - all update trade.stopLoss)
  if (side === 'BUY' && low <= trade.stopLoss) {
    const reason = trade.trailingActive ? 'TRAILING_STOP' : trade.breakevenTriggered ? 'BREAKEVEN' : 'STOP_LOSS';
    logger.trade('MomentumTrailing exit: ' + reason, { tradeId: trade.id, price: trade.stopLoss });
    return { exitPrice: trade.stopLoss, reason };
  }
  if (side === 'SELL' && high >= trade.stopLoss) {
    const reason = trade.trailingActive ? 'TRAILING_STOP' : trade.breakevenTriggered ? 'BREAKEVEN' : 'STOP_LOSS';
    logger.trade('MomentumTrailing exit: ' + reason, { tradeId: trade.id, price: trade.stopLoss });
    return { exitPrice: trade.stopLoss, reason };
  }

  return null;
}

/**
 * Check if partial take profit should trigger (profit >= 3R, close 50%)
 * Returns partial close info or null
 */
function checkPartialTakeProfit(trade, currentCandle) {
  if (!trade || !currentCandle || trade.partialTPTriggered) return null;

  const riskDist = trade.initialRiskDistance || Math.abs(trade.entryPrice - (trade.initialStopLoss ?? trade.stopLoss));
  if (!riskDist || riskDist <= 0) return null;

  const cfg = getConfig();
  const partialTPRR = cfg.partialTPRR;
  const side = trade.side || 'BUY';

  // 3R profit level: LONG = entry + 3*R, SHORT = entry - 3*R
  const tpLevel = side === 'BUY'
    ? trade.entryPrice + partialTPRR * riskDist
    : trade.entryPrice - partialTPRR * riskDist;

  const [, open, high, low, close] = currentCandle;

  // Did price reach 3R? LONG: high >= tpLevel, SHORT: low <= tpLevel
  const reached = side === 'BUY' ? high >= tpLevel : low <= tpLevel;
  if (!reached) return null;

  const exitPrice = tpLevel; // Use exact 3R level for fill
  const closePercent = cfg.partialClosePercent ?? 0.5;

  logger.trade('MomentumTrailing PARTIAL_TP', {
    tradeId: trade.id,
    exitPrice: roundTo(exitPrice, 8),
    closePercent: closePercent * 100,
    rLevel: partialTPRR,
  });

  return {
    partialClose: true,
    exitPrice,
    closePercent,
    reason: 'PARTIAL_TP',
  };
}

/**
 * Log trade metrics
 */
function logTradeMetrics(closedTrades) {
  if (!closedTrades || closedTrades.length === 0) return;

  for (const t of closedTrades) {
    const riskDist = t.initialRiskDistance || Math.abs(t.entryPrice - (t.initialStopLoss ?? t.stopLoss));
    const rMultiple = riskDist > 0 && t.quantity > 0
      ? roundTo(t.pnl / (riskDist * t.quantity), 4)
      : null;
    logger.trade('MomentumTrailing trade summary', {
      tradeId: t.id,
      entryReason: t.entryReason ?? 'UNKNOWN',
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

  logger.trade('MomentumTrailing metrics', {
    totalTrades: closedTrades.length,
    winRate,
    profitFactor,
  });
}

/**
 * Wrapper: momentumTrailingStrategy({ ltfOhlcv, openTrades })
 * Single timeframe - no HTF required.
 */
function momentumTrailingStrategy({ ltfOhlcv, openTrades = [] }) {
  if (!ltfOhlcv || ltfOhlcv.length === 0) {
    return {
      signal: 'HOLD',
      price: 0,
      timestamp: 0,
      stopLoss: null,
      atr: null,
      debug: { reason: 'NO_CANDLES' },
    };
  }
  const currentIndex = ltfOhlcv.length - 1;
  return generateSignal(ltfOhlcv, currentIndex, openTrades);
}

module.exports = {
  generateSignal,
  calculateStopLoss,
  updateTrailingStop,
  shouldExitTrade,
  checkPartialTakeProfit,
  momentumTrailingStrategy,
  logTradeMetrics,
  getMomentum,
  getMomentumChange,
  getRMultiple,
  MAX_OPEN_TRADES,
  MAX_TRADES_PER_DAY,
};
