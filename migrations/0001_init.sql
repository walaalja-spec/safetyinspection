-- ---------------------------------------------------------------------
-- Phase 2 — D1 schema (infrastructure only, not yet wired to the app).
--
-- Mirrors the existing IndexedDB data model closely enough that a future
-- migration can map records 1:1, but uses real foreign keys instead of
-- matching schools by name text. No photo/audio bytes are ever stored
-- here — only metadata pointing at an R2 object key (see photo_refs).
--
-- Relationships:
--   schools -> visits -> observations -> photo_refs
--   schools -> monthly_submissions -> photo_refs
--
-- Apply locally with:
--   npx wrangler d1 execute safety_inspection_d1 --local --file=migrations/0001_init.sql
-- (Never run with --remote in this phase — see PHASE2_MIGRATION_PLAN.md.)
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS schools (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS visits (
  id                  TEXT PRIMARY KEY,
  -- Nullable: the existing app allows a "quick visit" with no linked
  -- school (a free-text location only) -- preserved here rather than
  -- forcing every visit to reference a school row.
  school_id           TEXT REFERENCES schools(id) ON DELETE SET NULL,
  title               TEXT NOT NULL,
  location            TEXT NOT NULL,
  date                TEXT NOT NULL,
  footer_text         TEXT,
  photo_settings_json TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_visits_school ON visits(school_id);

CREATE TABLE IF NOT EXISTS observations (
  id                          TEXT PRIMARY KEY,
  visit_id                    TEXT NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  text                        TEXT NOT NULL,
  spot_location               TEXT,
  category                    TEXT,
  recommended_action          TEXT,
  pending_ai                  INTEGER NOT NULL DEFAULT 0,
  -- Follow-up columns exist so a future phase can implement the
  -- Before/After feature without another migration -- deliberately NOT
  -- read or written by any endpoint in this phase.
  followup_enabled            INTEGER NOT NULL DEFAULT 0,
  followup_status             TEXT,
  followup_verification_date  TEXT,
  followup_verification_note  TEXT,
  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_observations_visit ON observations(visit_id);

-- The shared checklist of required monthly photo types (today: 15 rows,
-- same for every school) -- a table instead of a single blob record so
-- individual slots have stable ids or ordering.
CREATE TABLE IF NOT EXISTS monthly_slots (
  id         TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  category   TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS monthly_submissions (
  id         TEXT PRIMARY KEY,
  school_id  TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  month_key  TEXT NOT NULL, -- "YYYY-MM"
  visit_date TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(school_id, month_key)
);
CREATE INDEX IF NOT EXISTS idx_monthly_submissions_school ON monthly_submissions(school_id);

-- Metadata only. The photo/audio bytes themselves always live in R2 at
-- r2_key; this row never exists unless that R2 object has already been
-- confirmed present (see worker.js's POST /api/photos/confirm).
CREATE TABLE IF NOT EXISTS photo_refs (
  id            TEXT PRIMARY KEY,
  r2_key        TEXT NOT NULL UNIQUE,
  owner_type    TEXT NOT NULL CHECK (owner_type IN ('observation', 'monthly_submission')),
  owner_id      TEXT NOT NULL,
  photo_type    TEXT NOT NULL CHECK (photo_type IN ('original', 'before', 'after', 'monthly', 'audio')),
  slot_id       TEXT, -- only meaningful when owner_type = 'monthly_submission'
  content_type  TEXT NOT NULL,
  size          INTEGER NOT NULL,
  checksum      TEXT,
  taken_at      INTEGER,
  uploaded_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_photo_refs_owner ON photo_refs(owner_type, owner_id);
