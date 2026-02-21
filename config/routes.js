const express = require('express');
const router = express.Router();

// Health
router.get('/', require('../controllers/app/HealthController').ping);

// Station APIs
router.post('/station/list', require('../controllers/stations/StationController').stationList);

// Train APIs
router.get('/train/between/stations', require('../controllers/trains/TrainController').trainBetweenStations);
router.get('/train/between/states', require('../controllers/trains/TrainController').trainBetweenStates);

module.exports = router;
