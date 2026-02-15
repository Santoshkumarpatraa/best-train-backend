module.exports = {

    /**
     * Log and send error email
     *
     * @param exception - Error/exception object received
     */
    error: (exception, payload) => {
        if (payload) {
            console.error(exception, payload);
        } else {
            console.error(exception);
        }
        //Add email notification when required
    },

    /**
     * Log and send info email
     *
     * @param message - information message received
     * @param payload - information payload received
     */
    info: (message, payload) => {
        if (payload) {
            console.info(message, payload);
        } else {
            console.info(message);
        }
        //Add email notification when required
    },

    /**
     * Log and send debug email
     *
     * @param message - debug message received
     * @param payload - debug payload received
     */
    debug: (message, payload) => {
        console.debug(message, payload);
        //Add email notification when required
    },

    reqLogger: (req, res, next) => {
        console.debug(`[${req.method}] ${req.originalUrl}`);
        const start = Date.now();
    
        res.on('finish', () => {
            const duration = Date.now() - start;
            console.info(
                `[${req.method}] ${req.originalUrl} - status: ${res.statusCode} - ${duration}ms`
            );
        });
    
        next();
    },
};

