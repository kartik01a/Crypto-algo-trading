/**
 * Trend-Following Breakout Strategy (v3)
 *
 * Indicators: EMA50, EMA200, EMA20, ATR, ADX(14)
 * Entry: Pullback after breakout - breakout of 20 candles, pullback to EMA20, bounce
 * Filters: ADX > 20, ATR% > 0.3, breakout candle range > 1.2*ATR
 * Stop loss: 1% below entry
 * Exit: Trailing stop (highestPrice - 2*ATR), SL, or time exit
 * Cooldown: 10 candles after losing trade (handled in backtest)
 *
 * No lookahead: uses only data up to and including current candle close.
 */

const { EMA, ATR, ADX } = require('technicalindicators');
const { roundTo } = require('../../utils/helpers');

const EMA_FAST = 50;
const EMA_SLOW = 200;
const EMA_TRAIL = 20;
const ATR_PERIOD = 14;
const ADX_PERIOD = 14;
const BREAKOUT_LOOKBACK = 20;
const STOP_LOSS_PERCENT = 0.01; // 1%
const ATR_PERCENT_MIN = 0.003; // 0.3%
const ATR_TRAIL_MULTIPLIER = 2;
const TIME_EXIT_CANDLES = 50;
const ADX_MIN = 20;
const MOMENTUM_ATR_MULT = 1.2;
const PULLBACK_LOOKBACK = 30; // Max candles to look back for breakout

const MIN_CANDLES = 220;

function last(arr) {
  return arr && arr.length ? arr[arr.length - 1] : undefined;
}

function calculateEmaLast(closes, period) {
  const values = EMA.calculate({ values: closes, period });
  return last(values);
}

function calculateEmaAtEachIndex(closes, period) {
  const values = EMA.calculate({ values: closes, period });
  // EMA returns shorter array; pad with NaN to align indices (result[i] = EMA at closes[i])
  const padded = new Array(closes.length);
  for (let i = 0; i < period - 1; i++) padded[i] = NaN;
  for (let i = 0; i < values.length; i++) padded[period - 1 + i] = values[i];
  return padded;
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
 * Get highest high of candles [startIdx..endIdx) (exclusive endIdx)
 */
function getHighestHighInRange(ohlcv, startIdx, endIdx) {
  if (startIdx < 0 || endIdx > ohlcv.length || startIdx >= endIdx) return null;
  return Math.max(...ohlcv.slice(startIdx, endIdx).map((c) => c[2]));
}

/**
 * Find most recent breakout candle index, then check for pullback + bounce.
 * Breakout: close[i] > highestHigh of candles [i-20..i-1]
 * Pullback: after breakout, some candle j has low[j] <= EMA20[j] * 1.002
 * Bounce: current candle close > EMA20 and close > open (bullish)
 */
function findBreakoutPullbackBounce(ohlcv, ema20Values, atr) {
  const len = ohlcv.length;
  const currentIdx = len - 1;
  const closes = ohlcv.map((c) => c[4]);
  const ema20 = ema20Values[currentIdx];

  if (len < BREAKOUT_LOOKBACK + PULLBACK_LOOKBACK) return null;

  // Scan backwards for most recent breakout (within last PULLBACK_LOOKBACK candles)
  let breakoutIdx = -1;
  const scanStart = Math.max(BREAKOUT_LOOKBACK, currentIdx - PULLBACK_LOOKBACK);
  for (let i = currentIdx; i >= scanStart; i--) {
    const hh = getHighestHighInRange(ohlcv, i - BREAKOUT_LOOKBACK, i);
    if (hh !== null && closes[i] > hh) {
      breakoutIdx = i;
      break;
    }
  }
  if (breakoutIdx < 0) return null;

  // After breakout, was there a pullback? (low <= EMA20 * 1.002)
  let pullbackSeen = false;
  for (let j = breakoutIdx + 1; j < currentIdx; j++) {
    const ema20AtJ = ema20Values[j];
    if (typeof ema20AtJ !== 'number' || Number.isNaN(ema20AtJ)) continue;
    const lowJ = ohlcv[j][3];
    if (lowJ <= ema20AtJ * 1.002) {
      pullbackSeen = true;
      break;
    }
  }
  if (!pullbackSeen) return null;

  // Current candle: bounce (close > EMA20, bullish)
  const currentCandle = ohlcv[currentIdx];
  const close = currentCandle[4];
  const open = currentCandle[1];
  const bullish = close > open;
  const aboveEma = close > ema20;
  if (!bullish || !aboveEma) return null;

  // Momentum: breakout candle range > 1.2 * ATR
  const breakoutCandle = ohlcv[breakoutIdx];
  const breakoutRange = breakoutCandle[2] - breakoutCandle[3];
  const momentumOk = breakoutRange > MOMENTUM_ATR_MULT * atr;

  return {
    breakoutIdx,
    breakoutRange,
    breakoutStrength: atr > 0 ? roundTo(breakoutRange / atr, 4) : null,
    momentumOk,
  };
}

/**
 * Trend-following breakout with pullback entry.
 */
function trendBreakoutStrategy({ ltfOhlcv }) {
  const ltfLast = last(ltfOhlcv);
  if (!ltfLast) {
    return {
      signal: 'HOLD',
      price: 0,
      stopLoss: null,
      takeProfit: null,
      atr: null,
      debug: { reason: 'NO_CANDLES' },
    };
  }

  const price = ltfLast[4];
  const timestamp = ltfLast[0];

  if (ltfOhlcv.length < MIN_CANDLES) {
    return {
      signal: 'HOLD',
      price,
      timestamp,
      stopLoss: null,
      takeProfit: null,
      atr: null,
      debug: { reason: 'INSUFFICIENT_CANDLES', have: ltfOhlcv.length, need: MIN_CANDLES },
    };
  }

  const closes = ltfOhlcv.map((c) => c[4]);
  const ema50 = calculateEmaLast(closes, EMA_FAST);
  const ema200 = calculateEmaLast(closes, EMA_SLOW);
  const ema20Values = calculateEmaAtEachIndex(closes, EMA_TRAIL);
  const atr = calculateAtrLast(ltfOhlcv, ATR_PERIOD);
  const adx = calculateAdxLast(ltfOhlcv, ADX_PERIOD);

  if ([ema50, ema200, atr].some((v) => typeof v !== 'number' || Number.isNaN(v))) {
    return {
      signal: 'HOLD',
      price,
      timestamp,
      stopLoss: null,
      takeProfit: null,
      atr: atr ?? null,
      debug: { reason: 'INDICATOR_NAN' },
    };
  }
  if (adx == null || typeof adx !== 'number' || Number.isNaN(adx)) {
    return {
      signal: 'HOLD',
      price,
      timestamp,
      stopLoss: null,
      takeProfit: null,
      atr,
      debug: { reason: 'ADX_NAN' },
    };
  }

  // 1. Trend filter: EMA50 > EMA200
  const uptrend = ema50 > ema200;
  if (!uptrend) {
    return {
      signal: 'HOLD',
      price,
      timestamp,
      stopLoss: null,
      takeProfit: null,
      atr,
      debug: { reason: 'NO_UPTREND', ema50, ema200 },
    };
  }

  // 2. ADX filter: ADX > 20
  if (adx <= ADX_MIN) {
    return {
      signal: 'HOLD',
      price,
      timestamp,
      stopLoss: null,
      takeProfit: null,
      atr,
      debug: { reason: 'ADX_TOO_LOW', adx, threshold: ADX_MIN },
    };
  }

  // 3. Volatility filter: ATR% > 0.3
  const atrPercent = atr / price;
  if (atrPercent <= ATR_PERCENT_MIN) {
    return {
      signal: 'HOLD',
      price,
      timestamp,
      stopLoss: null,
      takeProfit: null,
      atr,
      debug: { reason: 'ATR_TOO_LOW', atrPercent, threshold: ATR_PERCENT_MIN },
    };
  }

  // 4. Pullback entry: breakout + pullback + bounce
  const pullbackResult = findBreakoutPullbackBounce(ltfOhlcv, ema20Values, atr);
  if (!pullbackResult) {
    return {
      signal: 'HOLD',
      price,
      timestamp,
      stopLoss: null,
      takeProfit: null,
      atr,
      debug: { reason: 'NO_PULLBACK_BOUNCE' },
    };
  }

  if (!pullbackResult.momentumOk) {
    return {
      signal: 'HOLD',
      price,
      timestamp,
      stopLoss: null,
      takeProfit: null,
      atr,
      debug: {
        reason: 'MOMENTUM_TOO_LOW',
        breakoutRange: pullbackResult.breakoutRange,
        required: MOMENTUM_ATR_MULT * atr,
      },
    };
  }

  // Entry: BUY
  const stopLoss = roundTo(price * (1 - STOP_LOSS_PERCENT), 8);
  const takeProfit = null;

  return {
    signal: 'BUY',
    price,
    timestamp,
    stopLoss,
    takeProfit,
    atr,
    highestHigh: null,
    breakoutStrength: pullbackResult.breakoutStrength,
    debug: {
      reason: 'PULLBACK_BOUNCE',
      ema50,
      ema200,
      adx,
      atrPercent,
      breakoutStrength: pullbackResult.breakoutStrength,
    },
  };
}

/**
 * Trailing stop: trailStop = highestPrice - (2 * ATR)
 */
function applyTrendBreakoutTrailingStop(trade, currentPrice, prevHigh, atr) {
  if (!trade || !currentPrice || !atr || Number.isNaN(atr)) return trade;
  if (trade.status && trade.status !== 'OPEN') return trade;
  if (!trade.entryPrice || !trade.stopLoss) return trade;

  const side = trade.side || 'BUY';
  const riskDistance = trade.initialRiskDistance
    || (trade.initialStopLoss ? Math.abs(trade.entryPrice - trade.initialStopLoss) : Math.abs(trade.entryPrice - trade.stopLoss));
  if (!riskDistance || riskDistance <= 0) return trade;

  const highestPrice = Math.max(
    trade.highestPrice ?? trade.entryPrice,
    prevHigh ?? currentPrice
  );

  const trailStop = side === 'BUY'
    ? highestPrice - (ATR_TRAIL_MULTIPLIER * atr)
    : highestPrice + (ATR_TRAIL_MULTIPLIER * atr);

  let newStop = trade.stopLoss;
  if (side === 'BUY') {
    newStop = Math.max(newStop, trailStop);
  } else {
    newStop = Math.min(newStop, trailStop);
  }

  if (newStop === trade.stopLoss) {
    return { ...trade, highestPrice };
  }
  return {
    ...trade,
    stopLoss: roundTo(newStop, 8),
    highestPrice,
    initialRiskDistance: trade.initialRiskDistance || riskDistance,
    initialStopLoss: trade.initialStopLoss || trade.stopLoss,
  };
}

module.exports = {
  trendBreakoutStrategy,
  applyTrendBreakoutTrailingStop,
  BREAKOUT_LOOKBACK,
  ATR_PERCENT_MIN,
  ATR_TRAIL_MULTIPLIER,
  TIME_EXIT_CANDLES,
  COOLDOWN_CANDLES: 10,
};
