-- ============================================================================
-- Nakshatra — birth city IANA timezone (006)
--
-- Adds public.birth_data.city_tz (the IANA timezone identifier, e.g.
-- "Asia/Kolkata" or "America/New_York") alongside the existing city_utc
-- (a fixed, DST-ignoring standard-time offset in hours).
--
-- Why: the previous fixed-offset-only design was wrong for any city that
-- observes daylight saving time — e.g. a New York-born user's chart was
-- always computed with the January (EST, UTC-5) offset, even for a July
-- birth (which is actually EDT, UTC-4), silently shifting their whole chart
-- by an hour for about half the calendar year. app/city-data.js now carries
-- a `tz` field for every city, and app/engine.js + app/engine.browser.js's
-- new toUtcDateTz() resolves the correct offset FOR THE ACTUAL BIRTH DATE
-- using the JS Intl timezone database, not a single hardcoded number. This
-- is the "#7" fix from the full-site QA pass: "replace fixed city UTC
-- offsets with IANA-timezone + birth-date + DST-aware handling."
--
-- Backward compatible / additive only: city_utc is kept (not dropped) so
-- already-saved rows from before this migration keep working via the
-- legacy toUtcDate() fallback in app/app.js's birthLocalToUtc() — they just
-- won't get DST-correct behavior until the user re-enters their birth
-- details (out of scope here; there's no "recalculate my chart" flow yet).
--
-- How to apply: same as every other file in this folder — Supabase project
-- -> SQL Editor -> New query -> paste this whole file -> Run. Run it AFTER
-- 002_schema.sql (which created birth_data). Apply it BEFORE (or in the
-- same release as) deploying the updated app/city-data.js + app/app.js +
-- app/engine.browser.js in this same change.
-- ============================================================================

alter table public.birth_data add column if not exists city_tz text;

comment on column public.birth_data.city_tz is
  'IANA timezone identifier for the birth city (e.g. Asia/Kolkata, America/New_York) — used for DST-aware UTC conversion. Nullable: rows saved before this migration only have the legacy city_utc fixed offset.';
