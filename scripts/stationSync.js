/**
 * Shared station sync logic for sync-stations.js and sync-popular-stations.js.
 */
const { toIntOrNull, toStringOrNull } = require("./utils");

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

/**
 * Normalize a raw station row from API/JSON to DB shape.
 * @param {Object} row - Raw row with code, name, latitude, longitude, etc.
 * @returns {Object|null} Normalized station or null if invalid
 */
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
    state: toStringOrNull(row.state),
    address: toStringOrNull(row.address),
    train_count: toIntOrNull(row.trainCount ?? row.train_count),
    utterances: utterances ?? "null",
    lat,
    lng,
  };
}

/**
 * Upsert a batch of stations.
 * @param {pg.Client} client - Database client
 * @param {Object[]} stations - Normalized stations (from normalizeStationRow)
 * @param {Object} options
 * @param {boolean} [options.isPopular=false] - If true, include is_popular=true in INSERT/UPDATE
 */
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
    ? `name = EXCLUDED.name,
      name_hi = EXCLUDED.name_hi,
      name_gu = EXCLUDED.name_gu,
      district = EXCLUDED.district,
      state = EXCLUDED.state,
      address = EXCLUDED.address,
      train_count = EXCLUDED.train_count,
      utterances = EXCLUDED.utterances,
      location = EXCLUDED.location,
      is_popular = true`
    : `name = EXCLUDED.name,
      name_hi = EXCLUDED.name_hi,
      name_gu = EXCLUDED.name_gu,
      district = EXCLUDED.district,
      state = EXCLUDED.state,
      address = EXCLUDED.address,
      train_count = EXCLUDED.train_count,
      utterances = EXCLUDED.utterances,
      location = EXCLUDED.location`;

  const sql = `
    INSERT INTO stations (${insertCols})
    SELECT ${selectCols}
    FROM (VALUES ${rowsSql}) AS v(${STATION_COLS.join(",")})
    ON CONFLICT (code) DO UPDATE SET ${updateSet}
  `;

  await client.query(sql, values);
}

module.exports = {
  normalizeStationRow,
  upsertStationsBatch,
};
