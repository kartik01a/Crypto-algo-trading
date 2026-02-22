#!/usr/bin/env node
/**
 * Run Golden Cross HTF strategy backtest
 * Usage: node scripts/run-golden-cross-htf-backtest.js [--multi]
 *
 * Uses 4H LTF + 1D HTF timeframes.
 * EMA crossover + ADX filter + percentage trailing stop.
 * --multi: Run on multiple symbols (BTC, ETH, SOL), rank by ADX/EMA distance, max 3 trades.
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
    strategy: 'goldenCrossHTF',
    debug: false,
  });

  console.log('\n=== Golden Cross HTF Backtest Results ===\n');
  console.log('Strategy:', result.meta.strategy);
  console.log('Symbols:', result.meta.symbols?.join(', ') || 'single');
  console.log('Timeframes:', result.meta.ltfTimeframe, '+', result.meta.htfTimeframe);
  console.log('Max Open Trades:', result.meta.maxOpenTrades);
  console.log('Period:', result.meta.candles?.ltf, 'LTF candles,', result.meta.candles?.htf, 'HTF candles');
  console.log('Total Trades:', result.totalTrades);
  console.log('Win Rate:', result.winRate + '%');
  console.log('Profit Factor:', result.profitFactor);
  console.log('Max Drawdown:', result.maxDrawdown + '%');
  console.log('Total PnL:', result.totalPnl?.toFixed(2), `(${result.totalPnlPercent}%)`);
  if (result.pnlBySymbol && Object.keys(result.pnlBySymbol).length > 0) {
    console.log('\nPnL by symbol:');
    for (const [sym, data] of Object.entries(result.pnlBySymbol)) {
      console.log(`  ${sym}: ${data.pnl?.toFixed(2)} (${data.trades} trades, ${data.winRate}% win)`);
    }
  }
  console.log('\nFinal Balance:', result.finalBalance?.toFixed(2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
