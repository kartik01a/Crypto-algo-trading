/**
 * Backtest Engine
 * Simulates trading on historical data with candle-by-candle execution
 */

const { fetchOHLCV } = require('../exchange');
const { getSignal } = require('../strategy');
const { canOpenTrade, getTradeRiskParams } = require('../risk');
const { getTradeRiskParamsCustom } = require('../risk');
const { applyTrendPullbackTrailingStop } = require('../strategy/trendPullbackStrategy');
const {
  applyTrendBreakoutTrailingStop,
  TIME_EXIT_CANDLES,
  COOLDOWN_CANDLES,
} = require('../strategy/trendBreakoutStrategy');
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
 * @param {number} [maxCandles] - Max candles to fetch (safety cap, fetches most recent)
 * @returns {Promise<Array>} OHLCV data
 */
async function fetchBacktestData(symbol, timeframe, from, to, maxCandles = null) {
  const allCandles = [];
  let since = from;
  let fetchCount = 0;

  while (since < to) {
    if (maxCandles && allCandles.length >= maxCandles) break;

    const limit = maxCandles ? Math.min(1000, maxCandles - allCandles.length) : 1000;
    const candles = await fetchOHLCV(symbol, timeframe, since, limit);
    if (candles.length === 0) break;

    for (const c of candles) {
      if (c[0] >= from && c[0] <= to) {
        allCandles.push(c);
        if (maxCandles && allCandles.length >= maxCandles) break;
      }
    }

    since = candles[candles.length - 1][0] + 1;
    fetchCount += 1;
    if (fetchCount % 10 === 0) {
      logger.info(`[Backtest] Fetching data... ${allCandles.length} candles so far`);
    }
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
  limit = null, // Max candles to fetch (quick test); e.g. 10000
}) {
  const fromTs = parseDate(from);
  const toTs = parseDate(to);

  let candles = ohlcv;
  let htfCandles = null;

  // For trendPullback/trendBreakout we use 5m for sufficient data
  const ltfTimeframe = (strategy === 'trendPullback' || strategy === 'trendBreakout') ? '5m' : timeframe;
  const htfTimeframe = '15m';

  if (!candles || candles.length === 0) {
    logger.info('[Backtest] Fetching OHLCV data...');
    candles = await fetchBacktestData(symbol, ltfTimeframe, fromTs, toTs, limit);
    logger.info(`[Backtest] Fetched ${candles.length} candles`);
  }
  if (strategy === 'trendPullback') {
    htfCandles = await fetchBacktestData(symbol, htfTimeframe, fromTs, toTs, limit ? Math.ceil(limit / 3) : null);
  }

  if (candles.length === 0) {
    throw new Error('No OHLCV data available for the specified range');
  }

  const portfolio = createPortfolio(initialBalance);
  // Backtest runs on historical timestamps; initialize daily reset anchor accordingly
  portfolio.lastDayReset = getStartOfDay(candles[0][0]);
  portfolio.dailyStartBalance = portfolio.balance;
  const warmupPeriod = strategy === 'trendBreakout' ? 220 : 50; // trendBreakout needs EMA200 + ADX + lookback
  let lastTradeClosedAt = 0;
  let candlesSinceLastLoss = Infinity; // Cooldown: wait 10 candles after losing trade
  let htfIdx = 0;
  const tradesToPersist = []; // Collect for batch DB write at end

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

    if (strategy === 'trendBreakout' && portfolio.openTrades.length > 0 && i >= 1) {
      const prevCandle = candles[i - 1];
      const prevHigh = prevCandle[2];
      const prevSlice = candles.slice(0, i);
      const prevSignal = getSignal(prevSlice, { strategy: 'trendBreakout' });
      const markPrice = prevSignal.price;
      const atrNow = prevSignal.atr;

      portfolio.openTrades = portfolio.openTrades.map((t) => {
        if (t.strategy !== 'trendBreakout') return t;
        const updated = applyTrendBreakoutTrailingStop(t, markPrice, prevHigh, atrNow);
        updated.candleCount = (t.candleCount || 0) + 1;
        return updated;
      });
    }

    // 1. Check exit conditions for open trades (SL/TP, time exit)
    const tradesToClose = [];
    for (const trade of portfolio.openTrades) {
      // Time exit: close if duration > 50 candles and profit < 1R (trendBreakout only)
      if (strategy === 'trendBreakout' && trade.strategy === 'trendBreakout') {
        const candleCount = trade.candleCount ?? 0;
        const riskDist = trade.initialRiskDistance || Math.abs(trade.entryPrice - trade.stopLoss);
        const profit = (close - trade.entryPrice) * (trade.side === 'BUY' ? 1 : -1);
        const rMultiple = riskDist > 0 ? profit / riskDist : 0;
        if (candleCount > TIME_EXIT_CANDLES && rMultiple < 1) {
          tradesToClose.push({ trade, exitPrice: close, reason: 'TIME_EXIT' });
          continue;
        }
      }

      const exitCheck = checkExitConditions(trade, candle);
      if (exitCheck) {
        tradesToClose.push({ trade, exitPrice: exitCheck.exitPrice, reason: exitCheck.reason });
      }
    }

    for (const { trade, exitPrice, reason } of tradesToClose) {
      const closedTrade = closeTrade(trade, exitPrice, timestamp);
      // MFE (max favorable excursion) in R multiples
      const riskDist = trade.initialRiskDistance || Math.abs(trade.entryPrice - trade.stopLoss);
      const highestPrice = Math.max(trade.highestPrice || trade.entryPrice, high);
      closedTrade.mfe = riskDist > 0
        ? roundTo(((highestPrice - trade.entryPrice) * (trade.side === 'BUY' ? 1 : -1)) / riskDist, 4)
        : null;
      closeTradeInPortfolio(portfolio, closedTrade);
      lastTradeClosedAt = timestamp;
      if (closedTrade.pnl < 0 && strategy === 'trendBreakout') {
        candlesSinceLastLoss = 0;
      }
      tradesToPersist.push({ trade: closedTrade, reason });
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

    const signal = getSignal(ohlcvSlice, {
      strategy: strategy === 'trendPullback' ? 'trendPullback' : strategy === 'trendBreakout' ? 'trendBreakout' : undefined,
      htfOhlcv: htfSlice,
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

    // Cooldown: increment candles since last loss
    if (strategy === 'trendBreakout') {
      candlesSinceLastLoss = Math.min(candlesSinceLastLoss + 1, Infinity);
    }

    // 3. Apply risk rules and execute new trade (BUY or SELL)
    const cooldownOk = strategy !== 'trendBreakout' || candlesSinceLastLoss >= COOLDOWN_CANDLES;
    if (['BUY', 'SELL'].includes(signal.signal) && portfolio.openTrades.length === 0 && cooldownOk) {
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
        : strategy === 'trendBreakout'
          ? { maxTradesPerDay: 5, tradeCooldownMs: 60 * 60 * 1000, now: timestamp }
          : null;
      const { allowed } = canOpenTrade(riskStateWithCooldown, riskOverrides);
      if (allowed) {
        const useCustomRisk = (strategy === 'trendPullback' && signal.stopLoss && signal.takeProfit)
          || (strategy === 'trendBreakout' && signal.stopLoss);
        const trendBreakoutRiskPct = 0.0175; // 1.75% risk (1.5-2% range)
        const riskParams = useCustomRisk
          ? getTradeRiskParamsCustom(
              signal.price,
              side,
              signal.stopLoss,
              signal.takeProfit ?? Infinity,
              portfolio.balance,
              strategy === 'trendBreakout' ? trendBreakoutRiskPct : null
            )
          : getTradeRiskParams(signal.price, side, portfolio.balance);

        const { stopLoss, takeProfit, positionSize } = riskParams;
        const effectiveTakeProfit = strategy === 'trendBreakout' ? null : takeProfit;

        if (positionSize > 0) {
          const trade = openTrade({
            entryPrice: signal.price,
            quantity: positionSize,
            side,
            stopLoss,
            takeProfit: effectiveTakeProfit,
            timestamp,
            symbol,
            strategy: strategy === 'trendPullback' ? 'trendPullback' : strategy === 'trendBreakout' ? 'trendBreakout' : 'default',
            atrAtEntry: signal.atr,
            initialStopLoss: stopLoss,
            initialRiskDistance: Math.abs(signal.price - stopLoss),
            breakoutStrength: signal.breakoutStrength ?? null,
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

    // 4. Update equity curve with candle close as mark price
    updateEquityCurve(portfolio, timestamp, close);
  }

  // Close any remaining open trades at last candle close
  const lastCandle = candles[candles.length - 1];
  const lastClose = lastCandle[4];
  const lastTimestamp = lastCandle[0];

  for (const trade of [...portfolio.openTrades]) {
    const closedTrade = closeTrade(trade, lastClose, lastTimestamp);
    const riskDist = trade.initialRiskDistance || Math.abs(trade.entryPrice - trade.stopLoss);
    const highestPrice = Math.max(trade.highestPrice || trade.entryPrice, lastCandle[2]);
    closedTrade.mfe = riskDist > 0
      ? roundTo(((highestPrice - trade.entryPrice) * (trade.side === 'BUY' ? 1 : -1)) / riskDist, 4)
      : null;
    closeTradeInPortfolio(portfolio, closedTrade);
    tradesToPersist.push({ trade: closedTrade, reason: 'MANUAL' });
  }

  updateEquityCurve(portfolio, lastTimestamp, lastClose);

  // Batch persist all trades at end
  await tradePersistence.persistBacktestTradesBulk(tradesToPersist, symbol);

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

  // R-multiple, avgWin, avgLoss, expectancy (for strategy evaluation)
  const tradesWithR = closedTrades.filter((t) => t.initialRiskDistance && t.initialRiskDistance > 0);
  const rMultiples = tradesWithR.map((t) => t.pnl / (t.initialRiskDistance * t.quantity));
  const avgRMultiple = rMultiples.length > 0
    ? roundTo(rMultiples.reduce((a, b) => a + b, 0) / rMultiples.length, 4)
    : null;
  const avgWin = winningTrades.length > 0 ? roundTo(grossProfit / winningTrades.length, 8) : 0;
  const avgLoss = losingTrades.length > 0 ? roundTo(grossLoss / losingTrades.length, 8) : 0;
  const expectancy = closedTrades.length > 0
    ? roundTo((winningTrades.length / closedTrades.length) * avgWin - (losingTrades.length / closedTrades.length) * avgLoss, 8)
    : 0;

  // Build drawdown curve from equity curve
  const drawdownCurve = [];
  let peak = portfolio.initialBalance;
  for (const point of portfolio.equityCurve) {
    const equity = point.equity;
    if (equity > peak) peak = equity;
    const drawdown = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    drawdownCurve.push({ timestamp: point.timestamp, drawdown: roundTo(drawdown, 4), equity });
  }

  // Trade list for response (with R-multiple, MFE when available)
  const tradeList = closedTrades.map((t) => {
    const riskAmount = t.initialRiskDistance && t.initialRiskDistance > 0
      ? t.initialRiskDistance * t.quantity
      : null;
    const rMultiple = riskAmount ? roundTo(t.pnl / riskAmount, 4) : null;
    return {
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      quantity: t.quantity,
      pnl: t.pnl,
      rMultiple,
      mfe: t.mfe ?? null,
      breakoutStrength: t.breakoutStrength ?? null,
      status: t.status,
      openedAt: t.openedAt,
      closedAt: t.closedAt,
    };
  });

  // Avg MFE for strategy evaluation
  const tradesWithMfe = closedTrades.filter((t) => t.mfe != null);
  const avgMfe = tradesWithMfe.length > 0
    ? roundTo(tradesWithMfe.reduce((a, t) => a + t.mfe, 0) / tradesWithMfe.length, 4)
    : null;

  return {
    finalBalance: summary.balance,
    initialBalance: portfolio.initialBalance,
    totalTrades: closedTrades.length,
    winRate,
    profitFactor,
    maxDrawdown: summary.maxDrawdown,
    totalPnl: summary.totalPnl,
    totalPnlPercent: summary.totalPnlPercent,
    avgWin,
    avgLoss,
    expectancy,
    avgRMultiple,
    avgMfe,
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
}

module.exports = {
  runBacktest,
  fetchBacktestData,
};
