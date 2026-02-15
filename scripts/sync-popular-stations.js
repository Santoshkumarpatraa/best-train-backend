require("dotenv").config();
require("../config/globals");
const pg = require("pg");
const { chunk, fetchJson } = require("./utils");
const { normalizeStationRow, upsertStationsBatch } = require("./stationSync");

async function main() {
  const url = customConfig.SYNC_POPULAR_URL;
  const databaseUrl = customConfig.DATABASE_URL;
  const batchSize = customConfig.BATCH_SIZE ?? 1000;
  const boundedBatchSize = Math.max(
    1,
    Math.min(Number.isFinite(batchSize) ? batchSize : 1000, 5000)
  );

  // eslint-disable-next-line no-console
  console.log(`Syncing popular stations from: ${url}`);

  const raw = await fetchJson(url);
  if (!Array.isArray(raw)) {
    throw new Error("Popular API must return an array");
  }

  const normalized = raw.map(normalizeStationRow).filter(Boolean);

  // eslint-disable-next-line no-console
  console.log(
    `Parsed ${normalized.length} popular stations (valid with code+name+lat+lng).`
  );

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await client.query("UPDATE stations SET is_popular = false");
    // eslint-disable-next-line no-console
    console.log("Set all is_popular to false");

    for (const group of chunk(normalized, boundedBatchSize)) {
      await upsertStationsBatch(client, group, { isPopular: true });
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
