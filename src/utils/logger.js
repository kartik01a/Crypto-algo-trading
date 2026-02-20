/**
 * Trading Logger - logs signals, trades, errors to console and file
 */

const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.LOG_DIR || path.join(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'trading.log');

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function formatLog(level, message, data = {}) {
  const timestamp = new Date().toISOString();
  const dataStr = Object.keys(data).length ? ` ${JSON.stringify(data)}` : '';
  return `${timestamp} [${level}] ${message}${dataStr}\n`;
}

function writeToFile(line) {
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch (err) {
    console.error('[Logger] Failed to write to file:', err.message);
  }
}

function log(level, message, data = {}) {
  const line = formatLog(level, message, data);
  console.log(line.trim());
  writeToFile(line);
}

function info(message, data) {
  log('INFO', message, data);
}

function warn(message, data) {
  log('WARN', message, data);
}

function error(message, data) {
  log('ERROR', message, data);
}

function signal(message, data) {
  log('SIGNAL', message, data);
}

function trade(message, data) {
  log('TRADE', message, data);
}

module.exports = {
  info,
  warn,
  error,
  signal,
  trade,
};
