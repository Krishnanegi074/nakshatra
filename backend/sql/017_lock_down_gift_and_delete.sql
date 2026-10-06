-- ============================================================================
-- Nakshatra — stop signed-out callers executing the two client-facing
-- SECURITY DEFINER functions (017)
--
-- Found by a read-only privilege check on nakshatra-prod (2026-10-06):
--   * redeem_gift_code(text)  -> anon could call it. It can't redeem or burn a
--     code for a signed-out caller (the null user makes grant_entitlement fail
--     and the whole call rolls back), but its different errors tell a caller
--     whether a gift code exists / is already redeemed.
--   * delete_own_account()    -> anon could call it. Harmless (it raises
--     NOT_AUTHENTICATED), but there is no reason for it to be callable.
--
-- Same cause as 012: Supabase grants EXECUTE on new functions to anon and
-- authenticated directly, and `revoke ... from public` doesn't remove those.
-- 012 deliberately left these two alone because signed-in clients need them.
--
-- Fix: revoke from public and anon, and state the grants the app actually
-- needs explicitly (authenticated for the signed-in app, service_role for
-- server-side use). Idempotent. How to apply: SQL Editor -> paste -> Run.
--
-- Verify afterwards (both rows must read  false / true / true):
--   select p.proname,
--          has_function_privilege('anon', p.oid, 'execute')          as anon,
--          has_function_privilege('authenticated', p.oid, 'execute') as authed,
--          has_function_privilege('service_role', p.oid, 'execute')  as svc
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname in ('redeem_gift_code', 'delete_own_account')
--   order by p.proname;
-- ============================================================================

revoke execute on function public.redeem_gift_code(text) from public, anon;
revoke execute on function public.delete_own_account() from public, anon;

grant execute on function public.redeem_gift_code(text) to authenticated, service_role;
grant execute on function public.delete_own_account() to authenticated, service_role;
