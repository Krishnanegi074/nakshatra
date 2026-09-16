// Nakshatra — shared site behavior

document.addEventListener('DOMContentLoaded', function () {
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
