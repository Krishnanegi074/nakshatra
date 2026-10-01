// Nakshatra — shared site behavior

// Same twinkling starfield as the app's landing screen (see app.js
// initStars()), so these marketing pages feel like the same site.
function nkInitStars() {
  var wrap = document.getElementById('stars-bg');
  if (!wrap) return;
  var n = 70;
  for (var i = 0; i < n; i++) {
    var s = document.createElement('div');
    s.className = 'nk-star';
    var size = (Math.random() * 2 + 1).toFixed(1);
    s.style.width = size + 'px';
    s.style.height = size + 'px';
    s.style.top = (Math.random() * 100).toFixed(2) + '%';
    s.style.left = (Math.random() * 100).toFixed(2) + '%';
    s.style.animationDelay = (Math.random() * 3).toFixed(2) + 's';
    wrap.appendChild(s);
  }
}

document.addEventListener('DOMContentLoaded', function () {
  nkInitStars();

  var toggle = document.querySelector('.nk-nav-toggle');
  var menu = document.querySelector('.nk-mobile-menu');

  if (toggle && menu) {
    toggle.addEventListener('click', function () {
      var isOpen = menu.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });

    // Close the mobile menu after a link is chosen
    menu.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', function () {
        menu.classList.remove('is-open');
        toggle.setAttribute('aria-expanded', 'false');
      });
    });
  }
});
