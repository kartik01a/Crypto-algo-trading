/**
 * Paper Trading Engine
 * Runs every 1 minute: fetch latest candle, generate signal, execute simulated trades
 */

const config = require('../../config');
const { fetchOHLCV, fetchLatestCandle } = require('../exchange');
const { getSignal, createDcaState } = require('../strategy');
const { applyTrendPullbackTrailingStop } = require('../strategy/trendPullbackStrategy');
const { checkDcaExit, resetDcaState, MAX_DRAWDOWN_NO_NEW_ENTRIES } = require('../strategy/dcaStrategy');
const { canOpenTrade, getTradeRiskParams, getTradeRiskParamsCustom } = require('../risk');
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
  timeframe: '5m', // LTF for legacy strategy
  htfTimeframe: '15m',
  strategy: null,
  ohlcvHistory: [], // LTF history
  htfOhlcvHistory: [], // HTF history (trendPullback only)
  dcaState: null, // DCA cycle state (dca strategy only)
  minHistoryLength: 50,
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

  // For trendPullback, use fixed MTF timeframes (5m entry, 15m trend)
  if (paperState.strategy === 'trendPullback') {
    paperState.timeframe = '5m';
    paperState.htfTimeframe = '15m';
    paperState.minHistoryLength = 50;
  } else if (paperState.strategy === 'dca') {
    paperState.timeframe = '5m';
    paperState.minHistoryLength = 200; // DCA needs 200 for EMA200
    paperState.dcaState = createDcaState();
  } else {
    paperState.timeframe = options.timeframe || '5m';
    paperState.minHistoryLength = 50;
  }
  paperState.portfolio = createPortfolio(options.initialBalance || config.risk.initialBalance);
  paperState.ohlcvHistory = [];
  paperState.htfOhlcvHistory = [];
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

  if (paperState.strategy === 'trendPullback') {
    const htf = await fetchOHLCV(
      paperState.symbol,
      paperState.htfTimeframe,
      undefined,
      limit
    );
    paperState.htfOhlcvHistory = htf;
  }
  if (paperState.strategy === 'dca') {
    paperState.dcaState = paperState.dcaState || createDcaState();
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

    if (paperState.strategy === 'trendPullback') {
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

    if (paperState.strategy === 'dca' && paperState.dcaState?.cycleActive && paperState.dcaState.entries.length > 0) {
      if (!paperState.dcaState.trailingState) paperState.dcaState.trailingState = { active: false, highestPrice: 0 };
      const dcaExit = checkDcaExit(paperState.dcaState.entries, latestCandle, {
        ohlcv: paperState.ohlcvHistory,
        cycleStartTimestamp: paperState.dcaState.cycleStartTimestamp,
        trailingState: paperState.dcaState.trailingState,
      });
      if (dcaExit) {
        const dcaTrades = portfolio.openTrades.filter((t) => t.strategy === 'dca');
        for (const trade of dcaTrades) {
          tradesToClose.push({ trade, exitPrice: dcaExit.exitPrice, reason: dcaExit.reason });
        }
        logger.signal('Smart DCA exit', { reason: dcaExit.reason, exitPrice: dcaExit.exitPrice });
        resetDcaState(paperState.dcaState);
      }
    }

    if (paperState.strategy !== 'dca') {
      for (const trade of portfolio.openTrades) {
        const exitCheck = checkExitConditions(trade, latestCandle);
        if (exitCheck) {
          tradesToClose.push({ trade, exitPrice: exitCheck.exitPrice, reason: exitCheck.reason });
        }
      }
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

    // 2. Generate signal
    let drawdownExceeded = false;
    if (paperState.strategy === 'dca') {
      const [, , , , close] = latestCandle;
      const equity = portfolio.balance + portfolio.openTrades.reduce((s, t) => {
        const pnl = t.side === 'BUY' ? (close - t.entryPrice) * t.quantity : (t.entryPrice - close) * t.quantity;
        return s + pnl;
      }, 0);
      const peakEquity = Math.max(...portfolio.equityCurve.map((p) => p.equity), equity);
      const drawdown = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;
      drawdownExceeded = drawdown >= MAX_DRAWDOWN_NO_NEW_ENTRIES;
    }

    const signal = getSignal(paperState.ohlcvHistory, {
      strategy: paperState.strategy === 'trendPullback' ? 'trendPullback' : paperState.strategy === 'dca' ? 'dca' : undefined,
      htfOhlcv: paperState.htfOhlcvHistory,
      dcaState: paperState.strategy === 'dca' ? paperState.dcaState : undefined,
      portfolioBalance: paperState.strategy === 'dca' ? portfolio.balance : undefined,
      drawdownExceeded: paperState.strategy === 'dca' ? drawdownExceeded : undefined,
    });
    logger.signal('Paper signal', { signal: signal.signal, price: signal.price });

    // 3a. DCA strategy: add DCA levels
    if (paperState.strategy === 'dca' && ['DCA_BUY_1', 'DCA_BUY_2', 'DCA_BUY_3', 'DCA_BUY_4'].includes(signal.signal)) {
      const dcaTrades = portfolio.openTrades.filter((t) => t.strategy === 'dca');
      if (dcaTrades.length < 4 && signal.quantity > 0) {
        const trade = openTrade({
          entryPrice: signal.price,
          quantity: signal.quantity,
          side: 'BUY',
          stopLoss: null,
          takeProfit: null,
          timestamp,
          symbol: paperState.symbol,
          strategy: 'dca',
          dcaLevel: signal.level,
        });
        addOpenTrade(portfolio, trade);
        await tradePersistence.persistTradeOpen(trade, 'paper', paperState.symbol);
        logger.signal('DCA level triggered', { level: signal.level, price: signal.price, quantity: signal.quantity });
      }
    }
    // 3b. Execute new trade if BUY/SELL signal and no open position (non-DCA)
    else if (['BUY', 'SELL'].includes(signal.signal) && portfolio.openTrades.length === 0) {
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
  paperState.intervalId = setInterval(
    runPaperTick,
    config.paper.intervalMs
  );

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
