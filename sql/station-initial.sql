-- best-train: initial stations schema (DEV ONLY)
--
-- This will DELETE existing stations table + data and recreate everything fresh.
-- Run it against your target database, e.g.:
--   psql "$DATABASE_URL" -f sql/station-initial.sql

-- Extensions (safe if already installed)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Drop and recreate table
DROP TABLE IF EXISTS stations CASCADE;

CREATE TABLE stations (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,   -- Core
  code TEXT NULL,
  country_code TEXT NULL,
  name_hi TEXT NULL,   -- Localized names + metadata (from stations.json)
  name_gu TEXT NULL,
  district TEXT NULL,
  state TEXT NULL,
  address TEXT NULL,
  train_count INTEGER NULL,
  utterances JSONB NULL,
  location POINT NOT NULL,   -- No PostGIS required: Postgres point type (lng, lat)
  is_popular BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Allow multiple NULL codes, but require uniqueness when code is present.
-- (Unique constraints treat NULLs as distinct in Postgres.)
ALTER TABLE stations
  ADD CONSTRAINT stations_code_uq UNIQUE (code);

-- Indexes
CREATE INDEX stations_location_gist ON stations USING GIST (location);
CREATE INDEX stations_name_trgm_gin ON stations USING GIN (name gin_trgm_ops);
CREATE INDEX stations_code_trgm_gin ON stations USING GIN (code gin_trgm_ops);
CREATE INDEX stations_name_hi_trgm_gin ON stations USING GIN (name_hi gin_trgm_ops);
CREATE INDEX stations_name_gu_trgm_gin ON stations USING GIN (name_gu gin_trgm_ops);
CREATE INDEX stations_state_trgm_gin ON stations USING GIN (state gin_trgm_ops);
CREATE INDEX stations_district_trgm_gin ON stations USING GIN (district gin_trgm_ops);
CREATE INDEX stations_is_popular_idx ON stations (is_popular) WHERE is_popular = true;

