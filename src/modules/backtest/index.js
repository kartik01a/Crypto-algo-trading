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
  shouldExitTrade,
  updateTrailingStop,
  logTradeMetrics,
  COOLDOWN_CANDLES,
} = require('../strategy/swingTrendStrategy');
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
 * @param {string} params.symbol - Trading pair (e.g., 'BTC/USDT') - used when symbols not provided
 * @param {Array<string>} [params.symbols] - Multiple symbols for swingTrend multi-symbol (rank by score, top 2)
 * @param {string} params.timeframe - Candle timeframe (e.g., '5m')
 * @param {string} params.from - Start date (YYYY-MM-DD)
 * @param {string} params.to - End date (YYYY-MM-DD)
 * @param {number} [params.initialBalance] - Starting balance
 * @param {Array} [params.ohlcv] - Pre-fetched OHLCV data (optional, single symbol only)
 * @returns {Promise<Object>} Backtest results
 */
async function runBacktest({
  symbol,
  symbols: symbolsParam = null,
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

  // Multi-symbol: use symbols array; single-symbol: use symbol
  const symbols = symbolsParam && symbolsParam.length > 0 ? symbolsParam : [symbol || 'BTC/USDT'];
  const isMultiSymbol = strategy === 'swingTrend' && symbols.length > 1;

  let candles = ohlcv;
  let htfCandles = null;
  let candlesBySymbol = null;
  let htfCandlesBySymbol = null;

  // For trendPullback we enforce 5m+15m; for swingTrend we enforce 4h+1d
  const ltfTimeframe = strategy === 'swingTrend' ? '4h' : strategy === 'trendPullback' ? '5m' : timeframe;
  const htfTimeframe = strategy === 'swingTrend' ? '1d' : '15m';

  if (isMultiSymbol) {
    // Fetch LTF and HTF for each symbol
    candlesBySymbol = {};
    htfCandlesBySymbol = {};
    let htfFrom = fromTs;
    if (htfTimeframe === '1d') {
      const WARMUP_DAYS_MS = 250 * 24 * 60 * 60 * 1000;
      htfFrom = Math.max(0, fromTs - WARMUP_DAYS_MS);
    }
    for (const sym of symbols) {
      candlesBySymbol[sym] = await fetchBacktestData(sym, ltfTimeframe, fromTs, toTs);
      htfCandlesBySymbol[sym] = await fetchBacktestData(sym, htfTimeframe, htfFrom, toTs);
    }
    // Use first symbol's candles for compatibility; main loop will use candlesBySymbol
    candles = candlesBySymbol[symbols[0]];
  } else {
    if (!candles || candles.length === 0) {
      candles = await fetchBacktestData(symbols[0], ltfTimeframe, fromTs, toTs);
    }
    if (strategy === 'trendPullback' || strategy === 'swingTrend') {
      let htfFrom = fromTs;
      if (strategy === 'swingTrend' && htfTimeframe === '1d') {
        const WARMUP_DAYS_MS = 250 * 24 * 60 * 60 * 1000;
        htfFrom = Math.max(0, fromTs - WARMUP_DAYS_MS);
      }
      htfCandles = await fetchBacktestData(symbols[0], htfTimeframe, htfFrom, toTs);
    }
  }

  if (!candles || candles.length === 0) {
    throw new Error('No OHLCV data available for the specified range');
  }

  const portfolio = createPortfolio(initialBalance);
  // Backtest runs on historical timestamps; initialize daily reset anchor accordingly
  portfolio.lastDayReset = getStartOfDay(candles[0][0]);
  portfolio.dailyStartBalance = portfolio.balance;
  const warmupPeriod = strategy === 'swingTrend' ? 220 : 50; // swingTrend needs EMA200
  let lastTradeClosedAt = 0;
  let candlesSinceLastLoss = Infinity; // Cooldown for swingTrend
  let htfIdx = 0;
  const htfIdxBySymbol = isMultiSymbol ? {} : null;
  if (isMultiSymbol) {
    for (const sym of symbols) htfIdxBySymbol[sym] = 0;
  }
  // Multi-symbol: use min length so all symbols have data at each index
  const loopLength = isMultiSymbol
    ? Math.min(...symbols.map((s) => candlesBySymbol[s].length))
    : candles.length;

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

  for (let i = warmupPeriod; i < loopLength; i++) {
    // Multi-symbol: resolve candle/slices per symbol; single-symbol: use candles
    const candle = isMultiSymbol ? candlesBySymbol[symbols[0]][i] : candles[i];
    const [timestamp, open, high, low, close] = candle;

    // Use only data up to current candle (no lookahead)
    const ohlcvSlice = isMultiSymbol ? candlesBySymbol[symbols[0]].slice(0, i + 1) : candles.slice(0, i + 1);

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

    if (strategy === 'swingTrend' && portfolio.openTrades.length > 0 && i >= 1) {
      portfolio.openTrades = portfolio.openTrades.map((t) => {
        if (t.strategy !== 'swingTrend') return t;
        const sym = t.symbol || symbols[0];
        const symCandles = isMultiSymbol ? candlesBySymbol[sym] : candles;
        const prevCandle = symCandles[i - 1];
        const prevHigh = prevCandle[2];
        const prevLow = prevCandle[3];
        const prevSlice = symCandles.slice(0, i);
        const symHtf = isMultiSymbol ? htfCandlesBySymbol[sym] : htfCandles;
        let prevHtfSlice = null;
        if (symHtf) {
          let idx = isMultiSymbol ? htfIdxBySymbol[sym] : htfIdx;
          while (idx < symHtf.length - 1 && symHtf[idx + 1][0] <= prevCandle[0]) idx += 1;
          prevHtfSlice = symHtf.slice(0, idx + 1);
        }
        const prevSignal = getSignal(prevSlice, {
          strategy: 'swingTrend',
          htfOhlcv: prevHtfSlice,
          openTrades: portfolio.openTrades,
        });
        const markPrice = prevSignal.price;
        const atrNow = prevSignal.atr;
        const updated = updateTrailingStop(t, markPrice, atrNow, prevHigh, prevLow);
        updated.candleCount = (t.candleCount || 0) + 1;
        return updated;
      });
    }

    // 1. Check exit conditions for open trades (SL/TP)
    const tradesToClose = [];
    for (const trade of portfolio.openTrades) {
      const tradeCandle = isMultiSymbol && trade.symbol ? candlesBySymbol[trade.symbol][i] : candle;
      if (strategy === 'swingTrend' && trade.strategy === 'swingTrend') {
        const sym = trade.symbol || symbols[0];
        const symCandles = isMultiSymbol ? candlesBySymbol[sym] : candles;
        const symHtf = isMultiSymbol ? htfCandlesBySymbol[sym] : htfCandles;
        const sliceForExit = symCandles.slice(0, i + 1);
        let prevHtfSlice = null;
        if (symHtf) {
          let idx = isMultiSymbol ? htfIdxBySymbol[sym] : htfIdx;
          while (idx < symHtf.length - 1 && symHtf[idx + 1][0] <= tradeCandle[0]) idx += 1;
          prevHtfSlice = symHtf.slice(0, idx + 1);
        }
        const signal = getSignal(sliceForExit, {
          strategy: 'swingTrend',
          htfOhlcv: prevHtfSlice,
          openTrades: portfolio.openTrades,
        });
        const exitCheck = shouldExitTrade(trade, tradeCandle, signal.atr, {
          ema50: signal.ema50,
          rsi: signal.rsi,
        });
        if (exitCheck) {
          tradesToClose.push({ trade, exitPrice: exitCheck.exitPrice, reason: exitCheck.reason });
        }
      } else {
        const exitCheck = checkExitConditions(trade, tradeCandle);
        if (exitCheck) {
          tradesToClose.push({ trade, exitPrice: exitCheck.exitPrice, reason: exitCheck.reason });
        }
      }
    }

    for (const { trade, exitPrice, reason } of tradesToClose) {
      const closedTrade = { ...closeTrade(trade, exitPrice, timestamp), exitReason: reason };
      closeTradeInPortfolio(portfolio, closedTrade);
      lastTradeClosedAt = timestamp;
      if (closedTrade.pnl < 0 && strategy === 'swingTrend') {
        candlesSinceLastLoss = 0;
      }
      if (strategy === 'swingTrend' && trade.strategy === 'swingTrend') {
        const riskDist = trade.initialRiskDistance || Math.abs(trade.entryPrice - trade.stopLoss);
        const rMultiple = riskDist > 0 && trade.quantity > 0
          ? roundTo(closedTrade.pnl / (riskDist * trade.quantity), 4)
          : null;
        logger.trade('SwingTrend trade closed', { tradeId: trade.id, reason, pnl: closedTrade.pnl, rMultiple });
      }
      await tradePersistence.persistTradeClose(closedTrade, reason, 'backtest');
    }

    // 2. Generate signal (single-symbol) or collect & rank signals (multi-symbol)
    if (strategy === 'trendPullback' || strategy === 'swingTrend') {
      if (isMultiSymbol) {
        for (const sym of symbols) {
          while (htfCandlesBySymbol[sym] && htfIdxBySymbol[sym] < htfCandlesBySymbol[sym].length - 1
            && htfCandlesBySymbol[sym][htfIdxBySymbol[sym] + 1][0] <= timestamp) {
            htfIdxBySymbol[sym] += 1;
          }
        }
      } else {
        while (htfCandles && htfIdx < htfCandles.length - 1 && htfCandles[htfIdx + 1][0] <= timestamp) {
          htfIdx += 1;
        }
      }
    }

    let signal;
    const openSymbols = new Set(portfolio.openTrades.map((t) => t.symbol));

    if (isMultiSymbol && strategy === 'swingTrend') {
      // Collect signals from all symbols, rank by score, take top 2
      const allSignals = [];
      for (const sym of symbols) {
        const symCandles = candlesBySymbol[sym];
        const symHtf = htfCandlesBySymbol[sym];
        const symSlice = symCandles.slice(0, i + 1);
        const htfSlice = symHtf ? symHtf.slice(0, htfIdxBySymbol[sym] + 1) : [];
        const s = getSignal(symSlice, {
          strategy: 'swingTrend',
          htfOhlcv: htfSlice,
          openTrades: portfolio.openTrades,
        });
        if (['BUY', 'SELL'].includes(s.signal) && (s.score ?? 0) >= 7) {
          allSignals.push({ ...s, symbol: sym });
        }
      }
      // Rank by score descending, exclude symbols we already have
      allSignals.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      const available = allSignals.filter((s) => !openSymbols.has(s.symbol));
      const topSignals = available.slice(0, 2 - portfolio.openTrades.length);
      signal = { topSignals, primary: topSignals[0] || { signal: 'HOLD', price: close, timestamp } };
    } else {
      const htfSlice = !isMultiSymbol && (strategy === 'trendPullback' || strategy === 'swingTrend')
        ? (htfCandles ? htfCandles.slice(0, htfIdx + 1) : [])
        : [];
      signal = getSignal(ohlcvSlice, {
        strategy: strategy === 'trendPullback' ? 'trendPullback' : strategy === 'swingTrend' ? 'swingTrend' : undefined,
        htfOhlcv: htfSlice,
        openTrades: strategy === 'swingTrend' ? portfolio.openTrades : undefined,
      });
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

    // Cooldown: increment candles since last loss (swingTrend)
    if (strategy === 'swingTrend') {
      candlesSinceLastLoss = Math.min(candlesSinceLastLoss + 1, Infinity);
    }

    // 3. Apply risk rules and execute new trade(s) (BUY or SELL)
    const cooldownOk = strategy !== 'swingTrend' || candlesSinceLastLoss >= COOLDOWN_CANDLES;
    const maxOpenOk = strategy !== 'swingTrend' || portfolio.openTrades.length < 2;
    const maxNewTrades = strategy === 'swingTrend' ? 2 - portfolio.openTrades.length : 1;
    const signalsToOpen = isMultiSymbol && signal.topSignals
      ? signal.topSignals.slice(0, maxNewTrades)
      : (['BUY', 'SELL'].includes(signal.signal) ? [signal] : []);
    const tradesToAttempt = signalsToOpen;

    if (tradesToAttempt.length > 0 && cooldownOk && maxOpenOk) {
      for (const sig of tradesToAttempt) {
        const side = sig.signal;
        const tradeSymbol = sig.symbol || symbols[0];
        if (portfolio.openTrades.some((t) => t.symbol === tradeSymbol)) continue; // already have position in this symbol
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
          : strategy === 'swingTrend'
            ? { maxTradesPerDay: 2, tradeCooldownMs: 0, now: timestamp }
            : null;
        const { allowed } = canOpenTrade(riskStateWithCooldown, riskOverrides);
        if (allowed) {
          const useCustomRisk =
            (strategy === 'trendPullback' && sig.stopLoss && sig.takeProfit) ||
            (strategy === 'swingTrend' && sig.stopLoss);
          const riskParams = useCustomRisk
            ? getTradeRiskParamsCustom(
                sig.price,
                side,
                sig.stopLoss,
                sig.takeProfit || Infinity,
                portfolio.balance,
                strategy === 'swingTrend' ? (sig.suggestedRiskPercent ?? 0.01) : null
              )
            : getTradeRiskParams(sig.price, side, portfolio.balance);

          const { stopLoss, takeProfit, positionSize } = riskParams;
          const effectiveTakeProfit = strategy === 'swingTrend' ? null : takeProfit;

          if (positionSize > 0) {
            const trade = openTrade({
              entryPrice: sig.price,
              quantity: positionSize,
              side,
              stopLoss,
              takeProfit: effectiveTakeProfit,
              timestamp,
              symbol: tradeSymbol,
              strategy: strategy === 'trendPullback' ? 'trendPullback' : strategy === 'swingTrend' ? 'swingTrend' : 'default',
              atrAtEntry: sig.atr,
              initialStopLoss: stopLoss,
              initialRiskDistance: Math.abs(sig.price - stopLoss),
              takeProfit: strategy === 'swingTrend' ? sig.takeProfit : undefined,
              score: strategy === 'swingTrend' ? sig.score : undefined,
            });

            addOpenTrade(portfolio, trade);
            await tradePersistence.persistTradeOpen(trade, 'backtest', tradeSymbol);
            if (debugSummary) debugSummary.entries.opened += 1;
          } else if (debugSummary) {
            debugSummary.entries.blockedSize += 1;
          }
        } else if (debugSummary) {
          debugSummary.entries.blockedRisk += 1;
        }
      }
    } else if (debugSummary && ['BUY', 'SELL'].includes((signal.primary || signal).signal) && portfolio.openTrades.length !== 0) {
      debugSummary.entries.blockedOpenTrade += 1;
    }

    // 4. Update equity curve with candle close as mark price
    const markPrice = isMultiSymbol
      ? Object.fromEntries(symbols.map((s) => [s, candlesBySymbol[s][i][4]]))
      : close;
    updateEquityCurve(portfolio, timestamp, markPrice);
  }

  // Close any remaining open trades at last candle close
  const lastIdx = loopLength - 1;
  const lastCandle = isMultiSymbol ? candlesBySymbol[symbols[0]][lastIdx] : candles[lastIdx];
  const lastTimestamp = lastCandle[0];

  for (const trade of [...portfolio.openTrades]) {
    const exitPrice = isMultiSymbol && trade.symbol && candlesBySymbol[trade.symbol]
      ? candlesBySymbol[trade.symbol][lastIdx][4]
      : lastCandle[4];
    const closedTrade = closeTrade(trade, exitPrice, lastTimestamp);
    closeTradeInPortfolio(portfolio, closedTrade);
    await tradePersistence.persistTradeClose(closedTrade, 'MANUAL', 'backtest');
  }

  const lastMarkPrice = isMultiSymbol
    ? Object.fromEntries(symbols.map((s) => [s, candlesBySymbol[s][lastIdx][4]]))
    : lastCandle[4];
  updateEquityCurve(portfolio, lastTimestamp, lastMarkPrice);

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

  if (strategy === 'swingTrend' && closedTrades.length > 0) {
    logTradeMetrics(closedTrades);
  }

  // Build drawdown curve from equity curve
  const drawdownCurve = [];
  let peak = portfolio.initialBalance;
  for (const point of portfolio.equityCurve) {
    const equity = point.equity;
    if (equity > peak) peak = equity;
    const drawdown = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    drawdownCurve.push({ timestamp: point.timestamp, drawdown: roundTo(drawdown, 4), equity });
  }

  // Trade list for response
  const tradeList = closedTrades.map((t) => ({
    symbol: t.symbol,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    quantity: t.quantity,
    pnl: t.pnl,
    status: t.status,
    openedAt: t.openedAt,
    closedAt: t.closedAt,
  }));

  return {
    finalBalance: summary.balance,
    initialBalance: portfolio.initialBalance,
    totalTrades: closedTrades.length,
    winRate,
    profitFactor,
    maxDrawdown: summary.maxDrawdown,
    totalPnl: summary.totalPnl,
    totalPnlPercent: summary.totalPnlPercent,
    equityCurve: portfolio.equityCurve,
    drawdownCurve,
    tradeList,
    meta: {
      strategy: strategy || 'default',
      symbols: isMultiSymbol ? symbols : [symbols[0]],
      ltfTimeframe,
      htfTimeframe: (strategy === 'trendPullback' || strategy === 'swingTrend') ? htfTimeframe : null,
      candles: {
        ltf: candles.length,
        htf: (strategy === 'trendPullback' || strategy === 'swingTrend')
          ? (isMultiSymbol ? (htfCandlesBySymbol?.[symbols[0]]?.length ?? 0) : (htfCandles?.length ?? 0))
          : null,
      },
    },
    debugSummary: debugSummary || undefined,
  };
}

module.exports = {
  runBacktest,
  fetchBacktestData,
};
