-- ---------------------------------------------------------------------
-- Migration 0003 — rate limiting for write requests (POST/PUT/DELETE)
--
-- REVIEW BEFORE APPLYING. Not applied automatically by anything.
--
-- Safety properties (same as 0002):
--   * Purely ADDITIVE. One new table, IF NOT EXISTS. No existing table,
--     column, or row is touched.
--   * If this migration hasn't been applied yet, the Worker's rate-limit
--     check fails closed to "not limited" (see writeRateLimited() in
--     worker.js) rather than breaking writes -- so deploying the code
--     before running this migration is safe, just not yet rate-limited.
--
-- Apply locally:
--   npx wrangler d1 execute school-inspection-db --local \
--     --file=migrations/0003_write_rate_limit.sql
--
-- Apply to the real database (only after local verification, and only
-- with explicit approval):
--   npx wrangler d1 execute school-inspection-db --remote \
--     --file=migrations/0003_write_rate_limit.sql
-- ---------------------------------------------------------------------

-- Same shape and purpose as auth_login_attempts, but a separate table on
-- purpose: this counts write requests (POST/PUT/DELETE) across every
-- /api/* endpoint except /api/auth/*, which is a completely different
-- threat model (throughput/abuse protection, not brute-force login
-- protection) and must not share -- or corrupt -- the login counter.
CREATE TABLE IF NOT EXISTS api_write_attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ip           TEXT    NOT NULL,
  attempted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_write_attempts_ip_time
  ON api_write_attempts(ip, attempted_at);
