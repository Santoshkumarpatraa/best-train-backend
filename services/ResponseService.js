/**
 * Response helpers.
 * - jsonResponse: success/validation (200, 400) – sends { message?, data? }
 * - json: server error (500) – logs, overrides message, sends { message }
 */
module.exports = {
    /**
     * Send JSON response for success or validation errors.
     * @param {Object} res - Express response
     * @param {number} status - HTTP status
     * @param {Object} data - Body with message and/or data
     */
    jsonResponse: (res, status, data) => {
        const response = data ?? {};
        return res.status(status).json(response);
    },

    /**
     * Send JSON response for server errors (500).
     * Logs the error and returns generic message to client.
     * @param {Object} res - Express response
     * @param {number} status - HTTP status (typically 500)
     * @param {string} message - Error message (logged, not sent to client on 500)
     * @param {Object} [data] - Optional extra data
     */
    json: (res, status, message, data) => {
        let response = { message };
        if (typeof data !== "undefined") response.data = data;

        if (status === ConstantService.responseCode.INTERNAL_SERVER_ERROR) {
            LogService.error(message);
            response.message = ConstantService.responseMessage.ERR_OOPS_SOMETHING_WENT_WRONG;
        }
        return res.status(status).json(response);
    },
};
