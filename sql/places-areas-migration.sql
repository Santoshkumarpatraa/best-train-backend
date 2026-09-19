-- best-train: turn `places` into a general area table (state / district / city / place).
--
-- Additive and reversible. Safe to run more than once.
--   psql "$DATABASE_URL" -f sql/places-areas-migration.sql
--
-- Rollback:
--   DROP TABLE IF EXISTS place_aliases;
--   DROP INDEX IF EXISTS places_kind_parent_name_uq;
--   DROP INDEX IF EXISTS places_lower_name_idx;
--   ALTER TABLE places DROP COLUMN IF EXISTS kind,
--                      DROP COLUMN IF EXISTS parent_id,
--                      DROP COLUMN IF EXISTS station_count,
--                      DROP COLUMN IF EXISTS updated_at;
--
-- Recreating the old places_name_uq (LOWER(TRIM(name))) is only possible on a
-- database the seeder has not run against: once "Pune" exists as both a city
-- and a district the unique constraint cannot be satisfied. Deduplicate by
-- hand first if the old index is genuinely needed.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE places ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'place';
ALTER TABLE places ADD COLUMN IF NOT EXISTS parent_id BIGINT REFERENCES places(id) ON DELETE SET NULL;
ALTER TABLE places ADD COLUMN IF NOT EXISTS station_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE places ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'places_kind_chk') THEN
    ALTER TABLE places ADD CONSTRAINT places_kind_chk
      CHECK (kind IN ('state', 'district', 'city', 'place'));
  END IF;
END $$;

-- Names are only unique within a kind and parent: "Aurangabad" is a district in
-- both Bihar and Maharashtra, and a district may share its name with its city.
DROP INDEX IF EXISTS places_name_uq;
CREATE UNIQUE INDEX IF NOT EXISTS places_kind_parent_name_uq
  ON places (kind, COALESCE(parent_id, 0), LOWER(TRIM(name)));

-- Name resolution filters on LOWER(TRIM(name)); places_kind_parent_name_uq
-- leads with kind, so it cannot serve that predicate.
CREATE INDEX IF NOT EXISTS places_lower_name_idx ON places (LOWER(TRIM(name)));
CREATE INDEX IF NOT EXISTS places_kind_idx ON places (kind);
CREATE INDEX IF NOT EXISTS places_parent_idx ON places (parent_id);
CREATE INDEX IF NOT EXISTS places_name_trgm_gin ON places USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS places_station_count_idx ON places (station_count DESC);

-- Alternate spellings: Bengaluru/Bangalore, Gurugram/Gurgaon, Hindi names.
-- Exact matching on stations.district is what breaks user searches today.
CREATE TABLE IF NOT EXISTS place_aliases (
  id BIGSERIAL PRIMARY KEY,
  place_id BIGINT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS place_aliases_uq ON place_aliases (place_id, LOWER(TRIM(alias)));
CREATE INDEX IF NOT EXISTS place_aliases_alias_idx ON place_aliases (LOWER(TRIM(alias)));
CREATE INDEX IF NOT EXISTS place_aliases_trgm_gin ON place_aliases USING GIN (alias gin_trgm_ops);

-- rank 1 is the primary station; the search orders results by it.
CREATE INDEX IF NOT EXISTS place_stations_rank_idx ON place_stations (place_id, rank);

COMMIT;
