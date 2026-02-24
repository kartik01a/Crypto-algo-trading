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

// Cache symbol stepSize from exchange info (Binance requires exact precision per symbol)
let exchangeInfoCache = null;

/**
 * Generate HMAC-SHA256 signature for authenticated requests
 */
function generateSignature(secret, queryString) {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

/**
 * Make authenticated request to Binance Futures API
 * @param {boolean} [returnError] - If true, return { ok, data, code, msg } instead of throwing
 */
async function authenticatedRequest(method, path, params = {}, returnError = false) {
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
    if (returnError) return { ok: false, code: data.code, msg: data.msg || data.message || response.statusText };
    const errMsg = data.msg || data.message || response.statusText;
    throw new Error(`Binance API error: ${errMsg}`);
  }

  return returnError ? { ok: true, data } : data;
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
 * Fetch exchange info and cache symbol step sizes (public endpoint, no auth)
 */
async function fetchExchangeInfo() {
  if (exchangeInfoCache) return exchangeInfoCache;
  const url = `${BASE_URL}/fapi/v1/exchangeInfo`;
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) throw new Error(`Exchange info error: ${data.msg || response.statusText}`);
  exchangeInfoCache = data;
  return data;
}

/**
 * Get stepSize for a symbol from Binance LOT_SIZE filter
 */
async function getStepSize(symbol) {
  const market = symbolToMarket(symbol);
  const info = await fetchExchangeInfo();
  const sym = (info.symbols || []).find((s) => s.symbol === market);
  if (!sym) return 0.001; // fallback
  const lotFilter = (sym.filters || []).find((f) => f.filterType === 'LOT_SIZE');
  const step = parseFloat(lotFilter?.stepSize || '0.001');
  return step > 0 ? step : 0.001;
}

/**
 * Format quantity for Binance using symbol's stepSize (avoids "Precision is over the maximum" error)
 */
async function formatQuantity(symbol, quantity) {
  const step = await getStepSize(symbol);
  const q = parseFloat(quantity);
  const precision = step >= 1 ? 0 : step.toString().split('.')[1]?.replace(/0+$/, '').length || 8;
  const rounded = Math.floor(q / step) * step;
  return rounded.toFixed(precision);
}

/**
 * Place market order (entry or close)
 * @param {Object} params - { symbol, side: 'BUY'|'SELL', quantity, reduceOnly?: boolean }
 */
async function placeMarketOrder({ symbol, side, quantity, reduceOnly = false }) {
  const market = symbolToMarket(symbol);
  const qty = await formatQuantity(symbol, quantity);
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
 * Uses Algo Order API - required for XRP, ADA and other symbols (regular order API rejects TRAILING_STOP_MARKET)
 * @param {Object} params - { symbol, side: 'BUY'|'SELL', quantity, callbackRate }
 * @param {number} params.callbackRate - Trail % (e.g. 2 = 2% for Binance, min 0.1 max 10)
 * @param {number} [params.activationPrice] - Optional; omit to start tracking immediately
 */
async function placeTrailingStopOrder({ symbol, side, quantity, callbackRate, activationPrice }) {
  const market = symbolToMarket(symbol);
  const qty = await formatQuantity(symbol, quantity);
  const params = {
    algoType: 'CONDITIONAL',
    symbol: market,
    side: side.toUpperCase(),
    type: 'TRAILING_STOP_MARKET',
    quantity: qty,
    reduceOnly: 'true',
    callbackRate: String(Math.min(10, Math.max(0.1, callbackRate))),
  };
  if (activationPrice != null) {
    params.activatePrice = String(activationPrice);
  }
  const data = await authenticatedRequest('POST', '/fapi/v1/algoOrder', params);
  return { orderId: data.algoId, order_id: data.algoId, algoId: data.algoId };
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
 * Get order status (regular or algo - tries both for compatibility with trailing stops)
 */
async function getOrderStatus(symbol, orderId) {
  const market = symbolToMarket(symbol);
  const id = String(orderId);
  const regular = await authenticatedRequest('GET', '/fapi/v1/order', { symbol: market, orderId: id }, true);
  if (regular.ok) return regular.data;
  if (regular.code === -2011 || regular.msg?.includes('Unknown order') || regular.msg?.includes('Order does not exist')) {
    const algo = await authenticatedRequest('GET', '/fapi/v1/algoOrder', { algoId: id });
    return { status: algo.algoStatus || algo.status, order_status: algo.algoStatus, avgPrice: algo.avgPrice, average_price: algo.avgPrice, ...algo };
  }
  throw new Error(`Binance API error: ${regular.msg}`);
}

/**
 * Cancel order (regular or algo - tries both for compatibility with trailing stops)
 */
async function cancelOrder(symbol, orderId) {
  const market = symbolToMarket(symbol);
  const id = String(orderId);
  const regular = await authenticatedRequest('DELETE', '/fapi/v1/order', { symbol: market, orderId: id }, true);
  if (regular.ok) return regular.data;
  if (regular.code === -2011 || regular.msg?.includes('Unknown order') || regular.msg?.includes('Order does not exist')) {
    const algo = await authenticatedRequest('DELETE', '/fapi/v1/algoOrder', { algoId: id });
    return algo;
  }
  throw new Error(`Binance API error: ${regular.msg}`);
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
