// Nakshatra — Kundli Matching waitlist signup.
//
// Wires the "Join the Waitlist" form on kundli-matching.html to the real
// public.kundli_waitlist table (see backend/sql/007_kundli_waitlist.sql).
// Anonymous visitors can INSERT an email address there; nothing can SELECT
// it back — no read policy and no grant at all (see that file's header) —
// so this script never logs, fetches, or displays the collected addresses,
// only ever sends one.
//
// SUPABASE_URL / SUPABASE_ANON_KEY intentionally match app/supabase-client.js
// exactly (same Supabase project). This page ships outside the app/ build
// pipeline, so it can't import that file directly — if the project URL or
// anon key ever changes, update both places. The anon key is safe to ship
// client-side; it has no power beyond what 007_kundli_waitlist.sql's RLS
// policy grants (insert-only, to anyone).
(function () {
  'use strict';

  var SUPABASE_URL = 'https://xinelwrxgveztrtokwbt.supabase.co';
  var SUPABASE_ANON_KEY = 'sb_publishable_TCpwYsH_r77QM7kRkdBLrw_BPW26GHs';

  document.addEventListener('DOMContentLoaded', function () {
    var form = document.getElementById('waitlist-form');
    var input = document.getElementById('waitlist-email');
    var button = document.getElementById('waitlist-submit');
    var status = document.getElementById('waitlist-status');
    if (!form || !input || !button || !status) return;

    var neutralText = status.textContent;

    var client = (window.supabase && typeof window.supabase.createClient === 'function')
      ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
      : null;

    function setStatus(text, kind) {
      // kind: 'success' | 'error' | null (neutral / in-progress).
      // #waitlist-status is role="status" aria-live="polite" (see
      // kundli-matching.html), so this text change is announced to screen
      // readers automatically — no separate a11y wiring needed here.
      status.textContent = text;
      status.classList.remove('nk-km-note--success', 'nk-km-note--error');
      if (kind === 'success') status.classList.add('nk-km-note--success');
      if (kind === 'error') status.classList.add('nk-km-note--error');
    }

    function setBusy(busy) {
      button.disabled = busy;
      input.disabled = busy;
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();

      if (!client) {
        // supabase-js failed to load (offline, ad blocker, CDN down, etc.)
        setStatus('Could not connect right now — please try again in a moment, or email support@nakshatra.ind.in.', 'error');
        return;
      }

      // The <input type="email" required> already blocks an empty/malformed
      // submit natively before this handler ever runs; this just normalizes
      // case the same way the server-side unique index treats it (see
      // 007_kundli_waitlist.sql's lower(email) index).
      var email = (input.value || '').trim().toLowerCase();
      if (!email) return;

      setBusy(true);
      setStatus('Joining…', null);

      client.from('kundli_waitlist').insert({ email: email }).then(function (result) {
        var error = result && result.error;
        setBusy(false);

        if (!error) {
          input.value = '';
          setStatus("You're on the list — we'll email you the moment Kundli Matching is ready.", 'success');
          return;
        }

        // 23505 = unique_violation. The email is already on the list (our
        // own case-insensitive unique index) — not a real failure from the
        // visitor's point of view, so this is shown as a success, not an error.
        if (error.code === '23505' || /duplicate key|already exists/i.test(error.message || '')) {
          input.value = '';
          setStatus("You're already on the list — we'll email you the moment it's ready.", 'success');
          return;
        }

        setStatus('Something went wrong — please try again in a moment, or email support@nakshatra.ind.in.', 'error');
      }).catch(function () {
        setBusy(false);
        setStatus('Something went wrong — please try again in a moment, or email support@nakshatra.ind.in.', 'error');
      });
    });

    // Exposed only so a future edit/test can restore the original copy
    // without hardcoding it twice; not called anywhere today.
    window.__nkWaitlistNeutralText = neutralText;
  });
})();
