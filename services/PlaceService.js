/**
 * Resolves "from" and "to" inputs to station lists.
 * Input can be: station_code (3-4 chars), place_name, or state_name.
 */
const STATIONS_PER_STATE = 5;
const STATION_CODE_PATTERN = /^[A-Z0-9]{3,4}$/;

/**
 * Resolve a single input to a list of { code, name } stations.
 * @param {string} input - User input (station code, place name, or state name)
 * @returns {Promise<{ stations: Array<{code, name}>, type: 'station'|'place'|'district'|'state', label?: string }>}
 */
async function resolveToStations(input) {
  if (!input || typeof input !== "string") {
    return { stations: [], type: null, label: null };
  }

  const trimmed = String(input).trim();
  const upper = trimmed.toUpperCase();

  // 1) Try as station code only when input looks like a code (3-4 chars, all uppercase)
  const looksLikeStationCode = trimmed.length >= 3 && trimmed.length <= 4 && trimmed === upper && /^[A-Z0-9]+$/.test(trimmed);
  if (looksLikeStationCode && STATION_CODE_PATTERN.test(upper)) {
    const rows = await SqlService.executeQuery(
      "SELECT code, name FROM stations WHERE code = $1",
      [upper]
    );
    if (rows.rows?.length > 0) {
      const s = rows.rows[0];
      return {
        stations: [{ code: s.code, name: s.name }],
        type: "station",
        label: s.name,
      };
    }
  }

  // 2) Try as place name (exact match first, then prefix)
  const placeRows = await SqlService.executeQuery(
    `SELECT p.id, p.name, p.display_name, ps.station_code, s.name AS station_name
     FROM places p
     INNER JOIN place_stations ps ON ps.place_id = p.id
     INNER JOIN stations s ON s.code = ps.station_code
     WHERE LOWER(TRIM(p.name)) = LOWER(TRIM($1))
        OR (LENGTH(TRIM($1)) >= 2 AND p.name ILIKE $2)
     ORDER BY CASE WHEN LOWER(TRIM(p.name)) = LOWER(TRIM($1)) THEN 0 ELSE 1 END, ps.rank ASC
     LIMIT 10`,
    [trimmed, `${trimmed}%`]
  );

  if (placeRows.rows?.length > 0) {
    const stations = placeRows.rows.map((r) => ({
      code: r.station_code,
      name: r.station_name,
    }));
    const label = placeRows.rows[0].display_name || placeRows.rows[0].name;
    return { stations, type: "place", label };
  }

  // 3) Try as district name (e.g. Bangalore, Chennai, Central)
  const districtRows = await SqlService.executeQuery(
    `SELECT code, name FROM stations
     WHERE district IS NOT NULL AND TRIM(district) != ''
       AND LOWER(TRIM(district)) = LOWER(TRIM($1))
       AND code IS NOT NULL
     ORDER BY COALESCE(train_count, 0) DESC NULLS LAST
     LIMIT ${STATIONS_PER_STATE}`,
    [trimmed]
  );

  if (districtRows.rows?.length > 0) {
    const stations = districtRows.rows.map((r) => ({ code: r.code, name: r.name }));
    return { stations, type: "district", label: trimmed };
  }

  // 4) Try as state name (case-insensitive)
  const stateRows = await SqlService.executeQuery(
    `SELECT code, name FROM stations
     WHERE LOWER(TRIM(state)) = LOWER(TRIM($1)) AND code IS NOT NULL
     ORDER BY COALESCE(train_count, 0) DESC NULLS LAST
     LIMIT ${STATIONS_PER_STATE}`,
    [trimmed]
  );

  if (stateRows.rows?.length > 0) {
    const stations = stateRows.rows.map((r) => ({ code: r.code, name: r.name }));
    return { stations, type: "state", label: trimmed };
  }

  return { stations: [], type: null, label: trimmed };
}

/**
 * Resolve both from and to inputs in parallel.
 */
async function resolveFromTo(fromInput, toInput) {
  const [fromResult, toResult] = await Promise.all([
    resolveToStations(fromInput),
    resolveToStations(toInput),
  ]);
  return { fromResult, toResult };
}

module.exports = {
  resolveToStations,
  resolveFromTo,
};
