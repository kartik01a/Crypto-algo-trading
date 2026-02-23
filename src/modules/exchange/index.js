/**
 * Exchange module - CCXT wrapper for Binance, CoinDCX for INR pairs
 * Fetches OHLCV data and ticker information
 */

const ccxt = require('ccxt');
const config = require('../../config');
const { fetchCandles: fetchCoinDCXCandles, symbolToPair } = require('../coindcx');

let exchangeInstance = null;

/**
 * Get or create exchange instance
 * @returns {ccxt.Exchange}
 */
function getExchange() {
  if (!exchangeInstance) {
    const ExchangeClass = ccxt[config.exchange.id] || ccxt.binance;
    exchangeInstance = new ExchangeClass(config.exchange.options);
  }
  return exchangeInstance;
}

/**
 * Check if symbol is INR pair (e.g. ETH/INR, BTC/INR)
 */
function isINRPair(symbol) {
  return symbol && symbol.toUpperCase().endsWith('/INR');
}

/**
 * Convert CoinDCX candle to OHLCV array format
 */
function candleToOHLCV(candle) {
  return [candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume || 0];
}

/**
 * Fetch OHLCV candle data
 * Uses CoinDCX for INR pairs (paper/backtest with Indian capital); Binance for USDT
 * @param {string} symbol - Trading pair (e.g., 'BTC/USDT' or 'ETH/INR')
 * @param {string} timeframe - Candle timeframe (e.g., '5m', '1h', '4h')
 * @param {number} [since] - Start timestamp in ms
 * @param {number} [limit] - Number of candles to fetch (default 100)
 * @returns {Promise<Array>} Array of [timestamp, open, high, low, close, volume]
 */
async function fetchOHLCV(symbol, timeframe, since = undefined, limit = 100) {
  try {
    if (isINRPair(symbol)) {
      const pair = symbolToPair(symbol);
      const candles = await fetchCoinDCXCandles(pair, timeframe, limit);
      return candles.map(candleToOHLCV).sort((a, b) => a[0] - b[0]);
    }
    const exchange = getExchange();
    const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, since, limit);
    return ohlcv;
  } catch (error) {
    throw new Error(`Exchange fetchOHLCV failed: ${error.message}`);
  }
}

/**
 * Fetch current ticker for symbol
 * @param {string} symbol - Trading pair (e.g., 'BTC/USDT')
 * @returns {Promise<Object>} Ticker data with last, bid, ask, etc.
 */
async function fetchTicker(symbol) {
  try {
    if (isINRPair(symbol)) {
      const { fetchTicker: fetchCoinDCXTicker, symbolToMarket } = require('../coindcx');
      const market = symbolToMarket(symbol);
      const ticker = await fetchCoinDCXTicker(market);
      return {
        last: parseFloat(ticker.last_price || ticker.bid || 0),
        bid: parseFloat(ticker.bid || 0),
        ask: parseFloat(ticker.ask || 0),
      };
    }
    const exchange = getExchange();
    const ticker = await exchange.fetchTicker(symbol);
    return ticker;
  } catch (error) {
    throw new Error(`Exchange fetchTicker failed: ${error.message}`);
  }
}

/**
 * Fetch latest closed candle for paper trading
 * @param {string} symbol - Trading pair
 * @param {string} timeframe - Candle timeframe
 * @returns {Promise<Array>} Single candle [timestamp, open, high, low, close, volume]
 */
async function fetchLatestCandle(symbol, timeframe) {
  const ohlcv = await fetchOHLCV(symbol, timeframe, undefined, 2);
  // Return the last closed candle (second to last, as last might be incomplete)
  return ohlcv.length >= 2 ? ohlcv[ohlcv.length - 2] : ohlcv[ohlcv.length - 1];
}

module.exports = {
  getExchange,
  fetchOHLCV,
  fetchTicker,
  fetchLatestCandle,
  isINRPair,
};
