/**
 * Paper Trading Engine
 * Runs every 1 minute: fetch latest candle, generate signal, execute simulated trades
 */

const config = require('../../config');
const { fetchOHLCV, fetchLatestCandle, fetchTicker } = require('../exchange');
const { getSignal } = require('../strategy');
const { applyTrendPullbackTrailingStop } = require('../strategy/trendPullbackStrategy');
const {
  shouldExitTrade: shouldExitTradeGoldenCross,
  updateTrailingStop: updateTrailingStopGoldenCross,
  MIN_LTF_CANDLES: GOLDEN_CROSS_MIN_LTF,
} = require('../strategy/goldenCrossHTFStrategy');
const { canOpenTrade, getTradeRiskParams, getTradeRiskParamsCustom, configMaxOpenTrades } = require('../risk');
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
  symbols: ['BTC/USDT'], // Multi-symbol: [BTC, ETH, SOL]; single: [BTC]
  timeframe: '5m',
  htfTimeframe: '15m',
  strategy: null,
  ohlcvHistory: [],
  htfOhlcvHistory: [],
  ohlcvHistoryBySymbol: {}, // Multi-symbol: { 'BTC/USDT': [...], ... }
  htfOhlcvHistoryBySymbol: {},
  minHistoryLength: 50,
  lastProcessedCandleTs: 0,
  maxOpenTrades: 3,
  longOnly: false,
};

/**
 * Initialize paper trading state
 * @param {Object} [options]
 * @param {string} [options.symbol] - Trading pair (single-symbol)
 * @param {Array<string>} [options.symbols] - Multiple symbols (e.g. ['BTC/USDT','ETH/USDT','SOL/USDT'])
 * @param {string} [options.timeframe] - Candle timeframe
 * @param {number} [options.initialBalance] - Starting balance
 * @param {number} [options.maxOpenTrades] - Max concurrent trades (multi-symbol)
 */
function initPaperTrading(options = {}) {
  const symbolsParam = options.symbols && options.symbols.length > 0 ? options.symbols : null;
  paperState.symbols = symbolsParam || [options.symbol || 'BTC/USDT'];
  paperState.symbol = paperState.symbols[0];
  paperState.strategy = options.strategy || null;
  paperState.longOnly = options.longOnly ?? false; // true = skip SELL (only BUY signals)
  paperState.maxOpenTrades = options.maxOpenTrades ?? configMaxOpenTrades;
  if (paperState.symbols.length === 1) {
    paperState.maxOpenTrades = 1;
  }

  if (paperState.strategy === 'trendPullback') {
    paperState.timeframe = '5m';
    paperState.htfTimeframe = '15m';
    paperState.minHistoryLength = 50;
  } else if (paperState.strategy === 'goldenCrossHTF') {
    paperState.timeframe = '4h';
    paperState.htfTimeframe = '1d';
    paperState.minHistoryLength = GOLDEN_CROSS_MIN_LTF;
  } else {
    paperState.timeframe = options.timeframe || '5m';
    paperState.minHistoryLength = 50;
  }
  paperState.portfolio = createPortfolio(options.initialBalance || config.risk.initialBalance);
  paperState.ohlcvHistory = [];
  paperState.htfOhlcvHistory = [];
  paperState.ohlcvHistoryBySymbol = {};
  paperState.htfOhlcvHistoryBySymbol = {};
  paperState.lastProcessedCandleTs = 0;
}

/**
 * Fetch and build OHLCV history for paper trading
 */
async function fetchHistory() {
  const limit = Math.max(paperState.minHistoryLength, 100);
  const htfLimit = paperState.strategy === 'goldenCrossHTF' ? 300 : limit;

  if (paperState.symbols.length > 1) {
    paperState.ohlcvHistoryBySymbol = {};
    paperState.htfOhlcvHistoryBySymbol = {};
    for (const sym of paperState.symbols) {
      paperState.ohlcvHistoryBySymbol[sym] = await fetchOHLCV(sym, paperState.timeframe, undefined, limit);
      if (paperState.strategy === 'trendPullback' || paperState.strategy === 'goldenCrossHTF') {
        paperState.htfOhlcvHistoryBySymbol[sym] = await fetchOHLCV(sym, paperState.htfTimeframe, undefined, htfLimit);
      }
    }
    paperState.ohlcvHistory = paperState.ohlcvHistoryBySymbol[paperState.symbol];
    paperState.htfOhlcvHistory = paperState.htfOhlcvHistoryBySymbol[paperState.symbol];
  } else {
    paperState.ohlcvHistory = await fetchOHLCV(
      paperState.symbol,
      paperState.timeframe,
      undefined,
      limit
    );
    if (paperState.strategy === 'trendPullback' || paperState.strategy === 'goldenCrossHTF') {
      paperState.htfOhlcvHistory = await fetchOHLCV(
        paperState.symbol,
        paperState.htfTimeframe,
        undefined,
        htfLimit
      );
    }
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
    logger.info('Paper tick', { openTrades: paperState.portfolio.openTrades.length, balance: paperState.portfolio.balance.toFixed(2) });
    const isMultiSymbol = paperState.symbols.length > 1;
    const latestCandleBySymbol = {};

    // Fetch latest candle(s) and update history
    if (isMultiSymbol) {
      for (const sym of paperState.symbols) {
        const c = await fetchLatestCandle(sym, paperState.timeframe);
        if (!c) continue;
        latestCandleBySymbol[sym] = c;
        paperState.ohlcvHistoryBySymbol[sym] = upsertCandle(paperState.ohlcvHistoryBySymbol[sym] || [], c);
        if (paperState.strategy === 'trendPullback' || paperState.strategy === 'goldenCrossHTF') {
          const htf = await fetchLatestCandle(sym, paperState.htfTimeframe);
          paperState.htfOhlcvHistoryBySymbol[sym] = upsertCandle(paperState.htfOhlcvHistoryBySymbol[sym] || [], htf);
        }
      }
      const firstCandle = Object.values(latestCandleBySymbol)[0];
      if (!firstCandle) return;
      paperState.ohlcvHistory = paperState.ohlcvHistoryBySymbol[paperState.symbol];
      paperState.htfOhlcvHistory = paperState.htfOhlcvHistoryBySymbol[paperState.symbol];
    } else {
      const latestCandle = await fetchLatestCandle(paperState.symbol, paperState.timeframe);
      if (!latestCandle) return;
      latestCandleBySymbol[paperState.symbol] = latestCandle;
      paperState.ohlcvHistory = upsertCandle(paperState.ohlcvHistory, latestCandle);
      if (paperState.strategy === 'trendPullback' || paperState.strategy === 'goldenCrossHTF') {
        const latestHtf = await fetchLatestCandle(paperState.symbol, paperState.htfTimeframe);
        paperState.htfOhlcvHistory = upsertCandle(paperState.htfOhlcvHistory, latestHtf);
      }
    }

    const firstCandle = Object.values(latestCandleBySymbol)[0];
    if (!firstCandle) return;
    const [timestamp] = firstCandle;

    if (paperState.ohlcvHistory.length < paperState.minHistoryLength) {
      return;
    }

    // goldenCrossHTF: only process when we have a new LTF candle (use first symbol's ts)
    if (paperState.strategy === 'goldenCrossHTF') {
      const latestTs = paperState.ohlcvHistory[paperState.ohlcvHistory.length - 1][0];
      if (latestTs <= paperState.lastProcessedCandleTs) {
        return;
      }
      paperState.lastProcessedCandleTs = latestTs;
    }

    const portfolio = paperState.portfolio;
    resetDailyIfNeeded(portfolio, timestamp);
    const openSymbols = new Set(portfolio.openTrades.map((t) => t.symbol));

    // 1. Update trailing stop for goldenCrossHTF (using previous candle per symbol)
    if (paperState.strategy === 'goldenCrossHTF' && portfolio.openTrades.length > 0) {
      portfolio.openTrades = portfolio.openTrades.map((t) => {
        if (t.strategy !== 'goldenCrossHTF') return t;
        const hist = isMultiSymbol ? (paperState.ohlcvHistoryBySymbol[t.symbol] || []) : paperState.ohlcvHistory;
        if (hist.length < 2) return t;
        const prevCandle = hist[hist.length - 2];
        const [, , prevHigh, prevLow] = prevCandle;
        const updated = updateTrailingStopGoldenCross(t, prevCandle, prevHigh, prevLow);
        updated.candleCount = (t.candleCount || 0) + 1;
        return updated;
      });
    }

    // 2. Check exit conditions for open trades (use live price, not stale candle)
    const tradesToClose = [];
    for (const trade of portfolio.openTrades) {
      let candle = latestCandleBySymbol[trade.symbol];
      try {
        const ticker = await fetchTicker(trade.symbol);
        const livePrice = parseFloat(ticker?.last ?? ticker?.bid ?? ticker?.ask ?? 0);
        if (livePrice > 0) {
          const ts = Date.now();
          candle = [ts, livePrice, livePrice, livePrice, livePrice, 0]; // synthetic candle for exit check
        }
      } catch (err) {
        logger.warn('Could not fetch live price for exit check', { symbol: trade.symbol, error: err.message });
      }
      if (!candle) continue;
      let exitCheck;
      if (trade.strategy === 'goldenCrossHTF') {
        exitCheck = shouldExitTradeGoldenCross(trade, candle);
      } else {
        exitCheck = checkExitConditions(trade, candle);
      }
      if (exitCheck) {
        tradesToClose.push({ trade, exitPrice: exitCheck.exitPrice, reason: exitCheck.reason });
      }
    }

    for (const { trade, exitPrice, reason } of tradesToClose) {
      const closedTrade = closeTrade(trade, exitPrice, timestamp);
      closeTradeInPortfolio(portfolio, closedTrade);
      await tradePersistence.persistTradeClose(closedTrade, reason, 'paper');
    }

    // 2b. Update trailing stop for trendPullback
    if (paperState.strategy === 'trendPullback' && portfolio.openTrades.length > 0) {
      const latestCandle = latestCandleBySymbol[paperState.symbol] || firstCandle;
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

    // 3. Generate signal(s)
    let topSignals = [];
    let primarySignal = null;

    if (isMultiSymbol && paperState.strategy === 'goldenCrossHTF') {
      const allSignals = [];
      for (const sym of paperState.symbols) {
        const symHist = paperState.ohlcvHistoryBySymbol[sym];
        const symHtf = paperState.htfOhlcvHistoryBySymbol[sym];
        if (!symHist || symHist.length < paperState.minHistoryLength) continue;
        const s = getSignal(symHist, {
          strategy: 'goldenCrossHTF',
          htfOhlcv: symHtf,
          openTrades: portfolio.openTrades,
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
      topSignals = allSignals.filter((s) => !openSymbols.has(s.symbol)).slice(0, paperState.maxOpenTrades - portfolio.openTrades.length);
      primarySignal = topSignals[0] || { signal: 'HOLD', price: firstCandle[4], symbol: paperState.symbol };
      if (topSignals.length > 0) {
        logger.signal('Paper multi-symbol', { selected: topSignals.map((s) => ({ symbol: s.symbol, action: s.action, adx: s.adx })) });
      }
    } else {
      const signal = getSignal(paperState.ohlcvHistory, {
        strategy: paperState.strategy === 'trendPullback' ? 'trendPullback' : paperState.strategy === 'goldenCrossHTF' ? 'goldenCrossHTF' : undefined,
        htfOhlcv: paperState.htfOhlcvHistory,
        openTrades: paperState.strategy === 'goldenCrossHTF' ? portfolio.openTrades : undefined,
        symbol: paperState.strategy === 'goldenCrossHTF' ? paperState.symbol : undefined,
      });
      primarySignal = signal;
      if (['BUY', 'SELL'].includes(signal.signal)) {
        topSignals = [{ ...signal, symbol: paperState.symbol, action: signal.signal }];
      }
      logger.signal('Paper signal', { signal: signal.signal, price: signal.price });
    }

    // 4. Execute new trades (one per topSignal, up to maxOpenTrades)
    const riskOverrides = paperState.strategy === 'trendPullback'
      ? { maxTradesPerDay: 2, tradeCooldownMs: 30 * 60 * 1000, now: timestamp }
      : paperState.strategy === 'goldenCrossHTF'
        ? { maxTradesPerDay: 10, tradeCooldownMs: 0, now: timestamp, maxDrawdown: 1 }
        : null;

    for (const sig of topSignals) {
      if (portfolio.openTrades.length >= paperState.maxOpenTrades) break;
      if (openSymbols.has(sig.symbol)) continue;

      const side = sig.action || sig.signal;
      if (paperState.longOnly && side === 'SELL') continue; // Skip short signals when longOnly
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
      const { allowed } = canOpenTrade(riskState, riskOverrides);
      if (!allowed) continue;

      // Use live ticker price for entry (not stale candle close) - more realistic for paper
      let entryPrice = sig.price;
      try {
        const ticker = await fetchTicker(sig.symbol);
        const livePrice = parseFloat(ticker?.last ?? ticker?.bid ?? ticker?.ask ?? sig.price) || sig.price;
        if (livePrice > 0) entryPrice = livePrice;
      } catch (err) {
        logger.warn('Could not fetch live price, using candle close', { symbol: sig.symbol, error: err.message });
      }

      // Recalc stopLoss for live price (goldenCrossHTF uses %; trendPullback shifts by price diff)
      let stopLossForRisk = sig.stopLoss;
      if (paperState.strategy === 'goldenCrossHTF' && sig.stopLoss) {
        const cfg = require('../strategy/goldenCrossHTFStrategy').getConfig();
        stopLossForRisk = side === 'BUY'
          ? entryPrice * (1 - cfg.trailPercent)
          : entryPrice * (1 + cfg.trailPercent);
      } else if (paperState.strategy === 'trendPullback' && sig.stopLoss && sig.atr) {
        const diff = entryPrice - sig.price;
        stopLossForRisk = side === 'BUY' ? sig.stopLoss + diff : sig.stopLoss + diff;
      }

      const useCustomRisk = (paperState.strategy === 'trendPullback' && sig.stopLoss && sig.takeProfit)
        || (paperState.strategy === 'goldenCrossHTF' && sig.stopLoss);
      const riskParams = useCustomRisk
        ? getTradeRiskParamsCustom(
            entryPrice,
            side,
            stopLossForRisk,
            sig.takeProfit || Infinity,
            portfolio.balance,
            sig.suggestedRiskPercent ?? 0.01
          )
        : getTradeRiskParams(entryPrice, side, portfolio.balance);

      const { stopLoss, takeProfit, positionSize } = riskParams;
      const effectiveTakeProfit = paperState.strategy === 'goldenCrossHTF' ? null : takeProfit;

      if (positionSize > 0) {
        const tradeParams = {
          entryPrice,
          quantity: positionSize,
          side,
          stopLoss,
          takeProfit: effectiveTakeProfit,
          timestamp,
          symbol: sig.symbol,
          strategy: paperState.strategy === 'trendPullback' ? 'trendPullback' : paperState.strategy === 'goldenCrossHTF' ? 'goldenCrossHTF' : 'default',
          atrAtEntry: sig.atr,
          initialStopLoss: stopLoss,
          initialRiskDistance: Math.abs(entryPrice - stopLoss),
        };
        if (paperState.strategy === 'goldenCrossHTF') {
          tradeParams.highestPrice = side === 'BUY' ? entryPrice : undefined;
          tradeParams.lowestPrice = side === 'SELL' ? entryPrice : undefined;
        }
        const trade = openTrade(tradeParams);
        addOpenTrade(portfolio, trade);
        await tradePersistence.persistTradeOpen(trade, 'paper', sig.symbol);
        openSymbols.add(sig.symbol);
      }
    }

    // 5. Update equity curve (per-symbol mark prices when multi-symbol)
    const markPrices = {};
    for (const [sym, c] of Object.entries(latestCandleBySymbol)) {
      markPrices[sym] = c[4];
    }
    updateEquityCurve(portfolio, timestamp, Object.keys(markPrices).length > 0 ? markPrices : firstCandle[4]);
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
    symbols: paperState.symbols,
    longOnly: paperState.longOnly,
    strategy: paperState.strategy,
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
