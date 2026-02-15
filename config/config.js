/**
 * Custom configuration
 * All values fetched directly from process.env.
 * Load dotenv before requiring this.
 *
 */

module.exports = {
  DATABASE_URL: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/best_train",
  PORT: process.env.PORT || "3000",
  TRAIN_LIST_URL: process.env.TRAIN_LIST_URL,
  TRAIN_DETAILS_URL: process.env.TRAIN_DETAILS_URL,
  IRCTC_ORIGIN: (() => {
    if (process.env.IRCTC_ORIGIN) return process.env.IRCTC_ORIGIN;
    const url = process.env.TRAIN_LIST_URL || process.env.TRAIN_DETAILS_URL;
    return url ? new URL(url).origin : undefined;
  })(),
  SYNC_STATION_URL: process.env.SYNC_STATION_URL,
  SYNC_POPULAR_URL: process.env.SYNC_POPULAR_URL,
  BATCH_SIZE: process.env.BATCH_SIZE ? parseInt(process.env.BATCH_SIZE, 10) : undefined,
  SYNC_TRAIN_DELAY_MS: process.env.SYNC_TRAIN_DELAY_MS
    ? parseInt(process.env.SYNC_TRAIN_DELAY_MS, 10)
    : undefined,
  SYNC_TRAIN_ALL: process.env.SYNC_TRAIN_ALL === "true",
  CORS_ORIGIN: process.env.CORS_ORIGIN || "*",
  RATE_LIMIT_WINDOW_MS: process.env.RATE_LIMIT_WINDOW_MS
    ? parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10)
    : 60 * 1000,
  RATE_LIMIT_MAX: process.env.RATE_LIMIT_MAX
    ? parseInt(process.env.RATE_LIMIT_MAX, 10)
    : 100,
  PG_POOL_MAX: process.env.PG_POOL_MAX
    ? parseInt(process.env.PG_POOL_MAX, 10)
    : 10,
  PG_POOL_IDLE_TIMEOUT_MS: process.env.PG_POOL_IDLE_TIMEOUT_MS
    ? parseInt(process.env.PG_POOL_IDLE_TIMEOUT_MS, 10)
    : 30000,
  PG_POOL_CONNECTION_TIMEOUT_MS: process.env.PG_POOL_CONNECTION_TIMEOUT_MS
    ? parseInt(process.env.PG_POOL_CONNECTION_TIMEOUT_MS, 10)
    : 5000,
  CACHE_TTL_SECONDS: process.env.CACHE_TTL_SECONDS
    ? parseInt(process.env.CACHE_TTL_SECONDS, 10)
    : 300,
  CACHE_ENABLED: process.env.CACHE_ENABLED !== "false",
};
