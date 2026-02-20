/**
 * Paper Trading Engine
 * Runs every 1 minute: fetch latest candle, generate signal, execute simulated trades
 */

const config = require('../../config');
const { roundTo } = require('../../utils/helpers');
const { fetchOHLCV, fetchLatestCandle } = require('../exchange');
const { getSignal } = require('../strategy');
const { applyTrendPullbackTrailingStop } = require('../strategy/trendPullbackStrategy');
const {
  applyScalpMomentumTrailingStop,
  TP1_CLOSE_PERCENT,
  GAP_THRESHOLD_PERCENT,
} = require('../strategy/scalpMomentumStrategy');
const { canOpenTrade, canOpenScalpMomentumTrade, getTradeRiskParams, getTradeRiskParamsCustom } = require('../risk');
const { openTrade, closeTrade, checkExitConditions } = require('../execution');
const {
  createPortfolio,
  resetDailyIfNeeded,
  getTradesToday,
  addOpenTrade,
  closeTradeInPortfolio,
  updateEquityCurve,
} = require('../portfolio');
const tradePersistence = require('../../services/tradePersistence');
const logger = require('../../utils/logger');

let paperState = {
  running: false,
  intervalId: null,
  portfolio: null,
  symbol: 'BTC/USDT',
  timeframe: '15m', // LTF for legacy strategy
  htfTimeframe: '1h',
  strategy: null,
  ohlcvHistory: [], // LTF history
  htfOhlcvHistory: [], // HTF history (trendPullback only)
  minHistoryLength: 50,
  pendingSignal: null, // scalpMomentum: execute on next candle open
};

/**
 * Initialize paper trading state
 * @param {Object} [options]
 * @param {string} [options.symbol] - Trading pair
 * @param {string} [options.timeframe] - Candle timeframe
 * @param {number} [options.initialBalance] - Starting balance
 */
function initPaperTrading(options = {}) {
  paperState.symbol = options.symbol || 'BTC/USDT';
  paperState.strategy = options.strategy || null;

  const mtfConfigByStrategy = {
    trendPullback: { ltfTimeframe: '15m', htfTimeframe: '1h' },
    scalpMomentum: { ltfTimeframe: '15m', htfTimeframe: '1h' },
  };
  const mtfCfg = paperState.strategy && mtfConfigByStrategy[paperState.strategy]
    ? mtfConfigByStrategy[paperState.strategy]
    : null;

  if (mtfCfg) {
    paperState.timeframe = mtfCfg.ltfTimeframe;
    paperState.htfTimeframe = mtfCfg.htfTimeframe;
  } else {
    paperState.timeframe = options.timeframe || '15m';
  }
  paperState.portfolio = createPortfolio(options.initialBalance || config.risk.initialBalance);
  paperState.ohlcvHistory = [];
  paperState.htfOhlcvHistory = [];
  paperState.pendingSignal = null;
}

/**
 * Fetch and build OHLCV history for paper trading
 * Fetches enough candles for strategy warmup
 */
async function fetchHistory() {
  const limit = Math.max(paperState.minHistoryLength, 100);
  const ohlcv = await fetchOHLCV(
    paperState.symbol,
    paperState.timeframe,
    undefined,
    limit
  );
  paperState.ohlcvHistory = ohlcv;

  if (paperState.strategy === 'trendPullback' || paperState.strategy === 'scalpMomentum') {
    const htf = await fetchOHLCV(
      paperState.symbol,
      paperState.htfTimeframe,
      undefined,
      limit
    );
    paperState.htfOhlcvHistory = htf;
  }
}

function upsertCandle(history, candle) {
  if (!candle) return history;
  const [timestamp] = candle;
  const lastIdx = history.length - 1;
  if (lastIdx >= 0 && history[lastIdx][0] === timestamp) {
    history[lastIdx] = candle;
  } else {
    history.push(candle);
  }
  if (history.length > 500) return history.slice(-500);
  return history;
}

/**
 * Single tick of paper trading - fetch latest, process signal, execute
 */
async function runPaperTick() {
  if (!paperState.running || !paperState.portfolio) return;

  try {
    // Fetch latest candle and update history
    const latestCandle = await fetchLatestCandle(paperState.symbol, paperState.timeframe);

    if (!latestCandle) return;

    const [timestamp] = latestCandle;
    paperState.ohlcvHistory = upsertCandle(paperState.ohlcvHistory, latestCandle);

    if (paperState.strategy === 'trendPullback' || paperState.strategy === 'scalpMomentum') {
      const latestHtf = await fetchLatestCandle(paperState.symbol, paperState.htfTimeframe);
      paperState.htfOhlcvHistory = upsertCandle(paperState.htfOhlcvHistory, latestHtf);
    }

    if (paperState.ohlcvHistory.length < paperState.minHistoryLength) {
      return;
    }

    const portfolio = paperState.portfolio;
    resetDailyIfNeeded(portfolio, timestamp);

    // 1. Check exit conditions for open trades
    const tradesToClose = [];
    const partialClosesFromExit = [];
    for (const trade of portfolio.openTrades) {
      const exitCheck = checkExitConditions(trade, latestCandle);
      if (exitCheck) {
        if (exitCheck.reason === 'PARTIAL_TP1' && exitCheck.partialCloseQuantity != null) {
          partialClosesFromExit.push({
            trade,
            partialQty: exitCheck.partialCloseQuantity,
            partialPrice: exitCheck.partialClosePrice ?? exitCheck.exitPrice,
          });
        } else {
          tradesToClose.push({ trade, exitPrice: exitCheck.exitPrice, reason: exitCheck.reason });
        }
      }
    }

    for (const { trade, partialQty, partialPrice } of partialClosesFromExit) {
      const closedPartial = closeTrade(trade, partialPrice, timestamp, partialQty);
      const updatedOpen = { ...trade, quantity: roundTo(trade.quantity - partialQty, 8), partialCloseDone: true };
      closeTradeInPortfolio(portfolio, closedPartial, updatedOpen);
      await tradePersistence.persistTradeClose(closedPartial, 'PARTIAL_TP1', 'paper');
    }
    for (const { trade, exitPrice, reason } of tradesToClose) {
      const closedTrade = closeTrade(trade, exitPrice, timestamp);
      closeTradeInPortfolio(portfolio, closedTrade);
      await tradePersistence.persistTradeClose(closedTrade, reason, 'paper');
    }

    // 1b. Update trailing stop (applies from next candle onward)
    if (paperState.strategy === 'trendPullback' && portfolio.openTrades.length > 0) {
      const mtfSignal = getSignal(paperState.ohlcvHistory, {
        strategy: 'trendPullback',
        htfOhlcv: paperState.htfOhlcvHistory,
      });
      const atr = mtfSignal.atr;
      const currentPrice = latestCandle[4];
      portfolio.openTrades = portfolio.openTrades.map((t) => {
        if (t.strategy !== 'trendPullback') return t;
        return applyTrendPullbackTrailingStop(t, currentPrice, atr);
      });
    }
    if (paperState.strategy === 'scalpMomentum' && portfolio.openTrades.length > 0) {
      const { closeTrade } = require('../execution');
      const mtfSignal = getSignal(paperState.ohlcvHistory, {
        strategy: 'scalpMomentum',
        htfOhlcv: paperState.htfOhlcvHistory,
      });
      const currentPrice = latestCandle[4];
      const atr = mtfSignal.atr;
      const ema20 = mtfSignal.ema20;
      const updatedTrades = [];
      const partialCloses = [];
      for (const t of portfolio.openTrades) {
        if (t.strategy !== 'scalpMomentum') {
          updatedTrades.push(t);
          continue;
        }
        const result = applyScalpMomentumTrailingStop(t, currentPrice, atr, ema20);
        updatedTrades.push(result.trade);
        if (result.partialCloseQuantity != null && result.partialCloseQuantity > 0) {
          partialCloses.push({ trade: result.trade, partialQty: result.partialCloseQuantity, partialPrice: result.partialClosePrice });
        }
      }
      portfolio.openTrades = updatedTrades;
      for (const { trade: t, partialQty, partialPrice } of partialCloses) {
        const closedPartial = closeTrade(t, partialPrice, timestamp, partialQty);
        const updatedOpen = { ...t, quantity: t.quantity - partialQty, partialCloseDone: true };
        closeTradeInPortfolio(portfolio, closedPartial, updatedOpen);
      }
    }

    // 2a. scalpMomentum: Execute PENDING signal from previous tick (entry at current candle open)
    if (paperState.strategy === 'scalpMomentum' && paperState.pendingSignal && ['BUY', 'SELL'].includes(paperState.pendingSignal.signal)) {
      const side = paperState.pendingSignal.signal;
      const entryPrice = latestCandle[1]; // Current candle open
      const signalPrice = paperState.pendingSignal.price;
      const gapPercent = Math.abs(entryPrice - signalPrice) / signalPrice * 100;

      if (gapPercent <= GAP_THRESHOLD_PERCENT) {
        const atr = paperState.pendingSignal.atr;
        const stopLoss = paperState.pendingSignal.stopLoss != null
          ? roundTo(paperState.pendingSignal.stopLoss, 8)
          : (side === 'BUY' ? roundTo(entryPrice - atr, 8) : roundTo(entryPrice + atr, 8));
        const takeProfit1 = paperState.pendingSignal.takeProfit1;
        const takeProfit = takeProfit1 ?? (side === 'BUY'
          ? roundTo(entryPrice + 10 * atr, 8)
          : roundTo(entryPrice - 10 * atr, 8));

        const lastBuy = portfolio.closedTrades.filter((t) => t.side === 'BUY').pop();
        const lastSell = portfolio.closedTrades.filter((t) => t.side === 'SELL').pop();
        const riskState = {
          balance: portfolio.balance,
          peakBalance: portfolio.peakBalance,
          initialBalance: portfolio.initialBalance,
          tradesToday: getTradesToday(portfolio, timestamp),
          dailyStartBalance: portfolio.dailyStartBalance,
          openTradesCount: portfolio.openTrades.length,
          lastBuyClosedAt: lastBuy?.closedAt || 0,
          lastSellClosedAt: lastSell?.closedAt || 0,
          lastBuyWasLoss: lastBuy ? (lastBuy.pnl < 0) : false,
          lastSellWasLoss: lastSell ? (lastSell.pnl < 0) : false,
        };
        const riskOverrides = {
          maxTradesPerDay: 5,
          tradeCooldownMs: 10 * 60 * 1000,
          maxConcurrentTrades: 3,
          perDirectionCooldown: true,
          skipAfterLossInSameDirection: true,
          now: timestamp,
          side,
        };
        const { allowed } = canOpenScalpMomentumTrade(riskState, riskOverrides);

        if (allowed) {
          const riskParams = getTradeRiskParamsCustom(entryPrice, side, stopLoss, takeProfit1 ?? takeProfit, portfolio.balance);
          const { positionSize } = riskParams;

          if (positionSize > 0) {
            const trade = openTrade({
              entryPrice,
              quantity: positionSize,
              side,
              stopLoss,
              takeProfit: takeProfit1 != null ? null : takeProfit,
              takeProfit1: takeProfit1 ?? undefined,
              partialClosePercent: TP1_CLOSE_PERCENT,
              timestamp,
              symbol: paperState.symbol,
              strategy: 'scalpMomentum',
              atrAtEntry: atr,
              initialStopLoss: stopLoss,
              initialRiskDistance: Math.abs(entryPrice - stopLoss),
            });
            addOpenTrade(portfolio, trade);
            await tradePersistence.persistTradeOpen(trade, 'paper', paperState.symbol);
          }
        }
      }
      paperState.pendingSignal = null;
    }

    // 2. Generate signal
    const signal = getSignal(paperState.ohlcvHistory, {
      strategy: (paperState.strategy === 'trendPullback' || paperState.strategy === 'scalpMomentum') ? paperState.strategy : undefined,
      htfOhlcv: paperState.htfOhlcvHistory,
    });
    logger.signal('Paper signal', { signal: signal.signal, price: signal.price });

    // 3. Execute new trade (trendPullback/default) or set pending signal (scalpMomentum)
    if (paperState.strategy === 'scalpMomentum' && ['BUY', 'SELL'].includes(signal.signal) && signal.stopLoss && signal.atr) {
      paperState.pendingSignal = {
        signal: signal.signal,
        price: signal.price,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
        takeProfit1: signal.takeProfit1,
        atr: signal.atr,
        ema20: signal.ema20,
        timestamp,
      };
    } else if (['BUY', 'SELL'].includes(signal.signal) && portfolio.openTrades.length === 0) {
      // trendPullback / default: execute immediately
      const side = signal.signal;
      const tradesToday = getTradesToday(portfolio, timestamp);
      const lastClosed = portfolio.closedTrades[portfolio.closedTrades.length - 1];
      const riskState = {
        balance: portfolio.balance,
        peakBalance: portfolio.peakBalance,
        initialBalance: portfolio.initialBalance,
        tradesToday,
        dailyStartBalance: portfolio.dailyStartBalance,
        lastTradeClosedAt: lastClosed?.closedAt || 0,
      };

      const riskOverrides = paperState.strategy === 'trendPullback'
        ? { maxTradesPerDay: 2, tradeCooldownMs: 30 * 60 * 1000, now: timestamp }
        : null;
      const { allowed } = canOpenTrade(riskState, riskOverrides);
      if (allowed) {
        const riskParams = (paperState.strategy === 'trendPullback' && signal.stopLoss && signal.takeProfit)
          ? getTradeRiskParamsCustom(signal.price, side, signal.stopLoss, signal.takeProfit, portfolio.balance)
          : getTradeRiskParams(signal.price, side, portfolio.balance);

        const { stopLoss, takeProfit, positionSize } = riskParams;

        if (positionSize > 0) {
          const trade = openTrade({
            entryPrice: signal.price,
            quantity: positionSize,
            side,
            stopLoss,
            takeProfit,
            timestamp,
            symbol: paperState.symbol,
            strategy: paperState.strategy === 'trendPullback' ? 'trendPullback' : 'default',
            atrAtEntry: signal.atr,
            initialStopLoss: stopLoss,
            initialRiskDistance: Math.abs(signal.price - stopLoss),
          });

          addOpenTrade(portfolio, trade);
          await tradePersistence.persistTradeOpen(trade, 'paper', paperState.symbol);
        }
      }
    }

    // 4. Update equity curve
    const [, , , , close] = latestCandle;
    updateEquityCurve(portfolio, timestamp, close);
  } catch (error) {
    logger.error('Paper trading tick error', { error: error.message });
  }
}

/**
 * Start paper trading
 * @param {Object} [options]
 * @param {string} [options.symbol] - Trading pair
 * @param {string} [options.timeframe] - Candle timeframe
 * @param {number} [options.initialBalance] - Starting balance
 */
async function startPaperTrading(options = {}) {
  if (paperState.running) {
    return { success: false, message: 'Paper trading already running' };
  }

  initPaperTrading(options);
  await fetchHistory();

  paperState.running = true;
  const intervalMs = paperState.strategy === 'scalpMomentum'
    ? 5 * 60 * 1000  // 5 minutes for scalpMomentum
    : config.paper.intervalMs;
  paperState.intervalId = setInterval(runPaperTick, intervalMs);

  // Run first tick immediately
  await runPaperTick();

  return { success: true, message: 'Paper trading started' };
}

/**
 * Stop paper trading
 */
function stopPaperTrading() {
  if (!paperState.running) {
    return { success: false, message: 'Paper trading not running' };
  }

  if (paperState.intervalId) {
    clearInterval(paperState.intervalId);
    paperState.intervalId = null;
  }

  paperState.running = false;
  return { success: true, message: 'Paper trading stopped' };
}

/**
 * Get paper trading status
 */
function getPaperStatus() {
  return {
    running: paperState.running,
    symbol: paperState.symbol,
    timeframe: paperState.timeframe,
    portfolio: paperState.portfolio
      ? {
          balance: paperState.portfolio.balance,
          openTrades: paperState.portfolio.openTrades.length,
          closedTrades: paperState.portfolio.closedTrades.length,
        }
      : null,
  };
}

/**
 * Get portfolio (for API)
 */
function getPaperPortfolio() {
  return paperState.portfolio;
}

/**
 * Get trades (for API)
 */
function getPaperTrades() {
  if (!paperState.portfolio) return { open: [], closed: [] };
  return {
    open: paperState.portfolio.openTrades,
    closed: paperState.portfolio.closedTrades,
  };
}

module.exports = {
  startPaperTrading,
  stopPaperTrading,
  getPaperStatus,
  getPaperPortfolio,
  getPaperTrades,
};
