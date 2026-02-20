#!/usr/bin/env node
/**
 * Run trend breakout strategy backtest
 * Usage: node scripts/run-trend-breakout-backtest.js
 *
 * Uses a long period (2 years) to ensure at least 100 trades.
 */

require('dotenv').config();
const { runBacktest } = require('../src/modules/backtest');

async function main() {
  const result = await runBacktest({
    symbol: 'BTC/USDT',
    timeframe: '5m',
    from: '2022-01-01',
    to: '2024-12-31',
    initialBalance: 10000,
    strategy: 'trendBreakout',
    debug: false,
  });

  console.log('\n=== Trend Breakout Backtest Results ===\n');
  console.log('Strategy:', result.meta.strategy);
  console.log('Period:', result.meta.candles?.ltf, 'candles (5m)');
  console.log('Total Trades:', result.totalTrades);
  console.log('Win Rate:', result.winRate + '%');
  console.log('Profit Factor:', result.profitFactor);
  console.log('Max Drawdown:', result.maxDrawdown + '%');
  console.log('Total PnL:', result.totalPnl.toFixed(2), `(${result.totalPnlPercent}%)`);
  console.log('\n--- Strategy Metrics ---');
  console.log('Avg Win:', result.avgWin?.toFixed(4) ?? 'N/A');
  console.log('Avg Loss:', result.avgLoss?.toFixed(4) ?? 'N/A');
  console.log('Expectancy:', result.expectancy?.toFixed(4) ?? 'N/A');
  console.log('Avg R-Multiple:', result.avgRMultiple ?? 'N/A');
  console.log('\nFinal Balance:', result.finalBalance.toFixed(2));

  if (result.totalTrades < 100) {
    console.warn('\n⚠️  Warning: Only', result.totalTrades, 'trades. Consider extending the backtest period for 100+ trades.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
