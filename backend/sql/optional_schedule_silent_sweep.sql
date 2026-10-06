-- Schedules the silent-expert sweep (supabase/functions/sweep-silent-expert-sessions)
-- to run once a minute. NOT a numbered migration: it needs a secret only you
-- have, and the project URL below is this project's. Run it by hand, once,
-- AFTER:
--   1. sql/016_silent_expert_refund.sql has been applied, and
--   2. the edge function has been deployed with "Verify JWT" turned OFF and
--      the edge-function secret SWEEP_SECRET set (see backend/SETUP.md,
--      "016 - Automatic end + refund when an expert never replies").
--
-- Generate the secret locally (any 24+ character random string works):
--     openssl rand -hex 32
-- Put the SAME value in two places: Edge Functions -> Secrets -> SWEEP_SECRET,
-- and in the vault.create_secret(...) line below. Don't commit the real value.
--
-- To stop the sweep any time:  select cron.unschedule('sweep-silent-expert-sessions');
-- To see recent runs:          select * from cron.job_run_details order by start_time desc limit 10;
-- To see the HTTP results:     select id, status_code, content, created from net._http_response order by created desc limit 10;

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- REPLACE the placeholder before running.
select vault.create_secret('<PASTE_SWEEP_SECRET_HERE>', 'sweep_secret', 'Shared secret for the sweep-silent-expert-sessions edge function');

select cron.schedule(
  'sweep-silent-expert-sessions',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://xinelwrxgveztrtokwbt.supabase.co/functions/v1/sweep-silent-expert-sessions',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'sweep_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 25000
  );
  $$
);
