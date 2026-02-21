const express = require('express');
const router = express.Router();

// Health
router.get('/', require('../controllers/app/HealthController').ping);

// Station APIs
router.post('/station/list', require('../controllers/stations/StationController').stationList);

// Place APIs
router.post('/place/add', require('../controllers/places/PlaceController').placeAdd);
router.put('/place/:id', require('../controllers/places/PlaceController').placeEdit);
router.delete('/place/:id', require('../controllers/places/PlaceController').placeDelete);
router.get('/place/list', require('../controllers/places/PlaceController').placeList);

// Train APIs
router.get('/train/between/stations', require('../controllers/trains/TrainController').trainBetweenStations);
router.get('/train/between/states', require('../controllers/trains/TrainController').trainBetweenStates);
router.get('/train/between/places', require('../controllers/trains/TrainController').trainBetweenPlaces);

module.exports = router;
