-- best-train: places and place_stations schema (DEV - no dependency on stations; runs in any order)
--
-- Popular places (cities, landmarks, attractions) mapped to stations.
-- Run: psql "$DATABASE_URL" -f sql/places-initial.sql
-- Docker: scripts in sql/ run alphabetically on first init.

-- Drop existing tables (order matters due to FK)
DROP TABLE IF EXISTS place_stations CASCADE;
DROP TABLE IF EXISTS places CASCADE;

CREATE TABLE places (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  display_name TEXT NULL,
  state TEXT NULL,
  description TEXT NULL,
  image_url TEXT NULL,
  location POINT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX places_name_uq ON places (LOWER(TRIM(name)));
CREATE INDEX places_name_idx ON places (name);
CREATE INDEX places_state_idx ON places (state);

-- place_stations: links place to stations (rank = 1 is primary)
CREATE TABLE place_stations (
  id BIGSERIAL PRIMARY KEY,
  place_id BIGINT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  station_code TEXT NOT NULL,
  rank INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(place_id, station_code)
);

CREATE INDEX place_stations_place_id_idx ON place_stations (place_id);
CREATE INDEX place_stations_station_code_idx ON place_stations (station_code);
