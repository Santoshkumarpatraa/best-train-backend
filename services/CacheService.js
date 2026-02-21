/**
 * In-memory cache for train search results.
 */
const NodeCache = require("node-cache");

const ttlSeconds = customConfig.CACHE_TTL_SECONDS ?? 300;
const cache = new NodeCache({ stdTTL: ttlSeconds, checkperiod: 60 });

function isEnabled() {
  return customConfig.CACHE_ENABLED !== false;
}

function get(key) {
  if (!isEnabled()) return undefined;
  return cache.get(key);
}

function set(key, value) {
  if (!isEnabled()) return;
  cache.set(key, value);
}

function getStats() {
  return cache.getStats();
}

function getKeys() {
  return cache.keys();
}

module.exports = { get, set, isEnabled, getStats, getKeys };
