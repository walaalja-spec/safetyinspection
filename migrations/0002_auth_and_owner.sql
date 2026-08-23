-- ---------------------------------------------------------------------
-- Migration 0002 — authentication support + forward-compatible ownership
--
-- REVIEW BEFORE APPLYING. Not applied automatically by anything.
--
-- Safety properties of this migration:
--   * Purely ADDITIVE. No table is dropped, renamed, or rewritten; no
--     column is removed or retyped; no existing row is modified.
--   * Every added column is NULLABLE with no DEFAULT, which in SQLite
--     (and therefore D1) is a metadata-only change -- it does not
--     rewrite existing rows, so it stays fast and safe regardless of how
--     much data is already there.
--   * Re-runnable: the new table uses IF NOT EXISTS. The ALTER TABLE
--     statements are NOT idempotent in SQLite -- re-running them errors
--     with "duplicate column name", which is harmless but means this
--     file should be applied exactly once per database.
--
-- Apply locally:
--   npx wrangler d1 execute school-inspection-db --local \
--     --file=migrations/0002_auth_and_owner.sql
--
-- Apply to the real database (only after local verification, and only
-- with explicit approval):
--   npx wrangler d1 execute school-inspection-db --remote \
--     --file=migrations/0002_auth_and_owner.sql
-- ---------------------------------------------------------------------

-- Brute-force protection for POST /api/auth/login. Holds only an IP and
-- a timestamp -- no credentials, no password material, nothing derived
-- from one. Rows older than the rate-limit window are deleted by the
-- Worker on each login attempt, so this table stays small on its own.
CREATE TABLE IF NOT EXISTS auth_login_attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ip           TEXT    NOT NULL,
  attempted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_login_attempts_ip_time
  ON auth_login_attempts(ip, attempted_at);

-- Forward-compatible ownership.
--
-- This application currently has exactly ONE operator, so authentication
-- alone is sufficient authorization today: every row belongs to that one
-- account, and no endpoint can leak data across users because there is
-- only one user. These columns are added now, while the tables are
-- small and the change is trivial, purely so that introducing a second
-- inspector later becomes a code change plus a backfill rather than a
-- risky schema migration on a large production dataset.
--
-- The column is named account_id, NOT owner_id, on purpose: photo_refs
-- already has an owner_id from migration 0001, where it means something
-- completely different -- the parent RECORD a photo belongs to (an
-- observation or a monthly_submission, selected by owner_type). Reusing
-- that name here would collide on photo_refs and would be misleading on
-- every other table. account_id unambiguously means "which login owns
-- this row".
--
-- NULL means "belongs to the original single operator". No code reads
-- these columns yet -- adding a WHERE account_id = ? clause to every
-- query is deliberately left for the phase that actually introduces
-- multiple users, so nothing changes behaviour today.
ALTER TABLE schools             ADD COLUMN account_id TEXT;
ALTER TABLE visits              ADD COLUMN account_id TEXT;
ALTER TABLE observations        ADD COLUMN account_id TEXT;
ALTER TABLE monthly_submissions ADD COLUMN account_id TEXT;
ALTER TABLE photo_refs          ADD COLUMN account_id TEXT;
