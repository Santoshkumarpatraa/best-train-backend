# Best Train Backend

Backend service for train station, place, and train search APIs.

## Requirements

- Node.js 24+
- npm
- PostgreSQL 18 (or compatible)
- `psql` client

## Local setup

1. Install dependencies:

```bash
cd /Users/santoshkumar/best-train-backend
npm install
```

2. Install PostgreSQL locally (macOS / Homebrew):

```bash
brew install postgresql@18
brew services start postgresql@18
```

If you only need the client tools, install:

```bash
brew install libpq
```

Then add `psql` to your path if needed:

```bash
echo 'export PATH="/opt/homebrew/opt/libpq/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

## Environment

Copy or create a `.env` file with values like:

```env
PORT=8000
NODE_ENV=production
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/best_train
SYNC_STATION_URL=https://cdn.jsdelivr.net/gh/corover/assets@UIChange/askdisha-bucket/stations.json
SYNC_POPULAR_URL=https://cdn.jsdelivr.net/gh/corover/assets@t52/askdisha-bucket/popular.json
TRAIN_LIST_URL=https://www.irctc.co.in/eticketing/trainList
TRAIN_DETAILS_URL=https://www.irctc.co.in/eticketing/protected/mapps1/trnscheduleenquiry
```

## Database initialization

Create the database and run the SQL schema files:

```bash
PGPASSWORD=postgres psql -h localhost -p 5432 -U postgres -c 'CREATE DATABASE best_train;'
for f in sql/*.sql; do PGPASSWORD=postgres psql -h localhost -p 5432 -U postgres -d best_train -f "$f"; done
```

If the database already exists, the SQL files will recreate the schema.

## Run locally

```bash
npm start
```

The API will start on `http://localhost:8000` by default.

## Data sync scripts

- `npm run sync:stations`
- `npm run sync:popular`
- `npm run sync:trains`
- `npm run sync:train-details`

## API endpoints

### Health

```bash
curl http://localhost:8000/
```

### Cache

```bash
curl http://localhost:8000/cache/stats
curl http://localhost:8000/cache/keys
curl -X DELETE http://localhost:8000/cache/clear
curl -X DELETE http://localhost:8000/cache/delete/YOUR_CACHE_KEY
curl -X POST http://localhost:8000/cache/delete-pattern \
  -H "Content-Type: application/json" \
  -d '{"pattern":"station:list:*"}'
```

### Station search

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

### Place APIs

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
    "stations": ["AGC", "TGT"]
  }'

curl -X PUT http://localhost:8000/place/1 \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Updated description",
    "stations": ["AGC", "TGT", "KWD"]
  }'
```

### Train search

```bash
curl "http://localhost:8000/train/between/stations?from=NDLS&to=BCT&date=2026-06-05&limit=10&sort=duration&order=asc"

curl "http://localhost:8000/train/between/states?from_state=Delhi&to_state=Maharashtra&date=2026-06-05&limit=20"

curl "http://localhost:8000/train/between/places?from=Delhi&to=Mumbai&date=2026-06-05&limit=20"
```

## Notes

- The app uses `config/config.js` to read environment variables.
- `app.js` includes graceful shutdown and rate limiting.
- If you change `.env`, restart the server.
