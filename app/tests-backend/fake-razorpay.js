// Injected into the page via page.addInitScript() BEFORE any of the app's
// own scripts run, alongside fake-supabase.js. Stands in for the real
// https://checkout.razorpay.com/v1/checkout.js widget (unreachable from
// this sandbox — no real network access, same limitation documented in
// nakshatra-backend/SETUP.md) so initCheckout() in app.js sees a working
// `window.Razorpay` and its whole real-payment flow (createRazorpayOrder ->
// Razorpay Checkout -> verifyRazorpayPayment) can be exercised through the
// real UI — the same way fake-supabase.js stands in for the real Supabase
// backend.
//
// By default `.open()` auto-completes as a successful payment shortly after
// being called (simulating the user finishing payment in the real popup),
// handing back a signature nobody checks here — this suite proves the UI
// wiring is correct, not the real HMAC verification, which is checked
// separately (see the "IMPORTANT" note in sql/004_razorpay_payments.sql and
// the type-check of supabase/functions/*.ts). Call
// window.__fakeRazorpayForceNextFailure() beforehand to make the NEXT
// .open() call fail instead (fires the 'payment.failed' handler), the same
// pattern window.__fakeSupabaseForceNextError() uses for the RPC-failure
// branch.
(function () {
  "use strict";
  let seq = 0;
  let forceNextFailure = false;
  window.__fakeRazorpayForceNextFailure = () => { forceNextFailure = true; };
  window.__lastRazorpayOptions = null; // exposed so tests can assert on what was passed (amount, description, prefill, ...)

  function FakeRazorpay(opts) {
    this.opts = opts;
    this._handlers = {};
    window.__lastRazorpayOptions = opts;
  }
  FakeRazorpay.prototype.on = function (event, cb) { this._handlers[event] = cb; };
  FakeRazorpay.prototype.open = function () {
    const opts = this.opts;
    const handlers = this._handlers;
    setTimeout(() => {
      if (forceNextFailure) {
        forceNextFailure = false;
        const cb = handlers["payment.failed"];
        if (cb) cb({ error: { description: "simulated failure" } });
        return;
      }
      opts.handler({
        razorpay_order_id: opts.order_id,
        razorpay_payment_id: "pay_fake_" + (++seq),
        razorpay_signature: "fakesig_" + opts.order_id,
      });
    }, 30);
  };

  window.Razorpay = FakeRazorpay;
})();
