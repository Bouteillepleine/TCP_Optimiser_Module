/* Sliding active-tab indicator.
 *
 * Standalone classic script (NOT a module): loaded from index.html with a ?v=
 * cache-buster so it is always fresh, and it imports nothing — which keeps
 * router.js a single instance (a second copy would fork router_state).
 *
 * Why not a plain CSS transition: tapping a tab immediately runs loadPage(),
 * which fetches the page, imports its module and calls initX() — and those make
 * blocking ksu.exec calls that freeze the JS/main thread for a while (the same
 * reason spinners stop mid-test). A CSS transition started right before that
 * freeze gets its whole duration eaten while nothing can be painted, so the pill
 * appears to jump. Web Animations API transform animations run on the compositor,
 * so they keep playing through main-thread jank.
 */
(function () {
  var DURATION = 450;
  var EASING = 'cubic-bezier(.34, 1.56, .64, 1)';   // slight overshoot = bounce

  function init() {
    var nav = document.querySelector('.footer-nav');
    if (!nav) return;
    var pill = nav.querySelector('.nav-pill');
    var items = [].slice.call(nav.querySelectorAll('.nav-item'));
    if (!pill || !items.length) return;

    function activeIndex() {
      for (var i = 0; i < items.length; i++) {
        if (items[i].classList.contains('active')) return i;
      }
      return -1;
    }

    var current = activeIndex();
    if (current < 0) current = 0;
    pill.style.transform = 'translateX(' + (current * 100) + '%)';

    function place() {
      var idx = activeIndex();
      if (idx < 0 || idx === current) return;
      var from = 'translateX(' + (current * 100) + '%)';
      var to = 'translateX(' + (idx * 100) + '%)';
      current = idx;
      pill.style.transform = to;           // final state
      if (pill.animate) {
        pill.animate([{ transform: from }, { transform: to }],
                     { duration: DURATION, easing: EASING });
      }
    }

    var mo = new MutationObserver(place);
    for (var j = 0; j < items.length; j++) {
      mo.observe(items[j], { attributes: true, attributeFilter: ['class'] });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
