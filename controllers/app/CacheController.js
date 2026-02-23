module.exports = {
    /**
     * Get cache statistics.
     * API Endpoint :   /cache/stats
     * API Method   :   GET
     *
     * @param   {Object}        req          Request Object From API Request.
     * @param   {Object}        res          Response Object For API Request.
     * @returns {Promise<*>}    JSONResponse With cache statistics.
     */
    getStats: async (req, res) => {
        try {
            const stats = CacheService.getStats();
            const keys = CacheService.getKeys();
            return ResponseService.jsonResponse(res, ConstantService.responseCode.SUCCESS, {
                message: "Cache statistics",
                data: {
                    ...stats,
                    keys: keys,
                    keyCount: keys.length,
                },
            });
        } catch (exception) {
            LogService.error(exception);
            return ResponseService.json(res, ConstantService.responseCode.INTERNAL_SERVER_ERROR, {
                message: "Failed to get cache statistics",
            });
        }
    },

    /**
     * Delete a specific cache key.
     * API Endpoint :   /cache/delete/:key
     * API Method   :   DELETE
     *
     * @param   {Object}        req          Request Object From API Request.
     * @param   {Object}        res          Response Object For API Request.
     * @returns {Promise<*>}    JSONResponse With success message.
     */
    deleteKey: async (req, res) => {
        try {
            const { key } = req.params;
            if (!key) {
                return ResponseService.jsonResponse(res, ConstantService.responseCode.BAD_REQUEST, {
                    message: "Cache key is required",
                });
            }

            const deleted = CacheService.del(key);
            if (deleted) {
                LogService.info(`[CACHE DELETE] Key deleted: ${key}`);
                return ResponseService.jsonResponse(res, ConstantService.responseCode.SUCCESS, {
                    message: `Cache key '${key}' deleted successfully`,
                });
            } else {
                return ResponseService.jsonResponse(res, ConstantService.responseCode.NOT_FOUND, {
                    message: `Cache key '${key}' not found`,
                });
            }
        } catch (exception) {
            LogService.error(exception);
            return ResponseService.json(res, ConstantService.responseCode.INTERNAL_SERVER_ERROR, {
                message: "Failed to delete cache key",
            });
        }
    },

    /**
     * Delete cache keys matching a pattern.
     * API Endpoint :   /cache/delete-pattern
     * API Method   :   POST
     *
     * @param   {Object}        req          Request Object From API Request.
     * @param   {Object}        res          Response Object For API Request.
     * @returns {Promise<*>}    JSONResponse With deletion count.
     */
    deletePattern: async (req, res) => {
        try {
            const { pattern } = req.body;
            if (!pattern) {
                return ResponseService.jsonResponse(res, ConstantService.responseCode.BAD_REQUEST, {
                    message: "Pattern is required",
                });
            }

            const deletedCount = CacheService.delPattern(pattern);
            LogService.info(`[CACHE DELETE PATTERN] Pattern: ${pattern}, Deleted: ${deletedCount} keys`);
            return ResponseService.jsonResponse(res, ConstantService.responseCode.SUCCESS, {
                message: `Deleted ${deletedCount} cache key(s) matching pattern '${pattern}'`,
                data: {
                    pattern,
                    deletedCount,
                },
            });
        } catch (exception) {
            LogService.error(exception);
            return ResponseService.json(res, ConstantService.responseCode.INTERNAL_SERVER_ERROR, {
                message: "Failed to delete cache keys by pattern",
            });
        }
    },

    /**
     * Clear all cache.
     * API Endpoint :   /cache/clear
     * API Method   :   DELETE
     *
     * @param   {Object}        req          Request Object From API Request.
     * @param   {Object}        res          Response Object For API Request.
     * @returns {Promise<*>}    JSONResponse With success message.
     */
    clearAll: async (req, res) => {
        try {
            const keysBefore = CacheService.getKeys();
            CacheService.flushAll();
            LogService.info(`[CACHE CLEAR] Cleared all cache (${keysBefore.length} keys)`);
            return ResponseService.jsonResponse(res, ConstantService.responseCode.SUCCESS, {
                message: "All cache cleared successfully",
                data: {
                    deletedCount: keysBefore.length,
                },
            });
        } catch (exception) {
            LogService.error(exception);
            return ResponseService.json(res, ConstantService.responseCode.INTERNAL_SERVER_ERROR, {
                message: "Failed to clear cache",
            });
        }
    },

    /**
     * List all cache keys.
     * API Endpoint :   /cache/keys
     * API Method   :   GET
     *
     * @param   {Object}        req          Request Object From API Request.
     * @param   {Object}        res          Response Object For API Request.
     * @returns {Promise<*>}    JSONResponse With list of cache keys.
     */
    listKeys: async (req, res) => {
        try {
            const keys = CacheService.getKeys();
            return ResponseService.jsonResponse(res, ConstantService.responseCode.SUCCESS, {
                message: "Cache keys retrieved successfully",
                data: {
                    keys,
                    count: keys.length,
                },
            });
        } catch (exception) {
            LogService.error(exception);
            return ResponseService.json(res, ConstantService.responseCode.INTERNAL_SERVER_ERROR, {
                message: "Failed to get cache keys",
            });
        }
    },
};
