-- best-train: trains and train_route schema
--
-- Run against your target database, e.g.:
--   psql "$DATABASE_URL" -f sql/trains-initial.sql

-- Drop existing tables (order matters due to FK)
DROP TABLE IF EXISTS train_route CASCADE;
DROP TABLE IF EXISTS trains CASCADE;

-- Main trains table
CREATE TABLE trains (
  id BIGSERIAL PRIMARY KEY,
  train_number INTEGER NOT NULL UNIQUE,
  train_name TEXT NOT NULL,
  station_from TEXT NULL,
  station_to TEXT NULL,
  train_owner TEXT NULL,
  runs_on_mon BOOLEAN NOT NULL DEFAULT false,
  runs_on_tue BOOLEAN NOT NULL DEFAULT false,
  runs_on_wed BOOLEAN NOT NULL DEFAULT false,
  runs_on_thu BOOLEAN NOT NULL DEFAULT false,
  runs_on_fri BOOLEAN NOT NULL DEFAULT false,
  runs_on_sat BOOLEAN NOT NULL DEFAULT false,
  runs_on_sun BOOLEAN NOT NULL DEFAULT false,
  duration TEXT NULL,
  fetched_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX trains_train_number_idx ON trains (train_number);
CREATE INDEX trains_station_from_idx ON trains (station_from);
CREATE INDEX trains_station_to_idx ON trains (station_to);
CREATE INDEX trains_station_from_to_idx ON trains (station_from, station_to);

-- Train route: stations along the train's path (ordered by serial_number)
CREATE TABLE train_route (
  id BIGSERIAL PRIMARY KEY,
  train_id BIGINT NOT NULL REFERENCES trains(id) ON DELETE CASCADE,
  station_code TEXT NOT NULL,
  station_name TEXT NOT NULL,
  arrival_time TEXT NULL,
  departure_time TEXT NULL,
  route_number TEXT NULL,
  halt_time TEXT NULL,
  distance INTEGER NULL,
  day_count INTEGER NULL,
  serial_number INTEGER NOT NULL,
  boarding_disabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX train_route_train_id_idx ON train_route (train_id);
CREATE INDEX train_route_station_code_idx ON train_route (station_code);
CREATE INDEX train_route_station_train_idx ON train_route (station_code, train_id);
CREATE UNIQUE INDEX train_route_train_serial_uq ON train_route (train_id, serial_number);
CREATE INDEX train_route_train_route_idx ON train_route (train_id, route_number);
