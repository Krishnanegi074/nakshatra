-- ============================================================================
-- Nakshatra — reject malformed addresses on the Kundli waitlist (018)
--
-- 007 left public.kundli_waitlist open to anonymous inserts (`with check
-- (true)`, deliberately: the form runs before signup). Nothing checked what
-- was inserted, so any text was accepted — a test on 2026-10-06 stored "x".
-- The form already trims and lowercases the address (kundli-waitlist.js) and
-- the unique index on lower(email) already dedups; this is the database-level
-- backstop for anything else that submits.
--
-- The rule is deliberately pragmatic, not RFC-perfect: a non-empty local part,
-- exactly one "@", a domain with at least one dot and something after it, no
-- whitespace anywhere, and at most 254 characters. It also rejects exotic
-- quoted local parts like "a b"@c.com (almost never used) and still accepts
-- "a@b..com" (loose on purpose).
--
-- The table had 0 rows when this was written, so the constraint validates
-- instantly. Idempotent: the drop makes a rerun safe.
-- How to apply: Supabase SQL Editor -> new query -> paste -> Run.
--
-- BEFORE applying, test the exact pattern with the select-only query in the
-- comment block at the bottom of this file (every row must show ok = true).
-- ============================================================================

alter table public.kundli_waitlist
  drop constraint if exists kundli_waitlist_email_format;

alter table public.kundli_waitlist
  add constraint kundli_waitlist_email_format
  check (length(email) <= 254 and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$');

-- ----------------------------------------------------------------------------
-- Select-only test of the exact pattern (changes nothing). Run it in the SQL
-- Editor BEFORE applying 018; every row must show ok = true.
--
-- select input, expected,
--        (length(input) <= 254 and input ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') as passes,
--        ((length(input) <= 254 and input ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') = expected) as ok
-- from (values
--   ('a@b.com', true), ('A@B.COM', true), ('a+tag@b.co.in', true), ('a.b@c-d.com', true),
--   ('ñ@b.com', true), ('a@münchen.de', true), ('a@b..com', true),
--   ('a@b', false), ('a@b.', false), ('a@.com', false), ('@b.com', false), ('a@@b.com', false),
--   ('a b@c.com', false), (' a@b.com', false), ('a@b.com ', false), (E'a\t@b.com', false),
--   (E'a@b.com\n', false), ('x', false), ('', false),
--   (repeat('a', 245) || '@b.com', true), (repeat('a', 250) || '@b.com', false)
-- ) as t(input, expected)
-- order by ok, input;
