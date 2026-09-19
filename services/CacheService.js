/**
 * In-memory cache for train search results.
 */
const NodeCache = require("node-cache");

const ttlSeconds = customConfig.CACHE_TTL_SECONDS ?? 300;

/*
 * maxKeys is a hard bound, not a tuning knob: /place/suggest keys off arbitrary
 * user text, so without it a single crawler fills the heap for a whole TTL.
 * node-cache throws once the bound is reached rather than evicting, so set()
 * swallows that - dropping a cache write is always better than failing the
 * request that produced it.
 */
const cache = new NodeCache({
  stdTTL: ttlSeconds,
  checkperiod: 60,
  maxKeys: customConfig.CACHE_MAX_KEYS,
});

function isEnabled() {
  return customConfig.CACHE_ENABLED !== false;
}

function get(key) {
  if (!isEnabled()) return undefined;
  return cache.get(key);
}

function set(key, value, ttlSeconds) {
  if (!isEnabled()) return;
  try {
    if (ttlSeconds !== undefined) {
      cache.set(key, value, ttlSeconds);
    } else {
      cache.set(key, value);
    }
  } catch (err) {
    LogService.error("Cache set failed:", err.message || err);
  }
}

function getStats() {
  return cache.getStats();
}

function getKeys() {
  return cache.keys();
}

function del(key) {
  if (!isEnabled()) return false;
  return cache.del(key);
}

function delPattern(pattern) {
  if (!isEnabled()) return 0;
  const keys = cache.keys();
  const regex = new RegExp(pattern);
  let deleted = 0;
  keys.forEach((key) => {
    if (regex.test(key)) {
      if (cache.del(key)) {
        deleted++;
      }
    }
  });
  return deleted;
}

function flushAll() {
  if (!isEnabled()) return;
  cache.flushAll();
}

module.exports = { get, set, isEnabled, getStats, getKeys, del, delPattern, flushAll };
