/**
 * Trade Persistence - Save/update trades in DB (fails gracefully if DB unavailable)
 */

const tradeRepository = require('../db/tradeRepository');
const logger = require('../utils/logger');

let dbAvailable = false;

function setDbAvailable(available) {
  dbAvailable = available;
}

async function persistTradeOpen(trade, mode, symbol = 'BTC/USDT') {
  if (!dbAvailable) return null;

  try {
    const doc = await tradeRepository.saveTrade(
      { ...trade, symbol },
      mode
    );
    logger.trade('Trade saved to DB', { mode, tradeId: trade.id, dbId: doc._id });
    return doc._id;
  } catch (err) {
    logger.error('Failed to persist trade open', { error: err.message, mode });
    return null;
  }
}

async function persistTradeClose(trade, reason, mode) {
  if (!dbAvailable) return;

  try {
    const identifier = trade.orderId || trade.id;
    if (!identifier) return;

    await tradeRepository.updateTradeByIdentifier(identifier, {
      exitPrice: trade.exitPrice,
      pnl: trade.pnl,
      reason: reason === 'STOP_LOSS' ? 'SL' : reason === 'TAKE_PROFIT' ? 'TP' : 'MANUAL',
      closedAt: trade.closedAt,
      fees: (trade.entryFee || 0) + (trade.exitFee || 0),
    });
    logger.trade('Trade updated in DB', { mode, tradeId: trade.id, reason });
  } catch (err) {
    logger.error('Failed to persist trade close', { error: err.message, mode });
  }
}

/**
 * Bulk persist closed trades (e.g. after backtest completes)
 * Saves all trades in one DB operation when DB is available.
 * When DB unavailable, falls back to JSON file in ./logs/trades-{mode}.json
 * @param {Array<Object>} trades - Closed trades with full data
 * @param {string} mode - backtest | paper | real
 * @param {string} symbol - Trading pair
 * @returns {Promise<number>} Number of trades saved
 */
async function persistTradesBulk(trades, mode, symbol = 'BTC/USDT') {
  if (!trades || trades.length === 0) return 0;

  if (dbAvailable) {
    try {
      const count = await tradeRepository.saveTradesBulk(trades, mode, symbol);
      logger.trade('Trades saved to DB (bulk)', { mode, count, symbol });
      return count;
    } catch (err) {
      logger.error('Failed to persist trades bulk', { error: err.message, mode });
    }
  }

  // Fallback: save to JSON file when MongoDB unavailable
  try {
    const fs = require('fs');
    const path = require('path');
    const logDir = process.env.LOG_DIR || path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const toSave = trades.map((t) => ({
      symbol: t.symbol || symbol,
      side: t.side,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      quantity: t.quantity,
      pnl: t.pnl,
      closedAt: t.closedAt,
      mode,
    }));
    // backtest: overwrite each run; paper/real: append
    const filePath = path.join(logDir, `trades-${mode}.json`);
    if (mode === 'backtest') {
      fs.writeFileSync(filePath, JSON.stringify(toSave, null, 2));
    } else {
      const existing = fs.existsSync(filePath)
        ? JSON.parse(fs.readFileSync(filePath, 'utf8') || '[]')
        : [];
      const merged = Array.isArray(existing) ? [...existing, ...toSave] : toSave;
      fs.writeFileSync(filePath, JSON.stringify(merged, null, 2));
    }
    logger.trade('Trades saved to file (DB unavailable)', { mode, count: trades.length, file: filePath });
    return trades.length;
  } catch (err) {
    logger.error('Failed to persist trades to file', { error: err.message, mode });
    return 0;
  }
}

module.exports = {
  setDbAvailable,
  persistTradeOpen,
  persistTradeClose,
  persistTradesBulk,
};
