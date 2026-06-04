# Best Train Backend

Backend API service for Indian railway train and station search. Provides endpoints for searching trains between stations/places/states, managing places (cities, landmarks), and searching stations.

## Features

- **Train Search**: Find trains between stations, places, or states with optional date filtering
- **Station Search**: Browse and search railway stations with location data
- **Place Management**: Create and manage places (cities, landmarks) with associated stations
- **Data Sync**: Scripts to sync train list, train details, and station data from external sources
- **Caching**: In-memory cache for frequently accessed train searches
- **Rate Limiting**: Built-in rate limiting on all endpoints
- **Graceful Shutdown**: Proper cleanup of database connections on shutdown

## Tech Stack

- **Node.js** 16+ with Express.js 5.2.1
- **PostgreSQL** 18 for data storage with connection pooling
- **pg** 8.18.0 for database access
- **Joi** for request validation
- **node-cache** for in-memory caching
- **Helmet** for security headers
- **CORS** for cross-origin requests

## Requirements

- Node.js 16+
- npm
- PostgreSQL 18 (or compatible)
- `psql` client for database management

## Local Setup

### 1. Install Dependencies

```bash
cd best-train-backend
npm install
```

### 2. Install PostgreSQL (macOS with Homebrew)

```bash
brew install postgresql@18
brew services start postgresql@18
```

For client tools only:
```bash
brew install libpq
echo 'export PATH="/opt/homebrew/opt/libpq/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

### 3. Environment Configuration

Create `.env` file in the project root:

```env
PORT=8000
NODE_ENV=production
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/best_train
DATASTORE_PORT=5432
DATASTORE_CONNECTION_LIMIT=5000
TRAIN_LIST_URL=https://www.irctc.co.in/eticketing/trainList
TRAIN_DETAILS_URL=https://www.irctc.co.in/eticketing/protected/mapps1/trnscheduleenquiry
SYNC_STATION_URL=https://cdn.corover.ai/askdisha-bucket/stationupdated.json
SYNC_POPULAR_URL=https://cdn.corover.ai/askdisha-bucket/popular.json
CORS_ORIGIN=*
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=100
CACHE_TTL_SECONDS=300
SYNC_TRAIN_DELAY_MS=50
```

**For production deployment, update `DATABASE_URL`:**
```env
DATABASE_URL=postgresql://USERNAME:PASSWORD@HOST:PORT/DBNAME
```

### 4. Database Setup

Create database and initialize schema:

```bash
PGPASSWORD=postgres psql -h localhost -p 5432 -U postgres -c 'CREATE DATABASE best_train;'
for f in sql/*.sql; do PGPASSWORD=postgres psql -h localhost -p 5432 -U postgres -d best_train -f "$f"; done
```

### 5. Sync Initial Data Locally

Run data sync scripts to populate train and station data:

```bash
npm run sync:stations         # Fetch ~8,464 stations
npm run sync:popular          # Mark 100 popular stations
npm run sync:trains           # Fetch 6,334 train list
npm run sync:train-details    # Fetch route details for each train (~15 mins)
```

This will populate your local database with all train and station data.

### 6. Database Backup & Restore for Production

After syncing data locally:

**Step 1: Backup your local database**
```bash
pg_dump -U postgres best_train > backup.sql
```

This creates a `backup.sql` file (~2.3 MB) with all your data.

**Step 2: Get your production database URL**
- Open your hosting provider dashboard
- Copy the **External Database URL**

**Step 3: Restore to production**
```bash
psql "postgresql://USERNAME:PASSWORD@HOST:PORT/DBNAME" < backup.sql
```

**Step 4: Verify deployment**
```bash
curl -X POST "https://your-deployment-domain.com/station/list" \
  -H "Content-Type: application/json" \
  -d '{"search":"Delhi","limit":5}'
```

Should return station data ✅

## Running the Server

### Local Development

```bash
npm start
```

Server starts on `http://localhost:8000`

### Production (with NODE_ENV=production)

```bash
NODE_ENV=production npm start
```

## API Endpoints

### Health Check

```bash
curl http://localhost:8000/
```

Returns: `{"message":"Server is up and running"}`

### Station Search

**POST** `/station/list`

Search stations by name, state, or code.

```bash
curl -X POST http://localhost:8000/station/list \
  -H "Content-Type: application/json" \
  -d '{
    "search": "Delhi",
    "skip": 0,
    "limit": 10,
    "popular": true,
    "order": [{ "columnName": "name", "direction": "asc" }]
  }'
```

**Query Parameters:**
- `search` (string): Filter by station name, code, or state (case-insensitive LIKE search)
- `skip` (number): Pagination offset (default: 0)
- `limit` (number): Page size (default: 20, max: 100)
- `popular` (boolean): Filter to popular stations only (optional)
- `order` (array): Sort by columnName ("name", "code", "state") and direction ("asc"/"desc")

### Place APIs

**POST** `/place/add` – Create a new place

```bash
curl -X POST http://localhost:8000/place/add \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Taj Mahal",
    "display_name": "Taj Mahal, Agra",
    "state": "Uttar Pradesh",
    "description": "Famous monument",
    "image_url": "https://example.com/taj.jpg",
    "lat": 27.1751,
    "lng": 78.0421,
    "stations": ["AGC", "TGT", "UMB"]
  }'
```

**PUT** `/place/:id` – Update a place

```bash
curl -X PUT http://localhost:8000/place/1 \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Updated description",
    "stations": ["AGC", "TGT", "KWD"]
  }'
```

**DELETE** `/place/:id` – Delete a place

```bash
curl -X DELETE http://localhost:8000/place/1
```

**GET** `/place/list` – List all places

```bash
curl "http://localhost:8000/place/list?search=Delhi&limit=10"
```

### Train Search

**GET** `/train/between/stations` – Search trains between station codes

```bash
curl "http://localhost:8000/train/between/stations?from=NDLS&to=BCT&date=2026-06-05&limit=10&sort=duration&order=asc"
```

**Parameters:**
- `from` (string, required): Source station code (e.g., NDLS for New Delhi)
- `to` (string, required): Destination station code (e.g., BCT for Mumbai)
- `date` (string): Travel date in YYYY-MM-DD format (optional)
- `skip` (number): Pagination offset (default: 0)
- `limit` (number): Page size (default: 20, max: 100)
- `sort` (string): Sort by "duration", "departure_time", or "arrival_time" (default: duration)
- `order` (string): Sort order "asc" or "desc" (default: asc)

**Response:**
```json
{
  "message": "Trains between stations fetched successfully",
  "data": {
    "date": "2026-06-05",
    "dayOfWeek": 3,
    "totalCount": 5,
    "trains": [
      {
        "train_number": "12303",
        "train_name": "POORVA EXPRESS",
        "departure_time": "08:55",
        "arrival_time": "19:35",
        "duration": "10:40",
        "runs_on": {
          "mon": true,
          "tue": true,
          "wed": true,
          "thu": true,
          "fri": true,
          "sat": true,
          "sun": true
        }
      }
    ]
  }
}
```

**GET** `/train/between/states` – Search trains between states

```bash
curl "http://localhost:8000/train/between/states?from_state=West%20Bengal&to_state=Maharashtra&date=2026-06-05&limit=20"
```

**Parameters:**
- `from_state` (string, required): Source state name
- `to_state` (string, required): Destination state name
- `date` (string): Travel date (optional)
- `limit` (number): Page size (default: 30, max: 100)
- `sort` (string): Sort by "duration", "departure_time", or "arrival_time"
- `order` (string): Sort order "asc" or "desc"

**GET** `/train/between/places` – Search trains between places

```bash
curl "http://localhost:8000/train/between/places?from=Delhi&to=Mumbai&date=2026-06-05&limit=20"
```

**Parameters:**
- `from` (string, required): Source place name or station code
- `to` (string, required): Destination place name or station code
- `date` (string): Travel date (optional)
- `limit` (number): Page size (default: 30, max: 100)
- `sort` (string): Sort by "duration", "departure_time", or "arrival_time"
- `order` (string): Sort order "asc" or "desc"

### Cache Management

**GET** `/cache/stats` – Get cache statistics

```bash
curl http://localhost:8000/cache/stats
```

**GET** `/cache/keys` – List all cache keys

```bash
curl http://localhost:8000/cache/keys
```

**DELETE** `/cache/clear` – Clear all cache

```bash
curl -X DELETE http://localhost:8000/cache/clear
```

**DELETE** `/cache/delete/:key` – Delete a specific cache key

```bash
curl -X DELETE http://localhost:8000/cache/delete/train:NDLS:BCT
```

**POST** `/cache/delete-pattern` – Delete cache by pattern

```bash
curl -X POST http://localhost:8000/cache/delete-pattern \
  -H "Content-Type: application/json" \
  -d '{"pattern":"train:*"}'
```

## Data Sync Scripts

### Manual Sync Commands

```bash
npm run sync:stations         # Fetch stations from SYNC_STATION_URL
npm run sync:popular          # Mark popular stations from SYNC_POPULAR_URL
npm run sync:trains           # Fetch train list from TRAIN_LIST_URL
npm run sync:train-details    # Fetch route details from TRAIN_DETAILS_URL
```

### How Sync Works

1. **sync-stations.js**: Fetches ~8,464 Indian railway stations from configured data source, inserts/updates into `stations` table
2. **sync-popular-stations.js**: Marks 100 popular stations as `is_popular=true`
3. **sync-trains-list.js**: Fetches 6,334 train numbers and names, stores in `trains` table
4. **sync-train-details.js**: For each train, fetches route (all station stops), updates `trains` and `train_route` tables
   - Includes retry logic (3 attempts) with exponential backoff for network resilience
   - Honors `SYNC_TRAIN_DELAY_MS` for rate limiting (default 50ms between requests)
   - Only processes trains needing updates (no route data or last fetched >6 hours ago)
   - Use `SYNC_TRAIN_ALL=true` to process all trains

## Database Schema

### trains
Master train information with weekly schedule flags.

| Column | Type | Description |
|--------|------|-------------|
| id | BIGSERIAL | Primary key |
| train_number | INTEGER | Unique train identifier |
| train_name | TEXT | Train name (e.g., "POORVA EXPRESS") |
| station_from | TEXT | Origin station code |
| station_to | TEXT | Destination station code |
| runs_on_mon...sun | BOOLEAN | Weekly schedule flags |
| duration | TEXT | Journey duration (HH:MM) |
| fetched_at | TIMESTAMPTZ | Last sync timestamp |

### train_route
Individual station stops for each train's route.

| Column | Type | Description |
|--------|------|-------------|
| id | BIGSERIAL | Primary key |
| train_id | BIGINT | FK → trains.id |
| station_code | TEXT | Station code |
| station_name | TEXT | Station name |
| arrival_time | TEXT | Arrival time (HH:MM) |
| departure_time | TEXT | Departure time (HH:MM) |
| distance | INTEGER | Distance from origin (km) |
| day_count | INTEGER | Day of journey (1, 2, ...) |
| serial_number | INTEGER | Stop order in route |
| boarding_disabled | BOOLEAN | Can't board at this stop |

### stations
Railway station master data.

| Column | Type | Description |
|--------|------|-------------|
| id | BIGSERIAL | Primary key |
| code | TEXT | Unique station code |
| name | TEXT | Station display name |
| name_hi, name_gu | TEXT | Regional language names |
| district, state | TEXT | Location metadata |
| location | POINT | Geographic coordinates (lng, lat) |
| is_popular | BOOLEAN | Popular station flag |
| train_count | INTEGER | Number of trains stopping here |

### places
Cities and landmarks associated with stations.

| Column | Type | Description |
|--------|------|-------------|
| id | BIGSERIAL | Primary key |
| name | TEXT | Unique place name (case-insensitive) |
| display_name | TEXT | Display label |
| state | TEXT | State name |
| description | TEXT | Optional description |
| image_url | TEXT | Optional image URL |
| location | POINT | Geographic coordinates (optional) |

### place_stations
Mapping between places and their associated stations (rank 1 = primary).

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 3000 |
| `NODE_ENV` | Environment (development/production) | production |
| `DATABASE_URL` | PostgreSQL connection string (local or hosted environment) | postgresql://postgres:postgres@localhost:5432/best_train |
| `TRAIN_LIST_URL` | External API endpoint for train list | – |
| `TRAIN_DETAILS_URL` | External API base URL for train details | – |
| `SYNC_STATION_URL` | Stations data JSON URL | – |
| `SYNC_POPULAR_URL` | Popular stations data JSON URL | – |
| `CORS_ORIGIN` | Allowed CORS origins (comma-separated or *) | * |
| `RATE_LIMIT_WINDOW_MS` | Rate limit window duration | 60000 |
| `RATE_LIMIT_MAX` | Max requests per window | 100 |
| `CACHE_ENABLED` | Enable train search caching | true |
| `CACHE_TTL_SECONDS` | Cache expiry in seconds | 300 |
| `SYNC_TRAIN_DELAY_MS` | Delay between train detail fetches (rate limiting) | 50 |
| `SYNC_TRAIN_ALL` | Sync all trains (ignoring age filter) | false |
| `PG_POOL_MAX` | Max DB connections | 10 |
| `PG_POOL_IDLE_TIMEOUT_MS` | Idle connection timeout | 30000 |
| `PG_POOL_CONNECTION_TIMEOUT_MS` | Connection timeout | 5000 |

## Project Structure

```
best-train-backend/
├── app.js                      # Express server entry point
├── config/
│   ├── config.js              # Environment configuration
│   ├── globals.js             # Global app setup
│   └── routes.js              # Route definitions
├── controllers/
│   ├── app/
│   │   ├── CacheController.js # Cache management
│   │   └── HealthController.js # Health check
│   ├── places/
│   │   └── PlaceController.js # Place CRUD
│   ├── stations/
│   │   └── StationController.js # Station search
│   └── trains/
│       └── TrainController.js # Train search
├── services/
│   ├── browserHeaders.js      # Browser-like request headers
│   ├── CacheService.js        # In-memory caching
│   ├── ConstantService.js     # App constants
│   ├── HelperService.js       # Utility functions
│   ├── LogService.js          # Logging
│   ├── PlaceService.js        # Place/station resolution
│   ├── ResponseService.js     # API response formatting
│   └── SqlService.js          # Database operations
├── scripts/
│   ├── sync-stations.js       # Station data sync
│   ├── sync-popular-stations.js # Popular stations sync
│   ├── sync-trains-list.js    # Train list sync
│   ├── sync-train-details.js  # Train route sync
│   ├── stationSync.js         # Shared sync utilities
│   └── utils.js               # Script helpers
├── sql/
│   ├── station-initial.sql    # Stations schema
│   ├── places-initial.sql     # Places schema
│   └── trains-initial.sql     # Trains schema
└── docs/
    └── ARCHITECTURE.md        # Detailed architecture
```

## Deployment

### 1. Create PostgreSQL Database
- Dashboard → Create new database
- Copy the **External Database URL** (format: `postgresql://user:password@host:port/dbname`)
- Save this URL

### 2. Deploy Node App
- Connect GitHub repo to your hosting provider
- Set environment variables:
  - `DATABASE_URL`: Your production database URL
  - `PORT`: 8000
  - `NODE_ENV`: production
  - Other config as needed (see Environment Variables section)

### 3. Populate Database with Data
**Important**: Sync data on your **local machine first**, then backup and restore to production.

```bash
# On your local machine:
npm run sync:stations
npm run sync:popular
npm run sync:trains
npm run sync:train-details

# Backup
pg_dump -U postgres best_train > backup.sql

# Restore to production (get the external database URL from your hosting dashboard)
psql "postgresql://USERNAME:PASSWORD@HOST:PORT/DBNAME" < backup.sql
```

### 4. Verify Deployment
```bash
curl -X POST "https://your-deployment-domain.com/station/list" \
  -H "Content-Type: application/json" \
  -d '{"search":"Delhi","limit":5}'
```

### Why Sync Locally First?
- External data sources apply anti-bot protection to datacenter IPs (including hosted environments)
- Local residential IPs are trusted and work reliably
- Syncing locally ensures all 6,334 trains and their routes are loaded
- Backup/restore is fast and reliable (~2-3 minutes)

## Development Notes

- **Request Logging**: All requests are logged with method, path, status, and duration
- **Rate Limiting**: Global rate limit of 100 requests/minute by default
- **CORS**: Enabled for all origins by default, customizable via `CORS_ORIGIN`
- **Security**: Helmet middleware adds security headers
- **Validation**: All API inputs validated with Joi schemas
- **Caching**: Train search results cached for 5 minutes (configurable)
- **Error Handling**: Comprehensive error messages with appropriate HTTP status codes

## Troubleshooting

### Connection Refused on localhost:5432
- Ensure PostgreSQL is running: `brew services list`
- Start PostgreSQL: `brew services start postgresql@18`

### "relation does not exist" errors
- Run initialization SQL: `for f in sql/*.sql; do psql -U postgres -d best_train -f "$f"; done`

### Train search returns empty results
- Ensure `sync-train-details.js` has run successfully (populates `train_route` table)
- Check: `psql -d best_train -c "SELECT COUNT(*) FROM train_route;"`

### Timeouts on External API Calls
- Normal behavior due to datacenter IP restrictions on external services
- Solution: Sync data locally on your machine, then backup and restore to the production database
- No need to run sync scripts in production; just restore from backup

## License

ISC

