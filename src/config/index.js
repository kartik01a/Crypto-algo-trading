/**
 * Application configuration
 */

module.exports = {
  // Server
  port: process.env.PORT || 3000,

  // Exchange (Binance default)
  exchange: {
    id: 'binance',
    options: {
      enableRateLimit: true,
      timeout: 30000,
    },
  },

  // Trading parameters
  trading: {
    fee: 0.001, // 0.1%
    slippage: 0.0005, // 0.05%
  },

  // Strategy defaults
  strategy: {
    emaShort: 9,
    emaLong: 21,
    emaTrend: 50,
    rsiPeriod: 14,
    rsiOversold: 30,
    rsiOverbought: 70,
    atrPeriod: 14,
    atrThresholdPercent: 0.5, // Min ATR as % of price to trade
  },

  // Risk management defaults
  risk: {
    initialBalance: 10000,
    riskPerTrade: 0.01, // 1%
    maxTradesPerDay: 3,
    maxDailyLoss: 0.05, // 5%
    maxDrawdown: 0.10, // 10%
    stopLossPercent: 0.015, // 1.5%
    takeProfitPercent: 0.03, // 3%
    tradeCooldownMs: 600000, // 10 minutes
  },

  // Paper trading
  paper: {
    intervalMs: 60000, // 1 minute
  },

  // Real trading (CoinDCX)
  real: {
    intervalMs: 60000, // 1 minute
    maxCapitalPerTrade: 0.05, // 5%
    maxOpenTrades: 1,
  },
};
