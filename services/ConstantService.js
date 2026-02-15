module.exports = {
    responseCode: {
        SUCCESS: 200,
        CREATED: 201,
        BAD_REQUEST: 400,
        UNAUTHORIZED: 401,
        FORBIDDEN: 403,
        NOT_FOUND: 404,
        CONFLICT: 409,
        TOO_MANY_REQUESTS: 429,
        INTERNAL_SERVER_ERROR: 500,
    },
    responseMessage: {
        STATION_LIST: 'Station list fetched successfully',
        ERR_MSG_ISSUE_IN_STATION_LIST_API: 'Something went wrong while fetching station list',
        TRAIN_BETWEEN_STATIONS: 'Trains between stations fetched successfully',
        ERR_MSG_ISSUE_IN_TRAIN_BETWEEN_API: 'Something went wrong while fetching trains between stations',
        ERR_OOPS_SOMETHING_WENT_WRONG: 'Oops! Something went wrong',
    },
};
