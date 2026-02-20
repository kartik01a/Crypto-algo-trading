/**
 * Trade Repository - Persist and query trades
 */

const Trade = require('./models/Trade');

/**
 * Save trade when opened
 * @param {Object} trade - Trade object from execution
 * @param {string} mode - backtest | paper | real
 * @returns {Promise<Object>} Saved trade document
 */
async function saveTrade(trade, mode) {
  const doc = new Trade({
    mode,
    symbol: trade.symbol || 'BTC/USDT',
    side: trade.side,
    entryPrice: trade.entryPrice,
    exitPrice: trade.exitPrice || null,
    quantity: trade.quantity,
    stopLoss: trade.stopLoss,
    takeProfit: trade.takeProfit,
    pnl: trade.pnl || 0,
    fees: (trade.entryFee || 0) + (trade.exitFee || 0),
    status: trade.status || 'OPEN',
    reason: null,
    orderId: trade.orderId || null,
    sourceId: trade.id || null,
    closedAt: trade.closedAt || null,
  });
  return doc.save();
}

/**
 * Update trade when closed
 * @param {string} tradeId - Trade ID (MongoDB _id or original id)
 * @param {Object} updates - { exitPrice, pnl, status, reason, fees }
 */
async function updateTrade(tradeId, updates) {
  const updateData = {
    exitPrice: updates.exitPrice,
    pnl: updates.pnl,
    status: 'CLOSED',
    reason: updates.reason || null,
    closedAt: updates.closedAt || new Date(),
  };
  if (updates.fees != null) updateData.fees = updates.fees;

  await Trade.findOneAndUpdate(
    { $or: [{ _id: tradeId }, { orderId: tradeId }] },
    { $set: updateData },
    { new: true }
  );
}

/**
 * Update trade by sourceId or orderId (for in-memory trades)
 * @param {string} identifier - sourceId (trade.id) or orderId
 * @param {Object} updates - Close data
 */
async function updateTradeByIdentifier(identifier, updates) {
  const updateData = {
    exitPrice: updates.exitPrice,
    pnl: updates.pnl,
    status: 'CLOSED',
    reason: updates.reason || null,
    closedAt: updates.closedAt || new Date(),
  };
  if (updates.fees != null) updateData.fees = updates.fees;

  await Trade.findOneAndUpdate(
    { $or: [{ sourceId: identifier }, { orderId: identifier }], status: 'OPEN' },
    { $set: updateData }
  );
}

/**
 * Get trades with optional mode filter
 * @param {string} [mode] - backtest | paper | real
 * @param {Object} [options] - { limit, skip }
 */
async function getTrades(mode = null, options = {}) {
  const query = mode ? { mode } : {};
  const limit = options.limit || 100;
  const skip = options.skip || 0;

  return Trade.find(query).sort({ createdAt: -1 }).limit(limit).skip(skip).lean();
}

/**
 * Get closed trades for performance calculation
 */
async function getClosedTrades(mode = null) {
  const query = { status: 'CLOSED' };
  if (mode) query.mode = mode;
  return Trade.find(query).sort({ closedAt: 1 }).lean();
}

/**
 * Bulk save closed trades (e.g. after backtest completes)
 * @param {Array<Object>} trades - Closed trades with full data
 * @param {string} mode - backtest | paper | real
 * @param {string} symbol - Trading pair
 * @returns {Promise<number>} Number of trades saved
 */
async function saveTradesBulk(trades, mode, symbol = 'BTC/USDT') {
  if (!trades || trades.length === 0) return 0;

  const docs = trades.map((t) => ({
    mode,
    symbol: t.symbol || symbol,
    side: t.side,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    quantity: t.quantity,
    stopLoss: t.stopLoss ?? null,
    takeProfit: t.takeProfit ?? null,
    pnl: t.pnl ?? 0,
    fees: (t.entryFee || 0) + (t.exitFee || 0),
    status: 'CLOSED',
    reason: t.reason || 'MANUAL',
    sourceId: t.id,
    closedAt: t.closedAt,
  }));

  const result = await Trade.insertMany(docs);
  return result.length;
}

module.exports = {
  saveTrade,
  updateTrade,
  updateTradeByIdentifier,
  getTrades,
  getClosedTrades,
  saveTradesBulk,
};
