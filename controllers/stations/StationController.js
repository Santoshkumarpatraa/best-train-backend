module.exports = {
    /**
     * List of Stations.
     * API Endpoint :   /station/list
     * API Method   :   POST
     *
     * @param   {Object}        req          Request Object From API Request.
     * @param   {Object}        res          Response Object For API Request.
     * @returns {Promise<*>}    JSONResponse With success code 200 and information or relevant error code with message.
     */
    stationList: async (req, res) => {
        try {
            LogService.info("====================== STATION LIST API ==============================");
            LogService.info("REQ BODY : ", { ...req.body });
            const request = {
                search: req.body.search,
                skip: req.body.skip,
                limit: req.body.limit,
                order: req.body.order,
                popular: req.body.popular,
            };

            const schema = Joi.object().keys({
                search: Joi.string().allow("").optional().default(""),
                skip: Joi.number().integer().min(0).optional().default(0),
                limit: Joi.number().integer().min(1).max(100).optional().default(10),
                popular: Joi.boolean().optional(),
                order: Joi.array()
                    .items(
                        Joi.object().keys({
                            columnName: Joi.string().required(),
                            direction: Joi.boolean().required(),
                        })
                    )
                    .optional()
                    .default([]),
            });

            const { error, value } = schema.validate(request, {
                abortEarly: false,
                stripUnknown: true,
            });
            if (error) {
                return ResponseService.jsonResponse(res, ConstantService.responseCode.BAD_REQUEST, {
                    message: error.message,
                });
            }

            const { search, skip, limit, order, popular } = value;

            // Step 1: Define constants and base queries
            let listSQL = `SELECT name, code FROM stations`;
            let countSQL = `SELECT count(id) FROM stations`;
            const queryParams = [];
            const countQueryParams = [];
            let paramIndex = 1;
            const conditions = [];

            // Step 2: Build filter conditions (popular, search)
            if (popular === true) {
                conditions.push("is_popular = true");
            }
            if (search) {
                const searchPattern = `%${String(search).sanitize()}%`;
                queryParams.push(searchPattern);
                countQueryParams.push(searchPattern);
                conditions.push(`(
                    name ILIKE $${paramIndex}
                    OR code ILIKE $${paramIndex}
                    OR (utterances IS NOT NULL AND EXISTS (
                        SELECT 1 FROM jsonb_array_elements_text(utterances) AS elem
                        WHERE elem ILIKE $${paramIndex}
                    ))
                )`);
                paramIndex++;
            }

            // Step 3: Apply WHERE clause
            if (conditions.length > 0) {
                const whereClause = conditions.join(" AND ");
                listSQL += ` WHERE ${whereClause}`;
                countSQL += ` WHERE ${whereClause.replace(/\$\d+/g, "$1")}`;
            }

            // Step 4: Sort by order
            const columnMap = {
                id: "id",
                name: "name",
                code: "code",
                nameHi: "name_hi",
                nameGu: "name_gu",
                district: "district",
                state: "state",
                trainCount: "train_count",
                isPopular: "is_popular",
                createdAt: "created_at",
            };
            if (!_.isEmpty(order)) {
                const orderClauses = [];
                for (const col of order) {
                    const dbColumn = columnMap[col.columnName];
                    if (dbColumn) {
                        orderClauses.push(`${dbColumn} ${col.direction ? "ASC" : "DESC"}`);
                    }
                }
                if (orderClauses.length > 0) {
                    listSQL += ` ORDER BY ${orderClauses.join(", ")}`;
                } else {
                    listSQL += ` ORDER BY is_popular DESC, train_count DESC`;
                }
            } else {
                listSQL += ` ORDER BY is_popular DESC, train_count DESC`;
            }

            // Step 5: Add pagination
            queryParams.push(limit, skip);
            listSQL += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;

            // Step 6: Execute list query
            let stationListResult = await SqlService.executeQuery(listSQL, queryParams);
            stationListResult = stationListResult.rows;

            // Step 7: Execute count query
            let totalStationCount = await SqlService.executeQuery(countSQL, countQueryParams);
            totalStationCount = parseInt(totalStationCount.rows[0].count, 10) || 0;

            return ResponseService.jsonResponse(res, ConstantService.responseCode.SUCCESS, {
                message: ConstantService.responseMessage.STATION_LIST,
                data: {
                    totalStationCount,
                    stationList: stationListResult
                }
            });
        } catch (exception) {
            LogService.error(exception);
            return ResponseService.json(res, ConstantService.responseCode.INTERNAL_SERVER_ERROR, ConstantService.responseMessage.ERR_MSG_ISSUE_IN_STATION_LIST_API);
        }
    },
};
