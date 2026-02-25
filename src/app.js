/**
 * Crypto Algorithmic Trading Backend
 * Express API server
 */

require('dotenv').config();

const express = require('express');
const config = require('./config');
const backtestService = require('./services/backtestService');
const paperService = require('./services/paperService');
const realService = require('./services/realService');
const tradeRepository = require('./db/tradeRepository');
const performanceService = require('./services/performanceService');
const { connectDB } = require('./db/connection');
const tradePersistence = require('./services/tradePersistence');

const app = express();
app.use(express.json());

// Connect to MongoDB (optional - app works without it)
connectDB()
  .then(() => {
    tradePersistence.setDbAvailable(true);
    console.log('[App] Trade persistence enabled');
  })
  .catch(() => {
    console.warn('[App] MongoDB not available - trade persistence disabled');
  });

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// Backtest API
// ---------------------------------------------------------------------------

/**
 * POST /api/backtest
 * Body: { symbol, timeframe, from, to, initialBalance }
 */
app.post('/api/backtest', async (req, res) => {
  try {
    const result = await backtestService.executeBacktest(req.body);
    res.json(result);
  } catch (error) {
    console.error('[Backtest] Error:', error.message);
    res.status(400).json({
      error: error.message,
    });
  }
});

// ---------------------------------------------------------------------------
// Paper Trading API
// ---------------------------------------------------------------------------

/**
 * POST /api/paper/start
 * Body: { symbol?, symbols?, timeframe?, strategy?, initialBalance?, maxOpenTrades?, longOnly? }
 * symbols: ['BTC/USDT','ETH/USDT','SOL/USDT'] for multi-symbol (goldenCrossHTF)
 * strategy: 'trendPullback' | 'goldenCrossHTF' | null (default EMA+RSI)
 */
app.post('/api/paper/start', async (req, res) => {
  try {
    const result = await paperService.start(req.body);
    res.json(result);
  } catch (error) {
    console.error('[Paper] Start error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/paper/stop
 */
app.post('/api/paper/stop', (req, res) => {
  try {
    const result = paperService.stop();
    res.json(result);
  } catch (error) {
    console.error('[Paper] Stop error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/paper/status
 */
app.get('/api/paper/status', (req, res) => {
  try {
    const status = paperService.getStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Portfolio API
// ---------------------------------------------------------------------------

/**
 * GET /api/portfolio
 * Returns portfolio summary (works with paper trading)
 */
app.get('/api/portfolio', (req, res) => {
  try {
    const portfolio = paperService.getPortfolioFull();
    if (!portfolio) {
      return res.status(404).json({
        error: 'No portfolio. Start paper trading first.',
      });
    }
    res.json(portfolio);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/trades
 * Returns trades from DB. Query: ?mode=backtest|paper|real&limit=100
 */
app.get('/api/trades', async (req, res) => {
  try {
    const { mode, limit } = req.query;
    const trades = await tradeRepository.getTrades(mode || null, { limit: parseInt(limit, 10) || 100 });
    res.json(trades);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/trades/:mode
 * Returns trades for specific mode (backtest, paper, real)
 */
app.get('/api/trades/:mode', async (req, res) => {
  try {
    const { mode } = req.params;
    if (!['backtest', 'paper', 'real'].includes(mode)) {
      return res.status(400).json({ error: 'Invalid mode' });
    }
    const { limit } = req.query;
    const trades = await tradeRepository.getTrades(mode, { limit: parseInt(limit, 10) || 100 });
    res.json(trades);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/performance
 * Returns performance metrics. Query: ?mode=backtest|paper|real
 */
app.get('/api/performance', async (req, res) => {
  try {
    const { mode } = req.query;
    const performance = await performanceService.getPerformance(mode || null);
    res.json(performance);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Real Trading API (Binance Futures)
// ---------------------------------------------------------------------------

/**
 * POST /api/real/start
 * Body: { symbol?, symbols?, strategy?, quoteCurrency?, initialBalance? (DRY_RUN), longOnly?, maxOpenTrades?, useExchangeStopLoss?, trailPercent?, leverage?, maxCapitalPerTrade?, riskPerTrade? }
 * symbols: ['BTC/USDT','ETH/USDT','SOL/USDT'] for multi-symbol (goldenCrossHTF)
 * strategy: 'trendPullback' | 'goldenCrossHTF' | null
 * longOnly: true = skip SELL signals (spot-only, no shorting)
 */
app.post('/api/real/start', async (req, res) => {
  try {
    const result = await realService.start(req.body);
    res.json(result);
  } catch (error) {
    console.error('[Real] Start error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/real/stop
 */
app.post('/api/real/stop', (req, res) => {
  try {
    const result = realService.stop();
    res.json(result);
  } catch (error) {
    console.error('[Real] Stop error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/real/status
 */
app.get('/api/real/status', (req, res) => {
  try {
    const status = realService.getStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

const PORT = config.port;
app.listen(PORT, () => {
  console.log(`Crypto Algo Trading API running on http://localhost:${PORT}`);
  console.log(`  POST /api/backtest - Run backtest`);
  console.log(`  POST /api/paper/start - Start paper trading`);
  console.log(`  POST /api/paper/stop - Stop paper trading`);
  console.log(`  GET  /api/paper/status - Paper trading status`);
  console.log(`  GET  /api/portfolio - Portfolio summary`);
  console.log(`  GET  /api/trades - Trades from DB (optional ?mode=)`);
  console.log(`  GET  /api/trades/:mode - Trades by mode`);
  console.log(`  GET  /api/performance - Performance metrics`);
  console.log(`  POST /api/real/start - Start real trading (Binance Futures)`);
  console.log(`  POST /api/real/stop - Stop real trading`);
  console.log(`  GET  /api/real/status - Real trading status`);
});

module.exports = app;
