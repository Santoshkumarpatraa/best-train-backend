/**
 * Shared utilities for sync scripts.
 */
const { getBrowserHeaders } = require("../services/browserHeaders");

module.exports = {
  chunk: (arr, size) => Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size)),
  toIntOrNull: (v) => {
    if (v == null) return null;
    if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
    const n = parseInt(String(v).trim(), 10);
    return Number.isFinite(n) ? n : null;
  },
  toStringOrNull: (v) => (v == null ? null : ((s) => (s || null))(String(v).trim())),
  toBool: (v) => v != null && ["Y", "YES", "1", "TRUE"].includes(String(v).toUpperCase()),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  fetchJson: async (url, extraHeaders = {}) => {
    const res = await fetch(url, { headers: getBrowserHeaders(extraHeaders) });
    if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
    return res.json();
  },
};
