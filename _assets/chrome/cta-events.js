/* =============================================================================
   cta-events.js - one GA4 event per lead click on the rankings pages (GOLIVE-04).

   Every "Book demo" button (an a.btn to /contact: the header rail, the drawer,
   the page body) and every /contact link inside a store page's "Is this your
   dispensary?" section sends

     gtag('event', 'book_demo_click', { page_type, region, cta_location, link_text })

   page_type and region come from the two <meta name="dz-..."> tags that the
   PRODUCTION head carries next to the owner's GA4 tag (site-src/chrome/
   analytics.html). The preview carries neither the tag nor the metas, so this
   file does nothing there: no gtag function, no hit.

   The click is never held up: the link navigates at once and gtag hands the
   event to GA4, which sends it with the browser's beacon transport. Capture
   phase, so a handler that stops propagation further down cannot hide a click.
   ES5, no dependencies.
   ============================================================================= */
(function () {
  'use strict';

  function meta(name) {
    var m = document.querySelector('meta[name="' + name + '"]');
    return m ? (m.getAttribute('content') || '') : '';
  }
  function up(el, test) {
    for (; el && el.nodeType === 1; el = el.parentNode) { if (test(el)) { return el; } }
    return null;
  }
  function toContact(a) {
    var h = a.getAttribute('href') || '';
    return h === '/contact' || h.indexOf('/contact?') === 0 || h === 'https://dispenza.com/contact';
  }
  function where(a) {
    if (up(a, function (n) { return /-yours$/.test(n.id || ''); })) { return 'is_this_your_dispensary'; }
    if (up(a, function (n) { return n.id === 'rail-shell'; })) { return 'header'; }
    if (up(a, function (n) { return n.id === 'mobile-drawer'; })) { return 'drawer'; }
    if (up(a, function (n) { return /\bsite-footer\b/.test(n.className || ''); })) { return 'footer'; }
    return 'page';
  }

  document.addEventListener('click', function (e) {
    if (typeof window.gtag !== 'function') { return; }
    var a = up(e.target, function (n) { return n.tagName === 'A' && n.hasAttribute('href'); });
    if (!a || !toContact(a)) { return; }
    var loc = where(a);
    /* the Book demo buttons and the claim section; the nav's plain "Contact" links are not a demo request */
    if (loc !== 'is_this_your_dispensary' && !/\bbtn\b/.test(a.className || '')) { return; }
    window.gtag('event', 'book_demo_click', {
      page_type: meta('dz-page-type'),
      region: meta('dz-region'),
      cta_location: loc,
      link_text: (a.textContent || '').replace(/\s+/g, ' ').replace(/^\s|\s$/g, '').slice(0, 100)
    });
  }, true);
}());
