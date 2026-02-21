/**
 * Global service registration.
 * Load this first in app.js so all controllers can use ServiceName.method without imports.
 */
require("dotenv").config();
const path = require("path");
const appRoot = path.join(__dirname, "..");

global.customConfig = require(path.join(appRoot, "config/config"));
global.Joi = require("joi");
global._ = require('lodash');
global.LogService = require(path.join(appRoot, 'services/LogService'));
global.ResponseService = require(path.join(appRoot, 'services/ResponseService'));
global.ConstantService = require(path.join(appRoot, 'services/ConstantService'));
global.SqlService = require(path.join(appRoot, 'services/SqlService'));
global.HelperService = require(path.join(appRoot, "services/HelperService"));
global.CacheService = require(path.join(appRoot, "services/CacheService"));
global.PlaceService = require(path.join(appRoot, "services/PlaceService"));
