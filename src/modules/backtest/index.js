/**
 * Backtest Engine
 * Simulates trading on historical data with candle-by-candle execution
 */

const { fetchOHLCV } = require('../exchange');
const { getSignal } = require('../strategy');
const { canOpenTrade, getTradeRiskParams } = require('../risk');
const { getTradeRiskParamsCustom } = require('../risk');
const { applyTrendPullbackTrailingStop } = require('../strategy/trendPullbackStrategy');
const { checkDcaExit, resetDcaState, createDcaState, getAverageEntry, getTotalQuantity, MAX_DRAWDOWN_HARD_STOP, MAX_DRAWDOWN_NO_NEW_ENTRIES } = require('../strategy/dcaStrategy');
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
  timeframe,
  from,
  to,
  initialBalance = 10000,
  ohlcv = null,
  strategy = null,
  debug = false,
}) {
  const fromTs = parseDate(from);
  const toTs = parseDate(to);

  let candles = ohlcv;
  let htfCandles = null;

  // For trendPullback we enforce MTF timeframes; DCA uses 5m
  const ltfTimeframe = (strategy === 'trendPullback' || strategy === 'dca') ? '5m' : timeframe;
  const htfTimeframe = '15m';

  if (!candles || candles.length === 0) {
    candles = await fetchBacktestData(symbol, ltfTimeframe, fromTs, toTs);
  }
  if (strategy === 'trendPullback') {
    htfCandles = await fetchBacktestData(symbol, htfTimeframe, fromTs, toTs);
  }

  if (candles.length === 0) {
    throw new Error('No OHLCV data available for the specified range');
  }

  const warmupPeriod = strategy === 'dca' ? 200 : 50; // DCA needs 200 for EMA200
  const portfolio = createPortfolio(initialBalance);
  // Backtest runs on historical timestamps; initialize daily reset anchor accordingly
  portfolio.lastDayReset = getStartOfDay(candles[0][0]);
  portfolio.dailyStartBalance = portfolio.balance;
  // Align initial equity curve point to first processed candle (no lookahead)
  if (portfolio.equityCurve[0]) {
    portfolio.equityCurve[0].timestamp = candles[warmupPeriod]?.[0] ?? portfolio.equityCurve[0].timestamp;
  }
  let lastTradeClosedAt = 0;
  let htfIdx = 0;
  let dcaState = strategy === 'dca' ? createDcaState() : null;

  // DCA cycle tracking (strategy === 'dca')
  const dcaCycles = [];
  let currentDcaCycle = null; // { startTime, equityAtStart, peakEquity, minEquity, maxDropFromEntry, maxCapitalUsed }

  const debugSummary = debug && strategy === 'trendPullback'
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

    // 1. Check exit conditions for open trades
    const tradesToClose = [];

    // DCA: check aggregate exit (RSI, EMA20, TP, timeout)
    let dcaExitInfo = null;
    if (strategy === 'dca' && dcaState && dcaState.cycleActive && dcaState.entries.length > 0) {
      if (!dcaState.trailingState) dcaState.trailingState = { active: false, highestPrice: 0 };
      const dcaExit = checkDcaExit(dcaState.entries, candle, {
        ohlcv: ohlcvSlice,
        cycleStartTimestamp: dcaState.cycleStartTimestamp,
        trailingState: dcaState.trailingState,
      });
      if (dcaExit) {
        dcaExitInfo = { avgEntry: getAverageEntry(dcaState.entries), totalQty: getTotalQuantity(dcaState.entries), entries: dcaState.entries.length };
        const dcaTrades = portfolio.openTrades.filter((t) => t.strategy === 'dca');
        for (const trade of dcaTrades) {
          tradesToClose.push({ trade, exitPrice: dcaExit.exitPrice, reason: dcaExit.reason });
        }
        resetDcaState(dcaState);
      }
    }

    // Non-DCA or per-trade SL/TP for non-DCA strategies
    if (strategy !== 'dca') {
      for (const trade of portfolio.openTrades) {
        const exitCheck = checkExitConditions(trade, candle);
        if (exitCheck) {
          tradesToClose.push({ trade, exitPrice: exitCheck.exitPrice, reason: exitCheck.reason });
        }
      }
    }

    let closedDcaPnl = 0;
    for (const { trade, exitPrice, reason } of tradesToClose) {
      const closedTrade = closeTrade(trade, exitPrice, timestamp);
      closedDcaPnl += closedTrade.pnl || 0;
      closeTradeInPortfolio(portfolio, closedTrade);
      lastTradeClosedAt = timestamp;
    }
    if (strategy === 'dca' && tradesToClose.length > 0 && dcaExitInfo) {
      const { avgEntry, totalQty, entries } = dcaExitInfo;
      const exitPrice = tradesToClose[0]?.exitPrice;
      const profitPercent = avgEntry && exitPrice ? ((exitPrice - avgEntry) / avgEntry) * 100 : 0;
      // Record completed DCA cycle
      if (currentDcaCycle) {
        const cycleDrawdown = currentDcaCycle.peakEquity > 0 && currentDcaCycle.minEquity != null
          ? ((currentDcaCycle.peakEquity - currentDcaCycle.minEquity) / currentDcaCycle.peakEquity) * 100
          : 0;
        dcaCycles.push({
          startTime: currentDcaCycle.startTime,
          endTime: timestamp,
          entries,
          pnl: closedDcaPnl,
          returnPercent: currentDcaCycle.equityAtStart > 0
            ? (closedDcaPnl / currentDcaCycle.equityAtStart) * 100
            : 0,
          maxDrawdownPercent: cycleDrawdown,
          maxDropFromEntryPercent: currentDcaCycle.maxDropFromEntry * 100,
          maxCapitalUsed: currentDcaCycle.maxCapitalUsed,
          win: closedDcaPnl > 0,
        });
        currentDcaCycle = null;
      }
      if (debug) {
        const exitReason = tradesToClose[0]?.reason || 'UNKNOWN';
        logger.trade('DCA cycle exit', {
          reason: exitReason,
          avgEntry: roundTo(avgEntry, 8),
          exitPrice,
          totalQuantity: totalQty,
          entries,
          profitPercent: roundTo(profitPercent, 4),
          totalPnl: roundTo(closedDcaPnl, 8),
        });
      }
    }

    // 2. Generate signal
    let htfSlice = null;
    if (strategy === 'trendPullback') {
      // Align HTF to current LTF timestamp: include only candles with ts <= current LTF candle ts
      while (htfCandles && htfIdx < htfCandles.length - 1 && htfCandles[htfIdx + 1][0] <= timestamp) {
        htfIdx += 1;
      }
      htfSlice = htfCandles ? htfCandles.slice(0, htfIdx + 1) : [];
    }

    // Compute drawdown for DCA risk control (block new entries if > 10%)
    let drawdownExceeded = false;
    if (strategy === 'dca') {
      const equity = portfolio.equityCurve[portfolio.equityCurve.length - 1]?.equity ?? portfolio.balance;
      const peakEquity = Math.max(...portfolio.equityCurve.map((p) => p.equity));
      const drawdown = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;
      drawdownExceeded = drawdown >= MAX_DRAWDOWN_NO_NEW_ENTRIES;
    }

    const signal = getSignal(ohlcvSlice, {
      strategy: strategy === 'trendPullback' ? 'trendPullback' : strategy === 'dca' ? 'dca' : undefined,
      htfOhlcv: htfSlice,
      dcaState: strategy === 'dca' ? dcaState : undefined,
      portfolioBalance: strategy === 'dca' ? portfolio.balance : undefined,
      drawdownExceeded: strategy === 'dca' ? drawdownExceeded : undefined,
    });

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
          debug: {
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

    // 3. DCA strategy: add DCA levels (max 4 entries per cycle)
    if (strategy === 'dca' && ['DCA_BUY_1', 'DCA_BUY_2', 'DCA_BUY_3', 'DCA_BUY_4'].includes(signal.signal)) {
      const dcaTrades = portfolio.openTrades.filter((t) => t.strategy === 'dca');
      if (dcaTrades.length < 4 && signal.quantity > 0) {
        // Initialize cycle tracking on first entry
        if (!currentDcaCycle) {
          const equityAtStart = portfolio.equityCurve[portfolio.equityCurve.length - 1]?.equity ?? portfolio.balance;
          currentDcaCycle = {
            startTime: timestamp,
            equityAtStart,
            peakEquity: equityAtStart,
            minEquity: equityAtStart,
            maxDropFromEntry: 0,
            maxCapitalUsed: 0,
          };
        }
        const trade = openTrade({
          entryPrice: signal.price,
          quantity: signal.quantity,
          side: 'BUY',
          stopLoss: null,
          takeProfit: null,
          timestamp,
          symbol,
          strategy: 'dca',
          dcaLevel: signal.level,
        });
        addOpenTrade(portfolio, trade);
        if (debug) {
          const avgEntry = dcaState && dcaState.entries.length > 0
            ? dcaState.entries.reduce((s, e) => s + e.price * e.quantity, 0) / dcaState.entries.reduce((s, e) => s + e.quantity, 0)
            : signal.price;
          logger.signal('Smart DCA entry', {
            level: signal.level,
            price: signal.price,
            quantity: signal.quantity,
            entryReason: signal.debug?.entryReason || signal.debug?.reason,
            avgEntry: roundTo(avgEntry, 8),
          });
        }
      }
    }
    // 3b. Apply risk rules and execute new trade for non-DCA strategies (BUY or SELL)
    else if (['BUY', 'SELL'].includes(signal.signal) && portfolio.openTrades.length === 0) {
      const side = signal.signal;
      if (debugSummary) debugSummary.entries.attempted += 1;
      const tradesToday = getTradesToday(portfolio, timestamp);
      const riskState = {
        balance: portfolio.balance,
        peakBalance: portfolio.peakBalance,
        initialBalance: portfolio.initialBalance,
        tradesToday,
        dailyStartBalance: portfolio.dailyStartBalance,
      };

      const riskStateWithCooldown = {
        ...riskState,
        lastTradeClosedAt,
      };
      const riskOverrides = strategy === 'trendPullback'
        ? { maxTradesPerDay: 2, tradeCooldownMs: 30 * 60 * 1000, now: timestamp }
        : null;
      const { allowed } = canOpenTrade(riskStateWithCooldown, riskOverrides);
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
            symbol,
            strategy: strategy === 'trendPullback' ? 'trendPullback' : 'default',
            atrAtEntry: signal.atr,
            initialStopLoss: stopLoss,
            initialRiskDistance: Math.abs(signal.price - stopLoss),
          });

          addOpenTrade(portfolio, trade);
          if (debugSummary) debugSummary.entries.opened += 1;
        } else if (debugSummary) {
          debugSummary.entries.blockedSize += 1;
        }
      } else if (debugSummary) {
        debugSummary.entries.blockedRisk += 1;
      }
    } else if (debugSummary && ['BUY', 'SELL'].includes(signal.signal) && portfolio.openTrades.length !== 0) {
      debugSummary.entries.blockedOpenTrade += 1;
    }

    // 4. Update equity curve with candle close as mark price (includes unrealized PnL)
    updateEquityCurve(portfolio, timestamp, close);

    // 4a. DCA hard stop: exit all if drawdown > 20%
    if (strategy === 'dca' && MAX_DRAWDOWN_HARD_STOP) {
      const equity = portfolio.equityCurve[portfolio.equityCurve.length - 1]?.equity ?? portfolio.balance;
      const peakEquity = Math.max(...portfolio.equityCurve.map((p) => p.equity));
      const drawdown = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;
      if (drawdown >= MAX_DRAWDOWN_HARD_STOP && portfolio.openTrades.length > 0) {
        const dcaTrades = portfolio.openTrades.filter((t) => t.strategy === 'dca');
        for (const trade of dcaTrades) {
          const closedTrade = closeTrade(trade, close, timestamp);
          closeTradeInPortfolio(portfolio, closedTrade);
        }
        resetDcaState(dcaState);
        currentDcaCycle = null;
        logger.warn('DCA backtest: 20% drawdown hard stop triggered - closed all positions');
        break;
      }
    }

    // 4b. DCA cycle tracking: update current cycle metrics each candle
    if (strategy === 'dca' && currentDcaCycle && dcaState?.entries?.length > 0) {
      const equity = portfolio.equityCurve[portfolio.equityCurve.length - 1]?.equity ?? portfolio.balance;
      currentDcaCycle.peakEquity = Math.max(currentDcaCycle.peakEquity, equity);
      currentDcaCycle.minEquity = Math.min(currentDcaCycle.minEquity ?? equity, equity);
      const avgEntry = getAverageEntry(dcaState.entries);
      if (avgEntry && avgEntry > 0) {
        const dropFromEntry = (avgEntry - low) / avgEntry; // use low for worst-case in candle
        currentDcaCycle.maxDropFromEntry = Math.max(currentDcaCycle.maxDropFromEntry, dropFromEntry);
      }
      const dcaTrades = portfolio.openTrades.filter((t) => t.strategy === 'dca');
      const capitalUsed = dcaTrades.reduce((s, t) => s + (t.entryPrice * t.quantity + (t.entryFee || 0)), 0);
      currentDcaCycle.maxCapitalUsed = Math.max(currentDcaCycle.maxCapitalUsed, capitalUsed);
    }
  }

  // Close any remaining open trades at last candle close
  const lastCandle = candles[candles.length - 1];
  const lastClose = lastCandle[4];
  const lastTimestamp = lastCandle[0];

  const remainingDcaTrades = strategy === 'dca' ? portfolio.openTrades.filter((t) => t.strategy === 'dca') : [];
  let forcedClosePnl = 0;
  for (const trade of [...portfolio.openTrades]) {
    const closedTrade = closeTrade(trade, lastClose, lastTimestamp);
    if (trade.strategy === 'dca') forcedClosePnl += closedTrade.pnl || 0;
    closeTradeInPortfolio(portfolio, closedTrade);
  }

  // Record DCA cycle if we forced-closed at end
  if (strategy === 'dca' && currentDcaCycle && remainingDcaTrades.length > 0) {
    const cycleDrawdown = currentDcaCycle.peakEquity > 0 && currentDcaCycle.minEquity != null
      ? ((currentDcaCycle.peakEquity - currentDcaCycle.minEquity) / currentDcaCycle.peakEquity) * 100
      : 0;
    dcaCycles.push({
      startTime: currentDcaCycle.startTime,
      endTime: lastTimestamp,
      entries: remainingDcaTrades.length,
      pnl: forcedClosePnl,
      returnPercent: currentDcaCycle.equityAtStart > 0
        ? (forcedClosePnl / currentDcaCycle.equityAtStart) * 100
        : 0,
      maxDrawdownPercent: cycleDrawdown,
      maxDropFromEntryPercent: currentDcaCycle.maxDropFromEntry * 100,
      maxCapitalUsed: currentDcaCycle.maxCapitalUsed,
      win: forcedClosePnl > 0,
    });
  }

  updateEquityCurve(portfolio, lastTimestamp, lastClose);

  // Calculate metrics and drawdown curve
  const summary = getSummary(portfolio);
  const closedTrades = portfolio.closedTrades;

  // Save all trades to DB in one batch (when MongoDB available)
  if (closedTrades.length > 0) {
    await tradePersistence.persistTradesBulk(closedTrades, 'backtest', symbol);
  }

  const winningTrades = closedTrades.filter((t) => t.pnl > 0);
  const losingTrades = closedTrades.filter((t) => t.pnl < 0);

  const grossProfit = winningTrades.reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0));

  const winRate = closedTrades.length > 0
    ? roundTo((winningTrades.length / closedTrades.length) * 100, 2)
    : 0;

  const profitFactor = grossLoss > 0 ? roundTo(grossProfit / grossLoss, 4) : grossProfit > 0 ? Infinity : 0;

  // Build drawdown curve from equity (includes unrealized PnL)
  const drawdownCurve = [];
  let peakEquity = portfolio.initialBalance;
  let maxEquityDrawdown = 0;
  for (const point of portfolio.equityCurve) {
    const equity = point.equity;
    if (equity > peakEquity) peakEquity = equity;
    const drawdown = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;
    maxEquityDrawdown = Math.max(maxEquityDrawdown, drawdown);
    drawdownCurve.push({ timestamp: point.timestamp, drawdown: roundTo(drawdown, 4), equity });
  }

  // DCA-specific metrics
  const totalCycles = dcaCycles.length;
  const winCycles = dcaCycles.filter((c) => c.win).length;
  const lossCycles = totalCycles - winCycles;
  const avgCycleReturn = totalCycles > 0
    ? roundTo(dcaCycles.reduce((s, c) => s + c.returnPercent, 0) / totalCycles, 4)
    : 0;
  const maxCycleDrawdown = totalCycles > 0
    ? roundTo(Math.max(0, ...dcaCycles.map((c) => c.maxDrawdownPercent || 0)), 4)
    : 0;

  // Max drawdown from equity curve (includes unrealized PnL)
  const maxDrawdown = roundTo(maxEquityDrawdown, 4);

  // Validation: warn if maxDrawdown is 0 (may indicate no trades or insufficient data)
  if (maxDrawdown === 0 && (closedTrades.length > 0 || totalCycles > 0)) {
    logger.warn('Backtest: maxDrawdown is 0 - verify equity curve and metrics are correct');
  }

  // Trade list for response
  const tradeList = closedTrades.map((t) => ({
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    quantity: t.quantity,
    pnl: t.pnl,
    status: t.status,
    openedAt: t.openedAt,
    closedAt: t.closedAt,
    ...(t.dcaLevel && { dcaLevel: t.dcaLevel }),
  }));

  const result = {
    finalBalance: summary.balance,
    initialBalance: portfolio.initialBalance,
    totalTrades: closedTrades.length,
    winRate,
    profitFactor,
    maxDrawdown,
    totalPnl: summary.totalPnl,
    totalPnlPercent: summary.totalPnlPercent,
    equityCurve: portfolio.equityCurve,
    drawdownCurve,
    tradeList,
    meta: {
      strategy: strategy || 'default',
      ltfTimeframe,
      htfTimeframe: strategy === 'trendPullback' ? htfTimeframe : null,
      candles: {
        ltf: candles.length,
        htf: strategy === 'trendPullback' ? (htfCandles ? htfCandles.length : 0) : null,
      },
    },
    debugSummary: debugSummary || undefined,
  };

  // DCA-specific output
  if (strategy === 'dca') {
    result.totalCycles = totalCycles;
    result.winCycles = winCycles;
    result.lossCycles = lossCycles;
    result.avgCycleReturn = avgCycleReturn;
    result.maxCycleDrawdown = maxCycleDrawdown;
    result.maxEquityDrawdown = maxDrawdown;
    result.cycles = dcaCycles.map((c) => ({
      startTime: c.startTime,
      endTime: c.endTime,
      entries: c.entries,
      pnl: roundTo(c.pnl, 8),
      returnPercent: roundTo(c.returnPercent, 4),
      maxDrawdownPercent: roundTo(c.maxDrawdownPercent, 4),
      maxDropFromEntryPercent: roundTo(c.maxDropFromEntryPercent, 4),
      maxCapitalUsed: roundTo(c.maxCapitalUsed, 8),
      win: c.win,
    }));
  }

  return result;
}

/**
 * Run backtest across multiple symbols (capital split equally)
 * @param {Object} params - Same as runBacktest plus symbols array
 * @param {Array<string>} params.symbols - e.g. ['BTC/USDT', 'ETH/USDT']
 * @returns {Promise<Object>} Aggregated results
 */
async function runBacktestMultiSymbol({
  symbols,
  timeframe,
  from,
  to,
  initialBalance = 10000,
  strategy = null,
  debug = false,
}) {
  if (!symbols || symbols.length === 0) {
    throw new Error('symbols array is required');
  }
  const balancePerSymbol = initialBalance / symbols.length;
  const results = await Promise.all(
    symbols.map((symbol) =>
      runBacktest({
        symbol,
        timeframe,
        from,
        to,
        initialBalance: balancePerSymbol,
        strategy,
        debug: false,
      })
    )
  );

  const aggregated = {
    finalBalance: results.reduce((s, r) => s + r.finalBalance, 0),
    initialBalance,
    totalTrades: results.reduce((s, r) => s + r.totalTrades, 0),
    totalPnl: results.reduce((s, r) => s + r.totalPnl, 0),
    totalPnlPercent: initialBalance > 0
      ? roundTo((results.reduce((s, r) => s + r.totalPnl, 0) / initialBalance) * 100, 4)
      : 0,
    maxDrawdown: results.length > 0 ? Math.max(...results.map((r) => r.maxDrawdown || 0)) : 0,
    symbols: symbols.map((sym, i) => ({
      symbol: sym,
      finalBalance: results[i].finalBalance,
      totalTrades: results[i].totalTrades,
      totalPnl: results[i].totalPnl,
    })),
    meta: { strategy: strategy || 'default', symbols },
  };

  const totalClosed = results.reduce((s, r) => s + r.totalTrades, 0);
  const winningTrades = results.reduce((s, r) => s + (r.tradeList || []).filter((t) => t.pnl > 0).length, 0);
  aggregated.winRate = totalClosed > 0 ? roundTo((winningTrades / totalClosed) * 100, 2) : 0;

  if (strategy === 'dca') {
    aggregated.totalCycles = results.reduce((s, r) => s + (r.totalCycles || 0), 0);
    aggregated.winCycles = results.reduce((s, r) => s + (r.winCycles || 0), 0);
    aggregated.lossCycles = results.reduce((s, r) => s + (r.lossCycles || 0), 0);
  }

  return aggregated;
}

module.exports = {
  runBacktest,
  runBacktestMultiSymbol,
  fetchBacktestData,
};
