-- ============================================================================
-- Nakshatra — Kundli Matching waitlist (007)
--
-- kundli-matching.html's "Join the Waitlist" form previously had
-- onsubmit="return false" — it visually accepted an email address and threw
-- it away, never actually saving anything anywhere. This is the real
-- backend for it: a table anonymous (not-signed-in) visitors can INSERT
-- into from the public marketing page, and nothing else can read.
--
-- Deliberately NO select/update/delete policy for anon or authenticated —
-- nobody can read the list of collected emails back from the client side
-- ("do not log or expose addresses" — item #10 of the full-site QA pass).
-- Only service_role (used from the Supabase dashboard's Table Editor, or a
-- future export script run with the service key) can read this table,
-- matching how purchases/user_entitlements already have no client-facing
-- read policy either (see 004_razorpay_payments.sql's header comment).
--
-- How to apply: same as every other file in this folder — Supabase project
-- -> SQL Editor -> New query -> paste this whole file -> Run. Run it any
-- time after 002_schema.sql.
-- ============================================================================

create table public.kundli_waitlist (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  created_at timestamptz not null default now()
);

-- Case-insensitive dedup at the database level, defense-in-depth alongside
-- the client already lowercasing the address before insert (see
-- kundli-matching.html) — so "Foo@Bar.com" and "foo@bar.com" are still
-- treated as the same signup no matter what submits them.
create unique index kundli_waitlist_email_lower_idx on public.kundli_waitlist (lower(email));

alter table public.kundli_waitlist enable row level security;

-- Anyone can join — this is captured on the public page BEFORE signup, so
-- there is no auth.uid() to scope it to. `with check (true)` is intentional:
-- the only thing being protected here is READ access (see above), not who
-- may add an email.
create policy "kundli_waitlist_insert_anyone" on public.kundli_waitlist
  for insert
  to anon, authenticated
  with check (true);

grant insert on public.kundli_waitlist to anon, authenticated;
-- select/update/delete are NOT granted to anon/authenticated at all, on top
-- of there being no policy for them — belt and suspenders.
