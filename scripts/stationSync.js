/**
 * Shared station sync logic for sync-stations.js and sync-popular-stations.js.
 */
const pg = require("pg");
const { toIntOrNull, toStringOrNull, chunk, fetchJson } = require("./utils");

// --- Constants ---
const BATCH_SIZE_MIN = 1;
const BATCH_SIZE_MAX = 5000;
const BATCH_SIZE_DEFAULT = 1000;

const STATE_ALIASES = {
  Chhattisgrah: "Chhattisgarh",
  "Delhi NCT": "Delhi",
  Harayana: "Haryana",
  Telanganah: "Telangana",
};

const STATION_COLS = [
  "name",
  "code",
  "name_hi",
  "name_gu",
  "district",
  "state",
  "address",
  "train_count",
  "utterances",
  "location_lng",
  "location_lat",
];

const CLEANUP_EMPTY_STATE_SQL =
  "UPDATE stations SET state = NULL WHERE state IS NOT NULL AND TRIM(state) = ''";

// --- State normalization ---
function normalizeState(state) {
  const s = toStringOrNull(state);
  if (!s || (typeof s === "string" && s.trim() === "")) return null;
  const trimmed = s.trim();
  return STATE_ALIASES[trimmed] ?? trimmed;
}

// --- Row normalization ---
function normalizeStationRow(row) {
  const code = toStringOrNull(row.code);
  const name = toStringOrNull(row.name);
  const lat = Number(row.latitude);
  const lng = Number(row.longitude);
  if (!code || !name) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const utterances =
    row.utterances === undefined ? null : JSON.stringify(row.utterances);

  return {
    code,
    name,
    name_hi: toStringOrNull(row.name_hi),
    name_gu: toStringOrNull(row.name_gu),
    district: toStringOrNull(row.district),
    state: normalizeState(row.state ?? row.stateName ?? row.state_name),
    address: toStringOrNull(row.address),
    train_count: toIntOrNull(row.trainCount ?? row.train_count),
    utterances: utterances ?? "null",
    lat,
    lng,
  };
}

// --- Batch upsert ---
async function upsertStationsBatch(client, stations, { isPopular = false } = {}) {
  const values = [];
  const rowsSql = stations
    .map((s, rowIdx) => {
      const base = rowIdx * STATION_COLS.length;
      values.push(
        s.name,
        s.code,
        s.name_hi,
        s.name_gu,
        s.district,
        s.state,
        s.address,
        s.train_count,
        s.utterances,
        s.lng,
        s.lat
      );
      const ph = STATION_COLS.map((_, colIdx) => `$${base + colIdx + 1}`);
      return `(${ph.join(",")})`;
    })
    .join(",\n");

  const insertCols = isPopular
    ? "name, code, name_hi, name_gu, district, state, address, train_count, utterances, location, is_popular"
    : "name, code, name_hi, name_gu, district, state, address, train_count, utterances, location";
  const selectCols = isPopular
    ? "v.name, v.code, v.name_hi, v.name_gu, v.district, v.state, v.address, v.train_count::int, v.utterances::jsonb, point(v.location_lng::float8, v.location_lat::float8), true"
    : "v.name, v.code, v.name_hi, v.name_gu, v.district, v.state, v.address, v.train_count::int, v.utterances::jsonb, point(v.location_lng::float8, v.location_lat::float8)";
  const updateSet = isPopular
    ? `name = EXCLUDED.name, name_hi = EXCLUDED.name_hi, name_gu = EXCLUDED.name_gu,
       district = EXCLUDED.district, state = EXCLUDED.state, address = EXCLUDED.address,
       train_count = EXCLUDED.train_count, utterances = EXCLUDED.utterances,
       location = EXCLUDED.location, is_popular = true`
    : `name = EXCLUDED.name, name_hi = EXCLUDED.name_hi, name_gu = EXCLUDED.name_gu,
       district = EXCLUDED.district, state = EXCLUDED.state, address = EXCLUDED.address,
       train_count = EXCLUDED.train_count, utterances = EXCLUDED.utterances,
       location = EXCLUDED.location`;

  const sql = `
    INSERT INTO stations (${insertCols})
    SELECT ${selectCols}
    FROM (VALUES ${rowsSql}) AS v(${STATION_COLS.join(",")})
    ON CONFLICT (code) DO UPDATE SET ${updateSet}
  `;

  await client.query(sql, values);
}

// --- Post-sync cleanup ---
async function cleanupEmptyStates(client) {
  const res = await client.query(CLEANUP_EMPTY_STATE_SQL);
  return res.rowCount ?? 0;
}

// --- Main sync runner ---
async function runStationSync(options) {
  const {
    url,
    isPopular = false,
    truncate = false,
    batchSize = customConfig.BATCH_SIZE ?? BATCH_SIZE_DEFAULT,
  } = options;

  const boundedBatchSize = Math.max(
    BATCH_SIZE_MIN,
    Math.min(Number.isFinite(batchSize) ? batchSize : BATCH_SIZE_DEFAULT, BATCH_SIZE_MAX)
  );

  const raw = await fetchJson(url);
  if (!Array.isArray(raw)) {
    throw new Error("Stations API must return an array");
  }

  const normalized = raw.map(normalizeStationRow).filter(Boolean);

  const client = new pg.Client({ connectionString: customConfig.DATABASE_URL });
  await client.connect();

  try {
    if (isPopular) {
      await client.query("UPDATE stations SET is_popular = false");
    } else if (truncate) {
      await client.query("TRUNCATE stations");
    }

    for (const group of chunk(normalized, boundedBatchSize)) {
      await upsertStationsBatch(client, group, { isPopular });
    }

    const cleaned = await cleanupEmptyStates(client);
    return { count: normalized.length, cleaned };
  } finally {
    await client.end();
  }
}

module.exports = {
  normalizeStationRow,
  upsertStationsBatch,
  cleanupEmptyStates,
  runStationSync,
};
