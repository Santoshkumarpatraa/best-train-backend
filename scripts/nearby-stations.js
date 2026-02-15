#!/usr/bin/env node
/**
 * List stations within 100km of a given station, ordered by train_count.
 * Usage: node scripts/nearby-stations.js <station_code>
 * Example: node scripts/nearby-stations.js NDLS
 */

require("dotenv").config();
const customConfig = require("../config/config");
const { Pool } = require("pg");

const nearbySQL = `
  SELECT s.code, s.name, s.train_count,
    (6371 * acos(LEAST(1, GREATEST(-1,
      cos(radians(orig.location[1])) * cos(radians(s.location[1])) * cos(radians(s.location[0]) - radians(orig.location[0]))
      + sin(radians(orig.location[1])) * sin(radians(s.location[1]))
    ))))::int AS distance_km
  FROM stations s
  CROSS JOIN (SELECT code, location FROM stations WHERE code = $1) orig
  WHERE s.code != orig.code
    AND (6371 * acos(LEAST(1, GREATEST(-1,
      cos(radians(orig.location[1])) * cos(radians(s.location[1])) * cos(radians(s.location[0]) - radians(orig.location[0]))
      + sin(radians(orig.location[1])) * sin(radians(s.location[1]))
    )))) <= 100
  ORDER BY distance_km ASC, COALESCE(s.train_count, 0) DESC NULLS LAST
`;

async function main() {
  const code = (process.argv[2] || "NDLS").toUpperCase();
  const pool = new Pool({ connectionString: customConfig.DATABASE_URL });

  try {
    const result = await pool.query(nearbySQL, [code]);
    console.log(`\nStations within 100km of ${code}:\n`);
    console.table(result.rows);
    console.log(`Total: ${result.rows.length} stations\n`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
