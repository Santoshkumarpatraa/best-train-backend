# Best Train – Architecture & Structure

## Overview

Best Train is a Node.js/Express backend for Indian railway train and station data. It uses PostgreSQL for storage and sync scripts to pull data from external sources (IRCTC, etc.).

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           EXTERNAL SOURCES                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│  IRCTC Train List API          │  IRCTC Train Details API                    │
│  (trainList?greq=...)          │  (trnscheduleenquiry/{trainNo})             │
│                                │  Stations JSON (SYNC_STATION_URL, etc.)     │
└───────────────┬────────────────┴─────────────────────┬───────────────────────┘
                │                                       │
                ▼                                       ▼
┌───────────────────────────────┐     ┌───────────────────────────────────────┐
│   sync-trains-list.js         │     │   sync-train-details.js                 │
│   - Fetches train list        │     │   - Fetches route per train            │
│   - Parses "12303 - POORVA"   │     │   - Updates trains + train_route       │
│   - Upserts train_number,     │     │   - Calculates duration if API returns 0│
│     train_name                │     │   - Rate limited (50ms default)         │
└───────────────┬───────────────┘     └───────────────────┬─────────────────────┘
                │                                       │
                │     ┌─────────────────────────────┐   │
                │     │  sync-stations.js            │   │
                │     │  sync-popular-stations.js    │   │
                │     │  (is_popular=false first,    │   │
                │     │   then true from API)        │   │
                │     └─────────────┬───────────────┘   │
                │                   │                   │
                └───────────────────┴───────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         POSTGRESQL DATABASE                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌─────────────────┐         ┌─────────────────────────────────────────┐   │
│   │     trains      │         │              train_route                 │   │
│   ├─────────────────┤         ├─────────────────────────────────────────┤   │
│   │ id (PK)         │◄────────│ train_id (FK)                            │   │
│   │ train_number    │  1    N │ station_code, station_name               │   │
│   │ train_name      │         │ arrival_time, departure_time             │   │
│   │ station_from    │         │ distance, day_count, serial_number        │   │
│   │ station_to      │         │ route_number, halt_time, boarding_disabled│   │
│   │ runs_on_*       │         └─────────────────────────────────────────┘   │
│   │ duration        │                                                       │
│   │ fetched_at      │         One train → many route stops (ordered)         │
│   └─────────────────┘                                                       │
│                                                                              │
│   ┌─────────────────┐                                                       │
│   │    stations     │   (Independent – linked by station_code)              │
│   ├─────────────────┤                                                       │
│   │ id (PK)         │                                                       │
│   │ code (unique)   │   ← train_route.station_code, trains.station_from/to   │
│   │ name, name_hi   │                                                       │
│   │ location (point)│                                                       │
│   │ is_popular      │                                                       │
│   └─────────────────┘                                                       │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         EXPRESS API LAYER                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│  app.js → routes.js → controllers → services                                 │
│                                                                              │
│  GET  /                → HealthController.ping                               │
│  POST /station/list    → StationController.stationList                       │
│  GET  /train/between   → TrainController.trainBetweenStations                │
│       ?from=HWH&to=NDLS&date=YYYY-MM-DD&skip=0&limit=20                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Database Schema (Detailed)

### 1. `trains` – Master train info

| Column          | Type        | Description |
|-----------------|-------------|-------------|
| `id`            | BIGSERIAL   | Primary key |
| `train_number`  | INTEGER     | Unique (e.g. 12303) |
| `train_name`    | TEXT        | e.g. "POORVA EXPRESS" |
| `station_from`  | TEXT        | Source station code (HWH) |
| `station_to`    | TEXT        | Destination station code (NDLS) |
| `train_owner`   | TEXT        | Zone/owner code |
| `runs_on_mon` … `runs_on_sun` | BOOLEAN | Weekly schedule |
| `duration`      | TEXT        | Journey duration |
| `fetched_at`    | TIMESTAMPTZ | Last sync timestamp |
| `created_at`    | TIMESTAMPTZ | Row creation |
| `updated_at`    | TIMESTAMPTZ | Row update |

**Indexes:** `train_number`, `station_from`, `station_to`, `(station_from, station_to)`

---

### 2. `train_route` – Stops along each train’s path

| Column            | Type      | API Source        | Description |
|-------------------|-----------|-------------------|-------------|
| `id`              | BIGSERIAL | –                 | Primary key |
| `train_id`        | BIGINT    | –                 | FK → trains.id |
| `station_code`    | TEXT      | stationCode       | e.g. HWH, BWN |
| `station_name`    | TEXT      | stationName       | e.g. HOWRAH JN |
| `arrival_time`    | TEXT      | arrivalTime       | "08:55" or "--" |
| `departure_time`  | TEXT      | departureTime     | "08:57" or "--" |
| `route_number`    | TEXT      | routeNumber       | Route/line id (often "1") |
| `halt_time`       | TEXT      | haltTime          | Stop duration |
| `distance`        | INTEGER   | distance          | km from origin |
| `day_count`       | INTEGER   | dayCount          | Day of journey (1, 2, …) |
| `serial_number`   | INTEGER   | stnSerialNumber   | Order in route (1st, 2nd, …) |
| `boarding_disabled` | BOOLEAN | boardingDisabled   | "false"/"true" |
| `created_at`      | TIMESTAMPTZ | –               | Row creation |

**Indexes:** `train_id`, `station_code`, unique `(train_id, serial_number)`

**Relationship:** One train → many route stops. Order by `serial_number` for correct sequence.

---

### 3. `stations` – Station master data

| Column       | Type    | Description |
|--------------|---------|-------------|
| `id`         | BIGSERIAL | Primary key |
| `code`       | TEXT    | Unique (HWH, NDLS) |
| `name`       | TEXT    | Display name |
| `name_hi`, `name_gu` | TEXT | Localized names |
| `district`, `state` | TEXT | Location metadata |
| `location`   | POINT   | (lng, lat) |
| `is_popular` | BOOLEAN | Popular station flag |
| …            |         | Other metadata |

**Relationship:** `trains.station_from` / `trains.station_to` and `train_route.station_code` reference `stations.code` conceptually (no FK yet).

---

## Data Flow

### Train list sync (`sync-trains-list.js`)

1. Fetch from IRCTC train list API (returns `"12303 - POORVA EXPRESS"` style strings).
2. Parse into `{ train_number, train_name }`.
3. Upsert into `trains` (ON CONFLICT train_number). Does not set `fetched_at`.

### Train details sync (`sync-train-details.js`)

1. Select trains needing details (`station_from`/`station_to` null, or `fetched_at` > 6hr ago).
2. For each train, fetch from IRCTC `trnscheduleenquiry/{trainNo}` (train number zero-padded to 5 digits).
3. Parse response: `stationFrom`, `stationTo`, `stationList`, `runs_on_*`, `duration`.
4. If API returns `duration: "0"`, calculate from first station `departureTime` to last station `arrivalTime` + `dayCount`.
5. Update `trains` and replace `train_route` rows.
6. Rate limited (default 50ms between requests). Use `SYNC_TRAIN_ALL=true` to process all trains.

### Station sync (`sync-stations.js`)

1. Fetch stations JSON from `SYNC_STATION_URL`.
2. Map to DB columns (including `point(lng, lat)` for `location`).
3. Upsert into `stations` by `code`.

### Popular stations (`sync-popular-stations.js`)

1. Set `is_popular = false` for all stations.
2. Fetch popular stations JSON from `SYNC_POPULAR_URL`.
3. Upsert into `stations` with `is_popular = true` for those.

---

## Project Structure

```
backend/
├── app.js                    # Express entry
├── config/
│   ├── globals.js            # App globals
│   └── routes.js             # Route definitions
├── controllers/
│   ├── app/
│   │   └── HealthController.js
│   ├── stations/
│   │   └── StationController.js
│   └── trains/
│       └── TrainController.js
├── services/
│   ├── ConstantService.js
│   ├── HelperService.js
│   ├── LogService.js
│   ├── ResponseService.js
│   └── SqlService.js
├── scripts/
│   ├── sync-trains-list.js     # Train list sync
│   ├── sync-train-details.js   # Train route/details sync
│   ├── sync-stations.js        # Station sync
│   └── sync-popular-stations.js
├── sql/
│   ├── station-initial.sql     # stations schema
│   ├── trains-initial.sql      # trains + train_route schema
│   ├── trains-allow-null-stations.sql
│   └── train-route-create.sql
└── docs/
    └── ARCHITECTURE.md       # This file
```

---

## API Field → DB Column Mapping

| API (JSON)         | DB Table     | DB Column |
|--------------------|--------------|-----------|
| trainNumber        | trains       | train_number |
| trainName          | trains       | train_name |
| stationFrom        | trains       | station_from |
| stationTo          | trains       | station_to |
| trainRunsOnMon…Sun | trains       | runs_on_mon … runs_on_sun |
| timeStamp          | trains       | fetched_at |
| duration           | trains       | duration |
| stationList[]      | train_route  | (one row per stop) |
| stationCode        | train_route  | station_code |
| stationName        | train_route  | station_name |
| arrivalTime        | train_route  | arrival_time |
| departureTime      | train_route  | departure_time |
| routeNumber        | train_route  | route_number |
| haltTime           | train_route  | halt_time |
| distance           | train_route  | distance |
| dayCount           | train_route  | day_count |
| stnSerialNumber    | train_route  | serial_number |
| boardingDisabled   | train_route  | boarding_disabled |

---

## Environment Variables

| Variable              | Purpose |
|-----------------------|---------|
| `DATABASE_URL`        | PostgreSQL connection string |
| `PORT`                | API server port (default 3000) |
| `TRAIN_LIST_URL`      | IRCTC train list API URL |
| `TRAIN_DETAILS_URL`   | IRCTC train details API base URL |
| `SYNC_STATION_URL`    | Stations JSON URL |
| `SYNC_POPULAR_URL`    | Popular stations JSON URL |
| `BATCH_SIZE`          | Batch size for sync upserts (default 500) |
| `CORS_ORIGIN`         | CORS allowed origin(s), comma-separated or `*` (default: `*`) |
| `RATE_LIMIT_WINDOW_MS`| Rate limit window in ms (default: 60000) |
| `RATE_LIMIT_MAX`      | Max requests per window (default: 100) |
| `PG_POOL_MAX`         | Max connections in pool (default: 10) |
| `PG_POOL_IDLE_TIMEOUT_MS` | Idle connection timeout (default: 30000) |
| `PG_POOL_CONNECTION_TIMEOUT_MS` | Connection timeout (default: 5000) |
| `CACHE_ENABLED`                | Enable train search cache (default: true, set false to disable) |
| `CACHE_TTL_SECONDS`            | Cache TTL in seconds (default: 300) |
| `SYNC_TRAIN_DELAY_MS` | Delay between train detail fetches (default 50) |
| `SYNC_TRAIN_ALL`      | Set `true` to process all trains, ignoring 6hr filter |

---

## Train Between Stations API

**Endpoint:** `GET /train/between`

**Query params (Joi validated):**

| Param  | Type   | Required | Description |
|--------|--------|----------|-------------|
| from   | string | ✓        | Source station code (e.g. HWH) |
| to     | string | ✓        | Destination station code (e.g. NDLS), must differ from from |
| date   | string |          | YYYY-MM-DD – filter by day; when present, adds `alternate_days` |
| skip   | number |          | Pagination offset (default 0) |
| limit  | number |          | Page size (default 20, max 100) |

**Response (with date):**

```json
{
  "message": "Trains between stations fetched successfully",
  "data": {
    "date": "2025-02-15",
    "dayOfWeek": 6,
    "totalCount": 5,
    "trains": [...],
    "alternate_days": {
      "totalCount": 3,
      "trains": [...]
    }
  }
}
```

**Response (without date):** All trains between stations; no `alternate_days`.

---

## Future Considerations

1. **Foreign keys:** Add FK from `trains.station_from` / `station_to` and `train_route.station_code` to `stations.code` when data is consistent.
2. **Train route API:** Expose endpoint for full route details of a single train.
