/* kit.js - the results pages' two small behaviours (shell). Everything still reads without it.
   1. The sticky "Book my demo" bar ([data-dzr-sticky]) shows once the hero ([data-dzr-hero]) is off screen.
   2. Site cards (.dzr-site with a <video data-dzr-clip>) play their clip on hover or focus; the poster image shows otherwise.
      Clips load only on first hover (data-src -> src), never on phones' first paint. */
(function () {
  'use strict';
  var d = document;
  function boot() {
    var bar = d.querySelector('[data-dzr-sticky]');
    var hero = d.querySelector('[data-dzr-hero]');
    if (bar && 'IntersectionObserver' in window) {
      var watch = hero || d.querySelector('main h1');
      if (watch) {
        new IntersectionObserver(function (es) {
          es.forEach(function (e) { bar.classList.toggle('is-on', !e.isIntersecting && e.boundingClientRect.top < 0); });
        }).observe(watch);
      }
    }
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    Array.prototype.forEach.call(d.querySelectorAll('.dzr-site'), function (card) {
      var v = card.querySelector('video[data-dzr-clip]');
      if (!v || reduce) return;
      function play() {
        if (!v.getAttribute('src') && v.getAttribute('data-src')) v.setAttribute('src', v.getAttribute('data-src'));
        var p = v.play(); card.classList.add('is-playing');
        if (p && p.catch) p.catch(function () { card.classList.remove('is-playing'); });
      }
      function stop() { v.pause(); card.classList.remove('is-playing'); }
      card.addEventListener('mouseenter', play); card.addEventListener('mouseleave', stop);
      card.addEventListener('focusin', play); card.addEventListener('focusout', stop);
    });
  }
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', boot); else boot();
})();
