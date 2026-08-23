# Phase 2 → Phase 3 migration plan (PLANNING DOCUMENT — NOT RUNNABLE CODE)

This document describes how a *future* phase would migrate existing
IndexedDB data into the D1 + R2 cloud data layer built in Phase 2. **No
migration has been implemented or run.** Phase 2 only builds and tests the
cloud infrastructure alongside the existing app; IndexedDB remains the
sole source of truth and the frontend does not call any `/api/*` endpoint
yet.

## Why this is a separate, later step

Migrating real inspection data (schools, visits, observations, photos,
audio, monthly submissions) is inherently risky: it is the one operation
in this project that touches a user's actual production records instead
of test fixtures. It must not be attempted casually, automatically, or as
a side effect of infrastructure work. It needs its own review, its own
dry-run tooling, and explicit user sign-off before it ever writes to a
real D1 database or R2 bucket.

## Required sequence (future work, in order)

1. **Export/read from IndexedDB.** Read every record from every existing
   store (`schools`/school names, `visits`, `observations`, photo blobs,
   audio blobs, monthly submissions/photos) without modifying anything.
2. **Validate before touching the network.** Check required fields are
   present, IDs are well-formed, every observation references a visit
   that exists, every monthly photo references a school and a known slot.
   Produce a report of anything that fails validation; do not migrate a
   record that fails.
3. **Write to D1/R2 (never the reverse order).** For each record:
   photo/audio bytes go to R2 first, confirmed present via `HEAD`, then
   the corresponding D1 row is written (`photo_refs` after the object is
   confirmed) — the same R2-then-D1 sequencing already implemented by
   `/api/photos/upload` + `/api/photos/confirm` in `worker.js`. Reuse
   those endpoints rather than writing separate migration-only logic, so
   the exact same consistency guarantees apply.
4. **Verify counts.** After migrating a school's data, count schools,
   visits, observations, and monthly submissions in D1 and compare
   against the IndexedDB source counts. Any mismatch stops the migration
   for that school and is reported, not silently retried or ignored.
5. **Verify every photo.** For every photo reference written to D1,
   confirm the R2 object exists (`HEAD`) and its size matches what was
   read from IndexedDB. A missing or size-mismatched object is a hard
   failure for that record.
6. **Verify every audio file.** Same check as photos, for the `audio`
   photo_type objects.
7. **Verify monthly submissions.** Confirm every monthly submission has
   the expected slots filled per the school's monthly photo checklist,
   matching what IndexedDB shows for that school/month.
8. **Only after every check above passes** would the app ever be
   switched to treat cloud storage as primary — and that switch is itself
   a separate, explicit, user-approved change. It is out of scope for
   both Phase 2 and this document; nothing here implements or enables it.

## What Phase 2 deliberately does NOT do

- No code reads from IndexedDB and writes to D1/R2, or vice versa.
- No automatic or scheduled migration exists.
- No existing production data has been uploaded to D1 or R2.
- No UI entry point exists to trigger any of the steps above.
- `wrangler d1 execute` / `wrangler r2 bucket create` have only been run
  in `--local` (fully emulated, no real Cloudflare account touched) mode
  during Phase 2 development and testing.

## Preconditions before this plan can be implemented

- A real D1 database and R2 bucket must exist (`wrangler d1 create`,
  `wrangler r2 bucket create`, both requiring real Cloudflare
  credentials not available in the Phase 2 development sandbox), and
  `wrangler.toml`'s placeholder `database_id`/`bucket_name` values must
  be replaced with the real ones.
- The migration must be dry-run-able (report what *would* happen without
  writing anything) before it is ever run for real.
- The user must explicitly approve running it against real data.
