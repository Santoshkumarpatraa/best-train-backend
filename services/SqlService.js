const { Pool } = require("pg");

const pool = new Pool({
  connectionString: customConfig.DATABASE_URL,
  max: customConfig.PG_POOL_MAX,
  idleTimeoutMillis: customConfig.PG_POOL_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: customConfig.PG_POOL_CONNECTION_TIMEOUT_MS,
});

pool.on("error", (err) => {
  LogService.error("Unexpected pool error:", err);
});

module.exports = {
  pool,
  executeQuery: async (text, params = []) => {
    return pool.query(text, params);
  },
};
