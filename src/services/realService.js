/**
 * Real Trading API Service
 */

const {
  startRealTrading,
  stopRealTrading,
  getRealStatus,
} = require('../modules/real');

async function start(options = {}) {
  return startRealTrading(options);
}

function stop() {
  return stopRealTrading();
}

function getStatus() {
  return getRealStatus();
}

module.exports = {
  start,
  stop,
  getStatus,
};
