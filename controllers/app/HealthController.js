module.exports = {
    /**
     * Check if server is running.
     * API Endpoint :   /
     * API Method   :   GET
     *
     * @param   {Object}        req          Request Object From API Request.
     * @param   {Object}        res          Response Object For API Request.
     * @returns {Promise<*>}    JSONResponse With success code 200 and  information or relevant error code with message.
     */
    ping: async (req, res) => {
        res.status(200).json("ok");
    },
};
