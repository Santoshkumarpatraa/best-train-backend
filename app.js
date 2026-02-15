require("./config/globals");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const app = express();
const port = customConfig.PORT || 3000;

app.use(express.json());
app.use(helmet());

// CORS: allow configured origins (default: *)
const corsOrigin = customConfig.CORS_ORIGIN;
app.use(
  cors({
    origin:
      corsOrigin === "*"
        ? "*"
        : corsOrigin.split(",").map((o) => o.trim()).filter(Boolean),
  })
);

// Rate limiting: limit requests per window (default: 100/min)
app.use(
  rateLimit({
    windowMs: customConfig.RATE_LIMIT_WINDOW_MS,
    max: customConfig.RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Log all requests and responses
app.use(LogService.reqLogger);

app.use("", require("./config/routes"));

// Global error handler (must be last)
app.use((err, req, res, next) => {
  LogService.error(err);
  const status = err.status || err.statusCode || 500;
  const message =
    status >= 500
      ? ConstantService.responseMessage.ERR_OOPS_SOMETHING_WENT_WRONG
      : err.message || "Bad request";
  return res.status(status).json({ message });
});

const server = app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

// Graceful shutdown
function shutdown(signal) {
  LogService.info(`${signal} received, shutting down gracefully`);
  server.close(() => {
    LogService.info("HTTP server closed");
    SqlService.pool
      .end()
      .then(() => {
        LogService.info("Database pool closed");
        process.exit(0);
      })
      .catch((err) => {
        LogService.error("Error closing pool:", err);
        process.exit(1);
      });
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
