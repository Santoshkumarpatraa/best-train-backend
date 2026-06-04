require("dotenv").config();
require("../config/globals");
const pg = require("pg");
const { getBrowserHeaders } = require("../services/browserHeaders");
const { toIntOrNull, toStringOrNull, toBool, sleep } = require("./utils");

async function fetchWithTimeout(url, options = {}, timeoutMs = 45000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTrainDetails(baseUrl, trainNumber) {
  const greq = Math.floor(Date.now() / 1000);
  const requestUrl = `${baseUrl}/${String(trainNumber).padStart(5, "0")}?greq=${greq}`;
  const headers = getBrowserHeaders({
    "Content-Type": "application/x-www-form-urlencoded",
    Referer: `${customConfig.IRCTC_ORIGIN}/online-charts/`,
    Origin: customConfig.IRCTC_ORIGIN,
    greq: String(greq),
  });

  const maxAttempts = 3;
  const baseDelayMs = 1000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetchWithTimeout(requestUrl, {
        method: "GET",
        headers,
      }, 45000);

      if (!res.ok) {
        throw new Error(`Train ${trainNumber}: ${res.status} ${res.statusText}`);
      }
      return await res.json();
    } catch (err) {
      if (attempt < maxAttempts) {
        const delayMs = baseDelayMs * attempt;
        await sleep(delayMs);
      }
    }
  }

  return null;
}

async function updateTrainAndRoute(client, trainId, data) {
  const {
    train_name,
    station_from,
    station_to,
    train_owner,
    runs_on_mon,
    runs_on_tue,
    runs_on_wed,
    runs_on_thu,
    runs_on_fri,
    runs_on_sat,
    runs_on_sun,
    duration,
    station_list,
  } = data;

  await client.query(
    `UPDATE trains SET
      train_name = $1,
      station_from = $2,
      station_to = $3,
      train_owner = $4,
      runs_on_mon = $5,
      runs_on_tue = $6,
      runs_on_wed = $7,
      runs_on_thu = $8,
      runs_on_fri = $9,
      runs_on_sat = $10,
      runs_on_sun = $11,
      duration = $12,
      fetched_at = now(),
      updated_at = now()
    WHERE id = $13`,
    [
      train_name,
      station_from,
      station_to,
      train_owner,
      runs_on_mon,
      runs_on_tue,
      runs_on_wed,
      runs_on_thu,
      runs_on_fri,
      runs_on_sat,
      runs_on_sun,
      duration,
      trainId,
    ],
  );

  await client.query("DELETE FROM train_route WHERE train_id = $1", [trainId]);

  if (Array.isArray(station_list) && station_list.length > 0) {
    const values = [trainId];
    const rows = station_list
      .map((s, i) => {
        const base = 2 + i * 10;
        values.push(
          s.station_code,
          s.station_name,
          s.arrival_time,
          s.departure_time,
          s.route_number,
          s.halt_time,
          s.distance,
          s.day_count,
          s.serial_number,
          s.boarding_disabled,
        );
        return `($1, $${base}, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`;
      })
      .join(",\n");

    await client.query(
      `INSERT INTO train_route (
        train_id, station_code, station_name, arrival_time, departure_time,
        route_number, halt_time, distance, day_count, serial_number, boarding_disabled
      ) VALUES ${rows}`,
      values,
    );
  }
}

/**
 * Calculate duration from first station departure to last station arrival.
 * Times in "HH:MM" or "HH:MM:SS", dayCount from last station (1, 2, ...).
 */
function calculateDuration(stationList) {
  if (!Array.isArray(stationList) || stationList.length < 2) return null;
  const first = stationList[0];
  const last = stationList[stationList.length - 1];
  const dep = first?.departure_time;
  const arr = last?.arrival_time;
  const dayCount = last?.day_count ?? 1;
  if (!dep || !arr) return null;

  const parseTime = (t) => {
    const parts = String(t).split(":");
    const h = parseInt(parts[0], 10) || 0;
    const m = parseInt(parts[1], 10) || 0;
    return h * 60 + m;
  };

  const depMins = parseTime(dep);
  const arrMins = parseTime(arr);
  const totalArrMins = arrMins + (dayCount - 1) * 24 * 60;
  let durationMins = totalArrMins - depMins;
  if (durationMins < 0) durationMins += 24 * 60;

  const h = Math.floor(durationMins / 60);
  const m = durationMins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function parseDetailsResponse(json, trainNumber) {
  const rawStations = (json.stationList || [])
    .map((s) => ({
      station_code: toStringOrNull(s.stationCode),
      station_name: toStringOrNull(s.stationName),
      arrival_time:
        toStringOrNull(s.arrivalTime) === "--"
          ? null
          : toStringOrNull(s.arrivalTime),
      departure_time:
        toStringOrNull(s.departureTime) === "--"
          ? null
          : toStringOrNull(s.departureTime),
      route_number: toStringOrNull(s.routeNumber) || "1",
      halt_time:
        toStringOrNull(s.haltTime) === "--" ? null : toStringOrNull(s.haltTime),
      distance: toIntOrNull(s.distance),
      day_count: toIntOrNull(s.dayCount),
      stn_serial: toIntOrNull(s.stnSerialNumber) ?? 0,
      boarding_disabled: toBool(s.boardingDisabled),
    }))
    .filter((s) => s.station_code && s.station_name);

  const byRoute = new Map();
  rawStations.forEach((s) => {
    const r = s.route_number;
    if (!byRoute.has(r)) byRoute.set(r, []);
    byRoute.get(r).push(s);
  });

  const routeOrder = [...byRoute.keys()].sort((a, b) => {
    const na = parseInt(a, 10) || 0;
    const nb = parseInt(b, 10) || 0;
    return na - nb;
  });

  const orderedList = [];
  routeOrder.forEach((r) => {
    const stations = byRoute.get(r);
    stations.sort((a, b) => a.stn_serial - b.stn_serial);
    orderedList.push(...stations);
  });

  orderedList.forEach((s, i) => {
    s.serial_number = i + 1;
    delete s.stn_serial;
  });

  return {
    train_number: trainNumber,
    train_name: toStringOrNull(json.trainName) || "",
    station_from: toStringOrNull(json.stationFrom),
    station_to: toStringOrNull(json.stationTo),
    train_owner: toStringOrNull(json.trainOwner),
    runs_on_mon: toBool(json.trainRunsOnMon),
    runs_on_tue: toBool(json.trainRunsOnTue),
    runs_on_wed: toBool(json.trainRunsOnWed),
    runs_on_thu: toBool(json.trainRunsOnThu),
    runs_on_fri: toBool(json.trainRunsOnFri),
    runs_on_sat: toBool(json.trainRunsOnSat),
    runs_on_sun: toBool(json.trainRunsOnSun),
    duration:
      toStringOrNull(json.duration) && toStringOrNull(json.duration) !== "0"
        ? toStringOrNull(json.duration)
        : calculateDuration(orderedList),
    station_list: orderedList,
  };
}

async function main() {
  const baseUrl = customConfig.TRAIN_DETAILS_URL;
  const databaseUrl = customConfig.DATABASE_URL;

  if (!baseUrl) {
    console.error("TRAIN_DETAILS_URL is required");
    process.exit(1);
  }
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const delayMs =
    customConfig.SYNC_TRAIN_DELAY_MS != null
      ? Math.max(100, customConfig.SYNC_TRAIN_DELAY_MS || 50)
      : 50;

  // eslint-disable-next-line no-console
  console.log(`Syncing train details from: ${baseUrl}`);
  // eslint-disable-next-line no-console
  console.log(`Rate limit: ${delayMs}ms between requests`);
  // eslint-disable-next-line no-console
  console.log(
    `Processing: trains without details + those not synced in 6 hours`,
  );

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  const skipIdx = process.argv.indexOf("--skip");
  const skipCount =
    skipIdx >= 0 && process.argv[skipIdx + 1] != null
      ? Math.max(0, parseInt(process.argv[skipIdx + 1], 10) || 0)
      : 0;

  const syncAll = customConfig.SYNC_TRAIN_ALL;
  const notRecentlyFetched =
    "fetched_at IS NULL OR fetched_at < now() - interval '6 hours'";
  const needsDetails =
    "(station_from IS NULL OR station_to IS NULL) OR (" +
    notRecentlyFetched +
    ")";
  const whereClause = syncAll ? "1=1" : needsDetails;
  let query = `SELECT id, train_number FROM trains WHERE ${whereClause} ORDER BY train_number DESC`;
  const params = [];
  if (skipCount > 0) {
    query += ` OFFSET $1`;
    params.push(skipCount);
  }
  const result = await client.query(query, params);
  const trains = result.rows;

  if (skipCount > 0) {
    // eslint-disable-next-line no-console
    console.log(`Skipping first ${skipCount} trains`);
  }

  // eslint-disable-next-line no-console
  console.log(`Processing ${trains.length} trains`);

  let ok = 0;
  let err = 0;
  let skipped = 0;

  for (let i = 0; i < trains.length; i++) {
    const { id: trainId, train_number } = trains[i];
    try {
      const json = await fetchTrainDetails(baseUrl, train_number);

      if (json === null) {
        skipped++;
        // eslint-disable-next-line no-console
        console.log(`[${train_number}] skipped: failed to fetch after retries`);
      } else if (json.errorMessage) {
        skipped++;
        // eslint-disable-next-line no-console
        console.log(`[${train_number}] skipped: ${json.errorMessage}`);
      } else {
        const data = parseDetailsResponse(json, train_number);

        if (
          !data.station_from &&
          !data.station_to &&
          !data.station_list?.length
        ) {
          skipped++;
          // eslint-disable-next-line no-console
          console.log(`[${train_number}] skipped: no valid data`);
        } else {
          // eslint-disable-next-line no-console
          console.log(
            `[${train_number}] ${data.train_name} | ${data.station_from} → ${data.station_to} | ${data.station_list?.length ?? 0} stations`,
          );

          await client.query("BEGIN");
          await updateTrainAndRoute(client, trainId, data);
          await client.query("COMMIT");

          ok++;
        }
      }

      if ((i + 1) % 10 === 0 || i === trains.length - 1) {
        // eslint-disable-next-line no-console
        console.log(
          `Progress: ${i + 1}/${trains.length} (ok: ${ok}, skipped: ${skipped}, err: ${err})`,
        );
      }
    } catch (e) {
      await client.query("ROLLBACK").catch(() => { });
      err++;
      // eslint-disable-next-line no-console
      console.error(`Train ${train_number}: ${e.message}`);
    }

    if (i < trains.length - 1) {
      await sleep(delayMs);
    }
  }

  await client.end();

  // eslint-disable-next-line no-console
  console.log(`Done. ok: ${ok}, skipped: ${skipped}, err: ${err}`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
