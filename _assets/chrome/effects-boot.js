/* =============================================================================
   effects-boot.js - the owner's decorative engines, started the way his live
   pages start them (UX-01).

   His live pages park smoke-engine, section-smoke-rise and hex-field as inert
   <script type="text/plain" data-sgen-defer> blocks and start them from his
   "rw-js-95-effects-deferred-boot (v4)" (saved live copy of /locations,
   site-src/chrome/live/locations.html). The same three tiers here, for our
   copies of his files, parked as <script type="text/plain" data-dz-defer
   src="..."> (a script of that type is neither fetched nor run):

     data-dz-eager-above="<px>"  loaded at once when the viewport is at least
                                 that wide (desktop has the headroom; his value
                                 for the smoke engine is 1024)
     data-dz-lazy="<selector>"   loaded when that element nears the viewport
                                 (rootMargin 200%, his value)
     (neither)                   loaded after load + idle

   One engine at a time, in page order, 120 ms apart (his GAP), so no two
   inits share a task and section-smoke-rise always runs after the
   smoke-engine it needs. The engines pause themselves off-screen
   (IntersectionObserver) and paint one still frame under
   prefers-reduced-motion. Without IntersectionObserver the lazy ones load
   after load + idle, as in his boot. A file that fails to load is skipped:
   the page stays readable, it only loses that atmosphere. ES5.
   ============================================================================= */
(function () {
  'use strict';

  var SEL = 'script[type="text/plain"][data-dz-defer]';
  var GAP = 120;
  var queue = [];
  var busy = false;

  function pump() {
    if (busy) { return; }
    var node = queue.shift();
    if (!node) { return; }
    if (!node.parentNode) { pump(); return; }
    busy = true;
    var s = document.createElement('script');
    var done = function () { busy = false; setTimeout(pump, GAP); };
    s.onload = done;
    s.onerror = done;
    s.src = node.getAttribute('src');
    node.parentNode.insertBefore(s, node);
    node.parentNode.removeChild(node);
  }
  function enqueue(node) {
    if (node.getAttribute('data-dz-queued')) { return; }
    node.setAttribute('data-dz-queued', '1');
    queue.push(node);
    pump();
  }

  /* tier 1: wide viewports, now */
  var parked = document.querySelectorAll(SEL);
  for (var i = 0; i < parked.length; i++) {
    var min = parseInt(parked[i].getAttribute('data-dz-eager-above'), 10);
    if (!isNaN(min) && window.innerWidth >= min) { enqueue(parked[i]); }
  }

  /* tier 2: when the host nears the viewport */
  function whenNear(node, selector, later) {
    var host = null;
    try { host = document.querySelector(selector); } catch (e) { host = null; }
    if (!host || typeof IntersectionObserver !== 'function') { later.push(node); return; }
    var io = new IntersectionObserver(function (entries) {
      for (var k = 0; k < entries.length; k++) {
        if (entries[k].isIntersecting) { io.disconnect(); enqueue(node); return; }
      }
    }, { rootMargin: '200% 0px' });
    io.observe(host);
  }

  /* tier 3: after load + idle */
  function boot() {
    var rest = document.querySelectorAll(SEL);
    var later = [];
    for (var j = 0; j < rest.length; j++) {
      if (rest[j].getAttribute('data-dz-queued')) { continue; }
      var lazy = rest[j].getAttribute('data-dz-lazy');
      if (lazy) { whenNear(rest[j], lazy, later); } else { later.push(rest[j]); }
    }
    for (var k = 0; k < later.length; k++) { enqueue(later[k]); }
  }
  function kick() {
    (window.requestIdleCallback || function (f) { return setTimeout(f, 200); })(boot, { timeout: 3000 });
  }
  if (document.readyState === 'complete') { kick(); }
  else { window.addEventListener('load', kick); }
}());
