

 document.addEventListener('DOMContentLoaded', function () {
  var header = document.querySelector('header');
  var toggle = document.querySelector('.menu_toggle');
  var nav = document.getElementById('primary-nav');
  if (!header || !toggle || !nav) return;

  var mq = window.matchMedia('(max-width: 1040px)');

  function isOpen() { return header.classList.contains('nav-open'); }

  function openMenu() {
    header.classList.add('nav-open');
    toggle.classList.add('is-open');
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-label', 'Close menu');
    document.body.classList.add('no-scroll');
  }

  function closeMenu() {
    header.classList.remove('nav-open');
    toggle.classList.remove('is-open');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Open menu');
    document.body.classList.remove('no-scroll');
  }

  toggle.addEventListener('click', function () {
    if (!mq.matches) return; // only active on mobile
    isOpen() ? closeMenu() : openMenu();
  });

  nav.addEventListener('click', function (e) {
    if (!mq.matches) return;
    var t = e.target;
    if (t && t.closest('a')) closeMenu();
  });

  document.addEventListener('keydown', function (e) {
    if (!mq.matches) return;
    if (e.key === 'Escape' && isOpen()) closeMenu();
  });

  function handleResize() {
    if (!mq.matches) {
      // ensure clean state on desktop
      closeMenu();
    }
  }

  if (mq.addEventListener) mq.addEventListener('change', handleResize);
  else mq.onchange = handleResize;
  window.addEventListener('resize', handleResize);
});
