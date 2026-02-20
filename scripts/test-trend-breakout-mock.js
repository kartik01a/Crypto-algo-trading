#!/usr/bin/env node
/**
 * Unit test for trend breakout strategy with mock data
 * Verifies logic without network calls.
 */

const { trendBreakoutStrategy } = require('../src/modules/strategy/trendBreakoutStrategy');

// Generate mock OHLCV: uptrend with EMA50 > EMA200, then a breakout
function makeCandle(ts, open, high, low, close) {
  return [ts, open, high, low, close, 1000];
}

// Build 250 candles: flat then uptrend, EMA50 > EMA200, ATR ~0.5%, breakout at end
const basePrice = 50000;
const candles = [];
let ts = Date.now() - 250 * 5 * 60 * 1000; // 5m candles

for (let i = 0; i < 250; i++) {
  const t = i / 250;
  // Uptrend: price drifts up, pullbacks
  const trend = basePrice * (1 + t * 0.1);
  const noise = Math.sin(i * 0.3) * 200;
  const close = trend + noise;
  const high = close + 100;
  const low = close - 150;
  const open = candles.length ? candles[candles.length - 1][4] : close - 50;
  candles.push(makeCandle(ts, open, high, low, close));
  ts += 5 * 60 * 1000;
}

// Create breakout + pullback + bounce sequence
const len = candles.length;
const breakoutIdx = len - 3;
const prev20Highs = candles.slice(breakoutIdx - 20, breakoutIdx).map((c) => c[2]);
const hh = Math.max(...prev20Highs);
// Breakout candle
candles[breakoutIdx][1] = hh;
candles[breakoutIdx][2] = hh + 450;
candles[breakoutIdx][3] = hh - 50;
candles[breakoutIdx][4] = hh + 400;
// Pullback candle
candles[len - 2][4] = hh + 100;
candles[len - 2][1] = hh + 150;
candles[len - 2][2] = hh + 180;
const { EMA } = require('technicalindicators');
const closes = candles.map((c) => c[4]);
const ema20Vals = EMA.calculate({ values: closes, period: 20 });
// EMA returns length n-period+1; last value is for last candle, second-last for pullback candle
const ema20Pullback = ema20Vals[ema20Vals.length - 2];
candles[len - 2][3] = ema20Pullback - 5;
// Bounce candle
candles[len - 1][1] = ema20Pullback + 20;
candles[len - 1][4] = ema20Pullback + 100;
candles[len - 1][2] = ema20Pullback + 120;
candles[len - 1][3] = ema20Pullback + 10;

const result = trendBreakoutStrategy({ ltfOhlcv: candles });

console.log('Trend Breakout Strategy Test:');
console.log('  Signal:', result.signal);
console.log('  Price:', result.price);
console.log('  Stop Loss:', result.stopLoss);
console.log('  ATR:', result.atr);
console.log('  Debug:', result.debug?.reason);

if (result.signal === 'BUY' && result.stopLoss && result.stopLoss < result.price) {
  console.log('\n✓ Strategy returns BUY with valid stop loss');
  const slPercent = ((result.price - result.stopLoss) / result.price) * 100;
  console.log('  SL distance:', slPercent.toFixed(2) + '% (expected ~1%)');
  if (Math.abs(slPercent - 1) < 0.5) {
    console.log('✓ SL is ~1% below entry');
  }
} else {
  console.log('\n✗ Unexpected result - check strategy logic');
  process.exit(1);
}
