/**
 * Wraps a TEXT time column in a guarded cast.
 *
 * arrival_time / departure_time are TEXT. The sync maps the feed's "--" sentinel
 * to NULL, but rows written before that normalisation still hold "--", and a bare
 * ::time cast on one of them aborts the whole query - a single bad row would 500
 * an entire search. Guarding it costs one duration instead.
 *
 * @param {string} col - Column reference, e.g. "from_stop.departure_time"
 * @returns {string} - SQL expression yielding time or NULL
 */
const asTime = (col) => `(CASE WHEN ${col} ~ '^[0-9]{1,2}:[0-9]{2}(:[0-9]{2})?$' THEN ${col}::time ELSE NULL END)`;

/**
 * Helper function to sort trains array by duration, departure_time, or arrival_time.
 * @param {Array} trains - Array of train objects to sort
 * @param {string} sort - Sort field: "duration", "departure_time", or "arrival_time"
 * @param {string} order - Sort order: "asc" or "desc"
 * @returns {void} - Sorts the array in place
 */
function sortTrains(trains, sort, order) {
    const parseDurationMins = (d) => {
        if (!d || typeof d !== "string") return 999999;
        const [h, m] = d.split(":").map((x) => parseInt(x, 10) || 0);
        return h * 60 + m;
    };
    const timeStr = (t) => (t ? String(t).replace(/:\d{2}$/, "") : "") || "99:99";

    trains.sort((a, b) => {
        if (sort === "duration") {
            const diff = parseDurationMins(a.duration) - parseDurationMins(b.duration);
            return order === "asc" ? diff : -diff;
        }
        if (sort === "departure_time") {
            const cmp = timeStr(a.departure_time).localeCompare(timeStr(b.departure_time));
            return order === "asc" ? cmp : -cmp;
        }
        if (sort === "arrival_time") {
            const cmp = timeStr(a.arrival_time).localeCompare(timeStr(b.arrival_time));
            return order === "asc" ? cmp : -cmp;
        }
        return 0;
    });
}

module.exports = {
    /**
     * Find trains between two stations.
     * API Endpoint :   /train/between/stations
     * API Method   :   GET
     *
     * @param   {Object}        req          Request Object From API Request.
     * @param   {Object}        res          Response Object For API Request.
     * @returns {Promise<*>}    JSONResponse With success code 200 and train list or relevant error code with message.
     */
    trainBetweenStations: async (req, res) => {
        try {
            LogService.info("====================== TRAIN BETWEEN STATIONS API ==============================");
            LogService.info("REQ QUERY : ", { ...req.query });

            const request = {
                from: req.query.from,
                to: req.query.to,
                date: req.query.date,
                skip: req.query.skip,
                limit: req.query.limit,
                day: req.query.day,
                sort: req.query.sort,
                order: req.query.order,
            };

            const schema = Joi.object().keys({
                from: Joi.string().required().min(1).max(10).trim().uppercase(),
                to: Joi.string().required().min(1).max(10).trim().uppercase().invalid(Joi.ref("from")),
                date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional().allow(""),
                skip: Joi.number().integer().min(0).optional().default(0),
                limit: Joi.number().integer().min(1).max(100).optional().default(20),
                day: Joi.number().integer().min(0).max(6).optional().allow(null),
                sort: Joi.string().valid("duration", "departure_time", "arrival_time").default("duration").optional(),
                order: Joi.string().valid("asc", "desc").default("asc").optional(),
            });

            const { error, value } = schema.validate(request, { abortEarly: false, stripUnknown: true });
            if (error) {
                return ResponseService.jsonResponse(res, ConstantService.responseCode.BAD_REQUEST, {
                    message: error.message,
                });
            }

            const { from, to, date: dateStr, skip, limit, day: dayParam, sort, order } = value;
            let day = dayParam;
            if (dateStr) {
                const d = new Date(dateStr);
                if (!Number.isNaN(d.getTime())) {
                    day = d.getDay();
                }
            }

            // Step 1: Define constants and SQL fragments
            const DAY_COLS = ["runs_on_sun", "runs_on_mon", "runs_on_tue", "runs_on_wed", "runs_on_thu", "runs_on_fri", "runs_on_sat"];
            const NEARBY_DISTANCE_KM = 100;
            const NEARBY_MIN_DISTANCE_KM = 200;
            const NEARBY_STATIONS_LIMIT = 5;
            const NEARBY_PAIR_TRAINS_LIMIT = 10;
            const ALTERNATE_DAYS_LIMIT = 50;

            // Step 2: Build day filter conditions (trains running on selected day vs alternate days)
            const hasDateFilter = day != null && day >= 0 && day <= 6;
            const dayCondition = hasDateFilter ? ` AND t.${DAY_COLS[day]} = true` : "";
            const alternateDayCondition = hasDateFilter ? ` AND t.${DAY_COLS[day]} = false` : "";

            // Duration in minutes: (arrival_time + day_offset) - departure_time
            // Handle NULL day_count: NULL defaults to 1 (first day of journey)
            const DEP = asTime("from_stop.departure_time");
            const ARR = asTime("to_stop.arrival_time");
            const DURATION_MINS = `(
                EXTRACT(EPOCH FROM ${ARR}) / 60
                + GREATEST(0, COALESCE(to_stop.day_count, 1) - COALESCE(from_stop.day_count, 1)) * 24 * 60
                - EXTRACT(EPOCH FROM ${DEP}) / 60
            )`;
            const sortExpr = {
                duration: DURATION_MINS,
                departure_time: DEP,
                arrival_time: ARR,
            };
            const orderBy = `${sortExpr[sort]} ${order.toUpperCase()} NULLS LAST, t.train_number`;

            // Step 3: Route reachability - excludes invalid paths on split trains (e.g. KGM→RMR)
            // Same route: valid. Different routes: valid only if from is before the split point (max serial of stations in from's route that also appear in to's route)
            const ROUTE_REACHABILITY = `
                AND (
                    COALESCE(from_stop.route_number, '1') = COALESCE(to_stop.route_number, '1')
                    OR from_stop.serial_number <= (
                        SELECT COALESCE(MAX(tr.serial_number), 0)
                        FROM train_route tr
                        WHERE tr.train_id = t.id
                            AND COALESCE(tr.route_number, '1') = COALESCE(from_stop.route_number, '1')
                            AND tr.station_code IN (
                                SELECT station_code FROM train_route
                                WHERE train_id = t.id
                                    AND COALESCE(route_number, '1') = COALESCE(to_stop.route_number, '1')
                            )
                    )
                )`;

            // Join trains with train_route: from_stop ($1) and to_stop ($2). Ensures from comes before to (serial_number), boarding allowed, and route reachable.
            const trainJoins = `
                FROM trains t
                INNER JOIN train_route from_stop
                    ON from_stop.train_id = t.id AND from_stop.station_code = $1
                INNER JOIN train_route to_stop
                    ON to_stop.train_id = t.id AND to_stop.station_code = $2
                WHERE from_stop.serial_number < to_stop.serial_number
                    AND from_stop.boarding_disabled = false
                    AND to_stop.boarding_disabled = false
                    ${ROUTE_REACHABILITY}`;

            // Columns: train_number, name, duration (computed or fallback), runs_on [Mon-Sun], from/to station info, arrival/departure times, distance_between
            const trainSelect = `
                LPAD(t.train_number::text, 5, '0') AS train_number,
                t.train_name,
                CASE
                    WHEN from_stop.departure_time IS NOT NULL AND to_stop.arrival_time IS NOT NULL THEN (
                        SELECT LPAD((dm / 60)::text, 2, '0') || ':' || LPAD((dm % 60)::text, 2, '0')
                        FROM (SELECT GREATEST(0, ${DURATION_MINS})::int AS dm) x
                    )
                    ELSE t.duration
                END AS duration,
                ARRAY[
                    t.runs_on_mon::int, t.runs_on_tue::int, t.runs_on_wed::int,
                    t.runs_on_thu::int, t.runs_on_fri::int, t.runs_on_sat::int, t.runs_on_sun::int
                ] AS "runs_on",
                from_stop.station_code AS from_station_code,
                from_stop.station_name AS from_station_name,
                from_stop.departure_time AS departure_time,
                to_stop.station_code AS to_station_code,
                to_stop.station_name AS to_station_name,
                to_stop.arrival_time AS arrival_time,
                (to_stop.distance - from_stop.distance) AS distance_between`;

            // Haversine: distance in km between two points. Uses location[1]=lat, location[0]=lng. 6371 = Earth radius in km.
            const HAVERSINE_KM = `(6371 * acos(LEAST(1, GREATEST(-1,
                cos(radians(f.location[1])) * cos(radians(t.location[1])) * cos(radians(t.location[0]) - radians(f.location[0]))
                + sin(radians(f.location[1])) * sin(radians(t.location[1]))
            ))))`;
            // Haversine for single point (orig) to station (s) - used for nearby stations query
            const HAVERSINE_SINGLE = `(6371 * acos(LEAST(1, GREATEST(-1,
                cos(radians(orig.location[1])) * cos(radians(s.location[1])) * cos(radians(s.location[0]) - radians(orig.location[0]))
                + sin(radians(orig.location[1])) * sin(radians(s.location[1]))
            ))))`;

            // Step 4: Check cache (key: from, to, date/day, skip, limit, sort, order)
            // Include day in cache key if dateStr is empty (day passed separately) or if day is explicitly set
            const dayKey = dateStr ? dateStr : (day != null ? `day:${day}` : "all");
            const cacheKey = `train:${from}:${to}:${dayKey}:${skip}:${limit}:${sort}:${order}`;
            const cached = CacheService.get(cacheKey);
            if (cached) {
                LogService.info(`[CACHE HIT] ${cacheKey}`);
                return ResponseService.jsonResponse(res, ConstantService.responseCode.SUCCESS, cached);
            }
            LogService.info(`[CACHE MISS] ${cacheKey}`);

            // Step 5: Main trains, count, and from-to distance in parallel
            const trainsSQL = `
                SELECT ${trainSelect}
                ${trainJoins}
                ${dayCondition}
                ORDER BY ${orderBy}
                LIMIT $3 OFFSET $4
            `;
            const countSQL = `SELECT COUNT(*) AS total ${trainJoins} ${dayCondition}`;
            const fromToDistanceSQL = `
                SELECT ${HAVERSINE_KM}::int AS distance_km, f.name AS from_name, t.name AS to_name,
                    f.location[0] AS from_lng, f.location[1] AS from_lat,
                    t.location[0] AS to_lng, t.location[1] AS to_lat
                FROM stations f CROSS JOIN stations t
                WHERE f.code = $1 AND t.code = $2
                    AND f.location[0] != 0 AND f.location[1] != 0
                    AND t.location[0] != 0 AND t.location[1] != 0
            `;

            const [trainsResult, countResult, fromToResult] = await Promise.all([
                SqlService.executeQuery(trainsSQL, [from, to, limit, skip]),
                SqlService.executeQuery(countSQL, [from, to]),
                SqlService.executeQuery(fromToDistanceSQL, [from, to]),
            ]);

            const trains = trainsResult.rows;
            const fromToRow = fromToResult.rows[0];

            // Validate station coordinates
            if (!fromToRow || !fromToRow.from_name || !fromToRow.to_name) {
                // Query returned no rows - could be missing stations or invalid coordinates
                // Check if stations exist first
                // Postgres has no `=` for point, so comparing against '(0,0)'::point
                // threw 42883 and turned every unknown station into a 500.
                const stationCheckSQL = `
                    SELECT code, name,
                        (location IS NULL OR (location[0] = 0 AND location[1] = 0)) AS has_invalid_coords
                    FROM stations
                    WHERE code = ANY(ARRAY[$1, $2])
                `;
                const stationCheckResult = await SqlService.executeQuery(stationCheckSQL, [from, to]);
                const foundStations = stationCheckResult.rows || [];

                const foundCodes = new Set(foundStations.map((s) => s.code));
                const unknown = [from, to].filter((code) => !foundCodes.has(code));
                if (unknown.length > 0) {
                    return ResponseService.jsonResponse(res, ConstantService.responseCode.BAD_REQUEST, {
                        message: `Unknown station code${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`,
                    });
                }

                const invalidCoordsStations = foundStations
                    .filter(s => s.has_invalid_coords)
                    .map(s => `${s.code} (${s.name})`);

                if (invalidCoordsStations.length > 0) {
                    return ResponseService.jsonResponse(res, ConstantService.responseCode.BAD_REQUEST, {
                        message: `Stations ${invalidCoordsStations.join(' and ')} do not have valid GPS coordinates (0, 0). Cannot calculate distance.`,
                    });
                }

                return ResponseService.jsonResponse(res, ConstantService.responseCode.BAD_REQUEST, {
                    message: `Could not calculate distance between stations: ${from} and ${to}`,
                });
            }

            // Additional validation check (should not be needed due to SQL filter, but kept for safety)
            const fromHasValidCoords = fromToRow.from_lng != null && fromToRow.from_lat != null
                && fromToRow.from_lng != 0 && fromToRow.from_lat != 0;
            const toHasValidCoords = fromToRow.to_lng != null && fromToRow.to_lat != null
                && fromToRow.to_lng != 0 && fromToRow.to_lat != 0;

            if (!fromHasValidCoords || !toHasValidCoords) {
                const invalidStations = [];
                if (!fromHasValidCoords) invalidStations.push(`${from} (${fromToRow.from_name})`);
                if (!toHasValidCoords) invalidStations.push(`${to} (${fromToRow.to_name})`);

                return ResponseService.jsonResponse(res, ConstantService.responseCode.BAD_REQUEST, {
                    message: `Stations ${invalidStations.join(' and ')} do not have valid GPS coordinates. Cannot calculate distance.`,
                });
            }

            const fromToDistanceKm = parseInt(fromToRow?.distance_km, 10) || 0;
            const shouldFindNearby = fromToDistanceKm > NEARBY_MIN_DISTANCE_KM || (trains.length === 0 && fromToDistanceKm > 0);

            const origFrom = fromToRow ? { code: from, name: fromToRow.from_name, distance_km: 0 } : null;
            const origTo = fromToRow ? { code: to, name: fromToRow.to_name, distance_km: 0 } : null;

            // Step 6: Find nearby stations and their trains (when distance > 200 km or no direct trains)
            let nearbyTrains = [];
            if (shouldFindNearby) {
                // Step 6a: Stations within 100 km of orig ($1), excluding orig and the other station ($2). Ordered by train_count, limit 5.
                // Exclude stations with invalid coordinates (0, 0) and ensure distance > 0
                const nearbySQL = `
                    SELECT s.code, s.name, s.train_count,
                        ${HAVERSINE_SINGLE}::int AS distance_km
                    FROM stations s
                    CROSS JOIN (SELECT code, location FROM stations WHERE code = $1) orig
                    WHERE s.code != orig.code
                        AND s.code != $2
                        AND s.location[0] != 0 AND s.location[1] != 0
                        AND orig.location[0] != 0 AND orig.location[1] != 0
                        AND ${HAVERSINE_SINGLE} > 0
                        AND ${HAVERSINE_SINGLE} <= ${NEARBY_DISTANCE_KM}
                    ORDER BY COALESCE(s.train_count, 0) DESC NULLS LAST
                    LIMIT ${NEARBY_STATIONS_LIMIT}
                `;
                const [nearbyFromRes, nearbyToRes] = await Promise.all([
                    SqlService.executeQuery(nearbySQL, [from, to]),
                    SqlService.executeQuery(nearbySQL, [to, from]),
                ]);
                const nearbyFrom = nearbyFromRes.rows;
                const nearbyTo = nearbyToRes.rows;

                // Step 6b: Build station pairs (nearby_from→to, from→nearby_to, nearby_from→nearby_to)
                const pairs = [];
                if (origFrom && origTo) {
                    nearbyFrom.forEach((s) => pairs.push({ from_station: s, to_station: origTo }));
                    nearbyTo.forEach((s) => pairs.push({ from_station: origFrom, to_station: s }));
                }
                nearbyFrom.forEach((xf) => {
                    nearbyTo.forEach((yt) => pairs.push({ from_station: xf, to_station: yt }));
                });

                // Step 6c: Same as main trains query but for each nearby pair (from_station.code, to_station.code), limit 10
                const pairSQL = `
                    SELECT ${trainSelect}
                    ${trainJoins}
                    ${dayCondition}
                    ORDER BY ${orderBy}
                    LIMIT ${NEARBY_PAIR_TRAINS_LIMIT} OFFSET 0
                `;
                // Up to 35 pairs here. Firing them all at once starves the
                // connection pool (max 10) and every laggard dies on the 5s
                // acquire timeout, so run them in small waves instead.
                const NEARBY_CONCURRENCY = 4;
                const pairResults = [];
                for (let i = 0; i < pairs.length; i += NEARBY_CONCURRENCY) {
                    const wave = pairs.slice(i, i + NEARBY_CONCURRENCY);
                    const settled = await Promise.allSettled(
                        wave.map((p) => SqlService.executeQuery(pairSQL, [p.from_station.code, p.to_station.code]))
                    );
                    for (const outcome of settled) {
                        if (outcome.status === "fulfilled") {
                            pairResults.push(outcome.value);
                        } else {
                            // A nearby suggestion failing must not fail the search itself.
                            LogService.error("Nearby pair query failed:", outcome.reason);
                            pairResults.push({ rows: [] });
                        }
                    }
                }

                // Step 6d: Deduplicate - exclude trains already in main result, keep unique per nearby pair
                const mainTrainNumbers = new Set(trains.map((t) => t.train_number));
                const seenInNearby = new Set();

                nearbyTrains = pairs
                    .map((p, i) => {
                        const rows = pairResults[i]?.rows || [];
                        const filtered = rows.filter(
                            (t) => !mainTrainNumbers.has(t.train_number) && !seenInNearby.has(t.train_number)
                        );
                        filtered.forEach((t) => seenInNearby.add(t.train_number));
                        return {
                            from_station: { code: p.from_station.code, name: p.from_station.name, distance_km: p.from_station.distance_km },
                            to_station: { code: p.to_station.code, name: p.to_station.name, distance_km: p.to_station.distance_km },
                            trains: filtered,
                        };
                    })
                    .filter((item) => item.trains.length > 0)
                    .sort((a, b) => {
                        // Sort nearby trains groups according to priority:
                        // 1. Origin same, destination nearby (sort by destination distance ASC)
                        // 2. Destination same, origin nearby (sort by origin distance ASC)
                        // 3. Both nearby (sort by origin distance ASC, then destination distance ASC)
                        const aFromSame = a.from_station.code === from;
                        const aToSame = a.to_station.code === to;
                        const bFromSame = b.from_station.code === from;
                        const bToSame = b.to_station.code === to;

                        // Category 1: Origin same, destination nearby
                        const aIsCategory1 = aFromSame && !aToSame;
                        const bIsCategory1 = bFromSame && !bToSame;

                        // Category 2: Destination same, origin nearby
                        const aIsCategory2 = !aFromSame && aToSame;
                        const bIsCategory2 = !bFromSame && bToSame;

                        // Category 3: Both nearby
                        const aIsCategory3 = !aFromSame && !aToSame;
                        const bIsCategory3 = !bFromSame && !bToSame;

                        // Priority: Category 1 > Category 2 > Category 3
                        if (aIsCategory1 && !bIsCategory1) return -1;
                        if (!aIsCategory1 && bIsCategory1) return 1;

                        if (aIsCategory2 && !bIsCategory2 && !bIsCategory1) return -1;
                        if (!aIsCategory2 && bIsCategory2 && !aIsCategory1) return 1;

                        // Within same category, sort by distance
                        if (aIsCategory1 && bIsCategory1) {
                            // Sort by destination distance ASC
                            return (a.to_station.distance_km || 0) - (b.to_station.distance_km || 0);
                        }

                        if (aIsCategory2 && bIsCategory2) {
                            // Sort by origin distance ASC
                            return (a.from_station.distance_km || 0) - (b.from_station.distance_km || 0);
                        }

                        if (aIsCategory3 && bIsCategory3) {
                            // Sort by origin distance ASC, then destination distance ASC
                            const originDiff = (a.from_station.distance_km || 0) - (b.from_station.distance_km || 0);
                            if (originDiff !== 0) return originDiff;
                            return (a.to_station.distance_km || 0) - (b.to_station.distance_km || 0);
                        }

                        return 0;
                    });
            }

            // Step 7: Fetch alternate-day trains (when date filter applied)
            let alternateResult = { rows: [] };
            let alternateCountResult = { rows: [{ total: "0" }] };
            if (hasDateFilter) {
                // Trains that do NOT run on selected day (alternate days), limit 50
                const alternateSQL = `SELECT ${trainSelect} ${trainJoins} ${alternateDayCondition}
                    ORDER BY ${orderBy} LIMIT ${ALTERNATE_DAYS_LIMIT} `;
                // Count of trains that do NOT run on selected day
                const alternateCountSQL = `SELECT COUNT(*) AS total ${trainJoins} ${alternateDayCondition}`;
                [alternateResult, alternateCountResult] = await Promise.all([
                    SqlService.executeQuery(alternateSQL, [from, to]),
                    SqlService.executeQuery(alternateCountSQL, [from, to]),
                ]);
            }

            // Step 8: Total count (already fetched in Step 5)
            const totalCount = parseInt(countResult.rows[0]?.total || 0, 10);
            const alternateTotalCount = parseInt(alternateCountResult.rows[0]?.total || 0, 10);

            const data = {
                totalCount,
                trains,
                nearby_trains: nearbyTrains,
            };
            if (hasDateFilter) {
                data.date = dateStr || null;
                data.dayOfWeek = day;
                data.alternate_days = {
                    totalCount: alternateTotalCount,
                    trains: alternateResult.rows,
                };
            }

            const response = {
                message: ConstantService.responseMessage.TRAIN_BETWEEN_STATIONS,
                data,
            };

            // Step 9: Cache the response for 1 day (24 hours)
            const ttlSeconds = 24 * 60 * 60; // 1 day in seconds

            CacheService.set(cacheKey, response, ttlSeconds);

            return ResponseService.jsonResponse(res, ConstantService.responseCode.SUCCESS, response);
        } catch (exception) {
            LogService.error(exception);
            return ResponseService.json(res, ConstantService.responseCode.INTERNAL_SERVER_ERROR, ConstantService.responseMessage.ERR_MSG_ISSUE_IN_TRAIN_BETWEEN_API);
        }
    },

    /**
     * Find trains between two states.
     * API Endpoint :   /train/between/states
     * API Method   :   GET
     *
     * @param   {Object}        req          Request Object From API Request.
     * @param   {Object}        res          Response Object For API Request.
     * @returns {Promise<*>}    JSONResponse With success code 200 and train list or relevant error code with message.
     */
    trainBetweenStates: async (req, res) => {
        try {
            LogService.info("====================== TRAIN BETWEEN STATES API ==============================");
            LogService.info("REQ QUERY : ", { ...req.query });

            const request = {
                from_state: req.query.from_state,
                to_state: req.query.to_state,
                date: req.query.date,
                limit: req.query.limit,
                sort: req.query.sort,
                order: req.query.order,
            };

            const schema = Joi.object().keys({
                from_state: Joi.string().required().min(1).max(100).trim(),
                to_state: Joi.string().required().min(1).max(100).trim().invalid(Joi.ref("from_state")),
                date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional().allow(""),
                limit: Joi.number().integer().min(1).max(100).optional().default(30),
                sort: Joi.string().valid("duration", "departure_time", "arrival_time").default("duration").optional(),
                order: Joi.string().valid("asc", "desc").default("asc").optional(),
            });

            const { error, value } = schema.validate(request, { abortEarly: false, stripUnknown: true });
            if (error) {
                return ResponseService.jsonResponse(res, ConstantService.responseCode.BAD_REQUEST, {
                    message: error.message,
                });
            }

            const { from_state, to_state, date: dateStr, limit, sort, order } = value;
            let day = null;
            if (dateStr) {
                const d = new Date(dateStr);
                if (!Number.isNaN(d.getTime())) day = d.getDay();
            }

            // Step 1: Check cache
            const cacheKey = `train:states:${from_state}:${to_state}:${dateStr || "all"}:${limit}:${sort}:${order}`;
            const cached = CacheService.get(cacheKey);
            if (cached) {
                LogService.info(`[CACHE HIT] ${cacheKey}`);
                return ResponseService.jsonResponse(res, ConstantService.responseCode.SUCCESS, cached);
            }
            LogService.info(`[CACHE MISS] ${cacheKey}`);

            // Step 2: Get top stations per state (by train_count)
            const STATIONS_PER_STATE = 5;
            const TRAINS_PER_PAIR = 15;

            const fromStationsSQL = `
                SELECT code, name FROM stations
                WHERE LOWER(TRIM(state)) = LOWER(TRIM($1)) AND code IS NOT NULL
                ORDER BY COALESCE(train_count, 0) DESC NULLS LAST
                LIMIT ${STATIONS_PER_STATE}
            `;
            const toStationsSQL = `
                SELECT code, name FROM stations
                WHERE LOWER(TRIM(state)) = LOWER(TRIM($1)) AND code IS NOT NULL
                ORDER BY COALESCE(train_count, 0) DESC NULLS LAST
                LIMIT ${STATIONS_PER_STATE}
            `;

            const [fromStationsRes, toStationsRes] = await Promise.all([
                SqlService.executeQuery(fromStationsSQL, [from_state]),
                SqlService.executeQuery(toStationsSQL, [to_state]),
            ]);

            const fromStations = fromStationsRes.rows;
            const toStations = toStationsRes.rows;

            if (fromStations.length === 0) {
                return ResponseService.jsonResponse(res, ConstantService.responseCode.BAD_REQUEST, {
                    message: `No stations found in state: ${from_state}`,
                });
            }
            if (toStations.length === 0) {
                return ResponseService.jsonResponse(res, ConstantService.responseCode.BAD_REQUEST, {
                    message: `No stations found in state: ${to_state}`,
                });
            }

            // Step 3: Build SQL fragments (same as trainBetweenStations)
            const DAY_COLS = ["runs_on_sun", "runs_on_mon", "runs_on_tue", "runs_on_wed", "runs_on_thu", "runs_on_fri", "runs_on_sat"];
            const hasDateFilter = day != null && day >= 0 && day <= 6;
            const dayCondition = hasDateFilter ? ` AND t.${DAY_COLS[day]} = true` : "";

            // Duration in minutes: (arrival_time + day_offset) - departure_time
            // Handle NULL day_count: NULL defaults to 1 (first day of journey)
            const DEP = asTime("from_stop.departure_time");
            const ARR = asTime("to_stop.arrival_time");
            const DURATION_MINS = `(
                EXTRACT(EPOCH FROM ${ARR}) / 60
                + GREATEST(0, COALESCE(to_stop.day_count, 1) - COALESCE(from_stop.day_count, 1)) * 24 * 60
                - EXTRACT(EPOCH FROM ${DEP}) / 60
            )`;
            const sortExpr = {
                duration: DURATION_MINS,
                departure_time: DEP,
                arrival_time: ARR,
            };
            const orderBy = `${sortExpr[sort]} ${order.toUpperCase()} NULLS LAST, t.train_number`;

            const ROUTE_REACHABILITY = `
                AND (
                    COALESCE(from_stop.route_number, '1') = COALESCE(to_stop.route_number, '1')
                    OR from_stop.serial_number <= (
                        SELECT COALESCE(MAX(tr.serial_number), 0)
                        FROM train_route tr
                        WHERE tr.train_id = t.id
                            AND COALESCE(tr.route_number, '1') = COALESCE(from_stop.route_number, '1')
                            AND tr.station_code IN (
                                SELECT station_code FROM train_route
                                WHERE train_id = t.id
                                    AND COALESCE(route_number, '1') = COALESCE(to_stop.route_number, '1')
                            )
                    )
                )`;

            const trainJoins = `
                FROM trains t
                INNER JOIN train_route from_stop
                    ON from_stop.train_id = t.id AND from_stop.station_code = $1
                INNER JOIN train_route to_stop
                    ON to_stop.train_id = t.id AND to_stop.station_code = $2
                WHERE from_stop.serial_number < to_stop.serial_number
                    AND from_stop.boarding_disabled = false
                    AND to_stop.boarding_disabled = false
                    ${ROUTE_REACHABILITY}`;

            const trainSelect = `
                LPAD(t.train_number::text, 5, '0') AS train_number,
                t.train_name,
                CASE
                    WHEN from_stop.departure_time IS NOT NULL AND to_stop.arrival_time IS NOT NULL THEN (
                        SELECT LPAD((dm / 60)::text, 2, '0') || ':' || LPAD((dm % 60)::text, 2, '0')
                        FROM (SELECT GREATEST(0, ${DURATION_MINS})::int AS dm) x
                    )
                    ELSE t.duration
                END AS duration,
                ARRAY[
                    t.runs_on_mon::int, t.runs_on_tue::int, t.runs_on_wed::int,
                    t.runs_on_thu::int, t.runs_on_fri::int, t.runs_on_sat::int, t.runs_on_sun::int
                ] AS "runs_on",
                from_stop.station_code AS from_station_code,
                from_stop.station_name AS from_station_name,
                from_stop.departure_time AS departure_time,
                to_stop.station_code AS to_station_code,
                to_stop.station_name AS to_station_name,
                to_stop.arrival_time AS arrival_time,
                (to_stop.distance - from_stop.distance) AS distance_between`;

            const trainsSQL = `
                SELECT ${trainSelect}
                ${trainJoins}
                ${dayCondition}
                ORDER BY ${orderBy}
                LIMIT $3
            `;

            // Step 4: Query trains for each station pair, merge and deduplicate
            const seenTrainNumbers = new Set();
            const allTrains = [];
            const routeDetails = [];

            for (const fs of fromStations) {
                for (const ts of toStations) {
                    if (fs.code === ts.code) continue;
                    const result = await SqlService.executeQuery(trainsSQL, [fs.code, ts.code, TRAINS_PER_PAIR]);
                    const rows = result.rows || [];
                    for (const row of rows) {
                        if (!seenTrainNumbers.has(row.train_number)) {
                            seenTrainNumbers.add(row.train_number);
                            allTrains.push(row);
                            if (allTrains.length >= limit) break;
                        }
                    }
                    if (rows.length > 0) {
                        routeDetails.push({
                            from_station: { code: fs.code, name: fs.name },
                            to_station: { code: ts.code, name: ts.name },
                            train_count: rows.length,
                        });
                    }
                    if (allTrains.length >= limit) break;
                }
                if (allTrains.length >= limit) break;
            }

            // Step 5: Sort merged trains by duration/departure/arrival
            sortTrains(allTrains, sort, order);

            const data = {
                from_state,
                to_state,
                totalCount: allTrains.length,
                trains: allTrains.slice(0, limit),
                from_stations: fromStations.map((s) => ({ code: s.code, name: s.name })),
                to_stations: toStations.map((s) => ({ code: s.code, name: s.name })),
                route_details: routeDetails,
            };
            if (hasDateFilter) {
                data.date = dateStr || null;
                data.dayOfWeek = day;
            }

            const response = {
                message: ConstantService.responseMessage.TRAIN_BETWEEN_STATES,
                data,
            };

            // Step 6: Cache the response for 1 day (24 hours)
            const ttlSeconds = 24 * 60 * 60; // 1 day in seconds
            CacheService.set(cacheKey, response, ttlSeconds);

            return ResponseService.jsonResponse(res, ConstantService.responseCode.SUCCESS, response);
        } catch (exception) {
            LogService.error(exception);
            return ResponseService.json(res, ConstantService.responseCode.INTERNAL_SERVER_ERROR, ConstantService.responseMessage.ERR_MSG_ISSUE_IN_TRAIN_BETWEEN_STATES_API);
        }
    },

    /**
     * Full stop-by-stop schedule for one train, with coordinates for mapping.
     * API Endpoint :   /train/:number/route
     * API Method   :   GET
     */
    trainRoute: async (req, res) => {
        try {
            LogService.info("====================== TRAIN ROUTE API ==============================");

            const schema = Joi.object().keys({
                number: Joi.string().required().pattern(/^\d{1,5}$/),
            });
            const { error, value } = schema.validate({ number: req.params.number }, { abortEarly: false, stripUnknown: true });
            if (error) {
                return ResponseService.jsonResponse(res, ConstantService.responseCode.BAD_REQUEST, { message: error.message });
            }

            const trainNumber = parseInt(value.number, 10);
            const cacheKey = `train:route:${trainNumber}`;
            const cached = CacheService.get(cacheKey);
            if (cached) {
                LogService.info(`[CACHE HIT] ${cacheKey}`);
                return ResponseService.jsonResponse(res, ConstantService.responseCode.SUCCESS, cached);
            }

            const trainRes = await SqlService.executeQuery(
                `SELECT id, LPAD(train_number::text, 5, '0') AS train_number, train_name, train_owner, duration,
                        station_from, station_to,
                        ARRAY[runs_on_mon::int, runs_on_tue::int, runs_on_wed::int,
                              runs_on_thu::int, runs_on_fri::int, runs_on_sat::int, runs_on_sun::int] AS "runs_on"
                 FROM trains WHERE train_number = $1`,
                [trainNumber],
            );
            const train = trainRes.rows[0];
            if (!train) {
                return ResponseService.jsonResponse(res, ConstantService.responseCode.BAD_REQUEST, {
                    message: `No train found with number ${value.number}`,
                });
            }

            // location is a Postgres point; a few hundred stops have (0,0) and
            // must come back as null so the map can skip them rather than
            // drawing a line through the Gulf of Guinea.
            const stopsRes = await SqlService.executeQuery(
                `SELECT tr.serial_number, tr.station_code, tr.station_name,
                        tr.arrival_time, tr.departure_time, tr.halt_time,
                        tr.distance, tr.day_count, tr.route_number, tr.boarding_disabled,
                        s.name AS canonical_name, s.state, s.district,
                        CASE WHEN s.location IS NULL OR (s.location[0] = 0 AND s.location[1] = 0)
                             THEN NULL ELSE s.location[0] END AS lng,
                        CASE WHEN s.location IS NULL OR (s.location[0] = 0 AND s.location[1] = 0)
                             THEN NULL ELSE s.location[1] END AS lat
                 FROM train_route tr
                 LEFT JOIN stations s ON s.code = tr.station_code
                 WHERE tr.train_id = $1
                 ORDER BY tr.serial_number`,
                [train.id],
            );

            const stops = stopsRes.rows.map((r) => ({
                serial: r.serial_number,
                code: r.station_code,
                name: r.canonical_name || r.station_name,
                state: r.state || null,
                district: r.district || null,
                arrival: r.arrival_time,
                departure: r.departure_time,
                halt: r.halt_time,
                distance: r.distance,
                day: r.day_count,
                routeNumber: r.route_number,
                boardingDisabled: r.boarding_disabled,
                lat: r.lat === null ? null : Number(r.lat),
                lng: r.lng === null ? null : Number(r.lng),
            }));

            const response = {
                message: "Train route fetched successfully",
                data: {
                    train: {
                        train_number: train.train_number,
                        train_name: train.train_name,
                        train_owner: train.train_owner,
                        duration: train.duration,
                        station_from: train.station_from,
                        station_to: train.station_to,
                        runs_on: train.runs_on,
                    },
                    totalStops: stops.length,
                    totalDistance: stops.reduce((max, s) => (s.distance == null ? max : Math.max(max, s.distance)), null),
                    mappedStops: stops.filter((s) => s.lat !== null).length,
                    stops,
                },
            };

            CacheService.set(cacheKey, response, 24 * 60 * 60);
            return ResponseService.jsonResponse(res, ConstantService.responseCode.SUCCESS, response);
        } catch (exception) {
            LogService.error(exception);
            return ResponseService.json(res, ConstantService.responseCode.INTERNAL_SERVER_ERROR, ConstantService.responseMessage.ERR_OOPS_SOMETHING_WENT_WRONG);
        }
    },

    /**
     * Find trains between two locations (place, station, or state).
     * API Endpoint :   /train/between/places
     * API Method   :   GET
     * from/to can be: station code (NDLS), place name (Delhi, Taj Mahal), or state name (Maharashtra).
     */
    trainBetweenPlaces: async (req, res) => {
        try {
            LogService.info("====================== TRAIN BETWEEN PLACES API ==============================");
            LogService.info("REQ QUERY : ", { ...req.query });

            const schema = Joi.object().keys({
                from: Joi.string().required().min(1).max(100).trim(),
                to: Joi.string().required().min(1).max(100).trim(),
                from_kind: Joi.string().valid("station", "city", "place", "district", "state").optional().allow("", null),
                to_kind: Joi.string().valid("station", "city", "place", "district", "state").optional().allow("", null),
                date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional().allow(""),
                skip: Joi.number().integer().min(0).optional().default(0),
                limit: Joi.number().integer().min(1).max(100).optional().default(30),
                sort: Joi.string().valid("duration", "departure_time", "arrival_time").default("duration").optional(),
                order: Joi.string().valid("asc", "desc").default("asc").optional(),
            });

            const { error, value } = schema.validate(
                {
                    from: req.query.from,
                    to: req.query.to,
                    from_kind: req.query.from_kind,
                    to_kind: req.query.to_kind,
                    date: req.query.date,
                    skip: req.query.skip,
                    limit: req.query.limit,
                    sort: req.query.sort,
                    order: req.query.order,
                },
                { abortEarly: false, stripUnknown: true },
            );
            if (error) {
                return ResponseService.jsonResponse(res, ConstantService.responseCode.BAD_REQUEST, { message: error.message });
            }

            const { from: fromInput, to: toInput, from_kind: fromKind, to_kind: toKind, date: dateStr, skip, limit, sort, order } = value;

            let day = null;
            if (dateStr) {
                // The pattern admits 2026-13-45, so only a real calendar date may
                // filter. Read the weekday in UTC: getDay() would answer in the
                // server's zone and shift the day west of UTC.
                const d = new Date(`${dateStr}T00:00:00Z`);
                if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== dateStr) {
                    return ResponseService.jsonResponse(res, ConstantService.responseCode.BAD_REQUEST, {
                        message: `Invalid date: ${dateStr}`,
                    });
                }
                day = d.getUTCDay();
            }
            const hasDateFilter = day != null;

            const cacheKey = `train:place:${fromKind || "?"}:${fromInput}:${toKind || "?"}:${toInput}:${dateStr || "all"}:${skip}:${limit}:${sort}:${order}`;
            const cached = CacheService.get(cacheKey);
            if (cached) {
                LogService.info(`[CACHE HIT] ${cacheKey}`);
                return ResponseService.jsonResponse(res, ConstantService.responseCode.SUCCESS, cached);
            }

            const { fromResult, toResult } = await PlaceService.resolveFromTo(fromInput, toInput, fromKind || null, toKind || null);
            const fromCodes = fromResult.stations.map((s) => s.code);
            const toCodes = toResult.stations.map((s) => s.code);

            const describe = (input, result) => ({
                input,
                type: result.type,
                label: result.label,
                parent: result.parent || null,
                stations: result.stations.map((s) => ({ code: s.code, name: s.name })),
            });

            if (fromCodes.length === 0 || toCodes.length === 0) {
                const unresolved = [fromCodes.length === 0 ? fromInput : null, toCodes.length === 0 ? toInput : null].filter(Boolean);
                return ResponseService.jsonResponse(res, ConstantService.responseCode.BAD_REQUEST, {
                    message: `Could not match ${unresolved.join(" or ")} to any station, city, district or state`,
                    data: {
                        from: describe(fromInput, fromResult),
                        to: describe(toInput, toResult),
                        totalCount: 0,
                        trains: [],
                        date: dateStr || null,
                        dayOfWeek: hasDateFilter ? day : undefined,
                    },
                });
            }

            const DAY_COLS = ["runs_on_sun", "runs_on_mon", "runs_on_tue", "runs_on_wed", "runs_on_thu", "runs_on_fri", "runs_on_sat"];
            const dayCondition = hasDateFilter ? ` AND t.${DAY_COLS[day]} = true` : "";
            const altDayCondition = hasDateFilter ? ` AND t.${DAY_COLS[day]} = false` : "";

            const DEP = asTime("from_stop.departure_time");
            const ARR = asTime("to_stop.arrival_time");
            const DURATION_MINS = `(
                EXTRACT(EPOCH FROM ${ARR}) / 60
                + GREATEST(0, COALESCE(to_stop.day_count, 1) - COALESCE(from_stop.day_count, 1)) * 24 * 60
                - EXTRACT(EPOCH FROM ${DEP}) / 60
            )`;

            const ROUTE_REACHABILITY = `
                AND (
                    COALESCE(from_stop.route_number, '1') = COALESCE(to_stop.route_number, '1')
                    OR from_stop.serial_number <= (
                        SELECT COALESCE(MAX(tr.serial_number), 0)
                        FROM train_route tr
                        WHERE tr.train_id = t.id
                            AND COALESCE(tr.route_number, '1') = COALESCE(from_stop.route_number, '1')
                            AND tr.station_code IN (
                                SELECT station_code FROM train_route
                                WHERE train_id = t.id
                                    AND COALESCE(route_number, '1') = COALESCE(to_stop.route_number, '1')
                            )
                    )
                )`;

            /*
             * One query for every station pair, instead of a sequential loop over
             * the cross product. WITH ORDINALITY carries each station's curated
             * rank, and DISTINCT ON keeps a single row per train: the best-ranked
             * boarding point, then the widest segment. Ordering and paging then
             * apply to the whole result set rather than to whatever the loop
             * happened to collect first.
             */
            const bestPerTrain = (extraCondition) => `
                SELECT DISTINCT ON (t.id)
                    t.id AS train_id,
                    LPAD(t.train_number::text, 5, '0') AS train_number,
                    t.train_name,
                    CASE
                        WHEN ${DEP} IS NOT NULL AND ${ARR} IS NOT NULL THEN (
                            SELECT LPAD((dm / 60)::text, 2, '0') || ':' || LPAD((dm % 60)::text, 2, '0')
                            FROM (SELECT GREATEST(0, ${DURATION_MINS})::int AS dm) x
                        )
                        ELSE t.duration
                    END AS duration,
                    /*
                     * Must stay NULL when either time is missing so NULLS LAST can
                     * push it to the end. GREATEST ignores NULLs, so the obvious
                     * GREATEST(0, ...) would score these 0 and sort them first -
                     * a 10h train ahead of a 7h one under the default sort.
                     */
                    CASE WHEN ${DEP} IS NULL OR ${ARR} IS NULL
                         THEN NULL ELSE GREATEST(0, ${DURATION_MINS})::int END AS duration_mins,
                    ARRAY[
                        t.runs_on_mon::int, t.runs_on_tue::int, t.runs_on_wed::int,
                        t.runs_on_thu::int, t.runs_on_fri::int, t.runs_on_sat::int, t.runs_on_sun::int
                    ] AS "runs_on",
                    from_stop.station_code AS from_station_code,
                    from_stop.station_name AS from_station_name,
                    from_stop.departure_time AS departure_time,
                    to_stop.station_code AS to_station_code,
                    to_stop.station_name AS to_station_name,
                    to_stop.arrival_time AS arrival_time,
                    (to_stop.distance - from_stop.distance) AS distance_between
                FROM trains t
                INNER JOIN train_route from_stop ON from_stop.train_id = t.id
                INNER JOIN unnest($1::text[]) WITH ORDINALITY AS f(code, ord) ON f.code = from_stop.station_code
                INNER JOIN train_route to_stop ON to_stop.train_id = t.id
                INNER JOIN unnest($2::text[]) WITH ORDINALITY AS v(code, ord) ON v.code = to_stop.station_code
                WHERE from_stop.serial_number < to_stop.serial_number
                    AND from_stop.boarding_disabled = false
                    AND to_stop.boarding_disabled = false
                    ${ROUTE_REACHABILITY}
                    ${extraCondition}
                ORDER BY t.id,
                    (${DEP} IS NULL OR ${ARR} IS NULL),
                    f.ord, v.ord, from_stop.serial_number, to_stop.serial_number DESC`;

            const OUT_COLS = `train_number, train_name, duration, "runs_on",
                from_station_code, from_station_name, departure_time,
                to_station_code, to_station_name, arrival_time, distance_between`;
            const sortExpr = {
                duration: "duration_mins",
                departure_time: asTime("departure_time"),
                arrival_time: asTime("arrival_time"),
            }[sort];
            const outerOrder = `${sortExpr} ${order.toUpperCase()} NULLS LAST, train_number`;

            const listSQL = `SELECT ${OUT_COLS} FROM (${bestPerTrain(dayCondition)}) b ORDER BY ${outerOrder} LIMIT $3 OFFSET $4`;
            const countSQL = `SELECT COUNT(*)::int AS total FROM (${bestPerTrain(dayCondition)}) b`;

            const queries = [
                SqlService.executeQuery(listSQL, [fromCodes, toCodes, limit, skip]),
                SqlService.executeQuery(countSQL, [fromCodes, toCodes]),
            ];
            if (hasDateFilter) {
                queries.push(
                    SqlService.executeQuery(
                        `SELECT ${OUT_COLS} FROM (${bestPerTrain(altDayCondition)}) b ORDER BY ${outerOrder} LIMIT 50`,
                        [fromCodes, toCodes],
                    ),
                );
                queries.push(
                    SqlService.executeQuery(`SELECT COUNT(*)::int AS total FROM (${bestPerTrain(altDayCondition)}) b`, [fromCodes, toCodes]),
                );
            }

            const [listRes, countRes, altRes, altCountRes] = await Promise.all(queries);

            const data = {
                from: describe(fromInput, fromResult),
                to: describe(toInput, toResult),
                totalCount: countRes.rows[0]?.total || 0,
                trains: listRes.rows,
            };
            if (hasDateFilter) {
                data.date = dateStr || null;
                data.dayOfWeek = day;
                data.alternate_days = {
                    totalCount: altCountRes?.rows[0]?.total || 0,
                    trains: altRes?.rows || [],
                };
            }

            const response = { message: ConstantService.responseMessage.TRAIN_BETWEEN_PLACES, data };
            CacheService.set(cacheKey, response, 24 * 60 * 60);
            return ResponseService.jsonResponse(res, ConstantService.responseCode.SUCCESS, response);
        } catch (exception) {
            LogService.error(exception);
            return ResponseService.json(res, ConstantService.responseCode.INTERNAL_SERVER_ERROR, ConstantService.responseMessage.ERR_MSG_ISSUE_IN_TRAIN_BETWEEN_PLACES_API);
        }
    },
};
