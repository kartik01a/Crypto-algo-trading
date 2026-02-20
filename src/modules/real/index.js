/**
 * Real Trading Engine
 * Live trading via CoinDCX with manual SL/TP monitoring
 *
 * Safety: DRY_RUN mode, KILL_SWITCH, strict risk controls
 */

const config = require('../../config');
const { roundTo, getStartOfDay } = require('../../utils/helpers');
const logger = require('../../utils/logger');
const tradePersistence = require('../../services/tradePersistence');
const {
  getAvailableBalance,
  placeOrder,
  getOrderStatus,
  cancelOrder,
  fetchCandles,
  fetchTicker,
  symbolToMarket,
  symbolToPair,
} = require('../coindcx');
const { getSignal } = require('../strategy');
const { applyTrendPullbackTrailingStop } = require('../strategy/trendPullbackStrategy');
const {
  calculateStopLoss,
  calculateTakeProfit,
  calculatePositionSize,
  getTradeRiskParams,
  calculatePositionSizeWithStop,
  getTradeRiskParamsCustom,
} = require('../risk');

const DRY_RUN = process.env.DRY_RUN === 'true';
const KILL_SWITCH_THRESHOLD = parseFloat(process.env.KILL_SWITCH_LOSS_PERCENT || '10');
const INTERVAL_MS = 60000; // 1 minute

// Real trading risk limits (stricter than paper)
const MAX_CAPITAL_PER_TRADE = 0.05; // 5%
const RISK_PER_TRADE = 0.01; // 1%
const MAX_DAILY_LOSS = 0.05; // 5%
const MAX_DRAWDOWN = 0.10; // 10%
const MAX_OPEN_TRADES = 1;

let realState = {
  isRunning: false,
  intervalId: null,
  currentTrade: null,
  balance: 0,
  peakBalance: 0,
  dailyStartBalance: 0,
  dailyLoss: 0,
  lastDayReset: 0,
  symbol: 'BTC/USDT',
  timeframe: '5m', // LTF for signals
  htfTimeframe: '15m',
  strategy: null,
  quoteCurrency: 'USDT',
  ohlcvHistory: [],
  htfOhlcvHistory: [],
  minHistoryLength: 50,
  killSwitchTriggered: false,
  lastTradeClosedAt: 0,
};

/**
 * Convert CoinDCX candle to OHLCV array format
 * CoinDCX: { open, high, low, close, volume, time }
 * Strategy expects: [timestamp, open, high, low, close, volume]
 */
function candleToOHLCV(candle) {
  return [
    candle.time,
    candle.open,
    candle.high,
    candle.low,
    candle.close,
    candle.volume || 0,
  ];
}

/**
 * Fetch OHLCV history from CoinDCX
 */
async function fetchRealOHLCVHistory(timeframe, limit = 100) {
  const pair = symbolToPair(realState.symbol);
  const candles = await fetchCandles(pair, timeframe, limit);
  return candles.map(candleToOHLCV).sort((a, b) => a[0] - b[0]);
}

/**
 * Check if we can open a new trade (strict risk rules)
 */
function canOpenRealTrade() {
  if (realState.killSwitchTriggered) {
    return { allowed: false, reason: 'Kill switch triggered' };
  }

  if (realState.currentTrade) {
    return { allowed: false, reason: 'Already have open trade (max 1)' };
  }

  if (realState.balance <= 0) {
    return { allowed: false, reason: 'Insufficient balance' };
  }

  // Max drawdown
  const drawdown = realState.peakBalance > 0
    ? (realState.peakBalance - realState.balance) / realState.peakBalance
    : 0;
  if (drawdown >= MAX_DRAWDOWN) {
    return { allowed: false, reason: 'Max drawdown exceeded' };
  }

  // Max daily loss
  const dailyLossPercent = realState.dailyStartBalance > 0
    ? (realState.dailyStartBalance - realState.balance) / realState.dailyStartBalance
    : 0;
  if (dailyLossPercent >= MAX_DAILY_LOSS) {
    return { allowed: false, reason: 'Max daily loss exceeded' };
  }

  return { allowed: true };
}

/**
 * Calculate position size with max 5% capital per trade cap
 */
function getRealPositionSize(balance, entryPrice, side) {
  const riskBasedSize = calculatePositionSize(balance, entryPrice, side);
  const maxCapital = balance * MAX_CAPITAL_PER_TRADE;
  const maxQuantity = maxCapital / entryPrice;
  const size = Math.min(riskBasedSize, maxQuantity);
  return roundTo(Math.max(0, size), 8);
}

function getRealPositionSizeWithStop(balance, entryPrice, stopLoss) {
  const riskBasedSize = calculatePositionSizeWithStop(balance, entryPrice, stopLoss);
  const maxCapital = balance * MAX_CAPITAL_PER_TRADE;
  const maxQuantity = maxCapital / entryPrice;
  const size = Math.min(riskBasedSize, maxQuantity);
  return roundTo(Math.max(0, size), 8);
}

/**
 * Execute buy order (real or simulated)
 */
async function executeBuy(price, quantity, stopLoss, takeProfit) {
  const trade = {
    id: null,
    orderId: null,
    entryPrice: price,
    quantity,
    side: 'BUY',
    stopLoss,
    takeProfit,
    status: 'PENDING',
    openedAt: Date.now(),
  };

  if (DRY_RUN) {
    logger.info('DRY_RUN: Simulated BUY order', {
      price,
      quantity,
      stopLoss,
      takeProfit,
    });
    trade.id = `dry_${Date.now()}`;
    trade.status = 'OPEN';
    trade.orderId = 'simulated';
    return trade;
  }

  try {
    const order = await placeOrder({
      symbol: realState.symbol,
      side: 'buy',
      quantity,
      price,
      orderType: 'limit_order',
    });

    trade.orderId = order.id || order.order_id;
    trade.id = trade.orderId;

    if (order.status === 'rejected' || order.message) {
      throw new Error(order.message || 'Order rejected');
    }

    trade.status = 'OPEN';
    logger.info('Trade executed: BUY', {
      orderId: trade.orderId,
      price,
      quantity,
      stopLoss,
      takeProfit,
    });

    return trade;
  } catch (err) {
    logger.error('Order failed', { error: err.message, price, quantity });
    throw err;
  }
}

/**
 * Execute sell/close order
 * Uses market_order for immediate fill when SL/TP hit
 */
async function executeSell(trade, price, reason) {
  if (DRY_RUN) {
    logger.info('DRY_RUN: Simulated SELL (close)', {
      reason,
      price,
      quantity: trade.quantity,
    });
    return { success: true };
  }

  try {
    // Use market order for immediate execution when closing
    await placeOrder({
      symbol: realState.symbol,
      side: 'sell',
      quantity: trade.quantity,
      price, // Not used for market_order but kept for API compatibility
      orderType: 'market_order',
    });

    logger.info('Trade closed: SELL', {
      reason,
      orderId: trade.orderId,
      price,
      quantity: trade.quantity,
    });

    return { success: true };
  } catch (err) {
    logger.error('Close order failed', { error: err.message, tradeId: trade.id });
    throw err;
  }
}

/**
 * Check if SL or TP is hit (using current price)
 */
function checkSLTP(trade, currentPrice) {
  if (trade.side === 'BUY') {
    if (currentPrice <= trade.stopLoss) {
      return { hit: true, reason: 'STOP_LOSS', exitPrice: trade.stopLoss };
    }
    if (currentPrice >= trade.takeProfit) {
      return { hit: true, reason: 'TAKE_PROFIT', exitPrice: trade.takeProfit };
    }
  }
  return { hit: false };
}

/**
 * Single tick of real trading loop
 */
async function runRealTick() {
  if (!realState.isRunning) return;

  try {
    // Reset daily tracking if new day
    const now = Date.now();
    const dayStart = getStartOfDay(now);
    if (dayStart > realState.lastDayReset) {
      realState.dailyStartBalance = realState.balance;
      realState.dailyLoss = 0;
      realState.lastDayReset = dayStart;
    }

    // Fetch balance (skip in DRY_RUN, use cached)
    if (!DRY_RUN) {
      realState.balance = await getAvailableBalance(realState.quoteCurrency);
      if (realState.balance > realState.peakBalance) {
        realState.peakBalance = realState.balance;
      }
    }

    // Kill switch check
    const totalLossPercent = realState.peakBalance > 0
      ? ((realState.peakBalance - realState.balance) / realState.peakBalance) * 100
      : 0;
    if (totalLossPercent >= KILL_SWITCH_THRESHOLD) {
      realState.killSwitchTriggered = true;
      logger.error('KILL SWITCH TRIGGERED', {
        lossPercent: totalLossPercent,
        threshold: KILL_SWITCH_THRESHOLD,
      });
      return;
    }

    // If we have an open trade, check SL/TP
    if (realState.currentTrade) {
      const pair = symbolToPair(realState.symbol);
      const tickerData = await fetchTicker(symbolToMarket(realState.symbol));
      const currentPrice = parseFloat(tickerData?.last_price || tickerData?.bid || 0);

      if (currentPrice > 0) {
        // Trailing stop update (trendPullback only)
        if (realState.currentTrade.strategy === 'trendPullback') {
          const ltfCandles = await fetchRealOHLCVHistory(realState.timeframe, 120);
          const mtfSignal = getSignal(ltfCandles, {
            strategy: 'trendPullback',
            htfOhlcv: realState.htfOhlcvHistory,
          });
          const atr = mtfSignal.atr;
          realState.currentTrade = applyTrendPullbackTrailingStop(realState.currentTrade, currentPrice, atr);
        }

        const sltpCheck = checkSLTP(realState.currentTrade, currentPrice);
        if (sltpCheck.hit) {
          logger.info(`${sltpCheck.reason} hit`, {
            tradeId: realState.currentTrade.id,
            exitPrice: sltpCheck.exitPrice,
            currentPrice,
          });

          await executeSell(realState.currentTrade, sltpCheck.exitPrice, sltpCheck.reason);

          // Persist closed trade
          const closedTrade = {
            ...realState.currentTrade,
            exitPrice: sltpCheck.exitPrice,
            pnl: (sltpCheck.exitPrice - realState.currentTrade.entryPrice) * realState.currentTrade.quantity,
            status: 'CLOSED',
            closedAt: Date.now(),
          };
          await tradePersistence.persistTradeClose(closedTrade, sltpCheck.reason, 'real');
          realState.lastTradeClosedAt = Date.now();
          realState.currentTrade = null;
        }
      }
      return;
    }

    // No open trade - fetch candles, generate signal, maybe open
    const candles = await fetchRealOHLCVHistory(realState.timeframe, 120);
    if (candles.length < realState.minHistoryLength) {
      return;
    }

    realState.ohlcvHistory = candles;
    if (realState.strategy === 'trendPullback') {
      const htfCandles = await fetchRealOHLCVHistory(realState.htfTimeframe, 120);
      realState.htfOhlcvHistory = htfCandles;
    }

    const signal = getSignal(candles, {
      strategy: realState.strategy === 'trendPullback' ? 'trendPullback' : undefined,
      htfOhlcv: realState.htfOhlcvHistory,
    });

    logger.info('Signal generated', {
      signal: signal.signal,
      price: signal.price,
      timestamp: signal.timestamp,
    });

    if (signal.signal !== 'BUY') return;

    // Check cooldown
    const riskState = {
      lastTradeClosedAt: realState.lastTradeClosedAt,
    };
    const riskOverrides = realState.strategy === 'trendPullback'
      ? { maxTradesPerDay: 2, tradeCooldownMs: 30 * 60 * 1000 }
      : null;
    const { allowed: cooldownOk } = require('../risk').canOpenTrade(riskState, riskOverrides);
    if (!cooldownOk) return;

    const { allowed, reason } = canOpenRealTrade();
    if (!allowed) {
      logger.info('Trade blocked by risk rules', { reason });
      return;
    }

    const riskParams = (realState.strategy === 'trendPullback' && signal.stopLoss && signal.takeProfit)
      ? getTradeRiskParamsCustom(signal.price, 'BUY', signal.stopLoss, signal.takeProfit, realState.balance)
      : getTradeRiskParams(signal.price, 'BUY', realState.balance);

    const { stopLoss, takeProfit } = riskParams;
    const positionSize = (realState.strategy === 'trendPullback' && stopLoss)
      ? getRealPositionSizeWithStop(realState.balance, signal.price, stopLoss)
      : getRealPositionSize(realState.balance, signal.price, 'BUY');

    if (positionSize <= 0) {
      logger.warn('Position size is 0, skipping');
      return;
    }

    const trade = await executeBuy(signal.price, positionSize, stopLoss, takeProfit);
    trade.strategy = realState.strategy === 'trendPullback' ? 'trendPullback' : 'default';
    trade.atrAtEntry = signal.atr;
    trade.initialStopLoss = stopLoss;
    trade.initialRiskDistance = Math.abs(signal.price - stopLoss);
    realState.currentTrade = trade;

    // Persist trade
    await tradePersistence.persistTradeOpen(
      { ...trade, symbol: realState.symbol },
      'real',
      realState.symbol
    );

    // Deduct from balance (for tracking; real balance comes from API)
    if (DRY_RUN) {
      const cost = trade.entryPrice * trade.quantity;
      realState.balance -= cost;
    }
  } catch (err) {
    logger.error('Real trading tick error', { error: err.message });
  }
}

/**
 * Start real trading
 */
async function startRealTrading(options = {}) {
  if (realState.isRunning) {
    return { success: false, message: 'Real trading already running' };
  }

  realState.symbol = options.symbol || 'BTC/USDT';
  realState.strategy = options.strategy || null;
  if (realState.strategy === 'trendPullback') {
    realState.timeframe = '5m';
    realState.htfTimeframe = '15m';
  } else {
    realState.timeframe = options.timeframe || '5m';
  }
  realState.quoteCurrency = options.quoteCurrency || 'USDT';
  realState.killSwitchTriggered = false;
  realState.htfOhlcvHistory = [];

  if (!DRY_RUN) {
    realState.balance = await getAvailableBalance(realState.quoteCurrency);
    realState.peakBalance = realState.balance;
  } else {
    realState.balance = options.initialBalance || config.risk.initialBalance;
    realState.peakBalance = realState.balance;
  }

  realState.dailyStartBalance = realState.balance;
  realState.dailyLoss = 0;
  realState.lastDayReset = getStartOfDay(Date.now());
  realState.currentTrade = null;

  realState.isRunning = true;
  realState.intervalId = setInterval(runRealTick, INTERVAL_MS);

  logger.info('Real trading started', {
    symbol: realState.symbol,
    timeframe: realState.timeframe,
    dryRun: DRY_RUN,
    balance: realState.balance,
  });

  await runRealTick();

  return { success: true, message: DRY_RUN ? 'Real trading started (DRY_RUN)' : 'Real trading started' };
}

/**
 * Stop real trading
 */
function stopRealTrading() {
  if (!realState.isRunning) {
    return { success: false, message: 'Real trading not running' };
  }

  if (realState.intervalId) {
    clearInterval(realState.intervalId);
    realState.intervalId = null;
  }

  realState.isRunning = false;
  logger.info('Real trading stopped');

  return { success: true, message: 'Real trading stopped' };
}

/**
 * Get real trading status
 */
function getRealStatus() {
  return {
    isRunning: realState.isRunning,
    balance: roundTo(realState.balance, 2),
    openTrade: realState.currentTrade,
    dailyLoss: roundTo(realState.dailyLoss, 2),
    peakBalance: realState.peakBalance,
    killSwitchTriggered: realState.killSwitchTriggered,
    dryRun: DRY_RUN,
    symbol: realState.symbol,
    timeframe: realState.timeframe,
  };
}

module.exports = {
  startRealTrading,
  stopRealTrading,
  getRealStatus,
};
