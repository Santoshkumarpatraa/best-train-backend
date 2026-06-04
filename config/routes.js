const express = require('express');
const router = express.Router();

// Health
router.get('/', require('../controllers/app/HealthController').ping);

// Cache Management APIs
router.get('/cache/stats', require('../controllers/app/CacheController').getStats);
router.get('/cache/keys', require('../controllers/app/CacheController').listKeys);
router.delete('/cache/clear', require('../controllers/app/CacheController').clearAll);
router.delete('/cache/delete/:key', require('../controllers/app/CacheController').deleteKey);
router.post('/cache/delete-pattern', require('../controllers/app/CacheController').deletePattern);

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

// Admin initialization API
router.post('/admin/init', require('../controllers/app/AdminController').runInitialSqlAndScripts);

module.exports = router;
