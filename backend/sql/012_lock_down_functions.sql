-- ============================================================================
-- Nakshatra — lock down privileged SECURITY DEFINER functions (012)
--
-- SECURITY FIX. On the live project, any logged-in user could call these
-- directly through the REST API (supabase.rpc(...)):
--   * grant_entitlement(uuid, text, text)        -> free paid tier
--   * complete_razorpay_order(text, text, text)  -> mark THEIR OWN unpaid
--                                                   order "verified" and
--                                                   get the tier without paying
--   * complete_expert_session_order(...)         -> same, for an expert chat
--
-- Cause: 004/005/009 did `revoke execute ... from public`, but Supabase
-- grants EXECUTE on new functions to `anon` and `authenticated` explicitly
-- (default privileges), and revoking from PUBLIC does not remove those
-- direct grants. Confirmed on nakshatra-prod with throwaway users: all three
-- succeeded as a regular user.
--
-- Fix: revoke from anon/authenticated too, and grant only to service_role
-- (the secret key the Edge Functions use). The functions meant for clients
-- (redeem_gift_code, delete_own_account) are deliberately untouched, and so
-- are the trigger functions (handle_new_user, broadcast_chat_message): they
-- can't be called over RPC, so revoking there only risks breaking signup.
--
-- Idempotent. How to apply: Supabase SQL Editor -> paste -> Run.
-- Verify afterwards by re-running the function probe (a regular user calling
-- each of these should get "permission denied for function ...").
-- ============================================================================

revoke execute on function public.grant_entitlement(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.complete_razorpay_order(text, text, text) from public, anon, authenticated;
revoke execute on function public.complete_expert_session_order(text, text, text) from public, anon, authenticated;
revoke execute on function public.record_test_purchase(text, int, text) from public, anon, authenticated;

grant execute on function public.grant_entitlement(uuid, text, text) to service_role;
grant execute on function public.complete_razorpay_order(text, text, text) to service_role;
grant execute on function public.complete_expert_session_order(text, text, text) to service_role;

-- grant_entitlement() is also called from inside the other SECURITY DEFINER
-- functions, which run as their owner, so they keep working.
