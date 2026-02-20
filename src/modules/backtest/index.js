/**
 * Backtest Engine
 * Simulates trading on historical data with candle-by-candle execution
 */

const { fetchOHLCV } = require('../exchange');
const { getSignal } = require('../strategy');
const { canOpenTrade, canOpenScalpMomentumTrade, getTradeRiskParams, getTradeRiskParamsCustom } = require('../risk');
const { applyTrendPullbackTrailingStop } = require('../strategy/trendPullbackStrategy');
const {
  applyScalpMomentumTrailingStop,
  TP1_R_MULT,
  TP1_CLOSE_PERCENT,
  GAP_THRESHOLD_PERCENT,
} = require('../strategy/scalpMomentumStrategy');

const TIME_EXIT_CANDLES = 20; // Close if duration > 20 candles and profit < 0.5R
const TIME_EXIT_MIN_R = 0.5;
const { openTrade, closeTrade, checkExitConditions } = require('../execution');
const {
  createPortfolio,
  resetDailyIfNeeded,
  getTradesToday,
  addOpenTrade,
  closeTradeInPortfolio,
  updateEquityCurve,
  getSummary,
} = require('../portfolio');
const { parseDate, roundTo, getStartOfDay } = require('../../utils/helpers');
const tradePersistence = require('../../services/tradePersistence');
const logger = require('../../utils/logger');

/**
 * Fetch OHLCV data for backtest range
 * CCXT returns max 1000 candles per request, so we may need to paginate
 * @param {string} symbol - Trading pair
 * @param {string} timeframe - Candle timeframe
 * @param {number} from - Start timestamp ms
 * @param {number} to - End timestamp ms
 * @returns {Promise<Array>} OHLCV data
 */
async function fetchBacktestData(symbol, timeframe, from, to) {
  const allCandles = [];
  let since = from;

  while (since < to) {
    const candles = await fetchOHLCV(symbol, timeframe, since, 1000);
    if (candles.length === 0) break;

    for (const c of candles) {
      if (c[0] >= from && c[0] <= to) {
        allCandles.push(c);
      }
    }

    since = candles[candles.length - 1][0] + 1;
    if (candles.length < 1000) break;
  }

  return allCandles.sort((a, b) => a[0] - b[0]);
}

/**
 * Compute analytics from closed trades
 * @param {Array} closedTrades - Closed trade objects with pnl
 * @param {number} initialBalance - Starting balance for Sharpe
 * @returns {Object} Analytics
 */
function computeAnalytics(closedTrades, initialBalance = 10000) {
  const wins = closedTrades.filter((t) => t.pnl > 0);
  const losses = closedTrades.filter((t) => t.pnl < 0);

  const avgWin = wins.length > 0
    ? roundTo(wins.reduce((s, t) => s + t.pnl, 0) / wins.length, 8)
    : 0;
  const avgLoss = losses.length > 0
    ? roundTo(losses.reduce((s, t) => s + t.pnl, 0) / losses.length, 8)
    : 0;

  const avgWinPercent = wins.length > 0
    ? roundTo(wins.reduce((s, t) => s + (t.pnlPercent || 0), 0) / wins.length, 4)
    : 0;
  const avgLossPercent = losses.length > 0
    ? roundTo(losses.reduce((s, t) => s + (t.pnlPercent || 0), 0) / losses.length, 4)
    : 0;

  const rMultiples = closedTrades.map((t) => {
    const riskDist = t.initialRiskDistance ?? (t.initialStopLoss != null ? Math.abs(t.entryPrice - t.initialStopLoss) : null);
    if (!riskDist || riskDist <= 0) return null;
    const priceMove = t.side === 'BUY' ? (t.exitPrice - t.entryPrice) : (t.entryPrice - t.exitPrice);
    return priceMove / riskDist;
  }).filter((r) => r != null);
  const avgRMultiple = rMultiples.length > 0
    ? roundTo(rMultiples.reduce((a, b) => a + b, 0) / rMultiples.length, 4)
    : 0;

  const winRate = closedTrades.length > 0 ? wins.length / closedTrades.length : 0;
  const lossRate = closedTrades.length > 0 ? losses.length / closedTrades.length : 0;
  const expectancy = roundTo(winRate * avgWin + lossRate * avgLoss, 8);

  const pnlSeries = closedTrades.map((t) => t.pnl);
  const meanPnl = pnlSeries.length > 0
    ? pnlSeries.reduce((a, b) => a + b, 0) / pnlSeries.length
    : 0;
  const variance = pnlSeries.length > 1
    ? pnlSeries.reduce((s, p) => s + Math.pow(p - meanPnl, 2), 0) / (pnlSeries.length - 1)
    : 0;
  const stdDev = Math.sqrt(variance);
  const sharpeRatio = stdDev > 0 && initialBalance > 0
    ? roundTo((meanPnl / stdDev) * Math.sqrt(252), 4)
    : 0;

  const winStreaks = [];
  const lossStreaks = [];
  let currentWin = 0;
  let currentLoss = 0;
  for (const t of closedTrades) {
    if (t.pnl > 0) {
      currentWin += 1;
      if (currentLoss > 0) {
        lossStreaks.push(currentLoss);
        currentLoss = 0;
      }
    } else {
      currentLoss += 1;
      if (currentWin > 0) {
        winStreaks.push(currentWin);
        currentWin = 0;
      }
    }
  }
  if (currentWin > 0) winStreaks.push(currentWin);
  if (currentLoss > 0) lossStreaks.push(currentLoss);

  const maxWinStreak = winStreaks.length > 0 ? Math.max(...winStreaks) : 0;
  const maxLossStreak = lossStreaks.length > 0 ? Math.max(...lossStreaks) : 0;
  const avgWinStreak = winStreaks.length > 0
    ? roundTo(winStreaks.reduce((a, b) => a + b, 0) / winStreaks.length, 2)
    : 0;
  const avgLossStreak = lossStreaks.length > 0
    ? roundTo(lossStreaks.reduce((a, b) => a + b, 0) / lossStreaks.length, 2)
    : 0;

  const distribution = {
    wins: wins.length,
    losses: losses.length,
    breakeven: closedTrades.filter((t) => t.pnl === 0).length,
    winStreaks,
    lossStreaks,
  };

  return {
    avgWin,
    avgLoss,
    avgWinPercent,
    avgLossPercent,
    avgRMultiple,
    expectancy,
    sharpeRatio,
    maxWinStreak,
    maxLossStreak,
    avgWinStreak,
    avgLossStreak,
    distribution,
  };
}

/**
 * Run backtest on historical data
 * @param {Object} params
 * @param {string} params.symbol - Trading pair (e.g., 'BTC/USDT')
 * @param {string} params.timeframe - Candle timeframe (e.g., '5m')
 * @param {string} params.from - Start date (YYYY-MM-DD)
 * @param {string} params.to - End date (YYYY-MM-DD)
 * @param {number} [params.initialBalance] - Starting balance
 * @param {Array} [params.ohlcv] - Pre-fetched OHLCV data (optional)
 * @returns {Promise<Object>} Backtest results
 */
async function runBacktest({
  symbol,
  symbols,
  timeframe,
  from,
  to,
  initialBalance = 10000,
  ohlcv = null,
  strategy = null,
  debug = false,
  minTrades = 100,
}) {
  const symbolList = symbols && Array.isArray(symbols) ? symbols : [symbol || 'BTC/USDT'];
  if (symbolList.length > 1) {
    return runMultiSymbolBacktest({
      symbols: symbolList,
      timeframe,
      from,
      to,
      initialBalance,
      strategy,
      debug,
      minTrades,
    });
  }

  const sym = symbolList[0];
  const fromTs = parseDate(from);
  const toTs = parseDate(to);

  let candles = ohlcv;
  let htfCandles = null;

  const mtfConfigByStrategy = {
    trendPullback: { ltfTimeframe: '15m', htfTimeframe: '1h' },
    scalpMomentum: { ltfTimeframe: '15m', htfTimeframe: '1h' },
  };
  const mtfCfg = strategy && mtfConfigByStrategy[strategy] ? mtfConfigByStrategy[strategy] : null;
  const ltfTimeframe = mtfCfg ? mtfCfg.ltfTimeframe : timeframe;
  const htfTimeframe = mtfCfg ? mtfCfg.htfTimeframe : null;

  if (!candles || candles.length === 0) {
    candles = await fetchBacktestData(sym, ltfTimeframe, fromTs, toTs);
  }
  if (mtfCfg) {
    htfCandles = await fetchBacktestData(sym, htfTimeframe, fromTs, toTs);
  }

  if (candles.length === 0) {
    throw new Error('No OHLCV data available for the specified range');
  }

  const portfolio = createPortfolio(initialBalance);
  // Backtest runs on historical timestamps; initialize daily reset anchor accordingly
  portfolio.lastDayReset = getStartOfDay(candles[0][0]);
  portfolio.dailyStartBalance = portfolio.balance;
  const warmupPeriod = 50; // minimum candles before signal
  let lastTradeClosedAt = 0;
  let lastBuyClosedAt = 0;
  let lastSellClosedAt = 0;
  let lastBuyWasLoss = false;
  let lastSellWasLoss = false;
  let pendingSignal = null; // Execute on next candle open (no lookahead)
  let htfIdx = 0;

  const scalpMomentumCounters = strategy === 'scalpMomentum'
    ? {
        totalSignals: 0,
        attemptedTrades: 0,
        blockedByGap: 0,
        blockedByCooldown: 0,
        blockedByMaxTrades: 0,
        blockedByMaxTradesPerDay: 0,
        blockedByDrawdown: 0,
        blockedByOpenTrade: 0,
        blockedByRisk: 0,
        blockedBySizeZero: 0,
        openedTrades: 0,
        filterRejectionCounts: {}, // Count per signalReason when strategy returns HOLD
      }
    : null;

  const debugSummary = debug && (strategy === 'trendPullback' || strategy === 'scalpMomentum')
    ? {
        signals: { BUY: 0, SELL: 0, HOLD: 0 },
        holdReasons: {},
        trendCounts: {},
        conditionPass: { atrOk: 0, nearOk: 0, rsiOk: 0, alignOk: 0, candlesOk: 0 },
        conditionTotal: 0,
        entries: { attempted: 0, opened: 0, blockedRisk: 0, blockedSize: 0, blockedOpenTrade: 0 },
        samples: [],
      }
    : null;

  for (let i = warmupPeriod; i < candles.length; i++) {
    const candle = candles[i];
    const [timestamp, open, high, low, close] = candle;

    // Use only data up to current candle (no lookahead)
    const ohlcvSlice = candles.slice(0, i + 1);

    resetDailyIfNeeded(portfolio, timestamp);

    // 0. Update trailing stops using previous closed candle (no lookahead)
    if (strategy === 'trendPullback' && portfolio.openTrades.length > 0 && i >= 1) {
      const prevCandle = candles[i - 1];
      const prevTs = prevCandle[0];
      const prevSlice = candles.slice(0, i); // up to prev candle

      let prevHtfSlice = null;
      if (htfCandles) {
        let idx = htfIdx;
        while (idx < htfCandles.length - 1 && htfCandles[idx + 1][0] <= prevTs) idx += 1;
        prevHtfSlice = htfCandles.slice(0, idx + 1);
      }

      const prevSignal = getSignal(prevSlice, { strategy: 'trendPullback', htfOhlcv: prevHtfSlice });
      const markPrice = prevSignal.price; // prev close
      const atrNow = prevSignal.atr;

      portfolio.openTrades = portfolio.openTrades.map((t) => {
        if (t.strategy !== 'trendPullback') return t;
        return applyTrendPullbackTrailingStop(t, markPrice, atrNow);
      });
    }
    if (strategy === 'scalpMomentum' && portfolio.openTrades.length > 0 && i >= 1) {
      const prevCandle = candles[i - 1];
      const prevTs = prevCandle[0];
      const prevSlice = candles.slice(0, i);

      let prevHtfSlice = null;
      if (htfCandles) {
        let idx = htfIdx;
        while (idx < htfCandles.length - 1 && htfCandles[idx + 1][0] <= prevTs) idx += 1;
        prevHtfSlice = htfCandles.slice(0, idx + 1);
      }

      const prevSignal = getSignal(prevSlice, { strategy: 'scalpMomentum', htfOhlcv: prevHtfSlice || [] });
      const markPrice = prevSignal.price;
      const atrNow = prevSignal.atr;
      const ema20Now = prevSignal.ema20;

      const updatedTrades = [];
      const partialClosesToProcess = [];
      for (const t of portfolio.openTrades) {
        if (t.strategy !== 'scalpMomentum') {
          updatedTrades.push(t);
          continue;
        }
        const result = applyScalpMomentumTrailingStop(t, markPrice, atrNow, ema20Now);
        if (result.partialCloseQuantity != null && result.partialCloseQuantity > 0) {
          partialClosesToProcess.push({
            trade: result.trade,
            partialQty: result.partialCloseQuantity,
            partialPrice: result.partialClosePrice,
          });
        }
        updatedTrades.push(result.trade);
      }
      portfolio.openTrades = updatedTrades;

      for (const { trade: t, partialQty, partialPrice } of partialClosesToProcess) {
        const closedPartial = closeTrade(t, partialPrice, prevTs, partialQty);
        const riskDist = t.initialRiskDistance ?? (t.initialStopLoss != null ? Math.abs(t.entryPrice - t.initialStopLoss) : null);
        if (riskDist && riskDist > 0) {
          const priceMove = t.side === 'BUY' ? (partialPrice - t.entryPrice) : (t.entryPrice - partialPrice);
          closedPartial.rMultiple = roundTo(priceMove / riskDist, 4);
        }
        const updatedOpen = {
          ...t,
          quantity: roundTo(t.quantity - partialQty, 8),
          partialCloseDone: true,
        };
        closeTradeInPortfolio(portfolio, closedPartial, updatedOpen);
        await tradePersistence.persistTradeClose(closedPartial, 'PARTIAL_TP', 'backtest');
      }
    }

    // 1. Check exit conditions for open trades (time exit, SL/TP/TP1 partial)
    const tradesToClose = [];
    const partialClosesFromExit = [];
    for (const trade of portfolio.openTrades) {
      // Time-based exit: close if duration > 20 candles and profit < 0.5R (scalpMomentum only)
      if (strategy === 'scalpMomentum' && trade.strategy === 'scalpMomentum') {
        const openedAtIdx = trade.openedAtCandleIndex;
        if (typeof openedAtIdx === 'number' && (i - openedAtIdx) > TIME_EXIT_CANDLES) {
          const riskDist = trade.initialRiskDistance ?? Math.abs(trade.entryPrice - trade.stopLoss);
          if (riskDist > 0) {
            const profit = trade.side === 'BUY' ? (close - trade.entryPrice) : (trade.entryPrice - close);
            const currentR = profit / riskDist;
            if (currentR < TIME_EXIT_MIN_R) {
              tradesToClose.push({ trade, exitPrice: close, reason: 'TIME_EXIT' });
              continue;
            }
          }
        }
      }
      const exitCheck = checkExitConditions(trade, candle);
      if (exitCheck) {
        if (exitCheck.reason === 'PARTIAL_TP1' && exitCheck.partialCloseQuantity != null) {
          partialClosesFromExit.push({
            trade,
            partialQty: exitCheck.partialCloseQuantity,
            partialPrice: exitCheck.partialClosePrice ?? exitCheck.exitPrice,
            timestamp,
          });
        } else {
          tradesToClose.push({ trade, exitPrice: exitCheck.exitPrice, reason: exitCheck.reason });
        }
      }
    }

    for (const { trade, partialQty, partialPrice, timestamp: ts } of partialClosesFromExit) {
      const closedPartial = closeTrade(trade, partialPrice, ts, partialQty);
      const riskDist = trade.initialRiskDistance ?? (trade.initialStopLoss != null ? Math.abs(trade.entryPrice - trade.initialStopLoss) : null);
      if (riskDist && riskDist > 0) {
        const priceMove = trade.side === 'BUY' ? (partialPrice - trade.entryPrice) : (trade.entryPrice - partialPrice);
        closedPartial.rMultiple = roundTo(priceMove / riskDist, 4);
      }
      if (debug) logger.trade('Partial TP1 closed', { exitPrice: partialPrice, pnl: closedPartial.pnl, rMultiple: closedPartial.rMultiple });
      const updatedOpen = {
        ...trade,
        quantity: roundTo(trade.quantity - partialQty, 8),
        partialCloseDone: true,
      };
      closeTradeInPortfolio(portfolio, closedPartial, updatedOpen);
      await tradePersistence.persistTradeClose(closedPartial, 'PARTIAL_TP1', 'backtest');
    }

    for (const { trade, exitPrice, reason } of tradesToClose) {
      const closedTrade = closeTrade(trade, exitPrice, timestamp);
      const riskDist = trade.initialRiskDistance ?? (trade.initialStopLoss != null ? Math.abs(trade.entryPrice - trade.initialStopLoss) : null);
      if (riskDist && riskDist > 0) {
        const priceMove = trade.side === 'BUY' ? (exitPrice - trade.entryPrice) : (trade.entryPrice - exitPrice);
        closedTrade.rMultiple = roundTo(priceMove / riskDist, 4);
      }
      if (debug) logger.trade('Trade closed', { reason, exitPrice, pnl: closedTrade.pnl, rMultiple: closedTrade.rMultiple });
      closeTradeInPortfolio(portfolio, closedTrade);
      lastTradeClosedAt = timestamp;
      if (strategy === 'scalpMomentum') {
        if (trade.side === 'BUY') {
          lastBuyClosedAt = timestamp;
          lastBuyWasLoss = closedTrade.pnl < 0;
        } else {
          lastSellClosedAt = timestamp;
          lastSellWasLoss = closedTrade.pnl < 0;
        }
      }
      await tradePersistence.persistTradeClose(closedTrade, reason, 'backtest');
    }

    // 2. Generate signal
    let htfSlice = null;
    if (mtfCfg) {
      // Align HTF to current LTF timestamp: include only candles with ts <= current LTF candle ts
      while (htfCandles && htfIdx < htfCandles.length - 1 && htfCandles[htfIdx + 1][0] <= timestamp) {
        htfIdx += 1;
      }
      htfSlice = htfCandles ? htfCandles.slice(0, htfIdx + 1) : [];
    }

    const signal = getSignal(ohlcvSlice, {
      strategy: mtfCfg ? strategy : undefined,
      htfOhlcv: htfSlice,
    });

    if (scalpMomentumCounters) {
      if (signal.signal !== 'HOLD') {
        scalpMomentumCounters.totalSignals += 1;
      } else if (signal.debug?.signalReason) {
        const reason = signal.debug.signalReason;
        scalpMomentumCounters.filterRejectionCounts[reason] = (scalpMomentumCounters.filterRejectionCounts[reason] || 0) + 1;
      }
    }

    // 2b. Execute PENDING signal from previous candle (next candle open - no lookahead)
    if (strategy === 'scalpMomentum' && pendingSignal && ['BUY', 'SELL'].includes(pendingSignal.signal)) {
      const side = pendingSignal.signal;
      const entryPrice = open; // Next candle open
      const signalPrice = pendingSignal.price;
      const gapPercent = Math.abs(entryPrice - signalPrice) / signalPrice * 100;
      if (gapPercent > GAP_THRESHOLD_PERCENT) {
        // Skip trade if gap > 0.3% from signal candle
        scalpMomentumCounters.blockedByGap += 1;
        pendingSignal = null;
      } else {
      const atr = pendingSignal.atr;
      const stopLoss = pendingSignal.stopLoss != null
        ? roundTo(pendingSignal.stopLoss, 8)
        : (side === 'BUY' ? roundTo(entryPrice - atr, 8) : roundTo(entryPrice + atr, 8));
      const takeProfit1 = pendingSignal.takeProfit1;
      const takeProfit = takeProfit1 != null ? null : (side === 'BUY'
        ? roundTo(entryPrice + 10 * atr, 8)
        : roundTo(entryPrice - 10 * atr, 8));

      scalpMomentumCounters.attemptedTrades += 1;

      const riskState = {
        balance: portfolio.balance,
        peakBalance: portfolio.peakBalance,
        initialBalance: portfolio.initialBalance,
        tradesToday: getTradesToday(portfolio, timestamp),
        dailyStartBalance: portfolio.dailyStartBalance,
        openTradesCount: portfolio.openTrades.length,
        lastBuyClosedAt,
        lastSellClosedAt,
        lastBuyWasLoss,
        lastSellWasLoss,
      };
      const riskOverrides = {
        maxTradesPerDay: 8,
        tradeCooldownMs: 10 * 60 * 1000,
        maxConcurrentTrades: 3,
        perDirectionCooldown: true,
        skipAfterLossInSameDirection: true,
        now: timestamp,
        side,
        maxDrawdown: 0.20, // Relaxed for scalp (balance drops when capital in positions)
      };
      const { allowed, reason } = canOpenScalpMomentumTrade(riskState, riskOverrides);

      if (!allowed) {
        if (reason && reason.includes('concurrent')) scalpMomentumCounters.blockedByMaxTrades += 1;
        else if (reason && (reason.includes('cooldown') || reason.includes('loss'))) scalpMomentumCounters.blockedByCooldown += 1;
        else if (reason && reason.includes('trades per day')) scalpMomentumCounters.blockedByMaxTradesPerDay += 1;
        else if (reason && reason.includes('drawdown')) scalpMomentumCounters.blockedByDrawdown = (scalpMomentumCounters.blockedByDrawdown || 0) + 1;
        else scalpMomentumCounters.blockedByRisk += 1;
      } else {
        const riskParams = getTradeRiskParamsCustom(entryPrice, side, stopLoss, takeProfit, portfolio.balance);
        let { positionSize } = riskParams;
        // Cap position to 5% of balance (matches real trading config)
        const maxCapitalPerTrade = 0.05;
        const maxQty = (portfolio.balance * maxCapitalPerTrade) / entryPrice;
        positionSize = Math.min(positionSize, maxQty);

        if (positionSize <= 0) {
          scalpMomentumCounters.blockedBySizeZero += 1;
          if (debug) logger.signal('ScalpMomentum SIZE_ZERO', { entryPrice, stopLoss, balance: portfolio.balance });
        } else {
          const trade = openTrade({
            entryPrice,
            quantity: positionSize,
            side,
            stopLoss,
            takeProfit: null, // No fixed TP; trailing stop only
            takeProfit1: takeProfit1 ?? undefined,
            partialClosePercent: TP1_CLOSE_PERCENT,
            timestamp,
            symbol: sym,
            strategy: 'scalpMomentum',
            atrAtEntry: atr,
            initialStopLoss: stopLoss,
            initialRiskDistance: Math.abs(entryPrice - stopLoss),
            openedAtCandleIndex: i,
          });
          addOpenTrade(portfolio, trade);
          await tradePersistence.persistTradeOpen(trade, 'backtest', sym);
          scalpMomentumCounters.openedTrades += 1;
          if (debug && pendingSignal?.tradeMetrics) {
            const m = pendingSignal.tradeMetrics;
            logger.signal('Trade metrics (scalpMomentum)', {
              side,
              entryPrice,
              slPercent: `${m.slPercent}%`,
              tpPercent: `${m.tpPercent}%`,
              rr: m.rr,
              feeImpact: `${m.feeImpact}%`,
            });
          }
        }
      }
      pendingSignal = null;
      }
    }

    if (debugSummary) {
      debugSummary.conditionTotal += 1;
      debugSummary.signals[signal.signal] = (debugSummary.signals[signal.signal] || 0) + 1;

      const d = signal.debug || {};
      const reason = d.reason || d.signalReason || 'UNKNOWN';
      if (signal.signal === 'HOLD') {
        debugSummary.holdReasons[reason] = (debugSummary.holdReasons[reason] || 0) + 1;
      }

      const trend = signal.trend || d.trend?.trend || 'NONE';
      debugSummary.trendCounts[trend] = (debugSummary.trendCounts[trend] || 0) + 1;

      if (d.alignment?.ok) debugSummary.conditionPass.alignOk += 1;
      if (d.candles?.ok) debugSummary.conditionPass.candlesOk += 1;
      if (d.atrCondition?.ok) debugSummary.conditionPass.atrOk += 1;
      if (d.priceNearEma?.ok) debugSummary.conditionPass.nearOk += 1;
      if (d.rsiCondition?.ok) debugSummary.conditionPass.rsiOk += 1;

      if (signal.signal !== 'HOLD' && debugSummary.samples.length < 25) {
        debugSummary.samples.push({
          timestamp,
          signal: signal.signal,
          price: signal.price,
          trend: signal.trend,
          stopLoss: signal.stopLoss,
          takeProfit: signal.takeProfit,
          atr: signal.atr,
          debug: strategy === 'scalpMomentum' ? d : {
            reason,
            atrCondition: d.atrCondition,
            priceNearEma: d.priceNearEma,
            rsiCondition: d.rsiCondition,
            alignment: d.alignment,
            candles: d.candles,
          },
        });
      }
    }

    if (debug && strategy === 'trendPullback' && signal && signal.debug) {
      // Throttled logging: always log BUY/SELL, and sample HOLD periodically
      const shouldLogHoldSample = (i % 250) === 0; // ~ every ~20h on 5m data
      if (signal.signal !== 'HOLD' || shouldLogHoldSample) {
        logger.signal('TrendPullback debug', {
          signal: signal.signal,
          ts: timestamp,
          price: signal.price,
          trend: signal.trend,
          reason: signal.debug.reason || signal.debug.signalReason || null,
          atrOk: signal.debug.atrCondition?.ok,
          nearOk: signal.debug.priceNearEma?.ok,
          rsiOk: signal.debug.rsiCondition?.ok,
          alignOk: signal.debug.alignment?.ok,
        });
      }
    }

    if (debug && strategy === 'scalpMomentum' && signal && signal.debug) {
      const shouldLogHoldSample = (i % 96) === 0; // sample HOLD every ~8h on 15m
      if (signal.signal !== 'HOLD' || shouldLogHoldSample) {
        const logMsg = signal.debug.logMessage || `ScalpMomentum ${signal.signal} (${signal.debug.signalReason || 'no reason'})`;
        logger.signal(logMsg, {
          signal: signal.signal,
          ts: timestamp,
          price: signal.price,
          atrPercent: signal.debug.atrPercent,
          htfTrend: signal.debug.htfTrend,
          signalReason: signal.debug.signalReason,
        });
      }
    }

    // 3. Apply risk rules and execute new trade (BUY or SELL)
    if (strategy === 'scalpMomentum') {
      // Store signal for execution on NEXT candle open
      if (['BUY', 'SELL'].includes(signal.signal) && signal.stopLoss && signal.atr) {
        pendingSignal = {
          signal: signal.signal,
          price: signal.price,
          stopLoss: signal.stopLoss,
          takeProfit: signal.takeProfit,
          takeProfit1: signal.takeProfit1,
          atr: signal.atr,
          ema20: signal.ema20,
          tradeMetrics: signal.tradeMetrics,
          timestamp,
        };
      }
    } else if (['BUY', 'SELL'].includes(signal.signal) && portfolio.openTrades.length === 0) {
      // trendPullback / default: execute same candle
      const side = signal.signal;
      if (debugSummary) debugSummary.entries.attempted += 1;
      const tradesToday = getTradesToday(portfolio, timestamp);
      const riskState = {
        balance: portfolio.balance,
        peakBalance: portfolio.peakBalance,
        initialBalance: portfolio.initialBalance,
        tradesToday,
        dailyStartBalance: portfolio.dailyStartBalance,
        lastTradeClosedAt,
      };
      const riskOverrides = strategy === 'trendPullback'
        ? { maxTradesPerDay: 2, tradeCooldownMs: 30 * 60 * 1000, now: timestamp }
        : null;
      const { allowed } = canOpenTrade(riskState, riskOverrides);
      if (allowed) {
        const riskParams = (strategy === 'trendPullback' && signal.stopLoss && signal.takeProfit)
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
            symbol: sym,
            strategy: strategy === 'trendPullback' ? 'trendPullback' : 'default',
            atrAtEntry: signal.atr,
            initialStopLoss: stopLoss,
            initialRiskDistance: Math.abs(signal.price - stopLoss),
          });

          addOpenTrade(portfolio, trade);
          await tradePersistence.persistTradeOpen(trade, 'backtest', sym);
          if (debugSummary) debugSummary.entries.opened += 1;
          if (debug && signal.tradeMetrics) {
            const m = signal.tradeMetrics;
            logger.signal('Trade metrics (trendPullback)', {
              side,
              entryPrice: signal.price,
              slPercent: `${m.slPercent}%`,
              tpPercent: `${m.tpPercent}%`,
              rr: m.rr,
              feeImpact: `${m.feeImpact}%`,
            });
          }
        } else if (debugSummary) {
          debugSummary.entries.blockedSize += 1;
        }
      } else if (debugSummary) {
        debugSummary.entries.blockedRisk += 1;
      }
    } else if (debugSummary && ['BUY', 'SELL'].includes(signal.signal) && portfolio.openTrades.length !== 0) {
      debugSummary.entries.blockedOpenTrade += 1;
    }

    // 4. Update equity curve with candle close as mark price
    updateEquityCurve(portfolio, timestamp, close);
  }

  // Close any remaining open trades at last candle close
  const lastCandle = candles[candles.length - 1];
  const lastClose = lastCandle[4];
  const lastTimestamp = lastCandle[0];

  for (const trade of [...portfolio.openTrades]) {
    const closedTrade = closeTrade(trade, lastClose, lastTimestamp);
    const riskDist = trade.initialRiskDistance ?? (trade.initialStopLoss != null ? Math.abs(trade.entryPrice - trade.initialStopLoss) : null);
    if (riskDist && riskDist > 0) {
      const priceMove = trade.side === 'BUY' ? (lastClose - trade.entryPrice) : (trade.entryPrice - lastClose);
      closedTrade.rMultiple = roundTo(priceMove / riskDist, 4);
    }
    closeTradeInPortfolio(portfolio, closedTrade);
    await tradePersistence.persistTradeClose(closedTrade, 'MANUAL', 'backtest');
  }

  updateEquityCurve(portfolio, lastTimestamp, lastClose);

  // Calculate metrics and drawdown curve
  const summary = getSummary(portfolio);
  const closedTrades = portfolio.closedTrades;

  const winningTrades = closedTrades.filter((t) => t.pnl > 0);
  const losingTrades = closedTrades.filter((t) => t.pnl < 0);

  const grossProfit = winningTrades.reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0));

  const winRate = closedTrades.length > 0
    ? roundTo((winningTrades.length / closedTrades.length) * 100, 2)
    : 0;

  const profitFactor = grossLoss > 0 ? roundTo(grossProfit / grossLoss, 4) : grossProfit > 0 ? Infinity : 0;

  // Build drawdown curve from equity curve
  const drawdownCurve = [];
  let peak = portfolio.initialBalance;
  for (const point of portfolio.equityCurve) {
    const equity = point.equity;
    if (equity > peak) peak = equity;
    const drawdown = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    drawdownCurve.push({ timestamp: point.timestamp, drawdown: roundTo(drawdown, 4), equity });
  }

  // Trade list for response (include rMultiple)
  const tradeList = closedTrades.map((t) => ({
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    quantity: t.quantity,
    pnl: t.pnl,
    rMultiple: t.rMultiple,
    status: t.status,
    openedAt: t.openedAt,
    closedAt: t.closedAt,
  }));

  const analytics = computeAnalytics(closedTrades, portfolio.initialBalance);

  const result = {
    finalBalance: summary.balance,
    initialBalance: portfolio.initialBalance,
    totalTrades: closedTrades.length,
    winRate,
    profitFactor,
    avgRMultiple: analytics.avgRMultiple,
    maxDrawdown: summary.maxDrawdown,
    totalPnl: summary.totalPnl,
    totalPnlPercent: summary.totalPnlPercent,
    equityCurve: portfolio.equityCurve,
    drawdownCurve,
    tradeList,
    analytics: {
      avgWin: analytics.avgWin,
      avgLoss: analytics.avgLoss,
      avgWinPercent: analytics.avgWinPercent,
      avgLossPercent: analytics.avgLossPercent,
      avgRMultiple: analytics.avgRMultiple,
      expectancy: analytics.expectancy,
      sharpeRatio: analytics.sharpeRatio,
      maxWinStreak: analytics.maxWinStreak,
      maxLossStreak: analytics.maxLossStreak,
      avgWinStreak: analytics.avgWinStreak,
      avgLossStreak: analytics.avgLossStreak,
      distribution: analytics.distribution,
    },
    meta: {
      strategy: strategy || 'default',
      symbol: sym,
      ltfTimeframe,
      htfTimeframe: mtfCfg ? htfTimeframe : null,
      candles: { ltf: candles.length, htf: mtfCfg ? (htfCandles ? htfCandles.length : 0) : null },
    },
    debugSummary: debugSummary || undefined,
    scalpMomentumCounters: scalpMomentumCounters || undefined,
  };

  if (minTrades && closedTrades.length < minTrades) {
    result.meta.minTradesWarning = `Only ${closedTrades.length} trades generated (target: ${minTrades}). Consider extending date range or adding more symbols.`;
  }

  // Log filter rejection summary for scalpMomentum
  if (strategy === 'scalpMomentum' && scalpMomentumCounters?.filterRejectionCounts) {
    const counts = scalpMomentumCounters.filterRejectionCounts;
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const total = Object.values(counts).reduce((s, n) => s + n, 0);
    logger.info('ScalpMomentum filter rejection summary', {
      totalRejections: total,
      totalSignals: scalpMomentumCounters.totalSignals,
      openedTrades: scalpMomentumCounters.openedTrades,
      byFilter: Object.fromEntries(sorted),
    });
  }

  return result;
}

/**
 * Run backtest across multiple symbols and aggregate results
 */
async function runMultiSymbolBacktest({
  symbols,
  timeframe,
  from,
  to,
  initialBalance = 10000,
  strategy,
  debug,
  minTrades = 100,
}) {
  const results = [];
  let aggregatedTrades = [];
  let balance = initialBalance;

  for (const sym of symbols) {
    const result = await runBacktest({
      symbol: sym,
      timeframe,
      from,
      to,
      initialBalance: balance,
      strategy,
      debug: false,
      minTrades: 0,
    });
    results.push({ symbol: sym, ...result });
    aggregatedTrades = aggregatedTrades.concat(result.tradeList.map((t) => ({ ...t, symbol: sym })));
    balance = result.finalBalance;
  }

  const analytics = computeAnalytics(
    aggregatedTrades.map((t) => ({ ...t, pnl: t.pnl })),
    initialBalance
  );

  const totalPnl = balance - initialBalance;
  const totalPnlPercent = initialBalance > 0 ? (totalPnl / initialBalance) * 100 : 0;

  // Combined equity curve (simplified: use last symbol's curve)
  const lastResult = results[results.length - 1];

  return {
    finalBalance: balance,
    initialBalance,
    totalTrades: aggregatedTrades.length,
    winRate: aggregatedTrades.length > 0
      ? roundTo(((aggregatedTrades.filter((t) => t.pnl > 0).length / aggregatedTrades.length) * 100), 2)
      : 0,
    profitFactor: (() => {
      const grossProfit = aggregatedTrades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
      const grossLoss = Math.abs(aggregatedTrades.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
      return grossLoss > 0 ? roundTo(grossProfit / grossLoss, 4) : grossProfit > 0 ? Infinity : 0;
    })(),
    maxDrawdown: lastResult?.maxDrawdown ?? 0,
    totalPnl: roundTo(totalPnl, 8),
    totalPnlPercent: roundTo(totalPnlPercent, 4),
    equityCurve: lastResult?.equityCurve ?? [],
    drawdownCurve: lastResult?.drawdownCurve ?? [],
    tradeList: aggregatedTrades,
    analytics: {
      avgWin: analytics.avgWin,
      avgLoss: analytics.avgLoss,
      avgWinPercent: analytics.avgWinPercent,
      avgLossPercent: analytics.avgLossPercent,
      avgRMultiple: analytics.avgRMultiple,
      expectancy: analytics.expectancy,
      sharpeRatio: analytics.sharpeRatio,
      maxWinStreak: analytics.maxWinStreak,
      maxLossStreak: analytics.maxLossStreak,
      avgWinStreak: analytics.avgWinStreak,
      avgLossStreak: analytics.avgLossStreak,
      distribution: analytics.distribution,
    },
    meta: {
      strategy: strategy || 'default',
      symbols,
      from,
      to,
      perSymbolResults: results.map((r) => ({
        symbol: r.meta?.symbol,
        totalTrades: r.totalTrades,
        totalPnl: r.totalPnl,
      })),
    },
    minTradesWarning: minTrades && aggregatedTrades.length < minTrades
      ? `Only ${aggregatedTrades.length} trades generated (target: ${minTrades}). Consider extending date range or adding more symbols.`
      : undefined,
  };
}

module.exports = {
  runBacktest,
  runMultiSymbolBacktest,
  fetchBacktestData,
  computeAnalytics,
};
