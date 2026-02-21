require("dotenv").config();
require("../config/globals");
const { runStationSync } = require("./stationSync");

async function main() {
  const url = customConfig.SYNC_POPULAR_URL;

  if (!url) {
    console.error("SYNC_POPULAR_URL is required");
    process.exit(1);
  }

  console.log(`Syncing popular stations from: ${url}`);

  const { count, cleaned } = await runStationSync({
    url,
    isPopular: true,
  });

  console.log(`Parsed ${count} popular stations (valid with code+name+lat+lng)`);
  if (cleaned > 0) console.log(`Cleaned ${cleaned} stations with empty state`);
  console.log("Sync complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
