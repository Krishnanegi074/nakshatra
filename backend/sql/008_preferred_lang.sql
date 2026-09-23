-- ============================================================================
-- Nakshatra — persist signed-in users' language choice (008)
--
-- Adds public.profiles.preferred_lang ('en' | 'hi'). This is the "#19" fix
-- from the full-site QA pass: previously state.lang (app.js) was explicitly
-- documented as NOT persisted — it was re-detected from navigator.language
-- on every fresh page load, so a signed-in user who switched to Hindi would
-- silently see English again on their next visit (or on any other device).
--
-- This does NOT reach for localStorage — that constraint traces back to the
-- app's origins as a Claude-built HTML/JS Artifact, where browser storage
-- truly isn't supported. The app has since become a real production site
-- with a real Supabase backend, so the fix follows the app's own established
-- pattern (see birth_data, palm_reports, entitlements, etc.): persist real,
-- durable user data server-side, scoped to the signed-in account, so it
-- follows the user across devices/browsers instead of living in one tab.
--
-- Anonymous/pre-auth visitors are unaffected — their language still resets
-- to the browser-detected default each load, same as before this migration;
-- only signed-in users (who have a profiles row to persist into) get the
-- new behavior. See app/app.js's loadUserDataFromBackend() (reads it back
-- on login/session-restore) and initLangSwitch() (saves it on switch).
--
-- How to apply: same as every other file in this folder — Supabase project
-- -> SQL Editor -> New query -> paste this whole file -> Run. Run it AFTER
-- 002_schema.sql (which created profiles).
-- ============================================================================

alter table public.profiles
  add column if not exists preferred_lang text not null default 'en';

alter table public.profiles
  drop constraint if exists profiles_preferred_lang_check;

alter table public.profiles
  add constraint profiles_preferred_lang_check check (preferred_lang in ('en', 'hi'));

comment on column public.profiles.preferred_lang is
  'Signed-in user''s last-chosen UI language (''en'' or ''hi''), so it follows the account across devices/browsers instead of resetting to the browser-detected default on every load. Written by app/app.js''s language switcher; anonymous/pre-auth visitors have no profiles row and are unaffected.';
