/**
 * Real Trading Engine
 * Live trading via Binance Futures with native trailing stop
 *
 * App places entry + trailing stop once; Binance handles exit - no app dependency for stop updates.
 * Safety: DRY_RUN mode, KILL_SWITCH, strict risk controls
 */

const config = require('../../config');
const { roundTo, getStartOfDay } = require('../../utils/helpers');
const logger = require('../../utils/logger');
const tradePersistence = require('../../services/tradePersistence');
const {
  getAvailableBalance,
  setLeverage,
  placeMarketOrder,
  placeTrailingStopOrder,
  getOrderStatus,
  cancelOrder,
  fetchCandles,
  fetchTicker,
  symbolToMarket,
  timeframeToInterval,
} = require('../binance');
const { getSignal } = require('../strategy');
const {
  calculateStopLoss,
  calculateTakeProfit,
  calculatePositionSize,
  getTradeRiskParams,
  calculatePositionSizeWithStop,
  getTradeRiskParamsCustom,
  configMaxOpenTrades,
} = require('../risk');

const DRY_RUN = process.env.DRY_RUN === 'true';
const KILL_SWITCH_THRESHOLD = parseFloat(process.env.KILL_SWITCH_LOSS_PERCENT || '10');
const INTERVAL_MS = 60000; // 1 minute
const GOLDEN_CROSS_MIN_LTF = 55;

// Real trading risk limits (stricter than paper)
const MAX_CAPITAL_PER_TRADE = 0.05; // 5%
const RISK_PER_TRADE = 0.01; // 1%
const MAX_DAILY_LOSS = 0.05; // 5%
const MAX_DRAWDOWN = 0.10; // 10%

let realState = {
  isRunning: false,
  intervalId: null,
  currentTrade: null, // Single-symbol backward compat
  openTrades: [], // Multi-symbol: array of open trades
  balance: 0,
  peakBalance: 0,
  dailyStartBalance: 0,
  dailyLoss: 0,
  lastDayReset: 0,
  symbol: 'BTC/USDT',
  symbols: ['BTC/USDT'],
  maxOpenTrades: 1,
  timeframe: '5m',
  htfTimeframe: '15m',
  strategy: null,
  quoteCurrency: 'USDT',
  ohlcvHistory: [],
  htfOhlcvHistory: [],
  ohlcvHistoryBySymbol: {},
  htfOhlcvHistoryBySymbol: {},
  minHistoryLength: 50,
  killSwitchTriggered: false,
  lastTradeClosedAt: 0,
  longOnly: false,
  lastProcessedCandleTs: 0,
  lastProcessedCandleTsBySymbol: {},
  useExchangeStopLoss: true, // Place trailing stop on Binance; when false, app-managed SL
  trailPercent: 0.02, // 2% trailing for Binance (callbackRate = 2)
  leverage: 3, // 3x leverage (set via API before each order)
};

/**
 * Fetch OHLCV history from Binance Futures for a symbol
 * Returns: [[timestamp, open, high, low, close, volume], ...]
 */
async function fetchRealOHLCVHistory(symbol, timeframe, limit = 100) {
  const interval = timeframeToInterval(timeframe);
  const candles = await fetchCandles(symbol, interval, limit);
  return candles.sort((a, b) => a[0] - b[0]);
}

/**
 * Check if we can open a new trade (strict risk rules)
 * @param {string} [symbol] - Optional: skip if already have trade in this symbol
 */
function canOpenRealTrade(symbol = null) {
  if (realState.killSwitchTriggered) {
    return { allowed: false, reason: 'Kill switch triggered' };
  }

  const trades = realState.openTrades.length > 0 ? realState.openTrades : (realState.currentTrade ? [realState.currentTrade] : []);
  if (trades.length >= realState.maxOpenTrades) {
    return { allowed: false, reason: 'Max open trades reached' };
  }
  if (symbol && trades.some((t) => t.symbol === symbol)) {
    return { allowed: false, reason: 'Already have open trade in symbol' };
  }

  if (realState.balance <= 0) {
    return { allowed: false, reason: 'Insufficient balance' };
  }

  const drawdown = realState.peakBalance > 0
    ? (realState.peakBalance - realState.balance) / realState.peakBalance
    : 0;
  if (drawdown >= MAX_DRAWDOWN) {
    return { allowed: false, reason: 'Max drawdown exceeded' };
  }

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
 * @param {string} symbol - Trading pair (e.g. 'BTC/USDT')
 */
async function executeBuy(symbol, price, quantity, stopLoss, takeProfit) {
  const trade = {
    id: null,
    orderId: null,
    symbol,
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
      symbol,
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
    const lev = realState.leverage ?? 3;
    await setLeverage(symbol, lev);
    logger.info('Leverage set', { symbol, leverage: lev });
    const order = await placeMarketOrder({
      symbol,
      side: 'BUY',
      quantity,
    });

    trade.orderId = order.orderId || order.order_id;
    trade.id = trade.orderId;

    if (order.status === 'REJECTED' || order.msg) {
      throw new Error(order.msg || 'Order rejected');
    }

    trade.status = 'OPEN';

    // Place exchange-side trailing stop (Binance handles exit - no app dependency)
    if (realState.useExchangeStopLoss) {
      try {
        const callbackRate = (realState.trailPercent ?? 0.02) * 100; // 2% -> 2 for Binance
        const stopOrder = await placeTrailingStopOrder({
          symbol,
          side: 'SELL',
          quantity,
          callbackRate: Math.min(5, Math.max(0.1, callbackRate)),
        });
        trade.stopOrderId = stopOrder.orderId || stopOrder.order_id;
        logger.info('Trailing stop placed (Binance handles exit)', { stopOrderId: trade.stopOrderId, callbackRate: `${callbackRate}%` });
      } catch (err) {
        logger.error('Failed to place trailing stop order', { error: err.message });
        trade.stopOrderId = null;
      }
    }

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
 * Execute sell/close order (close long position)
 */
async function executeSell(trade, price, reason) {
  const sym = trade.symbol || realState.symbol;
  if (DRY_RUN) {
    logger.info('DRY_RUN: Simulated SELL (close long)', {
      symbol: sym,
      reason,
      price,
      quantity: trade.quantity,
    });
    return { success: true };
  }

  try {
    if (trade.stopOrderId) {
      try {
        await cancelOrder(sym, trade.stopOrderId);
      } catch (e) {
        logger.warn('Could not cancel trailing stop before manual close', { error: e.message });
      }
    }
    await placeMarketOrder({
      symbol: sym,
      side: 'SELL',
      quantity: trade.quantity,
      reduceOnly: true,
    });

    logger.info('Trade closed: SELL (long)', {
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
 * Execute buy/cover order (close short position)
 */
async function executeCover(trade, price, reason) {
  const sym = trade.symbol || realState.symbol;
  if (DRY_RUN) {
    logger.info('DRY_RUN: Simulated BUY (close short)', {
      symbol: sym,
      reason,
      price,
      quantity: trade.quantity,
    });
    return { success: true };
  }

  try {
    if (trade.stopOrderId) {
      try {
        await cancelOrder(sym, trade.stopOrderId);
      } catch (e) {
        logger.warn('Could not cancel trailing stop before manual close', { error: e.message });
      }
    }
    await placeMarketOrder({
      symbol: sym,
      side: 'BUY',
      quantity: trade.quantity,
      reduceOnly: true,
    });

    logger.info('Trade closed: BUY (short cover)', {
      reason,
      orderId: trade.orderId,
      price,
      quantity: trade.quantity,
    });

    return { success: true };
  } catch (err) {
    logger.error('Cover order failed', { error: err.message, tradeId: trade.id });
    throw err;
  }
}

/**
 * Execute short order (open short position)
 * Binance Futures supports shorts natively
 */
async function executeShort(symbol, price, quantity, stopLoss) {
  if (DRY_RUN) {
    logger.info('DRY_RUN: Simulated SHORT (open)', {
      symbol,
      price,
      quantity,
      stopLoss,
    });
    return {
      id: `dry_${Date.now()}`,
      orderId: 'simulated',
      status: 'OPEN',
      symbol,
      entryPrice: price,
      quantity,
      side: 'SELL',
      stopLoss,
      openedAt: Date.now(),
    };
  }

  try {
    const lev = realState.leverage ?? 3;
    await setLeverage(symbol, lev);
    logger.info('Leverage set', { symbol, leverage: lev });
    const order = await placeMarketOrder({
      symbol,
      side: 'SELL',
      quantity,
    });

    const trade = {
      id: String(order.orderId || order.order_id),
      orderId: String(order.orderId || order.order_id),
      status: 'OPEN',
      symbol,
      entryPrice: price,
      quantity,
      side: 'SELL',
      stopLoss,
      openedAt: Date.now(),
    };

    if (realState.useExchangeStopLoss) {
      try {
        const callbackRate = (realState.trailPercent ?? 0.02) * 100;
        const stopOrder = await placeTrailingStopOrder({
          symbol,
          side: 'BUY',
          quantity,
          callbackRate: Math.min(5, Math.max(0.1, callbackRate)),
        });
        trade.stopOrderId = stopOrder.orderId || stopOrder.order_id;
        logger.info('Trailing stop placed (short, Binance handles exit)', { stopOrderId: trade.stopOrderId, callbackRate: `${callbackRate}%` });
      } catch (err) {
        logger.error('Failed to place trailing stop order (short)', { error: err.message });
        trade.stopOrderId = null;
      }
    }

    return trade;
  } catch (err) {
    logger.error('Short order failed', { error: err.message, price, quantity });
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
    if (trade.takeProfit && currentPrice >= trade.takeProfit) {
      return { hit: true, reason: 'TAKE_PROFIT', exitPrice: trade.takeProfit };
    }
  }
  if (trade.side === 'SELL') {
    if (currentPrice >= trade.stopLoss) {
      return { hit: true, reason: 'STOP_LOSS', exitPrice: trade.stopLoss };
    }
  }
  return { hit: false };
}

/**
 * Check goldenCrossHTF exit: trailing stop (price hit) or max hold (time-based)
 */
function checkGoldenCrossExit(trade, currentPrice) {
  const cfg = require('../strategy/goldenCrossHTFStrategy').getConfig();
  const barsInTrade = trade.candleCount ?? 0;

  if (barsInTrade >= cfg.maxHoldBars) {
    return { hit: true, reason: 'MAX_HOLD', exitPrice: currentPrice };
  }
  const side = trade.side || 'BUY';
  if (barsInTrade >= cfg.minHoldBars) {
    if (side === 'BUY' && currentPrice <= trade.stopLoss) {
      return { hit: true, reason: 'TRAILING_STOP', exitPrice: trade.stopLoss };
    }
    if (side === 'SELL' && currentPrice >= trade.stopLoss) {
      return { hit: true, reason: 'TRAILING_STOP', exitPrice: trade.stopLoss };
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
    const openCount = realState.symbols.length > 1 ? realState.openTrades.length : (realState.currentTrade ? 1 : 0);
    logger.info('Real tick', { openTrades: openCount, balance: roundTo(realState.balance, 2) });
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

    // Get open trades: multi-symbol uses openTrades, single uses currentTrade
    const openTrades = realState.symbols.length > 1
      ? realState.openTrades
      : (realState.currentTrade ? [realState.currentTrade] : []);

    // If we have open trades, check SL/TP for each
    if (openTrades.length > 0) {
      for (let i = 0; i < openTrades.length; i++) {
        let trade = openTrades[i];
        const sym = trade.symbol || realState.symbol;
        const tickerData = await fetchTicker(symbolToMarket(sym));
        const currentPrice = parseFloat(tickerData?.last_price || tickerData?.bid || 0);
        if (currentPrice <= 0) continue;

        // 1. Check if Binance trailing stop order filled (exchange handles exit)
        if (!DRY_RUN && trade.stopOrderId && realState.useExchangeStopLoss) {
          try {
            const stopStatus = await getOrderStatus(sym, trade.stopOrderId);
            const status = (stopStatus.status || stopStatus.order_status || '').toUpperCase();
            if (status === 'FILLED' || status === 'PARTIALLY_FILLED') {
              const exitPrice = parseFloat(stopStatus.avgPrice || stopStatus.average_price || trade.stopLoss) || trade.stopLoss;
              logger.info('Exchange stop order filled', { tradeId: trade.id, symbol: sym, exitPrice, status });

              const isShort = trade.side === 'SELL';
              const pnl = isShort
                ? (trade.entryPrice - exitPrice) * trade.quantity
                : (exitPrice - trade.entryPrice) * trade.quantity;

              const closedTrade = {
                ...trade,
                symbol: sym,
                exitPrice,
                pnl,
                status: 'CLOSED',
                closedAt: Date.now(),
              };
              await tradePersistence.persistTradeClose(closedTrade, 'STOP_LOSS', 'real');
              realState.lastTradeClosedAt = Date.now();

              if (realState.symbols.length > 1) {
                realState.openTrades = realState.openTrades.filter((t) => t.id !== trade.id);
              } else {
                realState.currentTrade = null;
              }
              continue;
            }
          } catch (err) {
            logger.warn('Failed to check stop order status', { stopOrderId: trade.stopOrderId, error: err.message });
          }
        }

        // 2. Binance handles trailing stop natively - no app updates needed.
        //    Only update candleCount for MAX_HOLD check (goldenCrossHTF).
        if (trade.strategy === 'goldenCrossHTF') {
          const candles = await fetchRealOHLCVHistory(sym, realState.timeframe, 10);
          if (candles.length >= 2) {
            const latestTs = candles[candles.length - 1][0];
            const lastTs = realState.lastProcessedCandleTsBySymbol?.[sym] ?? realState.lastProcessedCandleTs;
            if (latestTs > lastTs) {
              if (!realState.lastProcessedCandleTsBySymbol) realState.lastProcessedCandleTsBySymbol = {};
              realState.lastProcessedCandleTsBySymbol[sym] = latestTs;
              trade.candleCount = (trade.candleCount || 0) + 1;
            }
          }
        }

        // 3. Exit check (manual close for MAX_HOLD only; Binance handles STOP_LOSS/TRAILING_STOP)
        let exitCheck = null;
        if (trade.strategy === 'goldenCrossHTF') {
          exitCheck = checkGoldenCrossExit(trade, currentPrice);
        } else {
          exitCheck = checkSLTP(trade, currentPrice);
        }

        // Skip manual sell for STOP_LOSS/TRAILING_STOP when we have exchange stop (exchange handles it)
        const useExchangeForStop = !DRY_RUN && trade.stopOrderId && realState.useExchangeStopLoss;
        const isStopExit = exitCheck && (exitCheck.reason === 'STOP_LOSS' || exitCheck.reason === 'TRAILING_STOP');

        if (exitCheck && exitCheck.hit && !(useExchangeForStop && isStopExit)) {
          logger.info(`${exitCheck.reason} hit`, {
            tradeId: trade.id,
            symbol: sym,
            exitPrice: exitCheck.exitPrice,
            currentPrice,
          });

          const isShort = trade.side === 'SELL';
          if (isShort) {
            await executeCover(trade, exitCheck.exitPrice, exitCheck.reason);
          } else {
            await executeSell(trade, exitCheck.exitPrice, exitCheck.reason);
          }

          const pnl = isShort
            ? (trade.entryPrice - exitCheck.exitPrice) * trade.quantity
            : (exitCheck.exitPrice - trade.entryPrice) * trade.quantity;

          const closedTrade = {
            ...trade,
            symbol: sym,
            exitPrice: exitCheck.exitPrice,
            pnl,
            status: 'CLOSED',
            closedAt: Date.now(),
          };
          await tradePersistence.persistTradeClose(closedTrade, exitCheck.reason, 'real');
          realState.lastTradeClosedAt = Date.now();

          if (realState.symbols.length > 1) {
            realState.openTrades = realState.openTrades.filter((t) => t.id !== trade.id);
          } else {
            realState.currentTrade = null;
          }
        } else {
          if (realState.symbols.length > 1) {
            const idx = realState.openTrades.findIndex((t) => t.id === trade.id);
            if (idx >= 0) realState.openTrades[idx] = trade;
          } else {
            realState.currentTrade = trade;
          }
        }
      }
      return;
    }

    // No open trades - fetch candles, generate signal(s), maybe open
    const isMultiSymbol = realState.symbols.length > 1;

    if (isMultiSymbol && realState.strategy === 'goldenCrossHTF') {
      realState.ohlcvHistoryBySymbol = {};
      realState.htfOhlcvHistoryBySymbol = {};
      for (const sym of realState.symbols) {
        realState.ohlcvHistoryBySymbol[sym] = await fetchRealOHLCVHistory(sym, realState.timeframe, 120);
        realState.htfOhlcvHistoryBySymbol[sym] = await fetchRealOHLCVHistory(sym, realState.htfTimeframe, 300);
      }
      realState.ohlcvHistory = realState.ohlcvHistoryBySymbol[realState.symbol];
      realState.htfOhlcvHistory = realState.htfOhlcvHistoryBySymbol[realState.symbol];
    } else {
      const candles = await fetchRealOHLCVHistory(realState.symbol, realState.timeframe, 120);
      if (candles.length < realState.minHistoryLength) return;
      realState.ohlcvHistory = candles;
      if (realState.strategy === 'trendPullback' || realState.strategy === 'goldenCrossHTF') {
        realState.htfOhlcvHistory = await fetchRealOHLCVHistory(realState.symbol, realState.htfTimeframe, realState.strategy === 'goldenCrossHTF' ? 300 : 120);
      }
    }

    const candles = realState.ohlcvHistory;
    if (candles.length < realState.minHistoryLength) return;

    // goldenCrossHTF: only process when we have a new LTF candle
    if (realState.strategy === 'goldenCrossHTF') {
      const latestTs = candles[candles.length - 1][0];
      if (latestTs <= realState.lastProcessedCandleTs) return;
      realState.lastProcessedCandleTs = latestTs;
    }

    const openSymbols = new Set(openTrades.map((t) => t.symbol || realState.symbol));
    let topSignals = [];

    if (isMultiSymbol && realState.strategy === 'goldenCrossHTF') {
      const allSignals = [];
      for (const sym of realState.symbols) {
        const symHist = realState.ohlcvHistoryBySymbol[sym];
        const symHtf = realState.htfOhlcvHistoryBySymbol[sym];
        if (!symHist || symHist.length < realState.minHistoryLength) continue;
        const s = getSignal(symHist, {
          strategy: 'goldenCrossHTF',
          htfOhlcv: symHtf,
          openTrades: [],
          symbol: sym,
        });
        if (['BUY', 'SELL'].includes(s.signal)) {
          allSignals.push({
            ...s,
            symbol: sym,
            action: s.signal,
            confidence: s.confidence ?? 0.5,
            adx: s.adx ?? s.metadata?.adx ?? 0,
            emaDistance: s.emaDistance ?? s.metadata?.emaDistance ?? 0,
          });
        }
      }
      allSignals.sort((a, b) => {
        if (b.adx !== a.adx) return b.adx - a.adx;
        if (b.emaDistance !== a.emaDistance) return b.emaDistance - a.emaDistance;
        return (b.confidence ?? 0) - (a.confidence ?? 0);
      });
      topSignals = allSignals.filter((s) => !openSymbols.has(s.symbol)).slice(0, realState.maxOpenTrades);
      if (topSignals.length > 0) {
        logger.info('Multi-symbol signals', { selected: topSignals.map((s) => ({ symbol: s.symbol, action: s.action, adx: s.adx })) });
      }
    } else {
      const signal = getSignal(candles, {
        strategy: realState.strategy === 'trendPullback' ? 'trendPullback' : realState.strategy === 'goldenCrossHTF' ? 'goldenCrossHTF' : undefined,
        htfOhlcv: realState.htfOhlcvHistory,
        openTrades: [],
        symbol: realState.strategy === 'goldenCrossHTF' ? realState.symbol : undefined,
      });
      if (['BUY', 'SELL'].includes(signal.signal)) {
        topSignals = [{ ...signal, symbol: realState.symbol, action: signal.signal }];
      }
      logger.info('Signal generated', { signal: signal.signal, price: signal.price, timestamp: signal.timestamp });
    }

    const riskOverrides = realState.strategy === 'trendPullback'
      ? { maxTradesPerDay: 2, tradeCooldownMs: 30 * 60 * 1000 }
      : realState.strategy === 'goldenCrossHTF'
        ? { maxTradesPerDay: 10, tradeCooldownMs: 0, maxDrawdown: 1 }
        : null;
    const riskState = { lastTradeClosedAt: realState.lastTradeClosedAt };
    const { allowed: cooldownOk } = require('../risk').canOpenTrade(riskState, riskOverrides);
    if (!cooldownOk) return;

    for (const sig of topSignals) {
      const side = sig.action || sig.signal;
      if (side !== 'BUY' && side !== 'SELL') continue;
      if (realState.longOnly && side === 'SELL') continue;

      const { allowed, reason } = canOpenRealTrade(realState.symbols.length > 1 ? sig.symbol : null);
      if (!allowed) {
        logger.info('Trade blocked by risk rules', { symbol: sig.symbol, reason });
        continue;
      }

      // Use live ticker price for entry (not stale candle close)
      let entryPrice = sig.price;
      try {
        const tickerData = await fetchTicker(symbolToMarket(sig.symbol));
        const livePrice = parseFloat(tickerData?.last_price || tickerData?.bid || tickerData?.ask || 0);
        if (livePrice > 0) entryPrice = livePrice;
      } catch (err) {
        logger.warn('Could not fetch live price for entry, using candle close', { symbol: sig.symbol, error: err.message });
      }

      // Recalc stopLoss for live price (goldenCrossHTF uses %)
      let stopLossForRisk = sig.stopLoss;
      if (realState.strategy === 'goldenCrossHTF' && sig.stopLoss) {
        const cfg = require('../strategy/goldenCrossHTFStrategy').getConfig();
        stopLossForRisk = side === 'BUY'
          ? entryPrice * (1 - cfg.trailPercent)
          : entryPrice * (1 + cfg.trailPercent);
      } else if (realState.strategy === 'trendPullback' && sig.stopLoss && sig.atr) {
        const diff = entryPrice - sig.price;
        stopLossForRisk = side === 'BUY' ? sig.stopLoss + diff : sig.stopLoss + diff;
      }

      const useCustomRisk = (realState.strategy === 'trendPullback' && sig.stopLoss && sig.takeProfit)
        || (realState.strategy === 'goldenCrossHTF' && sig.stopLoss);
      const riskParams = useCustomRisk
        ? getTradeRiskParamsCustom(
            entryPrice,
            side,
            stopLossForRisk,
            sig.takeProfit || Infinity,
            realState.balance,
            sig.suggestedRiskPercent ?? 0.01
          )
        : getTradeRiskParams(entryPrice, side, realState.balance);

      const { stopLoss, takeProfit } = riskParams;
      const positionSize = useCustomRisk && stopLoss
        ? getRealPositionSizeWithStop(realState.balance, entryPrice, stopLoss)
        : getRealPositionSize(realState.balance, entryPrice, side);

      if (positionSize <= 0) {
        logger.warn('Position size is 0, skipping', { symbol: sig.symbol });
        continue;
      }

      let trade;
      if (side === 'SELL') {
        trade = await executeShort(sig.symbol, entryPrice, positionSize, stopLoss);
      } else {
        trade = await executeBuy(sig.symbol, entryPrice, positionSize, stopLoss, takeProfit);
      }

      trade.strategy = realState.strategy === 'trendPullback' ? 'trendPullback' : realState.strategy === 'goldenCrossHTF' ? 'goldenCrossHTF' : 'default';
      trade.side = side;
      trade.symbol = sig.symbol;
      trade.atrAtEntry = sig.atr;
      trade.initialStopLoss = stopLoss;
      trade.initialRiskDistance = Math.abs(entryPrice - stopLoss);
      if (realState.strategy === 'goldenCrossHTF') {
        trade.highestPrice = side === 'BUY' ? entryPrice : undefined;
        trade.lowestPrice = side === 'SELL' ? entryPrice : undefined;
        trade.candleCount = 0;
      }

      if (realState.symbols.length > 1) {
        realState.openTrades.push(trade);
      } else {
        realState.currentTrade = trade;
      }

      await tradePersistence.persistTradeOpen({ ...trade, symbol: sig.symbol }, 'real', sig.symbol);

      if (DRY_RUN && side === 'BUY') {
        realState.balance -= trade.entryPrice * trade.quantity;
      }
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

  const symbolsParam = options.symbols && options.symbols.length > 0 ? options.symbols : null;
  realState.symbols = symbolsParam || [options.symbol || 'BTC/USDT'];
  realState.symbol = realState.symbols[0];
  realState.maxOpenTrades = options.maxOpenTrades ?? (realState.symbols.length > 1 ? configMaxOpenTrades : 1);
  realState.strategy = options.strategy || null;
  realState.longOnly = options.longOnly ?? false;
  realState.useExchangeStopLoss = options.useExchangeStopLoss ?? true;
  realState.trailPercent = options.trailPercent ?? 0.02; // 2% for Binance trailing stop
  realState.leverage = options.leverage ?? 3; // 2x leverage (set via API before each order)
  if (realState.strategy === 'trendPullback') {
    realState.timeframe = '5m';
    realState.htfTimeframe = '15m';
    realState.minHistoryLength = 50;
  } else if (realState.strategy === 'goldenCrossHTF') {
    realState.timeframe = '4h';
    realState.htfTimeframe = '1d';
    realState.minHistoryLength = GOLDEN_CROSS_MIN_LTF;
  } else {
    realState.timeframe = options.timeframe || '5m';
    realState.minHistoryLength = 50;
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
  realState.openTrades = [];
  realState.lastProcessedCandleTs = 0;
  realState.lastProcessedCandleTsBySymbol = {};
  realState.ohlcvHistoryBySymbol = {};
  realState.htfOhlcvHistoryBySymbol = {};

  realState.isRunning = true;
  realState.intervalId = setInterval(runRealTick, INTERVAL_MS);

  logger.info('Real trading started', {
    symbol: realState.symbol,
    symbols: realState.symbols,
    strategy: realState.strategy,
    timeframe: realState.timeframe,
    leverage: realState.leverage,
    dryRun: DRY_RUN,
    longOnly: realState.longOnly,
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
  const openTrades = realState.openTrades.length > 0 ? realState.openTrades : (realState.currentTrade ? [realState.currentTrade] : []);
  return {
    isRunning: realState.isRunning,
    balance: roundTo(realState.balance, 2),
    openTrade: realState.currentTrade,
    openTrades,
    symbols: realState.symbols,
    dailyLoss: roundTo(realState.dailyLoss, 2),
    peakBalance: realState.peakBalance,
    killSwitchTriggered: realState.killSwitchTriggered,
    dryRun: DRY_RUN,
    symbol: realState.symbol,
    strategy: realState.strategy,
    timeframe: realState.timeframe,
    longOnly: realState.longOnly,
  };
}

module.exports = {
  startRealTrading,
  stopRealTrading,
  getRealStatus,
};
