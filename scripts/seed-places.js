require("dotenv").config();
const { Pool } = require("pg");
const { CITIES, LANDMARKS } = require("./places-data");

/*
 * This script writes hundreds of rows, so it never inherits DATABASE_URL
 * silently: .env may point at a hosted database. Target it explicitly with
 * SEED_DATABASE_URL, and remote hosts are refused unless --allow-remote is
 * passed deliberately.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", ""]);
const DEFAULT_LOCAL = "postgresql://postgres:postgres@localhost:5432/best_train";

function resolveTarget() {
  const url = process.env.SEED_DATABASE_URL || DEFAULT_LOCAL;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    console.error("SEED_DATABASE_URL is not a valid connection string");
    process.exit(1);
  }
  const host = parsed.hostname;
  const target = `${host}:${parsed.port || 5432}/${parsed.pathname.slice(1)}`;
  if (!LOCAL_HOSTS.has(host) && !process.argv.includes("--allow-remote")) {
    console.error(`\nRefusing to seed a non-local database: ${target}`);
    console.error("Pass --allow-remote if that is genuinely what you want.\n");
    process.exit(1);
  }
  return { url, target };
}

const { url: TARGET_URL, target: TARGET_LABEL } = resolveTarget();
const pool = new Pool({ connectionString: TARGET_URL, max: 4, connectionTimeoutMillis: 15000 });

/**
 * Seeds `places` with every state and district found in the station data, plus
 * the curated cities and landmarks, and maps each to its stations in rank order.
 *
 * Idempotent: re-running updates rows in place rather than duplicating them.
 *   node scripts/seed-places.js [--stations-per-area=8] [--dry-run]
 */

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : fallback;
};
const STATIONS_PER_AREA = parseInt(arg("stations-per-area", "8"), 10);
if (!Number.isInteger(STATIONS_PER_AREA) || STATIONS_PER_AREA < 1) {
  console.error("--stations-per-area must be a positive integer");
  process.exit(1);
}
const DRY_RUN = process.argv.includes("--dry-run");

// Values the upstream feed uses for "unknown" - never real areas.
const JUNK = new Set(["#n/a", "n/a", "na", "null", "none", "-", "--", ""]);
const isJunk = (v) => !v || JUNK.has(String(v).trim().toLowerCase());

const q = (text, params = []) => pool.query(text, params);

async function upsertPlace({ name, kind, parentId, state, displayName }) {
  const res = await q(
    `INSERT INTO places (name, display_name, state, kind, parent_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (kind, COALESCE(parent_id, 0), LOWER(TRIM(name)))
     DO UPDATE SET display_name = EXCLUDED.display_name,
                   state = EXCLUDED.state,
                   updated_at = now()
     RETURNING id`,
    [name, displayName || name, state || null, kind, parentId || null],
  );
  return res.rows[0].id;
}

/**
 * Replaces the mapping for one place; ranks follow the given order.
 *
 * Runs on a single connection in one transaction: the delete and the insert must
 * not be observable apart, and station_count has to move with them - an empty
 * `codes` still has to write 0, or a place that loses its stations keeps a
 * phantom count and goes on outranking real ones in autocomplete.
 */
async function setStations(placeId, codes) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM place_stations WHERE place_id = $1`, [placeId]);
    if (codes.length > 0) {
      const values = codes.map((_, i) => `($1, $${i + 2}, ${i + 1})`).join(", ");
      await client.query(
        `INSERT INTO place_stations (place_id, station_code, rank) VALUES ${values}
         ON CONFLICT (place_id, station_code) DO NOTHING`,
        [placeId, ...codes],
      );
    }
    await client.query(`UPDATE places SET station_count = $2, updated_at = now() WHERE id = $1`, [placeId, codes.length]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return codes.length;
}

async function setAliases(placeId, aliases) {
  if (aliases.length === 0) return;
  const values = aliases.map((_, i) => `($1, $${i + 2})`).join(", ");
  await q(`INSERT INTO place_aliases (place_id, alias) VALUES ${values}
           ON CONFLICT (place_id, LOWER(TRIM(alias))) DO NOTHING`, [placeId, ...aliases]);
}

/**
 * Busiest stations in an area, which become rank 1..n.
 *
 * Ranked by actual train_route stops rather than stations.train_count: the
 * latter is stale for renamed stations (Prayagraj Jn reads train_count 0 but
 * carries 289 stops), which would bury the busiest station in its own city.
 * Stations no train stops at are excluded - they can never return a result.
 *
 * Coordinates are deliberately not a filter. A (0,0) location is a defect in the
 * station feed, not evidence the trains are wrong, and excluding those stations
 * makes a served station unreachable by place search; the route API already
 * drops the bad pin on its own.
 */
async function topStations({ state, district }) {
  const where = district
    ? `LOWER(TRIM(s.district)) = LOWER(TRIM($1)) AND LOWER(TRIM(s.state)) = LOWER(TRIM($2))`
    : `LOWER(TRIM(s.state)) = LOWER(TRIM($1))`;
  const params = district ? [district, state] : [state];
  const res = await q(
    `SELECT s.code, COUNT(tr.id) AS stops
     FROM stations s
     JOIN train_route tr ON tr.station_code = s.code
     WHERE ${where} AND s.code IS NOT NULL
     GROUP BY s.code
     HAVING COUNT(tr.id) > 0
     ORDER BY stops DESC, s.code
     LIMIT ${STATIONS_PER_AREA}`,
    params,
  );
  return res.rows.map((r) => r.code);
}

async function main() {
  const started = Date.now();
  console.log(`Seeding ${TARGET_LABEL} (stations-per-area=${STATIONS_PER_AREA}${DRY_RUN ? ", DRY RUN" : ""})\n`);

  const known = new Set(
    (await q(`SELECT code FROM stations WHERE code IS NOT NULL`)).rows.map((r) => r.code.toUpperCase()),
  );
  const served = new Set(
    (await q(`SELECT DISTINCT station_code FROM train_route`)).rows.map((r) => r.station_code.toUpperCase()),
  );
  console.log(`${known.size} station codes known, ${served.size} of them served by at least one train`);

  const stats = { state: 0, district: 0, city: 0, place: 0, mappings: 0, skipped: [] };
  const stateIds = new Map();

  // ---- States -------------------------------------------------------------
  const states = (await q(
    `SELECT state, COUNT(*) n FROM stations
     WHERE state IS NOT NULL AND BTRIM(state) <> '' GROUP BY 1 ORDER BY n DESC`,
  )).rows.filter((r) => !isJunk(r.state));

  for (const row of states) {
    if (DRY_RUN) { stats.state++; continue; }
    const id = await upsertPlace({ name: row.state, kind: "state", parentId: null, state: row.state });
    stateIds.set(row.state.trim().toLowerCase(), id);
    stats.mappings += await setStations(id, await topStations({ state: row.state }));
    stats.state++;
  }
  console.log(`states:     ${stats.state}`);

  // ---- Districts ----------------------------------------------------------
  const districts = (await q(
    `SELECT district, state, COUNT(*) n FROM stations
     WHERE district IS NOT NULL AND BTRIM(district) <> ''
       AND state IS NOT NULL AND BTRIM(state) <> ''
     GROUP BY 1, 2 ORDER BY n DESC`,
  )).rows.filter((r) => !isJunk(r.district) && !isJunk(r.state));

  for (const row of districts) {
    if (DRY_RUN) { stats.district++; continue; }
    const parentId = stateIds.get(row.state.trim().toLowerCase()) || null;
    const id = await upsertPlace({ name: row.district, kind: "district", parentId, state: row.state });
    stats.mappings += await setStations(id, await topStations({ state: row.state, district: row.district }));
    stats.district++;
  }
  console.log(`districts:  ${stats.district}`);

  // ---- Curated cities and landmarks ---------------------------------------
  for (const [kind, list] of [["city", CITIES], ["place", LANDMARKS]]) {
    for (const entry of list) {
      const codes = [...new Set(entry.stations.map((c) => c.toUpperCase()))];
      const valid = codes.filter((c) => known.has(c) && served.has(c));
      const missing = codes.filter((c) => !known.has(c));
      const dead = codes.filter((c) => known.has(c) && !served.has(c));
      if (missing.length > 0) stats.skipped.push(`${entry.name}: unknown code ${missing.join(", ")}`);
      if (dead.length > 0) stats.skipped.push(`${entry.name}: no trains stop at ${dead.join(", ")}`);
      if (valid.length === 0) {
        stats.skipped.push(`${entry.name}: NO VALID STATIONS - not inserted`);
        continue;
      }
      if (DRY_RUN) { stats[kind]++; continue; }
      const parentId = stateIds.get(entry.state.trim().toLowerCase()) || null;
      const id = await upsertPlace({ name: entry.name, kind, parentId, state: entry.state });
      stats.mappings += await setStations(id, valid);
      await setAliases(id, entry.aliases || []);
      stats[kind]++;
    }
  }
  console.log(`cities:     ${stats.city}`);
  console.log(`landmarks:  ${stats.place}`);
  console.log(`mappings:   ${stats.mappings}`);

  if (stats.skipped.length > 0) {
    console.log(`\nUnknown station codes (${stats.skipped.length}) - review scripts/places-data.js:`);
    for (const s of stats.skipped) console.log(`  ${s}`);
  }

  console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err.message || err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
