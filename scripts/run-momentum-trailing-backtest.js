#!/usr/bin/env node
/**
 * Run Momentum Trailing strategy backtest
 * Usage: node scripts/run-momentum-trailing-backtest.js
 *
 * Uses 4H timeframe. Momentum + momentum change with EMA50 trend filter.
 * Activation-based trailing stop (1% activation, 0.5% trail).
 * Max 2 open trades, max 5 trades per day.
 */

require('dotenv').config();
const { runBacktest } = require('../src/modules/backtest');

async function main() {
  const result = await runBacktest({
    symbol: 'BTC/USDT',
    timeframe: '4h',
    from: '2022-01-01',
    to: '2024-06-30',
    initialBalance: 10000,
    strategy: 'momentumTrailing',
    debug: false,
  });

  console.log('\n=== Momentum Trailing Backtest Results ===\n');
  console.log('Strategy:', result.meta.strategy);
  console.log('Timeframe:', result.meta.ltfTimeframe);
  console.log('Period:', result.meta.candles?.ltf, 'candles');
  console.log('Total Trades:', result.totalTrades);
  console.log('Win Rate:', result.winRate + '%');
  console.log('Profit Factor:', result.profitFactor);
  console.log('Max Drawdown:', result.maxDrawdown + '%');
  console.log('Total PnL:', result.totalPnl?.toFixed(2), `(${result.totalPnlPercent}%)`);
  console.log('\nFinal Balance:', result.finalBalance?.toFixed(2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
