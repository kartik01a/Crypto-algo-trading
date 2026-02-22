/**
 * Backtest Engine
 * Simulates trading on historical data with candle-by-candle execution
 */

const { fetchOHLCV } = require('../exchange');
const { getSignal } = require('../strategy');
const { canOpenTrade, getTradeRiskParams, getTradeRiskParamsCustom, getTotalOpenRiskPercent, maxTotalRiskPercent, configMaxOpenTrades } = require('../risk');
const { applyTrendPullbackTrailingStop } = require('../strategy/trendPullbackStrategy');
const {
  shouldExitTrade,
  updateTrailingStop,
  logTradeMetrics,
  COOLDOWN_CANDLES,
} = require('../strategy/swingTrendStrategy');
const {
  shouldExitTrade: shouldExitTradeGoldenCross,
  updateTrailingStop: updateTrailingStopGoldenCross,
  MIN_LTF_CANDLES: GOLDEN_CROSS_MIN_LTF,
} = require('../strategy/goldenCrossHTFStrategy');
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
 * Get candles up to and including timestamp (no lookahead)
 * @param {Array<Array>} candles - Sorted by timestamp
 * @param {number} timestamp
 * @returns {Array<Array>}
 */
function getCandlesUpTo(candles, timestamp) {
  if (!candles || candles.length === 0) return [];
  let end = candles.length - 1;
  while (end >= 0 && candles[end][0] > timestamp) end -= 1;
  return end >= 0 ? candles.slice(0, end + 1) : [];
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
  maxOpenTrades: maxOpenTradesParam = null,
}) {
  const fromTs = parseDate(from);
  const toTs = parseDate(to);

  // Multi-symbol: use symbols array; single-symbol: use symbol
  const symbols = symbolsParam && symbolsParam.length > 0 ? symbolsParam : [symbol || 'BTC/USDT'];
  const isMultiSymbol = symbols.length > 1;
  // Single-symbol goldenCrossHTF: max 1; multi-symbol or other: use config/param
  const maxOpenTrades = maxOpenTradesParam ?? (
    !isMultiSymbol && strategy === 'goldenCrossHTF' ? 1 : configMaxOpenTrades
  );

  let candles = ohlcv;
  let htfCandles = null;
  let candlesBySymbol = null;
  let htfCandlesBySymbol = null;

  // For trendPullback we enforce 5m+15m; for swingTrend/goldenCrossHTF we enforce 4h+1d
  const ltfTimeframe = (strategy === 'swingTrend' || strategy === 'goldenCrossHTF')
    ? '4h'
    : strategy === 'trendPullback'
      ? '5m'
      : timeframe;
  const htfTimeframe = (strategy === 'swingTrend' || strategy === 'goldenCrossHTF') ? '1d' : '15m';

  if (isMultiSymbol) {
    // Fetch LTF and HTF for each symbol - same timeframe for all
    candlesBySymbol = {};
    htfCandlesBySymbol = {};
    let htfFrom = fromTs;
    if (htfTimeframe === '1d') {
      const WARMUP_DAYS_MS = 250 * 24 * 60 * 60 * 1000;
      htfFrom = Math.max(0, fromTs - WARMUP_DAYS_MS);
    }
    for (const sym of symbols) {
      candlesBySymbol[sym] = await fetchBacktestData(sym, ltfTimeframe, fromTs, toTs);
      if (strategy === 'trendPullback' || strategy === 'swingTrend' || strategy === 'goldenCrossHTF') {
        htfCandlesBySymbol[sym] = await fetchBacktestData(sym, htfTimeframe, htfFrom, toTs);
      }
    }
    candles = candlesBySymbol[symbols[0]];
  }

  // Multi-symbol: build global timeline and candle maps (timestamp-based alignment)
  let timeline = null;
  let candleMapBySymbol = null;
  let htfCandleMapBySymbol = null;

  if (isMultiSymbol) {
    const allTimestamps = new Set();
    for (const sym of symbols) {
      for (const c of candlesBySymbol[sym] || []) {
        allTimestamps.add(c[0]);
      }
    }
    timeline = Array.from(allTimestamps).sort((a, b) => a - b);

    candleMapBySymbol = {};
    for (const sym of symbols) {
      const map = new Map();
      for (const c of candlesBySymbol[sym] || []) {
        map.set(c[0], c);
      }
      candleMapBySymbol[sym] = map;
    }

    htfCandleMapBySymbol = {};
    for (const sym of symbols) {
      const map = new Map();
      for (const c of htfCandlesBySymbol[sym] || []) {
        map.set(c[0], c);
      }
      htfCandleMapBySymbol[sym] = map;
    }

    if (debug) {
      logger.info('Multi-symbol timeline', {
        symbols,
        timelineLength: timeline.length,
        candleCounts: Object.fromEntries(symbols.map((s) => [s, candlesBySymbol[s]?.length ?? 0])),
      });
    }
  }

  if (!isMultiSymbol) {
    if (!candles || candles.length === 0) {
      candles = await fetchBacktestData(symbols[0], ltfTimeframe, fromTs, toTs);
    }
    if (strategy === 'trendPullback' || strategy === 'swingTrend' || strategy === 'goldenCrossHTF') {
      let htfFrom = fromTs;
      if ((strategy === 'swingTrend' || strategy === 'goldenCrossHTF') && htfTimeframe === '1d') {
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
  const warmupPeriod = strategy === 'swingTrend'
    ? 220
    : strategy === 'goldenCrossHTF'
      ? GOLDEN_CROSS_MIN_LTF
      : 50;
  let lastTradeClosedAt = 0;
  let candlesSinceLastLoss = Infinity; // Cooldown for swingTrend
  let htfIdx = 0;
  // Single-symbol: index-based; Multi-symbol: timeline-based
  const loopLength = isMultiSymbol ? timeline.length : candles.length;

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

  // Track last known price per symbol (for equity when candle missing)
  const lastPriceBySymbol = isMultiSymbol ? Object.fromEntries(symbols.map((s) => [s, 0])) : null;

  for (let i = warmupPeriod; i < loopLength; i++) {
    let timestamp;
    let candle;
    let candleBySymbol;
    let prevCandleBySymbol;

    if (isMultiSymbol) {
      timestamp = timeline[i];
      candleBySymbol = {};
      for (const sym of symbols) {
        const c = candleMapBySymbol[sym].get(timestamp);
        if (c) {
          candleBySymbol[sym] = c;
          lastPriceBySymbol[sym] = c[4];
        }
      }
      // Skip if no symbol has candle at this timestamp (shouldn't happen)
      if (Object.keys(candleBySymbol).length === 0) continue;
      // Warmup: need each symbol to have enough candles
      let warmupOk = true;
      for (const sym of symbols) {
        if (getCandlesUpTo(candlesBySymbol[sym], timestamp).length < warmupPeriod) {
          warmupOk = false;
          break;
        }
      }
      if (!warmupOk) continue;
      prevCandleBySymbol = {};
      if (i > 0) {
        const prevTs = timeline[i - 1];
        for (const sym of symbols) {
          const pc = candleMapBySymbol[sym].get(prevTs);
          if (pc) prevCandleBySymbol[sym] = pc;
        }
      }
      candle = candleBySymbol[symbols[0]] || candleBySymbol[symbols[1]] || candleBySymbol[symbols[2]] || Object.values(candleBySymbol)[0];
    } else {
      candle = candles[i];
      timestamp = candle[0];
    }

    const [ts, open, high, low, close] = candle;

    resetDailyIfNeeded(portfolio, timestamp);

    // 0. Update trailing stops using previous closed candle (no lookahead)
    if (strategy === 'trendPullback' && portfolio.openTrades.length > 0 && i >= 1) {
      const prevCandle = isMultiSymbol ? prevCandleBySymbol[symbols[0]] : candles[i - 1];
      if (prevCandle) {
        const prevTs = prevCandle[0];
        const prevSlice = isMultiSymbol ? getCandlesUpTo(candles, prevTs) : candles.slice(0, i);
        const prevHtfSlice = htfCandles ? getCandlesUpTo(htfCandles, prevTs) : null;
        const prevSignal = getSignal(prevSlice, { strategy: 'trendPullback', htfOhlcv: prevHtfSlice });
        portfolio.openTrades = portfolio.openTrades.map((t) => {
          if (t.strategy !== 'trendPullback') return t;
          return applyTrendPullbackTrailingStop(t, prevSignal.price, prevSignal.atr);
        });
      }
    }

    if (strategy === 'swingTrend' && portfolio.openTrades.length > 0 && i >= 1) {
      portfolio.openTrades = portfolio.openTrades.map((t) => {
        if (t.strategy !== 'swingTrend') return t;
        const sym = t.symbol || symbols[0];
        const symCandles = isMultiSymbol ? candlesBySymbol[sym] : candles;
        const prevTs = isMultiSymbol ? timeline[i - 1] : candles[i - 1][0];
        const prevCandle = isMultiSymbol ? prevCandleBySymbol[sym] : symCandles[i - 1];
        if (!prevCandle) return t;
        const prevHigh = prevCandle[2];
        const prevLow = prevCandle[3];
        const prevSlice = isMultiSymbol ? getCandlesUpTo(symCandles, prevTs) : symCandles.slice(0, i);
        const symHtf = isMultiSymbol ? htfCandlesBySymbol[sym] : htfCandles;
        const prevHtfSlice = symHtf ? getCandlesUpTo(symHtf, prevTs) : null;
        const prevSignal = getSignal(prevSlice, {
          strategy: 'swingTrend',
          htfOhlcv: prevHtfSlice,
          openTrades: portfolio.openTrades,
        });
        const updated = updateTrailingStop(t, prevSignal.price, prevSignal.atr, prevHigh, prevLow);
        updated.candleCount = (t.candleCount || 0) + 1;
        return updated;
      });
    }

    if (strategy === 'goldenCrossHTF' && portfolio.openTrades.length > 0 && i >= 1) {
      portfolio.openTrades = portfolio.openTrades.map((t) => {
        if (t.strategy !== 'goldenCrossHTF') return t;
        const sym = t.symbol || symbols[0];
        const prevCandle = isMultiSymbol ? prevCandleBySymbol[sym] : candles[i - 1];
        if (!prevCandle) return t;
        const prevHigh = prevCandle[2];
        const prevLow = prevCandle[3];
        const updated = updateTrailingStopGoldenCross(t, prevCandle, prevHigh, prevLow);
        updated.candleCount = (t.candleCount || 0) + 1;
        return updated;
      });
    }

    // 1. Check exit conditions for open trades (SL/TP)
    const tradesToClose = [];
    for (const trade of portfolio.openTrades) {
      let tradeCandle;
      if (isMultiSymbol && trade.symbol) {
        tradeCandle = candleBySymbol[trade.symbol];
        // If no candle at exact timestamp, use last candle up to this timestamp (for symbols with different candle counts)
        if (!tradeCandle) {
          const symSlice = getCandlesUpTo(candlesBySymbol[trade.symbol], timestamp);
          tradeCandle = symSlice.length > 0 ? symSlice[symSlice.length - 1] : null;
        }
      } else {
        tradeCandle = candle;
      }
      if (!tradeCandle) continue; // Skip if no candle data for this symbol
      if (strategy === 'swingTrend' && trade.strategy === 'swingTrend') {
        const sym = trade.symbol || symbols[0];
        const symCandles = isMultiSymbol ? candlesBySymbol[sym] : candles;
        const symHtf = isMultiSymbol ? htfCandlesBySymbol[sym] : htfCandles;
        const sliceForExit = isMultiSymbol ? getCandlesUpTo(symCandles, timestamp) : symCandles.slice(0, i + 1);
        const prevHtfSlice = symHtf ? getCandlesUpTo(symHtf, tradeCandle[0]) : null;
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
      } else if (strategy === 'goldenCrossHTF' && trade.strategy === 'goldenCrossHTF') {
        const exitCheck = shouldExitTradeGoldenCross(trade, tradeCandle);
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
      if (strategy === 'goldenCrossHTF' && trade.strategy === 'goldenCrossHTF') {
        const duration = trade.candleCount ?? 0;
        logger.trade('GoldenCrossHTF trade closed', {
          tradeId: trade.id,
          reason,
          pnl: closedTrade.pnl,
          duration,
        });
      }
      await tradePersistence.persistTradeClose(closedTrade, reason, 'backtest');
    }

    // 2. Advance htfIdx for single-symbol only (multi-symbol uses getCandlesUpTo)
    if (!isMultiSymbol && (strategy === 'trendPullback' || strategy === 'swingTrend' || strategy === 'goldenCrossHTF')) {
      while (htfCandles && htfIdx < htfCandles.length - 1 && htfCandles[htfIdx + 1][0] <= timestamp) {
        htfIdx += 1;
      }
    }

    let signal;
    const openSymbols = new Set(portfolio.openTrades.map((t) => t.symbol));

    if (isMultiSymbol && strategy === 'swingTrend') {
      // Collect signals from all symbols, rank by score, take top N
      const allSignals = [];
      for (const sym of symbols) {
        const c = candleBySymbol[sym];
        if (!c) continue; // Skip if no candle at this timestamp
        const symCandles = candlesBySymbol[sym];
        const symHtf = htfCandlesBySymbol[sym];
        const symSlice = getCandlesUpTo(symCandles, timestamp);
        const htfSlice = symHtf ? getCandlesUpTo(symHtf, timestamp) : [];
        const s = getSignal(symSlice, {
          strategy: 'swingTrend',
          htfOhlcv: htfSlice,
          openTrades: portfolio.openTrades,
        });
        if (['BUY', 'SELL'].includes(s.signal) && (s.score ?? 0) >= 7) {
          allSignals.push({ ...s, symbol: sym });
        }
      }
      allSignals.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      const available = allSignals.filter((s) => !openSymbols.has(s.symbol));
      const topSignals = available.slice(0, maxOpenTrades - portfolio.openTrades.length);
      signal = { topSignals, primary: topSignals[0] || { signal: 'HOLD', price: close, timestamp } };
    } else if (isMultiSymbol && strategy === 'goldenCrossHTF') {
      // Collect signals from all symbols, rank by ADX > emaDistance > confidence
      const allSignals = [];
      for (const sym of symbols) {
        const c = candleBySymbol[sym];
        if (!c) continue; // Skip if no candle at this timestamp
        const symCandles = candlesBySymbol[sym];
        const symHtf = htfCandlesBySymbol[sym];
        const symSlice = getCandlesUpTo(symCandles, timestamp);
        const htfSlice = symHtf ? getCandlesUpTo(symHtf, timestamp) : [];
        const s = getSignal(symSlice, {
          strategy: 'goldenCrossHTF',
          htfOhlcv: htfSlice,
          openTrades: portfolio.openTrades,
          symbol: sym,
        });
        if (['BUY', 'SELL'].includes(s.signal)) {
          allSignals.push({
            ...s,
            symbol: sym,
            action: s.signal,
            confidence: s.confidence ?? 0.5,
            entryPrice: s.price,
            stopLoss: s.stopLoss,
            metadata: s.metadata || { adx: s.adx, emaDistance: s.emaDistance },
          });
        }
      }
      // Rank: 1. ADX (higher first), 2. EMA distance, 3. confidence
      allSignals.sort((a, b) => {
        const adxA = a.adx ?? 0;
        const adxB = b.adx ?? 0;
        if (adxB !== adxA) return adxB - adxA;
        const emaA = a.emaDistance ?? 0;
        const emaB = b.emaDistance ?? 0;
        if (emaB !== emaA) return emaB - emaA;
        return (b.confidence ?? 0) - (a.confidence ?? 0);
      });
      const available = allSignals.filter((s) => !openSymbols.has(s.symbol));
      const topSignals = available.slice(0, maxOpenTrades - portfolio.openTrades.length);
      if (debug && allSignals.length > 0) {
        logger.signal('GoldenCrossHTF multi-symbol', {
          selected: topSignals.map((s) => ({ symbol: s.symbol, action: s.action, adx: s.adx })),
          rejected: available.slice(topSignals.length).map((s) => ({ symbol: s.symbol, reason: 'LIMIT' })),
        });
      }
      signal = { topSignals, primary: topSignals[0] || { signal: 'HOLD', price: close, timestamp } };
    } else {
      const ohlcvSlice = isMultiSymbol
        ? getCandlesUpTo(candles, timestamp)
        : candles.slice(0, i + 1);
      const htfForSlice = isMultiSymbol ? htfCandlesBySymbol?.[symbols[0]] : htfCandles;
      const htfSlice = (strategy === 'trendPullback' || strategy === 'swingTrend' || strategy === 'goldenCrossHTF')
        ? (htfForSlice ? (isMultiSymbol ? getCandlesUpTo(htfForSlice, timestamp) : htfForSlice.slice(0, htfIdx + 1)) : [])
        : [];
      signal = getSignal(ohlcvSlice, {
        strategy: strategy === 'trendPullback'
          ? 'trendPullback'
          : strategy === 'swingTrend'
            ? 'swingTrend'
            : strategy === 'goldenCrossHTF'
              ? 'goldenCrossHTF'
              : undefined,
        htfOhlcv: htfSlice,
        openTrades: (strategy === 'swingTrend' || strategy === 'goldenCrossHTF') ? portfolio.openTrades : undefined,
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
    const maxOpenOk = portfolio.openTrades.length < maxOpenTrades;
    const totalRiskPercent = getTotalOpenRiskPercent(portfolio.openTrades, portfolio.balance);
    const riskLimitOk = totalRiskPercent < maxTotalRiskPercent;
    const maxNewTrades = Math.min(maxOpenTrades - portfolio.openTrades.length, 10);
    const signalsToOpen = isMultiSymbol && signal.topSignals
      ? signal.topSignals.slice(0, maxNewTrades)
      : (['BUY', 'SELL'].includes(signal.signal) ? [signal] : []);
    const tradesToAttempt = signalsToOpen;

    if (tradesToAttempt.length > 0 && cooldownOk && maxOpenOk && riskLimitOk) {
      for (const sig of tradesToAttempt) {
        const side = sig.signal || sig.action;
        const tradeSymbol = sig.symbol || symbols[0];
        if (portfolio.openTrades.some((t) => t.symbol === tradeSymbol)) continue; // one trade per symbol
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
            : strategy === 'goldenCrossHTF'
              ? { maxTradesPerDay: 10, tradeCooldownMs: 0, now: timestamp, maxDrawdown: 1 }
              : null;
        const { allowed } = canOpenTrade(riskStateWithCooldown, riskOverrides);
        if (allowed) {
          const useCustomRisk =
            (strategy === 'trendPullback' && sig.stopLoss && sig.takeProfit) ||
            (strategy === 'swingTrend' && sig.stopLoss) ||
            (strategy === 'goldenCrossHTF' && sig.stopLoss);
          const riskParams = useCustomRisk
            ? getTradeRiskParamsCustom(
                sig.price,
                side,
                sig.stopLoss,
                sig.takeProfit || Infinity,
                portfolio.balance,
                (strategy === 'swingTrend' || strategy === 'goldenCrossHTF') ? (sig.suggestedRiskPercent ?? 0.01) : null
              )
            : getTradeRiskParams(sig.price, side, portfolio.balance);

          const { stopLoss, takeProfit, positionSize } = riskParams;
          const effectiveTakeProfit = (strategy === 'swingTrend' || strategy === 'goldenCrossHTF') ? null : takeProfit;

          if (positionSize > 0) {
            const tradeParams = {
              entryPrice: sig.price,
              quantity: positionSize,
              side,
              stopLoss,
              takeProfit: effectiveTakeProfit,
              timestamp,
              symbol: tradeSymbol,
              strategy: strategy === 'trendPullback'
                ? 'trendPullback'
                : strategy === 'swingTrend'
                  ? 'swingTrend'
                  : strategy === 'goldenCrossHTF'
                    ? 'goldenCrossHTF'
                    : 'default',
              atrAtEntry: sig.atr,
              initialStopLoss: stopLoss,
              initialRiskDistance: Math.abs(sig.price - stopLoss),
              takeProfit: (strategy === 'swingTrend' || strategy === 'goldenCrossHTF') ? sig.takeProfit : undefined,
              score: strategy === 'swingTrend' ? sig.score : undefined,
            };
            if (strategy === 'goldenCrossHTF') {
              tradeParams.entryIndex = i;
              tradeParams.highestPrice = side === 'BUY' ? sig.price : undefined;
              tradeParams.lowestPrice = side === 'SELL' ? sig.price : undefined;
            }
            const trade = openTrade(tradeParams);

            addOpenTrade(portfolio, trade);
            await tradePersistence.persistTradeOpen(trade, 'backtest', tradeSymbol);
            if (debugSummary) debugSummary.entries.opened += 1;
            if (debug && isMultiSymbol) {
              logger.signal('Trade opened', { symbol: tradeSymbol, side, price: sig.price, adx: sig.adx });
            }
          } else if (debugSummary) {
            debugSummary.entries.blockedSize += 1;
          }
        } else if (debugSummary) {
          debugSummary.entries.blockedRisk += 1;
        }
      }
    } else if (tradesToAttempt.length > 0 && !riskLimitOk && debug) {
      logger.signal('Signals rejected: total risk limit', {
        totalRiskPercent: roundTo(totalRiskPercent * 100, 2),
        maxPercent: maxTotalRiskPercent * 100,
        openTrades: portfolio.openTrades.length,
      });
    } else if (debugSummary && ['BUY', 'SELL'].includes((signal.primary || signal).signal) && portfolio.openTrades.length >= maxOpenTrades) {
      debugSummary.entries.blockedOpenTrade += 1;
    }

    // 4. Update equity curve with candle close as mark price
    const markPrice = isMultiSymbol
      ? Object.fromEntries(symbols.map((s) => {
          const c = candleBySymbol[s];
          return [s, c ? c[4] : lastPriceBySymbol[s] || 0];
        }))
      : close;
    updateEquityCurve(portfolio, timestamp, markPrice);
  }

  // Close any remaining open trades at last candle close
  const lastIdx = loopLength - 1;
  const lastTimestamp = isMultiSymbol ? timeline[lastIdx] : candles[lastIdx][0];
  const lastCandle = isMultiSymbol ? null : candles[lastIdx];

  for (const trade of [...portfolio.openTrades]) {
    const exitPrice = isMultiSymbol && trade.symbol && candlesBySymbol[trade.symbol]?.length > 0
      ? candlesBySymbol[trade.symbol][candlesBySymbol[trade.symbol].length - 1][4]
      : lastCandle[4];
    const closedTrade = closeTrade(trade, exitPrice, lastTimestamp);
    closeTradeInPortfolio(portfolio, closedTrade);
    await tradePersistence.persistTradeClose(closedTrade, 'MANUAL', 'backtest');
  }

  const lastMarkPrice = isMultiSymbol
    ? Object.fromEntries(symbols.map((s) => {
        const arr = candlesBySymbol[s];
        return [s, arr?.length > 0 ? arr[arr.length - 1][4] : lastPriceBySymbol[s] || 0];
      }))
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

  // PnL per symbol
  const pnlBySymbol = {};
  for (const t of closedTrades) {
    const sym = t.symbol || 'unknown';
    if (!pnlBySymbol[sym]) pnlBySymbol[sym] = { pnl: 0, trades: 0, wins: 0 };
    pnlBySymbol[sym].pnl += t.pnl;
    pnlBySymbol[sym].trades += 1;
    if (t.pnl > 0) pnlBySymbol[sym].wins += 1;
  }
  for (const sym of Object.keys(pnlBySymbol)) {
    const s = pnlBySymbol[sym];
    s.winRate = s.trades > 0 ? roundTo((s.wins / s.trades) * 100, 2) : 0;
  }

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
    pnlBySymbol,
    meta: {
      strategy: strategy || 'default',
      symbols: isMultiSymbol ? symbols : [symbols[0]],
      ltfTimeframe,
      htfTimeframe: (strategy === 'trendPullback' || strategy === 'swingTrend' || strategy === 'goldenCrossHTF') ? htfTimeframe : null,
      candles: {
        ltf: isMultiSymbol ? timeline?.length : candles.length,
        ltfBySymbol: isMultiSymbol ? Object.fromEntries(symbols.map((s) => [s, candlesBySymbol[s]?.length ?? 0])) : undefined,
        htf: (strategy === 'trendPullback' || strategy === 'swingTrend' || strategy === 'goldenCrossHTF')
          ? (isMultiSymbol ? (htfCandlesBySymbol?.[symbols[0]]?.length ?? 0) : (htfCandles?.length ?? 0))
          : null,
      },
      maxOpenTrades,
    },
    debugSummary: debugSummary || undefined,
  };
}

module.exports = {
  runBacktest,
  fetchBacktestData,
};
