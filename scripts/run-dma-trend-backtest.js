#!/usr/bin/env node
/**
 * Run DMA Trend strategy backtest
 * Usage: node scripts/run-dma-trend-backtest.js [--multi]
 *
 * Uses 4H + 1D timeframes. Daily SMA200 crossover with ADX > 20.
 * --multi: Run on multiple symbols (BTC, ETH, SOL), max 2 open trades.
 */

require('dotenv').config();
const { runBacktest } = require('../src/modules/backtest');

async function main() {
  const useMultiSymbol = process.argv.includes('--multi');

  const result = await runBacktest({
    symbol: 'BTC/USDT',
    symbols: useMultiSymbol ? ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'] : null,
    timeframe: '4h',
    from: '2022-01-01',
    to: '2024-06-30',
    initialBalance: 10000,
    strategy: 'dmaTrend',
    debug: false,
  });

  console.log('\n=== DMA Trend Backtest Results ===\n');
  console.log('Strategy:', result.meta.strategy);
  console.log('Symbols:', result.meta.symbols?.join(', ') || 'single');
  console.log('Timeframes:', result.meta.ltfTimeframe, '+', result.meta.htfTimeframe);
  console.log('Period:', result.meta.candles?.ltf, 'LTF candles,', result.meta.candles?.htf, 'HTF candles');
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
