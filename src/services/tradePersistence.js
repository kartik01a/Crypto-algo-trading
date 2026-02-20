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

module.exports = {
  setDbAvailable,
  persistTradeOpen,
  persistTradeClose,
};
