/**
 * CoinDCX API Module
 * REST API integration for real trading
 *
 * Env: COINDCX_API_KEY, COINDCX_SECRET
 * Docs: https://docs.coindcx.com/
 */

const crypto = require('crypto');

const BASE_URL = 'https://api.coindcx.com';
const PUBLIC_URL = 'https://public.coindcx.com';

/**
 * Generate HMAC-SHA256 signature for authenticated requests
 * @param {string} secret - API secret
 * @param {string} payload - JSON string payload (compact, no spaces)
 * @returns {string} Hex digest signature
 */
function generateSignature(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Make authenticated request to CoinDCX API
 * @param {string} path - API path (e.g., '/exchange/v1/users/balances')
 * @param {Object} body - Request body
 * @param {string} method - HTTP method (default POST)
 * @returns {Promise<Object>} Response data
 */
async function authenticatedRequest(path, body, method = 'POST') {
  const apiKey = process.env.COINDCX_API_KEY;
  const secret = process.env.COINDCX_SECRET;

  if (!apiKey || !secret) {
    throw new Error('COINDCX_API_KEY and COINDCX_SECRET must be set');
  }

  const payload = JSON.stringify(body);
  const signature = generateSignature(secret, payload);

  const url = `${BASE_URL}${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-AUTH-APIKEY': apiKey,
      'X-AUTH-SIGNATURE': signature,
    },
    body: method === 'POST' ? payload : undefined,
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const errMsg = data.message || data.error || response.statusText;
    throw new Error(`CoinDCX API error: ${errMsg}`);
  }

  return data;
}

/**
 * Get user balances
 * @returns {Promise<Array>} Array of balance objects { currency, balance, locked }
 */
async function getBalance() {
  const body = { timestamp: Date.now() };
  const data = await authenticatedRequest('/exchange/v1/users/balances', body);

  if (Array.isArray(data)) {
    return data;
  }
  throw new Error('Invalid balance response');
}

/**
 * Get available balance for a specific currency (e.g., USDT, INR)
 * Handles both array format [{currency, balance, locked}] and object format {USDT: {balance, locked}}
 * @param {string} currency - Currency code
 * @returns {Promise<number>} Available balance
 */
async function getAvailableBalance(currency = 'USDT') {
  const data = await getBalance();
  const curr = currency.toUpperCase();

  let balance = 0;
  let locked = 0;

  if (Array.isArray(data)) {
    const item = data.find((b) => b.currency && b.currency.toUpperCase() === curr);
    balance = parseFloat(item?.balance ?? item?.available ?? 0);
    locked = parseFloat(item?.locked ?? 0);
  } else if (data && typeof data === 'object') {
    const item = data[curr] ?? data[currency];
    if (item) {
      balance = parseFloat(item.balance ?? item.available ?? 0);
      locked = parseFloat(item.locked ?? 0);
    }
  }

  return Math.max(0, balance - locked);
}

/**
 * Convert symbol to CoinDCX market format
 * BTC/USDT -> BTCUSDT (or from markets_details)
 * @param {string} symbol - Trading pair (e.g., 'BTC/USDT')
 * @returns {string} CoinDCX market name
 */
function symbolToMarket(symbol) {
  const mapping = {
    'BTC/USDT': 'BTCUSDT',
    'BTC/INR': 'BTCINR',
    'ETH/USDT': 'ETHUSDT',
    'ETH/INR': 'ETHINR',
    'SOL/USDT': 'SOLUSDT',
    'SOL/INR': 'SOLINR',
  };
  return mapping[symbol] || symbol.replace('/', '');
}

/**
 * Place order on CoinDCX
 * @param {Object} params
 * @param {string} params.symbol - Trading pair (e.g., 'BTC/USDT')
 * @param {string} params.side - 'buy' or 'sell'
 * @param {number} params.quantity - Order quantity (in base currency for buy)
 * @param {number} [params.price] - Limit price (required for limit_order)
 * @param {string} [params.orderType] - 'limit_order' | 'market_order' | 'stop_limit'
 * @param {number} [params.stopPrice] - Trigger price (required for stop_limit)
 * @returns {Promise<Object>} Order response { id, status, ... }
 */
async function placeOrder({ symbol, side, quantity, price, orderType = 'limit_order', stopPrice }) {
  const market = symbolToMarket(symbol);
  const sideLower = side.toLowerCase();

  const body = {
    side: sideLower,
    order_type: orderType,
    market,
    total_quantity: quantity,
    timestamp: Date.now(),
  };

  if (orderType === 'limit_order' && price != null) {
    body.price_per_unit = price;
  }

  if (orderType === 'stop_limit') {
    if (stopPrice == null) throw new Error('stopPrice required for stop_limit');
    body.stop_price = stopPrice;
    body.price_per_unit = price != null ? price : stopPrice;
  }

  const data = await authenticatedRequest('/exchange/v1/orders/create', body);
  return data;
}

/**
 * Place stop-loss order (stop_limit) on CoinDCX
 * For LONG: sell when price drops to stopPrice
 * For SHORT cover: buy when price rises to stopPrice
 * @param {Object} params
 * @param {string} params.symbol - Trading pair
 * @param {string} params.side - 'buy' or 'sell'
 * @param {number} params.quantity - Order quantity
 * @param {number} params.stopPrice - Trigger price
 * @param {number} [params.limitPrice] - Limit price (defaults to stopPrice; use slightly worse for fill certainty)
 * @returns {Promise<Object>} Order response { id, status, ... }
 */
async function placeStopLossOrder({ symbol, side, quantity, stopPrice, limitPrice }) {
  const price = limitPrice != null ? limitPrice : stopPrice;
  return placeOrder({
    symbol,
    side,
    quantity,
    price,
    orderType: 'stop_limit',
    stopPrice,
  });
}

/**
 * Get order status
 * @param {string} orderId - Order ID
 * @returns {Promise<Object>} Order details { id, status, ... }
 */
async function getOrderStatus(orderId) {
  const body = {
    id: orderId,
    timestamp: Date.now(),
  };
  const data = await authenticatedRequest('/exchange/v1/orders/status', body);
  return data;
}

/**
 * Cancel order
 * @param {string} orderId - Order ID
 * @returns {Promise<Object>} Cancel response
 */
async function cancelOrder(orderId) {
  const body = {
    id: orderId,
    timestamp: Date.now(),
  };
  const data = await authenticatedRequest('/exchange/v1/orders/cancel', body);
  return data;
}

/**
 * Fetch ticker from CoinDCX API (no auth)
 * @param {string} market - Market name (e.g., 'BTCUSDT')
 * @returns {Promise<Object>} Ticker with last_price, bid, ask
 */
async function fetchTicker(market = 'BTCUSDT') {
  const url = `${BASE_URL}/exchange/ticker`;
  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(`CoinDCX ticker error: ${data.message || response.statusText}`);
  }

  const ticker = Array.isArray(data)
    ? data.find((t) => t.market && t.market.toUpperCase() === market.toUpperCase())
    : data;
  return ticker || { last_price: 0, bid: 0, ask: 0 };
}

/**
 * Fetch candles from CoinDCX public API
 * @param {string} pair - Pair (e.g., 'B-BTC_USDT')
 * @param {string} interval - Candle interval (1m, 5m, 1h, etc.)
 * @param {number} [limit] - Number of candles
 * @returns {Promise<Array>} Candles [{ open, high, low, close, volume, time }]
 */
async function fetchCandles(pair = 'B-BTC_USDT', interval = '5m', limit = 100) {
  const url = `${PUBLIC_URL}/market_data/candles?pair=${encodeURIComponent(pair)}&interval=${interval}&limit=${limit}`;
  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(`CoinDCX candles error: ${data.message || response.statusText}`);
  }

  return Array.isArray(data) ? data : [];
}

/**
 * Get pair from symbol (BTC/USDT -> B-BTC_USDT for Binance)
 * @param {string} symbol - Trading pair
 * @returns {string} CoinDCX pair
 */
function symbolToPair(symbol) {
  const mapping = {
    'BTC/USDT': 'B-BTC_USDT',
    'ETH/USDT': 'B-ETH_USDT',
    'SOL/USDT': 'B-SOL_USDT',
    'BTC/INR': 'I-BTC_INR',
    'ETH/INR': 'I-ETH_INR',
    'SOL/INR': 'I-SOL_INR',
  };
  return mapping[symbol] || `B-${symbol.replace('/', '_')}`;
}

module.exports = {
  generateSignature,
  getBalance,
  getAvailableBalance,
  placeOrder,
  placeStopLossOrder,
  getOrderStatus,
  cancelOrder,
  fetchTicker,
  fetchCandles,
  symbolToMarket,
  symbolToPair,
};
