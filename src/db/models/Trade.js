/**
 * Trade Model - MongoDB persistence
 */

const mongoose = require('mongoose');

const tradeSchema = new mongoose.Schema(
  {
    mode: {
      type: String,
      required: true,
      enum: ['backtest', 'paper', 'real'],
    },
    symbol: { type: String, required: true },
    side: { type: String, required: true, enum: ['BUY', 'SELL'] },
    entryPrice: { type: Number, required: true },
    exitPrice: { type: Number, default: null },
    quantity: { type: Number, required: true },
    stopLoss: { type: Number, required: true },
    takeProfit: { type: Number, default: null }, // null = no fixed TP (trailing stop / let profits run)
    pnl: { type: Number, default: 0 },
    fees: { type: Number, default: 0 },
    status: { type: String, required: true, enum: ['OPEN', 'CLOSED'], default: 'OPEN' },
    reason: { type: String, enum: ['SL', 'TP', 'MANUAL', null], default: null },
    orderId: { type: String, default: null },
    sourceId: { type: String, default: null }, // Execution engine trade id
    createdAt: { type: Date, default: Date.now },
    closedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

tradeSchema.index({ mode: 1, createdAt: -1 });
tradeSchema.index({ mode: 1, status: 1 });

module.exports = mongoose.model('Trade', tradeSchema);
