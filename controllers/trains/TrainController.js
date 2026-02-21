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
            const DURATION_MINS = `(
                EXTRACT(EPOCH FROM (to_stop.arrival_time::time)) / 60
                + GREATEST(0, COALESCE(to_stop.day_count, 1) - COALESCE(from_stop.day_count, 1)) * 24 * 60
                - EXTRACT(EPOCH FROM (from_stop.departure_time::time)) / 60
            )`;
            const sortExpr = {
                duration: DURATION_MINS,
                departure_time: "from_stop.departure_time::time",
                arrival_time: "to_stop.arrival_time::time",
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

            // Step 4: Check cache (key: from, to, date, skip, limit, sort, order)
            const cacheKey = `train:${from}:${to}:${dateStr ?? "all"}:${skip}:${limit}:${sort}:${order}`;
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
                SELECT ${HAVERSINE_KM}::int AS distance_km, f.name AS from_name, t.name AS to_name
                FROM stations f CROSS JOIN stations t
                WHERE f.code = $1 AND t.code = $2
            `;

            const [trainsResult, countResult, fromToResult] = await Promise.all([
                SqlService.executeQuery(trainsSQL, [from, to, limit, skip]),
                SqlService.executeQuery(countSQL, [from, to]),
                SqlService.executeQuery(fromToDistanceSQL, [from, to]),
            ]);

            const trains = trainsResult.rows;
            const fromToRow = fromToResult.rows[0];
            const fromToDistanceKm = parseInt(fromToRow?.distance_km, 10) || 0;
            const shouldFindNearby = fromToDistanceKm > NEARBY_MIN_DISTANCE_KM || (trains.length === 0 && fromToDistanceKm > 0);

            const origFrom = fromToRow ? { code: from, name: fromToRow.from_name, distance_km: 0 } : null;
            const origTo = fromToRow ? { code: to, name: fromToRow.to_name, distance_km: 0 } : null;

            // Step 6: Find nearby stations and their trains (when distance > 200 km or no direct trains)
            let nearbyTrains = [];
            if (shouldFindNearby) {
                // Step 6a: Stations within 100 km of orig ($1), excluding orig and the other station ($2). Ordered by train_count, limit 5.
                const nearbySQL = `
                    SELECT s.code, s.name, s.train_count,
                        ${HAVERSINE_SINGLE}::int AS distance_km
                    FROM stations s
                    CROSS JOIN (SELECT code, location FROM stations WHERE code = $1) orig
                    WHERE s.code != orig.code
                        AND s.code != $2
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
                const pairResults = await Promise.all(
                    pairs.map((p) => SqlService.executeQuery(pairSQL, [p.from_station.code, p.to_station.code]))
                );

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
                    .filter((item) => item.trains.length > 0);
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
            CacheService.set(cacheKey, response);

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

            // Step 1: Get top stations per state (by train_count)
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

            // Step 2: Build SQL fragments (same as trainBetweenStations)
            const DAY_COLS = ["runs_on_sun", "runs_on_mon", "runs_on_tue", "runs_on_wed", "runs_on_thu", "runs_on_fri", "runs_on_sat"];
            const hasDateFilter = day != null && day >= 0 && day <= 6;
            const dayCondition = hasDateFilter ? ` AND t.${DAY_COLS[day]} = true` : "";

            const DURATION_MINS = `(
                EXTRACT(EPOCH FROM (to_stop.arrival_time::time)) / 60
                + GREATEST(0, COALESCE(to_stop.day_count, 1) - COALESCE(from_stop.day_count, 1)) * 24 * 60
                - EXTRACT(EPOCH FROM (from_stop.departure_time::time)) / 60
            )`;
            const sortExpr = {
                duration: DURATION_MINS,
                departure_time: "from_stop.departure_time::time",
                arrival_time: "to_stop.arrival_time::time",
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

            // Step 3: Query trains for each station pair, merge and deduplicate
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

            // Step 4: Sort merged trains by duration/departure/arrival
            const parseDurationMins = (d) => {
                if (!d || typeof d !== "string") return 999999;
                const [h, m] = d.split(":").map((x) => parseInt(x, 10) || 0);
                return h * 60 + m;
            };
            const timeStr = (t) => (t ? String(t).replace(/:\d{2}$/, "") : "") || "99:99";
            allTrains.sort((a, b) => {
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

            return ResponseService.jsonResponse(res, ConstantService.responseCode.SUCCESS, {
                message: ConstantService.responseMessage.TRAIN_BETWEEN_STATES,
                data,
            });
        } catch (exception) {
            LogService.error(exception);
            return ResponseService.json(res, ConstantService.responseCode.INTERNAL_SERVER_ERROR, ConstantService.responseMessage.ERR_MSG_ISSUE_IN_TRAIN_BETWEEN_STATES_API);
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

            const request = {
                from: req.query.from,
                to: req.query.to,
                date: req.query.date,
                limit: req.query.limit,
                sort: req.query.sort,
                order: req.query.order,
            };

            const schema = Joi.object().keys({
                from: Joi.string().required().min(1).max(100).trim(),
                to: Joi.string().required().min(1).max(100).trim(),
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

            const { from: fromInput, to: toInput, date: dateStr, limit, sort, order } = value;
            let day = null;
            if (dateStr) {
                const d = new Date(dateStr);
                if (!Number.isNaN(d.getTime())) day = d.getDay();
            }

            const cacheKey = `train:place:${fromInput}:${toInput}:${dateStr ?? "all"}:${limit}:${sort}:${order}`;
            const cached = CacheService.get(cacheKey);
            if (cached) {
                LogService.info(`[CACHE HIT] ${cacheKey}`);
                return ResponseService.jsonResponse(res, ConstantService.responseCode.SUCCESS, cached);
            }
            LogService.info(`[CACHE MISS] ${cacheKey}`);

            const { fromResult, toResult } = await PlaceService.resolveFromTo(fromInput, toInput);

            if (fromResult.stations.length === 0) {
                return ResponseService.jsonResponse(res, ConstantService.responseCode.BAD_REQUEST, {
                    message: `Could not find stations for: ${fromInput}. Try a station code, place name, or state name.`,
                });
            }
            if (toResult.stations.length === 0) {
                return ResponseService.jsonResponse(res, ConstantService.responseCode.BAD_REQUEST, {
                    message: `Could not find stations for: ${toInput}. Try a station code, place name, or state name.`,
                });
            }

            const fromStations = fromResult.stations;
            const toStations = toResult.stations;

            const TRAINS_PER_PAIR = 15;
            const DAY_COLS = ["runs_on_sun", "runs_on_mon", "runs_on_tue", "runs_on_wed", "runs_on_thu", "runs_on_fri", "runs_on_sat"];
            const hasDateFilter = day != null && day >= 0 && day <= 6;
            const dayCondition = hasDateFilter ? ` AND t.${DAY_COLS[day]} = true` : "";

            const DURATION_MINS = `(
                EXTRACT(EPOCH FROM (to_stop.arrival_time::time)) / 60
                + GREATEST(0, COALESCE(to_stop.day_count, 1) - COALESCE(from_stop.day_count, 1)) * 24 * 60
                - EXTRACT(EPOCH FROM (from_stop.departure_time::time)) / 60
            )`;
            const sortExpr = {
                duration: DURATION_MINS,
                departure_time: "from_stop.departure_time::time",
                arrival_time: "to_stop.arrival_time::time",
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

            const seenTrainNumbers = new Set();
            const allTrains = [];

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
                    if (allTrains.length >= limit) break;
                }
                if (allTrains.length >= limit) break;
            }

            const parseDurationMins = (d) => {
                if (!d || typeof d !== "string") return 999999;
                const [h, m] = d.split(":").map((x) => parseInt(x, 10) || 0);
                return h * 60 + m;
            };
            const timeStr = (t) => (t ? String(t).replace(/:\d{2}$/, "") : "") || "99:99";
            allTrains.sort((a, b) => {
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

            const data = {
                from: { input: fromInput, type: fromResult.type, label: fromResult.label, stations: fromStations },
                to: { input: toInput, type: toResult.type, label: toResult.label, stations: toStations },
                totalCount: allTrains.length,
                trains: allTrains.slice(0, limit),
            };
            if (hasDateFilter) {
                data.date = dateStr || null;
                data.dayOfWeek = day;
            }

            const response = {
                message: ConstantService.responseMessage.TRAIN_BETWEEN_PLACES,
                data,
            };
            CacheService.set(cacheKey, response);
            return ResponseService.jsonResponse(res, ConstantService.responseCode.SUCCESS, response);
        } catch (exception) {
            LogService.error(exception);
            return ResponseService.json(res, ConstantService.responseCode.INTERNAL_SERVER_ERROR, ConstantService.responseMessage.ERR_MSG_ISSUE_IN_TRAIN_BETWEEN_PLACES_API);
        }
    },
};
