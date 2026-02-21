module.exports = {
    /**
     * Add a new place.
     * API Endpoint :   /place/add
     * API Method   :   POST
     * Body: { name, display_name?, state?, description?, image_url?, lat?, lng?, stations: [station_code, ...] }
     */
    placeAdd: async (req, res) => {
        try {
            LogService.info("====================== PLACE ADD API ==============================");
            LogService.info("REQ BODY : ", { ...req.body });

            const request = {
                name: req.body.name,
                display_name: req.body.display_name,
                state: req.body.state,
                description: req.body.description,
                image_url: req.body.image_url,
                lat: req.body.lat,
                lng: req.body.lng,
                stations: req.body.stations,
            };

            const schema = Joi.object().keys({
                name: Joi.string().required().min(1).max(200).trim(),
                display_name: Joi.string().allow("").max(200).trim().optional(),
                state: Joi.string().allow("").max(100).trim().optional(),
                description: Joi.string().allow("").max(2000).trim().optional(),
                image_url: Joi.string().max(2048).trim().optional().allow("", null),
                lat: Joi.number().min(-90).max(90).optional().allow(null),
                lng: Joi.number().min(-180).max(180).optional().allow(null),
                stations: Joi.array()
                    .items(Joi.string().trim().uppercase().min(2).max(10))
                    .min(1)
                    .max(20)
                    .required(),
            });

            const { error, value } = schema.validate(request, { abortEarly: false, stripUnknown: true });
            if (error) {
                return ResponseService.jsonResponse(res, ConstantService.responseCode.BAD_REQUEST, {
                    message: error.message,
                });
            }

            const { name, display_name, state, description, image_url, lat, lng, stations } = value;
            const displayName = display_name || name;
            const hasLoc = lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng);
            const desc = description || null;
            const imgUrl = image_url || null;

            const client = await SqlService.pool.connect();
            try {
                await client.query("BEGIN");

                const existing = await client.query(
                    "SELECT id FROM places WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))",
                    [name]
                );

                let placeId;
                if (existing.rows.length > 0) {
                    placeId = existing.rows[0].id;
                    await client.query("DELETE FROM place_stations WHERE place_id = $1", [placeId]);
                    if (hasLoc) {
                        await client.query(
                            "UPDATE places SET name = $1, display_name = $2, state = $3, description = $4, image_url = $5, location = point($6, $7) WHERE id = $8",
                            [name, displayName, state || null, desc, imgUrl, Number(lng), Number(lat), placeId]
                        );
                    } else {
                        await client.query(
                            "UPDATE places SET name = $1, display_name = $2, state = $3, description = $4, image_url = $5 WHERE id = $6",
                            [name, displayName, state || null, desc, imgUrl, placeId]
                        );
                    }
                } else {
                    if (hasLoc) {
                        const insertRes = await client.query(
                            "INSERT INTO places (name, display_name, state, description, image_url, location) VALUES ($1, $2, $3, $4, $5, point($6, $7)) RETURNING id",
                            [name, displayName, state || null, desc, imgUrl, Number(lng), Number(lat)]
                        );
                        placeId = insertRes.rows[0].id;
                    } else {
                        const insertRes = await client.query(
                            "INSERT INTO places (name, display_name, state, description, image_url) VALUES ($1, $2, $3, $4, $5) RETURNING id",
                            [name, displayName, state || null, desc, imgUrl]
                        );
                        placeId = insertRes.rows[0].id;
                    }
                }

                const placeStationsValues = stations
                    .map((code, i) => `($1, $${2 + i * 2}, $${3 + i * 2})`)
                    .join(", ");
                const placeStationsParams = [placeId, ...stations.flatMap((code, i) => [code, i + 1])];
                await client.query(
                    `INSERT INTO place_stations (place_id, station_code, rank) VALUES ${placeStationsValues}
                     ON CONFLICT (place_id, station_code) DO UPDATE SET rank = EXCLUDED.rank`,
                    placeStationsParams
                );

                await client.query("COMMIT");

                const loc = hasLoc ? { lat, lng } : null;
                const isUpdate = existing.rows.length > 0;
                return ResponseService.jsonResponse(
                    res,
                    isUpdate ? ConstantService.responseCode.SUCCESS : ConstantService.responseCode.CREATED,
                    {
                        message: isUpdate
                            ? ConstantService.responseMessage.PLACE_UPDATE_SUCCESS
                            : ConstantService.responseMessage.PLACE_ADD_SUCCESS,
                        data: {
                            id: placeId,
                            name,
                            display_name: displayName,
                            state: state || null,
                            description: description || null,
                            image_url: image_url || null,
                            lat: loc?.lat,
                            lng: loc?.lng,
                            stations,
                        },
                    }
                );
            } catch (txErr) {
                await client.query("ROLLBACK").catch(() => { });
                throw txErr;
            } finally {
                client.release();
            }
        } catch (exception) {
            LogService.error(exception);
            return ResponseService.json(res, ConstantService.responseCode.INTERNAL_SERVER_ERROR, ConstantService.responseMessage.ERR_MSG_ISSUE_IN_PLACE_ADD_API);
        }
    },

    /**
     * Edit an existing place by ID.
     * API Endpoint :   PUT /place/:id
     * API Method   :   PUT
     * Body: { name?, display_name?, state?, description?, image_url?, lat?, lng?, stations? }
     */
    placeEdit: async (req, res) => {
        try {
            LogService.info("====================== PLACE EDIT API ==============================");
            LogService.info("REQ PARAMS : ", { id: req.params.id });
            LogService.info("REQ BODY : ", { ...req.body });

            const placeId = parseInt(req.params.id, 10);
            if (!Number.isFinite(placeId) || placeId < 1) {
                return ResponseService.jsonResponse(res, ConstantService.responseCode.BAD_REQUEST, {
                    message: "Invalid place ID",
                });
            }

            const request = {
                name: req.body.name,
                display_name: req.body.display_name,
                state: req.body.state,
                description: req.body.description,
                image_url: req.body.image_url,
                lat: req.body.lat,
                lng: req.body.lng,
                stations: req.body.stations,
            };

            const schema = Joi.object().keys({
                name: Joi.string().min(1).max(200).trim().optional(),
                display_name: Joi.string().allow("").max(200).trim().optional(),
                state: Joi.string().allow("").max(100).trim().optional(),
                description: Joi.string().allow("").max(2000).trim().optional(),
                image_url: Joi.string().max(2048).trim().optional().allow("", null),
                lat: Joi.number().min(-90).max(90).optional().allow(null),
                lng: Joi.number().min(-180).max(180).optional().allow(null),
                stations: Joi.array()
                    .items(Joi.string().trim().uppercase().min(2).max(10))
                    .min(1)
                    .max(20)
                    .optional(),
            });

            const { error, value } = schema.validate(request, { abortEarly: false, stripUnknown: true });
            if (error) {
                return ResponseService.jsonResponse(res, ConstantService.responseCode.BAD_REQUEST, {
                    message: error.message,
                });
            }

            const client = await SqlService.pool.connect();
            try {
                await client.query("BEGIN");

                const existing = await client.query(
                    "SELECT id, name, display_name, state, description, image_url, location FROM places WHERE id = $1",
                    [placeId]
                );

                if (existing.rows.length === 0) {
                    return ResponseService.jsonResponse(res, ConstantService.responseCode.NOT_FOUND, {
                        message: "Place not found",
                    });
                }

                const row = existing.rows[0];
                const name = value.name !== undefined ? value.name : row.name;
                const displayName = value.display_name !== undefined ? value.display_name : (row.display_name || row.name);
                const state = value.state !== undefined ? value.state : row.state;
                const desc = value.description !== undefined ? (value.description || null) : row.description;
                const imgUrl = value.image_url !== undefined ? value.image_url : row.image_url;

                if (value.lat !== undefined && value.lng !== undefined) {
                    if (value.lat != null && value.lng != null && Number.isFinite(value.lat) && Number.isFinite(value.lng)) {
                        await client.query(
                            "UPDATE places SET name = $1, display_name = $2, state = $3, description = $4, image_url = $5, location = point($6, $7) WHERE id = $8",
                            [name, displayName, state || null, desc, imgUrl, Number(value.lng), Number(value.lat), placeId]
                        );
                    } else {
                        await client.query(
                            "UPDATE places SET name = $1, display_name = $2, state = $3, description = $4, image_url = $5, location = NULL WHERE id = $6",
                            [name, displayName, state || null, desc, imgUrl, placeId]
                        );
                    }
                } else {
                    await client.query(
                        "UPDATE places SET name = $1, display_name = $2, state = $3, description = $4, image_url = $5 WHERE id = $6",
                        [name, displayName, state || null, desc, imgUrl, placeId]
                    );
                }

                if (value.stations !== undefined) {
                    await client.query("DELETE FROM place_stations WHERE place_id = $1", [placeId]);
                    const placeStationsValues = value.stations
                        .map((code, i) => `($1, $${2 + i * 2}, $${3 + i * 2})`)
                        .join(", ");
                    const placeStationsParams = [placeId, ...value.stations.flatMap((code, i) => [code, i + 1])];
                    await client.query(
                        `INSERT INTO place_stations (place_id, station_code, rank) VALUES ${placeStationsValues}
                         ON CONFLICT (place_id, station_code) DO UPDATE SET rank = EXCLUDED.rank`,
                        placeStationsParams
                    );
                }

                let stationsOut = value.stations;
                if (stationsOut === undefined) {
                    const psRes = await client.query(
                        "SELECT station_code FROM place_stations WHERE place_id = $1 ORDER BY rank",
                        [placeId]
                    );
                    stationsOut = psRes.rows.map((r) => r.station_code);
                }

                await client.query("COMMIT");

                const loc =
                    value.lat !== undefined && value.lng !== undefined && value.lat != null && value.lng != null
                        ? { lat: value.lat, lng: value.lng }
                        : row.location != null
                            ? { lat: parseFloat(row.location[1]), lng: parseFloat(row.location[0]) }
                            : null;

                return ResponseService.jsonResponse(res, ConstantService.responseCode.SUCCESS, {
                    message: ConstantService.responseMessage.PLACE_UPDATE_SUCCESS,
                    data: {
                        id: placeId,
                        name,
                        display_name: displayName,
                        state: state || null,
                        description: desc,
                        image_url: imgUrl,
                        lat: loc?.lat,
                        lng: loc?.lng,
                        stations: stationsOut,
                    },
                });
            } catch (txErr) {
                await client.query("ROLLBACK").catch(() => { });
                throw txErr;
            } finally {
                client.release();
            }
        } catch (exception) {
            LogService.error(exception);
            return ResponseService.json(res, ConstantService.responseCode.INTERNAL_SERVER_ERROR, ConstantService.responseMessage.ERR_MSG_ISSUE_IN_PLACE_EDIT_API);
        }
    },

    /**
     * Delete a place by ID.
     * API Endpoint :   DELETE /place/:id
     * API Method   :   DELETE
     */
    placeDelete: async (req, res) => {
        try {
            LogService.info("====================== PLACE DELETE API ==============================");
            LogService.info("REQ PARAMS : ", { id: req.params.id });

            const placeId = parseInt(req.params.id, 10);
            if (!Number.isFinite(placeId) || placeId < 1) {
                return ResponseService.jsonResponse(res, ConstantService.responseCode.BAD_REQUEST, {
                    message: "Invalid place ID",
                });
            }

            const existing = await SqlService.executeQuery(
                "SELECT id FROM places WHERE id = $1",
                [placeId]
            );

            if (existing.rows.length === 0) {
                return ResponseService.jsonResponse(res, ConstantService.responseCode.NOT_FOUND, {
                    message: "Place not found",
                });
            }

            await SqlService.executeQuery("DELETE FROM places WHERE id = $1", [placeId]);

            return ResponseService.jsonResponse(res, ConstantService.responseCode.SUCCESS, {
                message: ConstantService.responseMessage.PLACE_DELETE_SUCCESS,
                data: { id: placeId },
            });
        } catch (exception) {
            LogService.error(exception);
            return ResponseService.json(res, ConstantService.responseCode.INTERNAL_SERVER_ERROR, ConstantService.responseMessage.ERR_MSG_ISSUE_IN_PLACE_DELETE_API);
        }
    },

    /**
     * List popular places (for autocomplete / search).
     * API Endpoint :   /place/list
     * API Method   :   GET
     */
    placeList: async (req, res) => {
        try {
            LogService.info("====================== PLACE LIST API ==============================");
            LogService.info("REQ QUERY : ", { ...req.query });

            const request = {
                search: req.query.search,
                skip: req.query.skip,
                limit: req.query.limit,
            };

            const schema = Joi.object().keys({
                search: Joi.string().allow("").optional().default(""),
                skip: Joi.number().integer().min(0).optional().default(0),
                limit: Joi.number().integer().min(1).max(100).optional().default(20),
            });

            const { error, value } = schema.validate(request, { abortEarly: false, stripUnknown: true });
            if (error) {
                return ResponseService.jsonResponse(res, ConstantService.responseCode.BAD_REQUEST, {
                    message: error.message,
                });
            }

            const { search, skip, limit } = value;

            let listSQL = `
                SELECT p.id, p.name, p.display_name, p.state, p.description, p.image_url,
                    p.location[0] AS lng, p.location[1] AS lat,
                    (SELECT json_agg(json_build_object('code', ps.station_code, 'rank', ps.rank))
                     FROM place_stations ps WHERE ps.place_id = p.id) AS stations
                FROM places p
            `;
            const countSQL = "SELECT COUNT(*) AS total FROM places";
            const params = [];
            let paramIdx = 1;

            if (search) {
                const pattern = `%${String(search).sanitize()}%`;
                params.push(pattern);
                listSQL += ` WHERE p.name ILIKE $${paramIdx} OR p.display_name ILIKE $${paramIdx} OR p.state ILIKE $${paramIdx}`;
                paramIdx++;
            }

            listSQL += ` ORDER BY p.name ASC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
            params.push(limit, skip);

            const [listRes, countRes] = await Promise.all([
                SqlService.executeQuery(listSQL, params),
                SqlService.executeQuery(
                    search
                        ? "SELECT COUNT(*) AS total FROM places WHERE name ILIKE $1 OR display_name ILIKE $1 OR state ILIKE $1"
                        : countSQL,
                    search ? [params[0]] : []
                ),
            ]);

            const totalCount = parseInt(countRes.rows[0]?.total || 0, 10);
            const places = (listRes.rows || []).map((r) => ({
                id: r.id,
                name: r.name,
                display_name: r.display_name || r.name,
                state: r.state,
                description: r.description || null,
                image_url: r.image_url || null,
                lat: r.lat != null ? parseFloat(r.lat) : null,
                lng: r.lng != null ? parseFloat(r.lng) : null,
                stations: r.stations || [],
            }));

            return ResponseService.jsonResponse(res, ConstantService.responseCode.SUCCESS, {
                message: ConstantService.responseMessage.PLACE_LIST,
                data: { totalCount, places },
            });
        } catch (exception) {
            LogService.error(exception);
            return ResponseService.json(res, ConstantService.responseCode.INTERNAL_SERVER_ERROR, ConstantService.responseMessage.ERR_MSG_ISSUE_IN_PLACE_LIST_API);
        }
    },
};
