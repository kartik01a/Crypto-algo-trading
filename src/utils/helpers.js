/**
 * Utility helper functions
 */

/**
 * Parse date string to timestamp
 * @param {string} dateStr - Date string (YYYY-MM-DD)
 * @returns {number} Unix timestamp in ms
 */
function parseDate(dateStr) {
  return new Date(dateStr).getTime();
}

/**
 * Format timestamp to ISO string
 * @param {number} timestamp - Unix timestamp in ms
 * @returns {string} ISO date string
 */
function formatTimestamp(timestamp) {
  return new Date(timestamp).toISOString();
}

/**
 * Round to specified decimal places
 * @param {number} value - Number to round
 * @param {number} decimals - Decimal places
 * @returns {number}
 */
function roundTo(value, decimals = 8) {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

/**
 * Apply slippage to price
 * @param {number} price - Original price
 * @param {number} slippage - Slippage rate (e.g., 0.0005 for 0.05%)
 * @param {string} side - 'buy' or 'sell'
 * @returns {number} Adjusted price
 */
function applySlippage(price, slippage, side) {
  if (side === 'buy') {
    return price * (1 + slippage);
  }
  return price * (1 - slippage);
}

/**
 * Apply trading fee to amount
 * @param {number} amount - Trade amount
 * @param {number} fee - Fee rate (e.g., 0.001 for 0.1%)
 * @returns {number} Fee amount
 */
function calculateFee(amount, fee) {
  return amount * fee;
}

/**
 * Get start of day timestamp
 * @param {number} timestamp - Unix timestamp in ms
 * @returns {number} Start of day timestamp
 */
function getStartOfDay(timestamp) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

module.exports = {
  parseDate,
  formatTimestamp,
  roundTo,
  applySlippage,
  calculateFee,
  getStartOfDay,
};
