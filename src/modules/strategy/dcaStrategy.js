/**
 * Smart DCA Trading Strategy
 *
 * Entry: Price > EMA200, price within 1 ATR of EMA50, RSI < 40, ATR% > 0.2%, ADX > 15
 * DCA Levels: 1 ATR, 2 ATR, 3 ATR drops from first entry (4 entries max per cycle)
 * Exit: RSI > 60 OR price >= EMA20 OR profit >= 3% OR trailing stop OR stop loss OR duration > 24h
 * Trailing: Activate at 2% profit, trail 2% below highest price
 * Stop loss: Close if drawdown from avgEntry > 8%
 * Risk: Max 8% capital per cycle, stop new entries if drawdown > 10%, hard stop at 20%
 *
 * No lookahead: Uses only data up to and including current candle.
 */

const { EMA, RSI, ATR, ADX } = require('technicalindicators');
const { roundTo } = require('../../utils/helpers');
const logger = require('../../utils/logger');

// Config
const EMA200_PERIOD = 200;
const EMA50_PERIOD = 50;
const EMA20_PERIOD = 20;
const RSI_PERIOD = 14;
const ATR_PERIOD = 14;
const ADX_PERIOD = 14;
const MIN_CANDLES = Math.max(EMA200_PERIOD, EMA50_PERIOD, EMA20_PERIOD, RSI_PERIOD + ATR_PERIOD, ADX_PERIOD * 2 + 1);

// Entry conditions
const RSI_ENTRY_MAX = 40;
const ATR_PERCENT_MIN = 0.2;
const ADX_MIN = 15;
const EMA50_ATR_BANDS = 1; // Price within 1 ATR of EMA50

// DCA levels: ATR drops from first entry [1, 2, 3]
const DCA_ATR_LEVELS = [1, 2, 3];
const MAX_ENTRIES = 4; // 1 initial + 3 DCA levels

// Exit conditions
const EXIT_RSI_MIN = 60;
const EXIT_PROFIT_PERCENT = 0.03; // 3% minimum profit target
const TRAILING_ACTIVATION_PERCENT = 0.02; // Activate trailing at 2% profit
const TRAILING_STOP_PERCENT = 0.02; // Trail 2% below highest price
const STOP_LOSS_PERCENT = 0.08; // Close if drawdown from avgEntry > 8%
const MAX_POSITION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

// Risk
const MAX_CAPITAL_PERCENT = 0.08; // 8% per cycle (was 5%)
const MAX_CONCURRENT_CYCLES = 3;
const MAX_DRAWDOWN_HARD_STOP = 0.20;
const MAX_DRAWDOWN_NO_NEW_ENTRIES = 0.10;

// Position sizing (multipliers for levels 1-4)
const DCA_MULTIPLIERS = [1, 1.5, 2, 2.5];

function last(arr) {
  return arr && arr.length ? arr[arr.length - 1] : undefined;
}

function lastN(arr, n) {
  if (!arr || arr.length < n) return null;
  return arr.slice(-n);
}

function getEma(closes, period) {
  if (!closes || closes.length < period) return null;
  const values = EMA.calculate({ values: closes, period });
  return last(values);
}

function getRsi(closes) {
  if (!closes || closes.length < RSI_PERIOD + 1) return null;
  const values = RSI.calculate({ values: closes, period: RSI_PERIOD });
  return last(values);
}

function getAtr(ohlcv) {
  if (!ohlcv || ohlcv.length < ATR_PERIOD + 1) return null;
  const high = ohlcv.map((c) => c[2]);
  const low = ohlcv.map((c) => c[3]);
  const close = ohlcv.map((c) => c[4]);
  const values = ATR.calculate({ high, low, close, period: ATR_PERIOD });
  return last(values);
}

function getAdx(ohlcv) {
  if (!ohlcv || ohlcv.length < ADX_PERIOD * 2 + 1) return null;
  const high = ohlcv.map((c) => c[2]);
  const low = ohlcv.map((c) => c[3]);
  const close = ohlcv.map((c) => c[4]);
  const values = ADX.calculate({ high, low, close, period: ADX_PERIOD });
  const lastVal = last(values);
  return lastVal && typeof lastVal === 'object' ? lastVal.adx : lastVal;
}

function getAverageEntry(entries) {
  if (!entries || entries.length === 0) return null;
  let totalCost = 0;
  let totalQty = 0;
  for (const e of entries) {
    totalCost += e.price * e.quantity;
    totalQty += e.quantity;
  }
  return totalQty > 0 ? totalCost / totalQty : null;
}

function getTotalQuantity(entries) {
  if (!entries || entries.length === 0) return 0;
  return entries.reduce((sum, e) => sum + e.quantity, 0);
}

function getBaseQuantity(portfolioBalance, price) {
  const maxCapital = portfolioBalance * MAX_CAPITAL_PERCENT;
  const totalMultiplier = DCA_MULTIPLIERS.reduce((s, m) => s + m, 0);
  const baseNotional = maxCapital / totalMultiplier;
  return baseNotional / price;
}

function getLevelQuantity(portfolioBalance, price, levelIndex) {
  const base = getBaseQuantity(portfolioBalance, price);
  const multiplier = DCA_MULTIPLIERS[levelIndex];
  return roundTo(base * multiplier, 8);
}

/**
 * Smart DCA Strategy - evaluates signal for current candle
 *
 * @param {Object} params
 * @param {Array<Array>} params.ohlcv - OHLCV candles [ts, open, high, low, close, vol]
 * @param {Object} params.dcaState - DCA cycle state (mutated in place)
 * @param {number} [params.portfolioBalance] - Current portfolio balance
 * @param {boolean} [params.drawdownExceeded] - If true, block new entries (drawdown > 10%)
 */
function dcaStrategy({ ohlcv, dcaState, portfolioBalance = 10000, drawdownExceeded = false }) {
  const lastCandle = last(ohlcv);
  if (!lastCandle) {
    return {
      signal: 'HOLD',
      price: 0,
      timestamp: 0,
      dcaState: dcaState || createDcaState(),
      debug: { reason: 'NO_CANDLES' },
    };
  }

  const price = lastCandle[4];
  const timestamp = lastCandle[0];
  const closes = ohlcv.map((c) => c[4]);
  const state = dcaState || createDcaState();

  const debug = {
    ema200: null,
    ema50: null,
    ema20: null,
    rsi: null,
    atr: null,
    atrPercent: null,
    adx: null,
    priceAboveEma200: null,
    priceNearEma50: null,
    rsiOk: null,
    volatilityOk: null,
    adxOk: null,
  };

  if (closes.length < MIN_CANDLES) {
    debug.reason = 'INSUFFICIENT_CANDLES';
    debug.required = MIN_CANDLES;
    debug.available = closes.length;
    return { signal: 'HOLD', price, timestamp, dcaState: state, debug };
  }

  const ema200 = getEma(closes, EMA200_PERIOD);
  const ema50 = getEma(closes, EMA50_PERIOD);
  const ema20 = getEma(closes, EMA20_PERIOD);
  const rsi = getRsi(closes);
  const atr = getAtr(ohlcv);
  const adx = getAdx(ohlcv);

  if (ema200 == null || ema50 == null || ema20 == null || rsi == null || atr == null || adx == null ||
      Number.isNaN(ema200) || Number.isNaN(ema50) || Number.isNaN(ema20) || Number.isNaN(rsi) || Number.isNaN(atr) || Number.isNaN(adx)) {
    debug.reason = 'INDICATOR_NAN';
    return { signal: 'HOLD', price, timestamp, dcaState: state, debug };
  }

  const atrPercent = price > 0 ? (atr / price) * 100 : 0;
  const priceAboveEma200 = price > ema200;
  const distFromEma50 = Math.abs(price - ema50);
  const priceNearEma50 = distFromEma50 <= atr * EMA50_ATR_BANDS;
  const rsiOk = rsi < RSI_ENTRY_MAX;
  const volatilityOk = atrPercent > ATR_PERCENT_MIN;
  const adxOk = adx > ADX_MIN;

  debug.ema200 = roundTo(ema200, 8);
  debug.ema50 = roundTo(ema50, 8);
  debug.ema20 = roundTo(ema20, 8);
  debug.rsi = roundTo(rsi, 2);
  debug.atr = roundTo(atr, 8);
  debug.atrPercent = roundTo(atrPercent, 4);
  debug.adx = roundTo(adx, 2);
  debug.priceAboveEma200 = priceAboveEma200;
  debug.priceNearEma50 = priceNearEma50;
  debug.rsiOk = rsiOk;
  debug.volatilityOk = volatilityOk;
  debug.adxOk = adxOk;

  // Exit logic is handled by checkDcaExit (called by backtest/paper before getSignal)

  // --- ENTRY LOGIC ---
  // Risk: block new entries if drawdown > 10%
  if (drawdownExceeded) {
    if (!state.cycleActive) {
      debug.reason = 'DRAWDOWN_BLOCK_NO_ENTRY';
      return { signal: 'HOLD', price, timestamp, dcaState: state, debug };
    }
    debug.reason = 'DRAWDOWN_BLOCK_NO_NEW_LEVELS';
    return { signal: 'HOLD', price, timestamp, dcaState: state, debug };
  }

  const numEntries = state.entries.length;
  const firstEntryPrice = numEntries > 0 ? state.entries[0].price : null;

  // First entry: price > EMA200, within 1 ATR of EMA50, RSI < 40, ATR% > 0.2%, ADX > 15
  if (numEntries === 0) {
    if (!priceAboveEma200) {
      debug.reason = 'BELOW_EMA200';
      debug.entryReason = null;
      return { signal: 'HOLD', price, timestamp, dcaState: state, debug };
    }
    if (!priceNearEma50) {
      debug.reason = 'NOT_NEAR_EMA50';
      debug.entryReason = null;
      return { signal: 'HOLD', price, timestamp, dcaState: state, debug };
    }
    if (!rsiOk) {
      debug.reason = 'RSI_TOO_HIGH';
      debug.entryReason = null;
      return { signal: 'HOLD', price, timestamp, dcaState: state, debug };
    }
    if (!volatilityOk) {
      debug.reason = 'ATR_TOO_LOW';
      debug.entryReason = null;
      return { signal: 'HOLD', price, timestamp, dcaState: state, debug };
    }
    if (!adxOk) {
      debug.reason = 'ADX_TOO_LOW';
      debug.entryReason = null;
      return { signal: 'HOLD', price, timestamp, dcaState: state, debug };
    }

    const quantity = getLevelQuantity(portfolioBalance, price, 0);
    if (quantity <= 0) {
      debug.reason = 'ZERO_QUANTITY';
      return { signal: 'HOLD', price, timestamp, dcaState: state, debug };
    }

    state.cycleActive = true;
    state.cycleStartTimestamp = timestamp;
    state.entries.push({ level: 1, price, quantity, timestamp });

    const entryReason = 'RSI_EMA50_TOUCH';
    logger.signal('Smart DCA entry', { reason: entryReason, level: 1, rsi: roundTo(rsi, 2), price, ema50, atr });
    debug.entryReason = entryReason;

    return {
      signal: 'DCA_BUY_1',
      price,
      timestamp,
      dcaState: state,
      level: 1,
      quantity,
      debug: { ...debug, reason: `DCA_LEVEL_1_${entryReason}` },
    };
  }

  // DCA levels 2-4: 1, 2, 3 ATR drop from first entry
  for (let i = numEntries; i < MAX_ENTRIES; i++) {
    const atrDrop = DCA_ATR_LEVELS[i - 1];
    const levelPrice = firstEntryPrice - atrDrop * atr;
    if (price <= levelPrice) {
      const quantity = getLevelQuantity(portfolioBalance, price, i);
      if (quantity <= 0) {
        debug.reason = 'ZERO_QUANTITY';
        return { signal: 'HOLD', price, timestamp, dcaState: state, debug };
      }

      state.entries.push({ level: i + 1, price, quantity, timestamp });

      const entryReason = `${atrDrop}_ATR_DROP`;
      logger.signal('Smart DCA entry', { reason: entryReason, level: i + 1, atrDrop, price, firstEntryPrice, atr });
      debug.entryReason = entryReason;

      return {
        signal: `DCA_BUY_${i + 1}`,
        price,
        timestamp,
        dcaState: state,
        level: i + 1,
        quantity,
        atrDrop,
        debug: { ...debug, reason: `DCA_LEVEL_${i + 1}_${entryReason}` },
      };
    }
  }

  debug.reason = 'NO_ENTRY_CONDITION';
  return { signal: 'HOLD', price, timestamp, dcaState: state, debug };
}

function createDcaState() {
  return {
    cycleActive: false,
    entries: [],
    cycleStartTimestamp: null,
    trailingState: { active: false, highestPrice: 0 },
  };
}

function resetDcaState(dcaState) {
  if (!dcaState) return createDcaState();
  dcaState.cycleActive = false;
  dcaState.entries = [];
  dcaState.cycleStartTimestamp = null;
  dcaState.trailingState = { active: false, highestPrice: 0 };
  return dcaState;
}

/**
 * Check if we should exit DCA position (for backtest/paper)
 * Exit: stop loss (8%), trailing stop (2% below high), TP (3%), RSI > 60, price >= EMA20, duration > 24h
 * No lookahead: uses only data up to and including current candle
 *
 * @param {Array} entries - DCA entries
 * @param {Array} candle - [ts, open, high, low, close, vol]
 * @param {Object} options
 * @param {Array<Array>} options.ohlcv - Full OHLCV history up to current candle
 * @param {number} options.cycleStartTimestamp - Cycle start time for duration check
 * @param {Object} options.trailingState - { active, highestPrice } - mutated in place
 */
function checkDcaExit(entries, candle, options = {}) {
  if (!entries || entries.length === 0) return null;

  const { ohlcv = [], cycleStartTimestamp, trailingState } = options;
  const ts = trailingState || { active: false, highestPrice: 0 };
  const [timestamp, , high, low, close] = candle;
  const avgEntry = getAverageEntry(entries);

  if (!avgEntry || avgEntry <= 0) return null;

  // 1. Stop loss: close if drawdown from avgEntry > 8% (low triggers)
  const stopLossPrice = avgEntry * (1 - STOP_LOSS_PERCENT);
  if (low <= stopLossPrice) {
    return { exitPrice: stopLossPrice, reason: 'STOP_LOSS' };
  }

  // 2. Trailing stop: activate at 2% profit, trail 2% below highest price
  if (high >= avgEntry * (1 + TRAILING_ACTIVATION_PERCENT)) {
    ts.active = true;
    ts.highestPrice = Math.max(ts.highestPrice, high);
  }
  if (ts.active) {
    ts.highestPrice = Math.max(ts.highestPrice, high);
    const trailStop = ts.highestPrice * (1 - TRAILING_STOP_PERCENT);
    if (low <= trailStop) {
      return { exitPrice: trailStop, reason: 'TRAILING_STOP' };
    }
  }

  // 3. Take profit: 3% (use high to allow exit within candle)
  const exitTarget = avgEntry * (1 + EXIT_PROFIT_PERCENT);
  if (high >= exitTarget) {
    return { exitPrice: exitTarget, reason: 'TAKE_PROFIT' };
  }

  // 4. RSI > 60, price >= EMA20, duration > 24h: use close (candle is complete)
  if (ohlcv.length >= MIN_CANDLES) {
    const closes = ohlcv.map((c) => c[4]);
    const rsi = getRsi(closes);
    const ema20 = getEma(closes, EMA20_PERIOD);
    const durationMs = timestamp - (cycleStartTimestamp || timestamp);

    if (rsi != null && rsi > EXIT_RSI_MIN) {
      return { exitPrice: close, reason: 'RSI_EXIT' };
    }
    if (ema20 != null && close >= ema20) {
      return { exitPrice: close, reason: 'EMA20_EXIT' };
    }
    if (durationMs >= MAX_POSITION_DURATION_MS) {
      return { exitPrice: close, reason: 'TIMEOUT' };
    }
  }

  return null;
}

module.exports = {
  dcaStrategy,
  createDcaState,
  resetDcaState,
  checkDcaExit,
  getAverageEntry,
  getTotalQuantity,
  getLevelQuantity,
  getBaseQuantity,
  DCA_ATR_LEVELS,
  DCA_MULTIPLIERS,
  EMA200_PERIOD,
  EMA50_PERIOD,
  EMA20_PERIOD,
  EXIT_PROFIT_PERCENT,
  TRAILING_ACTIVATION_PERCENT,
  TRAILING_STOP_PERCENT,
  STOP_LOSS_PERCENT,
  MAX_CAPITAL_PERCENT,
  MAX_ENTRIES,
  MAX_CONCURRENT_CYCLES,
  MAX_DRAWDOWN_HARD_STOP,
  MAX_DRAWDOWN_NO_NEW_ENTRIES,
  MAX_POSITION_DURATION_MS,
};
