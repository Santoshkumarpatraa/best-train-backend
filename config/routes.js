const express = require('express');
const router = express.Router();

// Health
router.get('/', require('../controllers/app/HealthController').ping);

// Station APIs
router.post('/station/list', require('../controllers/stations/StationController').stationList);

// Train APIs
router.get('/train/between', require('../controllers/trains/TrainController').trainBetweenStations);

module.exports = router;
