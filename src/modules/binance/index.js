/**
 * Binance Futures API Module
 * REST API for real trading with native trailing stop support
 *
 * Env: BINANCE_API_KEY, BINANCE_SECRET
 * Docs: https://developers.binance.com/docs/derivatives/usds-margined-futures
 *
 * Uses Binance Futures (fapi) for long + short support with TRAILING_STOP_MARKET.
 * App places entry + trailing stop once; Binance handles exit - no app dependency.
 */

const crypto = require('crypto');

const BASE_URL = 'https://fapi.binance.com';

/**
 * Generate HMAC-SHA256 signature for authenticated requests
 */
function generateSignature(secret, queryString) {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

/**
 * Make authenticated request to Binance Futures API
 */
async function authenticatedRequest(method, path, params = {}) {
  const apiKey = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_SECRET;

  if (!apiKey || !secret) {
    throw new Error('BINANCE_API_KEY and BINANCE_SECRET must be set');
  }

  params.timestamp = Date.now();
  const queryString = new URLSearchParams(params).toString();
  const signature = generateSignature(secret, queryString);

  const url = `${BASE_URL}${path}?${queryString}&signature=${signature}`;
  const response = await fetch(url, {
    method,
    headers: {
      'X-MBX-APIKEY': apiKey,
    },
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const errMsg = data.msg || data.message || response.statusText;
    throw new Error(`Binance API error: ${errMsg}`);
  }

  return data;
}

/**
 * Convert symbol to Binance format (BTC/USDT -> BTCUSDT)
 */
function symbolToMarket(symbol) {
  return (symbol || '').replace('/', '');
}

/**
 * Get account balance (USDT available)
 */
async function getAvailableBalance(currency = 'USDT') {
  const data = await authenticatedRequest('GET', '/fapi/v2/balance');
  const curr = currency.toUpperCase();
  const item = Array.isArray(data) ? data.find((b) => b.asset === curr) : null;
  if (!item) return 0;
  const available = parseFloat(item.availableBalance || item.balance || 0);
  return Math.max(0, available);
}

/**
 * Set leverage for a symbol (must be called before placing orders)
 * @param {string} symbol - Trading pair (e.g. BTC/USDT)
 * @param {number} leverage - 1 to 125 (e.g. 2 for 2x)
 */
async function setLeverage(symbol, leverage) {
  const market = symbolToMarket(symbol);
  return authenticatedRequest('POST', '/fapi/v1/leverage', {
    symbol: market,
    leverage: String(Math.round(leverage)),
  });
}

/**
 * Format quantity for Binance (BTC: 3 decimals, ETH: 3, etc.)
 */
function formatQuantity(symbol, quantity) {
  const market = symbolToMarket(symbol);
  const prec = market.startsWith('BTC') ? 3 : market.startsWith('ETH') ? 3 : 4;
  const q = parseFloat(quantity);
  const mult = Math.pow(10, prec);
  return (Math.floor(q * mult) / mult).toFixed(prec);
}

/**
 * Place market order (entry or close)
 * @param {Object} params - { symbol, side: 'BUY'|'SELL', quantity, reduceOnly?: boolean }
 */
async function placeMarketOrder({ symbol, side, quantity, reduceOnly = false }) {
  const market = symbolToMarket(symbol);
  const qty = formatQuantity(symbol, quantity);
  const params = {
    symbol: market,
    side: side.toUpperCase(),
    type: 'MARKET',
    quantity: qty,
  };
  if (reduceOnly) params.reduceOnly = 'true';
  return authenticatedRequest('POST', '/fapi/v1/order', params);
}

/**
 * Place trailing stop order (exit - Binance handles from here)
 * @param {Object} params - { symbol, side: 'BUY'|'SELL', quantity, callbackRate }
 * @param {number} params.callbackRate - Trail % (e.g. 0.02 = 2%, 2 = 2% for Binance)
 * @param {number} [params.activationPrice] - Optional; omit to start tracking immediately
 *
 * Binance Futures: callbackRate 0.1-5, where 1 = 1%
 * For long close: side=SELL, reduceOnly=true, triggers when price drops callbackRate from high
 * For short close: side=BUY, reduceOnly=true, triggers when price rises callbackRate from low
 */
async function placeTrailingStopOrder({ symbol, side, quantity, callbackRate, activationPrice }) {
  const market = symbolToMarket(symbol);
  const qty = formatQuantity(symbol, quantity);
  const params = {
    symbol: market,
    side: side.toUpperCase(),
    type: 'TRAILING_STOP_MARKET',
    quantity: qty,
    reduceOnly: 'true',
    callbackRate: String(callbackRate),
  };
  if (activationPrice != null) {
    params.activationPrice = String(activationPrice);
  }
  return authenticatedRequest('POST', '/fapi/v1/order', params);
}

/**
 * Fetch candles (OHLCV) from Binance Futures
 */
async function fetchCandles(symbol, interval = '5m', limit = 100) {
  const market = symbolToMarket(symbol);
  const params = new URLSearchParams({
    symbol: market,
    interval: interval,
    limit: String(limit),
  });
  const url = `${BASE_URL}/fapi/v1/klines?${params}`;
  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Binance candles error: ${data.msg || response.statusText}`);
  }

  // Binance: [openTime, open, high, low, close, volume, ...]
  return (Array.isArray(data) ? data : []).map((k) => [
    k[0],
    parseFloat(k[1]),
    parseFloat(k[2]),
    parseFloat(k[3]),
    parseFloat(k[4]),
    parseFloat(k[5]),
  ]);
}

/**
 * Fetch ticker (last price)
 */
async function fetchTicker(symbol) {
  const market = symbolToMarket(symbol);
  const params = new URLSearchParams({ symbol: market });
  const url = `${BASE_URL}/fapi/v1/ticker/price?${params}`;
  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Binance ticker error: ${data.msg || response.statusText}`);
  }

  const price = parseFloat(data.price || 0);
  return { last_price: price, bid: price, ask: price };
}

/**
 * Get order status
 */
async function getOrderStatus(symbol, orderId) {
  const market = symbolToMarket(symbol);
  return authenticatedRequest('GET', '/fapi/v1/order', {
    symbol: market,
    orderId: String(orderId),
  });
}

/**
 * Cancel order
 */
async function cancelOrder(symbol, orderId) {
  const market = symbolToMarket(symbol);
  return authenticatedRequest('DELETE', '/fapi/v1/order', {
    symbol: market,
    orderId: String(orderId),
  });
}

/**
 * Map timeframe to Binance interval
 */
function timeframeToInterval(timeframe) {
  const map = {
    '1m': '1m',
    '5m': '5m',
    '15m': '15m',
    '1h': '1h',
    '4h': '4h',
    '1d': '1d',
  };
  return map[timeframe] || timeframe || '5m';
}

module.exports = {
  symbolToMarket,
  getAvailableBalance,
  setLeverage,
  placeMarketOrder,
  placeTrailingStopOrder,
  fetchCandles,
  fetchTicker,
  getOrderStatus,
  cancelOrder,
  timeframeToInterval,
};
