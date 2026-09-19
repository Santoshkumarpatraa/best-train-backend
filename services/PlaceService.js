/**
 * Resolves a free-text "from"/"to" input to an ordered list of stations.
 *
 * Input may be a station code, or the name (or a known alias) of a city,
 * landmark, district or state. Areas come from the `places` table, where the
 * station list is curated and ranked - rank 1 is the primary station, which is
 * what makes "Pune" mean Pune Jn rather than whichever stop in Pune district
 * happens to have the most traffic.
 */

const STATION_CODE_PATTERN = /^[A-Z0-9]{2,5}$/;

// A name can be several things at once: "Pune" is a city and a district, "Goa"
// a city and a state. Prefer the tightest, most curated interpretation.
const KIND_RANK_SQL = `CASE p.kind WHEN 'city' THEN 0 WHEN 'place' THEN 1 WHEN 'district' THEN 2 WHEN 'state' THEN 3 ELSE 9 END`;

const FALLBACK_STATIONS_PER_AREA = 5;

function emptyResult(label = null) {
  return { stations: [], type: null, label, placeId: null, parent: null };
}

/** Stations of a place, already ranked by the seeder. */
async function stationsForPlace(placeId) {
  const rows = await SqlService.executeQuery(
    `SELECT ps.station_code AS code, COALESCE(s.name, ps.station_code) AS name, ps.rank
     FROM place_stations ps
     LEFT JOIN stations s ON s.code = ps.station_code
     WHERE ps.place_id = $1
     ORDER BY ps.rank, ps.station_code`,
    [placeId],
  );
  return rows.rows.map((r) => ({ code: r.code, name: r.name, rank: r.rank }));
}

async function findStation(code) {
  const rows = await SqlService.executeQuery("SELECT code, name FROM stations WHERE code = $1", [code]);
  if (rows.rows.length === 0) return null;
  const s = rows.rows[0];
  return { stations: [{ code: s.code, name: s.name, rank: 1 }], type: "station", label: s.name, placeId: null, parent: null };
}

/*
 * Name and alias are matched as two UNIONed index lookups rather than one
 * `name = $1 OR EXISTS (alias ...)`: the OR form cannot use an index and makes
 * the planner read every row of `places` on every search.
 */
async function matchPlace(input, kind) {
  const params = kind ? [input, kind] : [input];
  const rows = await SqlService.executeQuery(
    `WITH matched AS (
       SELECT id FROM places WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))
       UNION
       SELECT place_id FROM place_aliases WHERE LOWER(TRIM(alias)) = LOWER(TRIM($1))
     )
     SELECT p.id, p.name, p.display_name, p.kind, p.station_count, par.name AS parent_name
     FROM matched m
     JOIN places p ON p.id = m.id
     LEFT JOIN places par ON par.id = p.parent_id
     ${kind ? "WHERE p.kind = $2" : ""}
     ORDER BY ${KIND_RANK_SQL}, p.station_count DESC
     LIMIT 1`,
    params,
  );
  return rows.rows[0] || null;
}

/** Pre-`places` behaviour, kept for areas the seeder has not covered. */
async function fallbackArea(input, kind) {
  const columns = kind === "district" || kind === "state" ? [kind] : ["district", "state"];
  for (const column of columns) {
    const rows = await SqlService.executeQuery(
      `SELECT s.code, s.name
       FROM stations s
       JOIN train_route tr ON tr.station_code = s.code
       WHERE s.${column} IS NOT NULL AND TRIM(s.${column}) <> ''
         AND LOWER(TRIM(s.${column})) = LOWER(TRIM($1))
         AND s.code IS NOT NULL
       GROUP BY s.code, s.name
       ORDER BY COUNT(tr.id) DESC
       LIMIT ${FALLBACK_STATIONS_PER_AREA}`,
      [input],
    );
    if (rows.rows.length > 0) {
      return {
        stations: rows.rows.map((r, i) => ({ code: r.code, name: r.name, rank: i + 1 })),
        type: column,
        label: String(input).trim(),
        placeId: null,
        parent: null,
      };
    }
  }
  return null;
}

/**
 * @param {string} input
 * @param {string|null} kind Optional. When the caller already knows which
 *   entity the user picked, honour it - "Delhi" is a city AND a state, and
 *   guessing overrides an explicit choice.
 * @returns {Promise<{stations: Array<{code, name, rank}>, type: string|null, label: string|null, placeId: number|null, parent: string|null}>}
 */
async function resolveToStations(input, kind = null) {
  if (!input || typeof input !== "string") return emptyResult();

  const trimmed = String(input).trim();
  if (!trimmed) return emptyResult();
  const upper = trimmed.toUpperCase();
  const areaKind = kind && kind !== "station" ? kind : null;

  if (kind === "station") {
    return (await findStation(upper)) || emptyResult(trimmed);
  }

  // 1) A seeded city, landmark, district or state. Checked ahead of station
  //    codes so that capitalisation never decides what a search means: "PUNE"
  //    and "Pune" both give the city, and kind=station asks for the stop.
  const place = await matchPlace(trimmed, areaKind);
  if (place) {
    const stations = await stationsForPlace(place.id);
    if (stations.length > 0) {
      return {
        stations,
        type: place.kind,
        label: place.display_name || place.name,
        placeId: place.id,
        parent: place.parent_name || null,
      };
    }
  }

  // 2) A station code that is not also a place name (NDLS, HWH, MAS).
  if (!areaKind && STATION_CODE_PATTERN.test(upper)) {
    const station = await findStation(upper);
    if (station) return station;
  }

  return (await fallbackArea(trimmed, areaKind)) || emptyResult(trimmed);
}

async function resolveFromTo(fromInput, toInput, fromKind = null, toKind = null) {
  const [fromResult, toResult] = await Promise.all([
    resolveToStations(fromInput, fromKind),
    resolveToStations(toInput, toKind),
  ]);
  return { fromResult, toResult };
}

/**
 * Typed autocomplete over places, their aliases, and stations.
 *
 * Areas with no mapped station are excluded. The seeder derives districts from
 * `stations`, but ~80 of them have no station any train actually stops at, and
 * a few are duplicates filed under the wrong state. Offering those sends the
 * user to `fallbackArea`, which matches on district name alone and would answer
 * with a same-named district in another state.
 */
async function suggest(query, limit = 10) {
  const q = String(query || "").trim();
  if (q.length < 2) {
    const popular = await SqlService.executeQuery(
      `SELECT p.id, p.name, p.display_name, p.kind, p.station_count, NULL::text AS code,
              par.name AS parent_name
       FROM places p
       LEFT JOIN places par ON par.id = p.parent_id
       WHERE p.kind IN ('city', 'place') AND p.station_count > 0
       ORDER BY p.station_count DESC, p.name LIMIT $1`,
      [limit],
    );
    return popular.rows.map(toSuggestion);
  }

  const like = `${q.replace(/[%_\\]/g, "\\$&")}%`;
  const rows = await SqlService.executeQuery(
    `(
       SELECT p.id, p.name, p.display_name, p.kind, p.station_count, NULL::text AS code,
              par.name AS parent_name,
              CASE WHEN LOWER(TRIM(p.name)) = LOWER(TRIM($1)) THEN 0 ELSE 1 END AS exactness,
              CASE p.kind WHEN 'city' THEN 0 WHEN 'place' THEN 1 WHEN 'district' THEN 3 ELSE 4 END AS kind_rank
       FROM places p
       LEFT JOIN places par ON par.id = p.parent_id
       WHERE p.station_count > 0
         AND (
               p.name ILIKE $2
               OR EXISTS (SELECT 1 FROM place_aliases a WHERE a.place_id = p.id AND a.alias ILIKE $2)
             )
     )
     UNION ALL
     (
       SELECT NULL::bigint, s.name, NULL::text, 'station', 1, s.code,
              MIN(s.state),
              CASE WHEN UPPER(s.code) = UPPER($1) THEN 0 ELSE 1 END, 2
       FROM stations s
       JOIN train_route tr ON tr.station_code = s.code
       WHERE s.code ILIKE $2 OR s.name ILIKE $2
       GROUP BY s.name, s.code
     )
     ORDER BY exactness, kind_rank, station_count DESC, name
     LIMIT $3`,
    [q, like, limit],
  );
  return rows.rows.map(toSuggestion);
}

/*
 * `parent` is what lets a client tell two identically named entries apart -
 * "Pune" the city and "Pune" the district both render as "Pune" otherwise.
 */
function toSuggestion(row) {
  return {
    kind: row.kind,
    label: row.display_name || row.name,
    parent: row.parent_name || null,
    code: row.code || null,
    stationCount: row.kind === "station" ? 1 : Number(row.station_count) || 0,
    query: row.code || row.display_name || row.name,
  };
}

module.exports = { resolveToStations, resolveFromTo, suggest };
