/* ===================================================================
   Nakshatra — marketing pages language switcher (EN / HI)
   ===================================================================
   Loaded on all 10 static marketing pages (about.html, faq.html,
   how-it-works.html, kundli-matching.html, pricing.html, privacy.html,
   refund-policy.html, responsible-guidance.html, sample-report.html,
   terms.html), AFTER marketing-i18n.js (which defines window.NK_I18N)
   and AFTER main.js in each page's script order.

   This mirrors the app's own anonymous-visitor language handling
   (app/app.js's state.lang / app/i18n.js's tr()): browser-language is used
   ONLY to pick a sensible default, switching is in-memory for this page
   view, and nothing is persisted — these are unauthenticated static pages
   with no signed-in profile to persist a choice into (the app itself only
   persists a choice server-side for a SIGNED-IN user; see
   backend/sql/008_preferred_lang.sql). Reloading or navigating to another
   marketing page resets to the browser-detected default, same as the app's
   own pre-auth screens.

   Markup contract, per page:
     <div class="nk-lang-toggle-wrap">
       <button class="nk-lang-toggle" type="button" aria-label="Change language"
               aria-haspopup="true" aria-expanded="false">🌐</button>
       <div class="nk-lang-menu">
         <button type="button" data-lang="en">English</button>
         <button type="button" data-lang="hi">हिन्दी</button>
       </div>
     </div>
   ...one such block in .nk-nav-actions (desktop + mobile-visible), since the
   toggle is intentionally NOT hidden by the 900px .nk-nav-actions rule that
   hides Log In / Start Free — see style.css's .nk-lang-toggle-wrap comment.

   Text elements to translate carry either:
     data-i18n="some.key"        -> el.textContent = tr(key)
     data-i18n-html="some.key"   -> el.innerHTML = tr(key)   (copy with inline
                                     tags, e.g. an <em> or a mailto link)
   =================================================================== */
(function () {
  'use strict';

  function detectDefaultLang() {
    try {
      var langs = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language];
      for (var i = 0; i < langs.length; i++) {
        if (langs[i] && /^hi/i.test(langs[i])) return 'hi';
      }
    } catch (e) { /* navigator unavailable — fall through to English */ }
    return 'en';
  }

  var currentLang = detectDefaultLang();

  function dict(lang) {
    return (window.NK_I18N && window.NK_I18N[lang]) || {};
  }

  function tr(key) {
    var d = dict(currentLang);
    if (Object.prototype.hasOwnProperty.call(d, key)) return d[key];
    var en = dict('en');
    if (Object.prototype.hasOwnProperty.call(en, key)) return en[key];
    return key; // last resort — surfaces missing keys visibly instead of blanking text
  }

  function applyLang(lang) {
    currentLang = (lang === 'hi') ? 'hi' : 'en';
    document.documentElement.setAttribute('lang', currentLang === 'hi' ? 'hi' : 'en');

    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = tr(el.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-html]').forEach(function (el) {
      el.innerHTML = tr(el.getAttribute('data-i18n-html'));
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      el.setAttribute('placeholder', tr(el.getAttribute('data-i18n-placeholder')));
    });
    document.querySelectorAll('[data-i18n-aria]').forEach(function (el) {
      el.setAttribute('aria-label', tr(el.getAttribute('data-i18n-aria')));
    });

    document.querySelectorAll('.nk-lang-menu').forEach(function (menu) {
      menu.querySelectorAll('button[data-lang]').forEach(function (b) {
        var active = b.getAttribute('data-lang') === currentLang;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-current', active ? 'true' : 'false');
      });
    });
  }

  function closeAllMenus() {
    document.querySelectorAll('.nk-lang-menu.is-open').forEach(function (menu) {
      menu.classList.remove('is-open');
      var wrap = menu.closest('.nk-lang-toggle-wrap');
      var btn = wrap && wrap.querySelector('.nk-lang-toggle');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    });
  }

  function initToggles() {
    document.querySelectorAll('.nk-lang-toggle-wrap').forEach(function (wrap) {
      var btn = wrap.querySelector('.nk-lang-toggle');
      var menu = wrap.querySelector('.nk-lang-menu');
      if (!btn || !menu) return;

      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var willOpen = !menu.classList.contains('is-open');
        closeAllMenus();
        if (willOpen) {
          menu.classList.add('is-open');
          btn.setAttribute('aria-expanded', 'true');
        }
      });

      menu.querySelectorAll('button[data-lang]').forEach(function (b) {
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          applyLang(b.getAttribute('data-lang'));
          closeAllMenus();
        });
      });
    });

    document.addEventListener('click', closeAllMenus);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeAllMenus();
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    initToggles();
    applyLang(currentLang);
  });
})();
