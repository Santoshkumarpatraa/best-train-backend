require("dotenv").config();
require("../config/globals");
const pg = require("pg");
const { getBrowserHeaders } = require("../services/browserHeaders");
const { chunk, toIntOrNull, sleep } = require("./utils");

async function fetchWithTimeout(url, options = {}, timeoutMs = 45000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTrainList(url) {
  const greq = Math.floor(Date.now() / 1000);
  const requestUrl = `${url}?greq=${greq}`;
  const headers = getBrowserHeaders({
    "Content-Type": "application/x-www-form-urlencoded",
    Referer: `${customConfig.IRCTC_ORIGIN}/`,
    Origin: customConfig.IRCTC_ORIGIN,
    greq: String(greq),
  });

  const maxAttempts = 5;
  const baseDelayMs = 2000;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // eslint-disable-next-line no-console
      console.log(`Attempt ${attempt}/${maxAttempts}: Fetching train list...`);
      const res = await fetchWithTimeout(requestUrl, {
        method: "GET",
        headers,
      }, 45000);

      if (!res.ok) {
        throw new Error(`Failed to fetch train list: ${res.status} ${res.statusText}`);
      }

      const text = await res.text();
      const json = text.trim() ? `[${text.trim()}]` : "[]";
      return JSON.parse(json);
    } catch (err) {
      lastError = err;
      // eslint-disable-next-line no-console
      console.error(`Attempt ${attempt} failed:`, err.message);
      if (attempt < maxAttempts) {
        const delayMs = baseDelayMs * attempt;
        // eslint-disable-next-line no-console
        console.log(`Retrying in ${delayMs}ms...`);
        await sleep(delayMs);
      }
    }
  }

  // After all retries fail, log the error but don't throw - allow script to continue
  // eslint-disable-next-line no-console
  console.error(`All ${maxAttempts} fetch attempts failed. Continuing with empty train list.`);
  return [];
}

/**
 * Parse train list response. Each item is "train_number - train_name"
 * e.g. "22637 - WEST COAST EXP", "05299 - MFP TPJ SPL"
 */
function parseTrainItem(item) {
  if (typeof item !== "string") {
    return null;
  }
  const trimmed = item.trim();
  const sep = " - ";
  const idx = trimmed.indexOf(sep);
  if (idx < 0) {
    return null;
  }
  const trainNumberStr = trimmed.slice(0, idx).trim();
  const trainName = trimmed.slice(idx + sep.length).trim();
  const trainNumber = toIntOrNull(trainNumberStr);
  if (!trainNumber || trainNumber < 1 || !trainName) {
    return null;
  }
  return { train_number: trainNumber, train_name: trainName };
}

async function upsertBatch(client, trains) {
  const cols = ["train_number", "train_name"];

  const values = [];
  const rowsSql = trains
    .map((t, rowIdx) => {
      const base = rowIdx * cols.length;
      values.push(t.train_number, t.train_name);
      const ph = cols.map((_, colIdx) => `$${base + colIdx + 1}`);
      return `(${ph.join(",")})`;
    })
    .join(",\n");

  const sql = `
    INSERT INTO trains (
      train_number, train_name, updated_at
    )
    SELECT
      v.train_number::int,
      v.train_name,
      now()
    FROM (VALUES
      ${rowsSql}
    ) AS v(${cols.join(",")})
    ON CONFLICT (train_number) DO UPDATE SET
      train_name = EXCLUDED.train_name,
      updated_at = now()
  `;

  await client.query(sql, values);
}

async function main() {
  const url = customConfig.TRAIN_LIST_URL;
  const databaseUrl = customConfig.DATABASE_URL;
  const truncate = process.argv.includes("--truncate");
  const batchSize = customConfig.BATCH_SIZE ?? 500;
  const boundedBatchSize = Math.max(
    1,
    Math.min(Number.isFinite(batchSize) ? batchSize : 500, 2000)
  );

  if (!url) {
    console.error("TRAIN_LIST_URL is required");
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log(`Syncing trains from: ${url}`);

  const raw = await fetchTrainList(url);
  if (!Array.isArray(raw)) {
    throw new Error("Train list API must return an array");
  }

  const byNumber = new Map();
  for (const item of raw) {
    const parsed = parseTrainItem(item);
    if (!parsed) continue;
    if (!byNumber.has(parsed.train_number)) {
      byNumber.set(parsed.train_number, {
        train_number: parsed.train_number,
        train_name: parsed.train_name,
      });
    }
  }
  const normalized = Array.from(byNumber.values());

  // eslint-disable-next-line no-console
  console.log(
    `Parsed ${normalized.length} unique trains (valid train_number + train_name).`
  );

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    if (truncate) {
      await client.query("TRUNCATE train_route CASCADE");
      await client.query("TRUNCATE trains CASCADE");
      // eslint-disable-next-line no-console
      console.log("Truncated trains and train_route tables");
    }

    for (const group of chunk(normalized, boundedBatchSize)) {
      await upsertBatch(client, group);
      // eslint-disable-next-line no-console
      console.log(`Upserted batch: ${group.length}`);
    }
  } finally {
    await client.end();
  }

  // eslint-disable-next-line no-console
  console.log("Sync complete.");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
