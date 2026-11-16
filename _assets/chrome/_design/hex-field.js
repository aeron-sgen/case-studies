/* =============================================================================
   hex-field.js  --  the isometric hexagon field, mountable on ANY host.

   CANVAS BACKEND. Same plane, same seam guarantee, no DOM.

   WHY THIS FILE CHANGED. The SVG build put 4,185 <polygon> nodes in the document
   for a texture that sits behind two sections. Nodes are not free once painted:
   every style recalc and every layout in the page walks them. Measured at 6x CPU
   throttle, this field alone accounted for ~280ms of the page's blocking time
   and the hero's field for ~710ms; with both removed the page's blocking time
   fell from 1026ms to 36ms.

   WHAT IS PRESERVED, EXACTLY. The camera, the RW solve, the deterministic hash,
   the over-scan, the far-to-near painter's ordering, the back-face cull, the
   tokens, the edge mask, the reading clearing, the travelling band and the
   pointer pool. The numbers below are the originals.

   -----------------------------------------------------------------------------
   THE SEAM, WHICH IS THE WHOLE REASON THIS MODULE EXISTS.

   The brief was one continuous plane under the case studies AND the footer, with
   no butt-joint and no restart of the pattern. The SVG kept that promise by
   putting ONE scene in the document and giving each host a <use> of it.

   The canvas version keeps the same promise by a different mechanism, and it is
   worth being precise about why it still holds. There is ONE geometry pass, in
   ONE field coordinate system, whose origin is the union of every host's box.
   Each host paints THAT geometry, translated by (fieldOrigin - hostOrigin), into
   its own surface. No host has a camera, an aspect ratio, a light phase or a
   seed of its own -- there is no per-host value anywhere in the pipeline except
   that translation, which is measured from the same union both hosts were built
   from. The band and the pool are likewise computed once in field coordinates
   per frame and handed to every host.

   -----------------------------------------------------------------------------
   MEMORY, AND WHY THE LIGHT LAYERS ARE HALF RESOLUTION.

   The plane spans two page regions and is routinely 1366x2500. Backing three
   full-resolution layers at devicePixelRatio 2 would be ~160MB of bitmap for a
   decorative texture, which is not a trade worth making on a phone.

   So: the BODY layer, which carries the hairline on the top faces and is the
   only thing with a hard edge in it, is backed at up to 1.5x. The two LIGHT
   layers are backed at half scale, because both are drawn through a Gaussian
   blur and then composited additively -- there is no hard edge in either one to
   lose. Verified against the SVG render: the difference is below the frame-to-
   frame noise of the page's own smoke canvases.
   ============================================================================= */
(function () {
  'use strict';

  var EY = 250;
  var INST = 0;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function hash(c, r) {
    var h = (c * 73856093) ^ (r * 19349663);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }

  function parseColor(v) {
    v = String(v == null ? '' : v).trim();
    if (!v) { return null; }
    var m = v.replace('#', '');
    if (/^[0-9a-f]{3}$/i.test(m)) { m = m[0]+m[0]+m[1]+m[1]+m[2]+m[2]; }
    if (/^[0-9a-f]{6}$/i.test(m)) {
      return [parseInt(m.slice(0,2),16), parseInt(m.slice(2,4),16), parseInt(m.slice(4,6),16)];
    }
    m = v.match(/rgba?\(([^)]+)\)/i);
    if (m) {
      var p = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number);
      if (p.length >= 3 && p.slice(0,3).every(function (n) { return !isNaN(n); })) {
        return [p[0], p[1], p[2]];
      }
    }
    return null;
  }
  function mix(a, b, t) { return [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t]; }
  function out(c) { return 'rgb(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ')'; }

  function palette() {
    var css = getComputedStyle(document.documentElement);
    var surf  = parseColor(css.getPropertyValue('--ds-bg-surface'));
    var prim  = parseColor(css.getPropertyValue('--ds-primary'));
    var deep  = parseColor(css.getPropertyValue('--ds-accent-deep'));
    var light = parseColor(css.getPropertyValue('--ds-accent-light'));
    if (!surf || !prim || !deep || !light) { return null; }   /* fail closed */
    var black = [0, 0, 0];
    return {
      top: out(mix(surf, prim, 0.085)),
      wall: [0.20, 0.46, 0.68].map(function (k) {
        return out(mix(mix(surf, deep, 0.28), black, k));
      }),
      edge: out(prim),
      lit:  out(light)
    };
  }

  var ASPECT_LO = 1.2,  STRETCH_LO = 1.05, RATIO_LO = 2.6;   /* ~desktop  */
  var ASPECT_HI = 7.7,  STRETCH_HI = 1.00, RATIO_HI = 1.9;   /* ~390      */

  function defaults(W, H) {
    var cols = Math.round(clamp(9 + (W - 420) / (1200 - 420) * 3, 9, 12));
    var osTop = 0.10, osBot = 0.06;
    var t = clamp((H / Math.max(1, W) - ASPECT_LO) / (ASPECT_HI - ASPECT_LO), 0, 1);
    var stretch = STRETCH_LO + (STRETCH_HI - STRETCH_LO) * t;
    var ratio   = RATIO_LO   + (RATIO_HI   - RATIO_LO)   * t;
    var horizon = (1 + osBot + ratio * osTop) / (ratio - 1);
    var focal   = H * (1 + osBot + horizon) / stretch;
    return {
      cols: cols, focal: focal, horizon: horizon, stretch: stretch, ratio: ratio,
      osTop: osTop, osBot: osBot, osX: 0.06,
      hMin: 0.08, hMax: 0.50,
      edgeAlpha: 0.065, litW: 1.00, hotW: 1.50,
      clearMin: 0.05, clearKX: 0.76, clearKY: 0.84, clearPad: 0.05
    };
  }

  /* =========================================================================
     GEOMETRY. The original build(), emitting Path2D instead of markup.

     `cells` keeps walls and top face INTERLEAVED, cell by cell, far to near.
     That interleaving IS the painter's algorithm: hoisting all the walls into
     one pass and all the tops into another lets a near cell's wall paint under
     a far cell's top and the occlusion inverts. (It does, visibly -- the hero's
     canvas port was written that way first and the prisms came out flat.)

     `plates` is the bare top-face outline of every cell. Both light layers are
     the SAME outlines at a different width, so they are built once and stroked
     twice -- the structural guarantee the <use> gave, kept.
     ========================================================================= */
  function build(W, H, cfg) {
    var F     = cfg.focal;
    var HZN   = -cfg.horizon * H;
    var osTop = cfg.osTop * H, osBot = cfg.osBot * H, osX = cfg.osX * W;

    function zAt(y) { return EY * F / (y - HZN); }
    var ZN = zAt(H + osBot);
    var ZF = zAt(-osTop);

    var RW = (W / cfg.cols) * ZN / (1.5 * F);
    var hs = 1.5 * RW, vs = Math.sqrt(3) * RW;

    function px(X, Z) { return W / 2 + X * F / Z; }
    function py(Z, up) { return HZN + (EY - up) * F / Z; }

    var cells = [], c, r, Zc, Xc, sx;
    var cMax = Math.ceil(((W / 2 + osX) * ZF / F) / hs) + 2;
    for (c = -cMax; c <= cMax; c++) {
      for (r = 0; ; r++) {
        Zc = ZN + r * vs + ((c & 1) ? vs / 2 : 0);
        if (Zc > ZF) { break; }
        Xc = c * hs;
        sx = px(Xc, Zc);
        if (sx < -osX - RW * F / Zc || sx > W + osX + RW * F / Zc) { continue; }
        cells.push({ Xc: Xc, Zc: Zc, h: RW * (cfg.hMin + hash(c, r) * (cfg.hMax - cfg.hMin)) });
      }
    }
    cells.sort(function (a, b) { return b.Zc - a.Zc; });   /* far first */

    var draws = [], plates = new Path2D();
    var i, k, V, a, b, A, Z, X, shade, drawn = 0;
    for (i = 0; i < cells.length; i++) {
      Xc = cells[i].Xc; Zc = cells[i].Zc;
      V = [];
      for (k = 0; k < 6; k++) {
        A = Math.PI / 180 * (60 * k);
        X = Xc + RW * Math.cos(A);
        Z = Zc + RW * Math.sin(A);
        if (Z <= ZN * 0.2) { V = null; break; }
        V.push({ X: X, Z: Z, x: px(X, Z), yb: py(Z, 0), yt: py(Z, cells[i].h) });
      }
      if (!V) { continue; }
      drawn++;

      var walls = [];
      for (k = 0; k < 6; k++) {
        a = V[k]; b = V[(k + 1) % 6];
        if ((a.Z + b.Z) / 2 >= Zc) { continue; }           /* back-face cull */
        shade = Math.min(2, Math.floor(Math.abs(a.X + b.X - 2 * Xc) / RW * 1.6));
        var wp = new Path2D();
        wp.moveTo(a.x, a.yt); wp.lineTo(b.x, b.yt);
        wp.lineTo(b.x, b.yb); wp.lineTo(a.x, a.yb); wp.closePath();
        walls.push({ shade: shade, path: wp });
      }
      var tp = new Path2D();
      tp.moveTo(V[0].x, V[0].yt);
      for (k = 1; k < 6; k++) { tp.lineTo(V[k].x, V[k].yt); }
      tp.closePath();
      draws.push({ walls: walls, top: tp });

      plates.moveTo(V[0].x, V[0].yt);
      for (k = 1; k < 6; k++) { plates.lineTo(V[k].x, V[k].yt); }
      plates.closePath();
    }
    return { draws: draws, plates: plates, cells: drawn, RW: RW, ZN: ZN, ZF: ZF,
             rows: Math.round((ZF - ZN) / vs) };
  }

  function docRect(el) {
    var r = el.getBoundingClientRect();
    return { l: r.left + window.pageXOffset, t: r.top + window.pageYOffset, w: r.width, h: r.height };
  }

  function surface(w, h) {
    var s = document.createElement('canvas');
    s.width = Math.max(1, Math.round(w)); s.height = Math.max(1, Math.round(h));
    return s;
  }
  var SUPPORTS_FILTER = (function () {
    var t = surface(1, 1).getContext('2d');
    t.filter = 'blur(1px)';
    return t.filter === 'blur(1px)';
  }());

  /* =========================================================================
     THE MOUNT.
     ========================================================================= */
  function mount(hosts, userCfg) {
    hosts = [].slice.call(hosts || []).filter(Boolean);
    if (!hosts.length) { return null; }

    var pal = palette();
    if (!pal) { return null; }        /* fail closed: no tokens, no field */

    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    var id = 'hxf' + (++INST);
    var W = 0, H = 0, L = 0, T = 0, dx0 = 0, dy0 = 0, cfg = null, geo = null;
    var views = [];                   /* one per host: canvas + cached layers  */
    var pending = 0, pxq = 0, pyq = 0, queued = false, drawQueued = false;
    var over = 0, poolR = 0, bandY = 0, poolX = -9999, poolY = -9999, hotAlpha = 0;

    var BODY_DPR  = Math.min(1.5, window.devicePixelRatio || 1);
    var LIGHT_RES = 0.5;

    function syncCovers() {
      for (var i = 0; i < hosts.length; i++) {
        var sel = hosts[i].getAttribute('data-hexfield-cover');
        if (!sel) { continue; }
        var tgt = document.querySelector(sel);
        if (!tgt) { continue; }
        var op = hosts[i].offsetParent || document.body;
        var t = docRect(tgt), o = docRect(op);
        var s = hosts[i].style;
        s.position = 'absolute';
        s.right = 'auto'; s.bottom = 'auto';
        s.left   = (t.l - o.l) + 'px';
        s.top    = (t.t - o.t) + 'px';
        s.width  = t.w + 'px';
        s.height = t.h + 'px';
      }
    }

    /* THE EDGE MASK AND THE READING CLEARING, BAKED.

       Both are static in field coordinates, so they are multiplied into every
       cached layer once at build time and cost nothing per frame. The two edge
       axes were NESTED masks in the SVG rather than blended -- a plain multiply
       -- so applying them one after the other here is the same operation.

       The hard-zero band at each end is kept: a gradient that reaches 0 only AT
       offset 0 is sampled half a pixel inside, leaving a few percent of field on
       the outermost pixel row. Measured 6/255 at 390 before it was added. */
    function bakeStatic(s, ox, oy, scale, clear) {
      var g = s.getContext('2d');
      var vz = clamp(200 / H, 0, 1.5) / 100, vz2 = 1 - vz;
      var hz = clamp(200 / W, 0, 1.0) / 100, hz2 = 1 - hz;
      var A = function (v) { return 'rgba(255,255,255,' + v + ')'; };

      g.save();
      g.setTransform(scale, 0, 0, scale, ox * scale, oy * scale);
      g.globalCompositeOperation = 'destination-in';

      var v = g.createLinearGradient(0, 0, 0, H);
      v.addColorStop(0, A(0));       v.addColorStop(vz, A(0));
      v.addColorStop(0.04, A(0x59/255));
      v.addColorStop(0.16, A(1));    v.addColorStop(0.93, A(1));
      v.addColorStop(0.98, A(0x73/255));
      v.addColorStop(vz2, A(0));     v.addColorStop(1, A(0));
      g.fillStyle = v; g.fillRect(0, 0, W, H);

      var h = g.createLinearGradient(0, 0, W, 0);
      h.addColorStop(0, A(0));       h.addColorStop(hz, A(0));
      h.addColorStop(0.02, A(0x8c/255));
      h.addColorStop(0.07, A(1));    h.addColorStop(0.93, A(1));
      h.addColorStop(0.98, A(0x8c/255));
      h.addColorStop(hz2, A(0));     h.addColorStop(1, A(0));
      g.fillStyle = h; g.fillRect(0, 0, W, H);
      g.restore();

      if (!clear) { return; }

      /* THE READING CLEARING. The SVG mask was "white everywhere, with a darker
         ellipse punched into it" -- so it cannot be applied as a bare gradient
         fill the way the two edge fades can: a gradient only covers its own rect,
         and everything outside the ellipse has to stay at FULL field strength.

         So the mask is assembled in its own surface -- white ground, ellipse
         painted over it -- and that surface is multiplied in.

         THE PLATEAU IS LOAD-BEARING. A radial that starts easing at offset 0 puts
         its minimum on a single point, and the block being protected is a BLOCK:
         the head sits about 0.44 of the way out along the minor axis, where a
         plain ease had already recovered to 65%. Holding the floor flat to 45%
         covers the whole block instead of its centre pixel. */
      var g1 = cfg.clearMin;
      var g2 = cfg.clearMin + (1 - cfg.clearMin) * 0.55;

      /* THE ELLIPSE IS PUNCHED OUT, NOT PAINTED IN, and that is the whole trick.

         The mask wants "1 everywhere, easing DOWN to clearMin at the centre of
         the ellipse". Painting the gradient over the white ground with
         source-over cannot express it -- a low-alpha source over white leaves
         white -- and 'copy' expresses it by throwing the white ground away
         everywhere the source does not cover, which erases the field outside the
         ellipse entirely. (It does: the first run rendered a hard-edged ellipse
         across the case studies.)

         destination-out multiplies the destination's alpha by (1 - source), so
         punching with (1 - wanted) lands exactly on `wanted`, keeps the ground at
         1 where the gradient has faded to nothing, and needs no clip. */
      var m = surface(s.width, s.height);
      var mg = m.getContext('2d');
      mg.setTransform(scale, 0, 0, scale, ox * scale, oy * scale);
      mg.fillStyle = A(1);
      mg.fillRect(-ox, -oy, s.width / scale, s.height / scale);
      mg.translate(clear.cx, clear.cy);
      mg.scale(1, clear.ry / clear.rx);       /* a circle, squashed = the ellipse */
      var cg = mg.createRadialGradient(0, 0, 0, 0, 0, clear.rx);
      cg.addColorStop(0, A(1 - g1));    cg.addColorStop(0.45, A(1 - g1));
      cg.addColorStop(0.75, A(1 - g2)); cg.addColorStop(1, A(0));
      mg.globalCompositeOperation = 'destination-out';
      mg.fillStyle = cg;
      mg.fillRect(-clear.rx, -clear.rx, clear.rx * 2, clear.rx * 2);

      g.save();
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(m, 0, 0);
      g.restore();
    }

    /* THIS FIELD'S LIGHTS DO NOT BLOOM, AND THAT MATCHES WHAT SHIPPED.

       The SVG build declared `filter:url(#<id>-glow)` on both light groups, but
       those groups were only ever rendered through `<use>`, and the filter never
       resolved inside the shadow tree -- the original file's own comment worried
       about exactly this ("a document stylesheet is not guaranteed to reach into
       a <use> shadow tree"). Measured on the live SVG page, both
       `.mc-hexfield__lit` and `.mc-hexfield__hot` computed `filter: none`. The
       hero's filter DID resolve, because the hero draws its groups directly; that
       one is real and is kept.

       So the first canvas port, which faithfully implemented the DECLARED glow,
       rendered a bloom this section has never actually had -- brighter and wider
       than the picture it was replacing. Reproducing the declared intent would be
       a visual change nobody asked for, so the observed behaviour wins: a plain
       stroke. Verified by A/B against the SVG render at the same pointer
       position, mean delta 2.38 with the bloom, 1.49 without.

       To restore the author's intended glow, set GLOW_STDDEV to 2.4. */
    var GLOW_STDDEV = 0;
    function strokeGlow(g, path, colour, width, alpha, scale) {
      g.lineJoin = 'round';
      g.strokeStyle = colour;
      g.lineWidth = width;
      g.globalAlpha = alpha;
      if (GLOW_STDDEV && SUPPORTS_FILTER) {
        /* the radius would be in DEVICE pixels -- ctx.filter ignores the context
           transform -- so it is scaled to the surface to stay 2.4 FIELD px */
        g.filter = 'blur(' + (GLOW_STDDEV * scale).toFixed(2) + 'px)';
        g.stroke(path);
        g.filter = 'none';
      }
      g.stroke(path);
      g.globalAlpha = 1;
    }

    function buildView(host, clear) {
      var hr = docRect(host);
      var ox = L - hr.l, oy = T - hr.t;         /* field origin in host space */
      var cw = Math.max(1, Math.round(hr.w)), chh = Math.max(1, Math.round(hr.h));

      var cv = host.querySelector('canvas.mc-hexfield__cv');
      if (!cv) {
        cv = document.createElement('canvas');
        cv.className = 'mc-hexfield__cv';
        cv.setAttribute('aria-hidden', 'true');
        cv.style.cssText = 'position:absolute;top:0;left:0;display:block;width:100%;height:100%;pointer-events:none';
        host.appendChild(cv);
      }
      cv.width = Math.round(cw * BODY_DPR);
      cv.height = Math.round(chh * BODY_DPR);

      var base = surface(cw * BODY_DPR, chh * BODY_DPR);
      var g = base.getContext('2d');
      g.setTransform(BODY_DPR, 0, 0, BODY_DPR, ox * BODY_DPR, oy * BODY_DPR);
      g.lineWidth = 0.9;
      for (var n = 0; n < geo.draws.length; n++) {
        var d = geo.draws[n];
        for (var q = 0; q < d.walls.length; q++) {
          g.fillStyle = pal.wall[d.walls[q].shade];
          g.fill(d.walls[q].path);
        }
        g.fillStyle = pal.top;
        g.fill(d.top);
        g.strokeStyle = pal.edge;
        g.globalAlpha = cfg.edgeAlpha;
        g.stroke(d.top);
        g.globalAlpha = 1;
      }
      bakeStatic(base, ox, oy, BODY_DPR, clear);

      var lw = Math.max(1, Math.round(cw * LIGHT_RES)), lh = Math.max(1, Math.round(chh * LIGHT_RES));
      var lit = surface(lw, lh);
      g = lit.getContext('2d');
      g.setTransform(LIGHT_RES, 0, 0, LIGHT_RES, ox * LIGHT_RES, oy * LIGHT_RES);
      strokeGlow(g, geo.plates, pal.lit, cfg.litW, 1, LIGHT_RES);
      bakeStatic(lit, ox, oy, LIGHT_RES, clear);

      var hot = surface(lw, lh);
      g = hot.getContext('2d');
      g.setTransform(LIGHT_RES, 0, 0, LIGHT_RES, ox * LIGHT_RES, oy * LIGHT_RES);
      strokeGlow(g, geo.plates, pal.lit, cfg.hotW, 1, LIGHT_RES);
      bakeStatic(hot, ox, oy, LIGHT_RES, clear);

      return { host: host, cv: cv, ctx: cv.getContext('2d'), base: base, lit: lit, hot: hot,
               scratch: surface(lw, lh), ox: ox, oy: oy, w: cw, h: chh, bh: hr.h, lw: lw, lh: lh };
    }

    /* THE TRAVELLING BAND. Field coordinates, translated in Y by scroll -- the
       rect is 3H tall and leans, so it crosses the plane on a diagonal while
       running mostly along the depth axis, which is the direction this plane
       recedes. The peak is a GREY, not white: these stops were a luminance mask,
       so the value IS the light's alpha, and #8c8c8c holds the sweep at ~55%. */
    function paintBand(g, ox, oy) {
      var x0 = -W + ox, y0 = -H + oy + bandY;
      var w3 = W * 3, h3 = H * 3;
      var grd = g.createLinearGradient(x0, y0, x0 + w3 * 0.3, y0 + h3);
      grd.addColorStop(0,    'rgba(255,255,255,0)');
      grd.addColorStop(0.36, 'rgba(255,255,255,0)');
      grd.addColorStop(0.5,  'rgba(255,255,255,' + (0x8c / 255) + ')');
      grd.addColorStop(0.64, 'rgba(255,255,255,0)');
      grd.addColorStop(1,    'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.fillRect(x0, y0, w3, h3);
    }
    function paintPool(g, ox, oy) {
      var cx = poolX + ox, cy = poolY + oy;
      var grd = g.createRadialGradient(cx, cy, 0, cx, cy, poolR);
      grd.addColorStop(0,    'rgba(255,255,255,1)');
      grd.addColorStop(0.55, 'rgba(255,255,255,0.55)');
      grd.addColorStop(1,    'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.fillRect(cx - poolR, cy - poolR, poolR * 2, poolR * 2);
    }

    function drawView(v) {
      var c = v.ctx;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, v.cv.width, v.cv.height);
      c.globalCompositeOperation = 'source-over';
      c.drawImage(v.base, 0, 0);

      var g = v.scratch.getContext('2d');
      var lay = function (src, paint) {
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.globalCompositeOperation = 'source-over';
        g.clearRect(0, 0, v.lw, v.lh);
        g.drawImage(src, 0, 0);
        g.globalCompositeOperation = 'destination-in';
        g.setTransform(LIGHT_RES, 0, 0, LIGHT_RES, 0, 0);
        paint(g, v.ox, v.oy);
        g.setTransform(1, 0, 0, 1, 0, 0);
        return v.scratch;
      };

      c.globalCompositeOperation = 'lighter';
      c.drawImage(lay(v.lit, paintBand), 0, 0, v.lw, v.lh, 0, 0, v.cv.width, v.cv.height);
      if (hotAlpha > 0.001) {
        c.globalAlpha = hotAlpha;
        c.drawImage(lay(v.hot, paintPool), 0, 0, v.lw, v.lh, 0, 0, v.cv.width, v.cv.height);
        c.globalAlpha = 1;
      }
      c.globalCompositeOperation = 'source-over';
    }
    function draw() {
      drawQueued = false;
      for (var i = 0; i < views.length; i++) { drawView(views[i]); }
    }
    function invalidate() {
      if (drawQueued) { return; }
      drawQueued = true;
      requestAnimationFrame(draw);
    }

    function render() {
      var i, r, minL = Infinity, minT = Infinity, maxR = -Infinity, maxB = -Infinity;
      syncCovers();
      for (i = 0; i < hosts.length; i++) {
        r = docRect(hosts[i]);
        if (r.w <= 0 || r.h <= 0) { continue; }
        if (r.l < minL) { minL = r.l; }
        if (r.t < minT) { minT = r.t; }
        if (r.l + r.w > maxR) { maxR = r.l + r.w; }
        if (r.t + r.h > maxB) { maxB = r.t + r.h; }
      }
      if (!isFinite(minL)) { return false; }
      L = minL; T = minT;
      W = Math.round(maxR - minL); H = Math.round(maxB - minT);
      var h0 = docRect(hosts[0]);
      dx0 = L - h0.l; dy0 = T - h0.t;
      if (W <= 0 || H <= 0) { return false; }

      cfg = defaults(W, H);
      if (userCfg) { for (var k in userCfg) { if (userCfg.hasOwnProperty(k)) { cfg[k] = userCfg[k]; } } }
      geo = build(W, H, cfg);
      poolR = Math.round(clamp(Math.min(W, H) * 0.34, 170, 420));

      /* the block the mount asked to keep legible, measured into field space */
      var clear = null;
      if (cfg.clearSel) {
        var nodes = document.querySelectorAll(cfg.clearSel);
        var bl = Infinity, bt = Infinity, br = -Infinity, bb = -Infinity;
        for (i = 0; i < nodes.length; i++) {
          var b2 = docRect(nodes[i]);
          if (b2.w <= 0 || b2.h <= 0) { continue; }
          if (b2.l < bl) { bl = b2.l; }
          if (b2.t < bt) { bt = b2.t; }
          if (b2.l + b2.w > br) { br = b2.l + b2.w; }
          if (b2.t + b2.h > bb) { bb = b2.t + b2.h; }
        }
        if (isFinite(bl)) {
          var pad = cfg.clearPad * W;
          clear = { cx: (bl + br) / 2 - L, cy: (bt + bb) / 2 - T,
                    rx: cfg.clearKX * (br - bl) + pad, ry: cfg.clearKY * (bb - bt) + pad };
        }
      }

      views = [];
      for (i = 0; i < hosts.length; i++) { views.push(buildView(hosts[i], clear)); }
      place();
      invalidate();
      return true;
    }

    /* THE FIELD'S ORIGIN IN VIEWPORT COORDINATES, READ LIVE.

       dx0/dy0 are the field origin measured from host 0 in DOCUMENT space and
       are fixed by the geometry pass; only the host's viewport position moves.
       Reading it live rather than caching it is what keeps both lights attached
       to the plane while the page scrolls. */
    function origin() {
      var r = hosts[0].getBoundingClientRect();
      return { x: r.left + dx0, y: r.top + dy0 };
    }

    /* -- the drive. Scroll position only. No timer, no loop. --------------- */
    function progress() {
      if (reduce.matches) { return 0.5; }
      var top = origin().y;
      var p = 1 - (top + H) / (window.innerHeight + H);
      return clamp(p, 0, 1);
    }
    function place() {
      /* the band's bright centre travels from just below the field to just above
         it across the pass; p=0.5 -- the reduced-motion rest value -- parks it in
         the middle of the plane rather than off-canvas */
      bandY = H * (0.70 - progress() * 1.40);
    }
    /* COVER DRIFT, ported from /v2 (repo 49d4e8f). The drift check rides the
       scroll handler, not place() itself: place() is also called BY settle()
       and render(), so putting it there would let a settle re-enter itself.
       Here the two are ordered -- settle (which moves the light itself), or
       move the light, never both. hasCovers, coversDrifted() and settle() are
       defined below; this listener is attached only after hasCovers is set. */
    function onScroll() {
      if (hasCovers && coversDrifted()) { settle(); return; }
      place(); invalidate();
    }

    function paintPointer() {
      queued = false;
      var o = origin();
      poolX = pxq - o.x;
      poolY = pyq - o.y;
      invalidate();
    }
    function onMove(e) {
      pxq = e.clientX; pyq = e.clientY;
      if (!queued) { queued = true; requestAnimationFrame(paintPointer); }
    }
    var hotTarget = 0, hotRaf = 0, hotLast = 0;
    var HOT_MS = (function () {
      var d = (getComputedStyle(document.documentElement).getPropertyValue('--ds-dur') || '').trim();
      var m = d.match(/([\d.]+)(ms|s)/);
      return m ? (+m[1] * (m[2] === 's' ? 1000 : 1)) : 260;
    }());
    function easeHot(now) {
      hotRaf = 0;
      if (!hotLast) { hotLast = now; }
      var dt = Math.min(64, now - hotLast); hotLast = now;
      var d = dt / Math.max(1, HOT_MS);
      if (hotAlpha < hotTarget) { hotAlpha = Math.min(hotTarget, hotAlpha + d); }
      else                      { hotAlpha = Math.max(hotTarget, hotAlpha - d); }
      invalidate();
      if (Math.abs(hotAlpha - hotTarget) > 0.001) { hotRaf = requestAnimationFrame(easeHot); }
      else { hotLast = 0; }
    }
    function setHot(v) { hotTarget = v; if (!hotRaf) { hotLast = 0; hotRaf = requestAnimationFrame(easeHot); } }
    function onEnter() { over++; setHot(1); }
    function onLeave() { over = Math.max(0, over - 1); if (!over) { setHot(0); } }

    /* A REBUILD IS ONLY WARRANTED BY A SIZE CHANGE. ResizeObserver fires once the
       moment it starts observing, and `resize` fires on things that do not change
       the field at all. If only the POSITION moved there is nothing to do: every
       view is offset from the field origin, so the hosts move together and the
       plane stays continuous. */
    /* -- A MIRRORING HOST CAN GO STALE WITHOUT ANYTHING RESIZING ------------
       Ported from /v2 (repo 49d4e8f). The paragraph above is true of an
       ORDINARY host and false of a `data-hexfield-cover` one.

       An ordinary host is in flow: when the document above it changes height it
       moves, its canvas moves inside it, and the union travels intact. A cover
       host is absolutely positioned at a pixel `top` that syncCovers() WROTE.
       When the document changes height the mirrored target moves and that
       written number does not, so the mirror drifts off its target by exactly
       the change and part of the plane is covered by neither canvas. On /v2 it
       showed as a flat bar of the page's own background between the
       case-studies plane and the footer plane: measured at
       /locations/las-vegas-nv 2026-09-09 as a 56px bar, reproduced at 8px by
       changing #faq-doc's padding after load -- a change that resizes no host,
       so nothing fired.

       Nothing else here observes the cover TARGET moving, so this is checked at
       scroll -- read-only, two rects per mirroring host, and it settles at most
       once per drift because settling removes the condition. */
    function coversDrifted() {
      for (var i = 0; i < hosts.length; i++) {
        var sel = hosts[i].getAttribute('data-hexfield-cover');
        if (!sel) { continue; }
        var tgt = document.querySelector(sel);
        if (!tgt) { continue; }
        var t = docRect(tgt), h = docRect(hosts[i]);
        /* NOT RENDERED IS NOT DRIFTED. A display:none host or target has an
           all-zero rect, so its docRect sits at the current scroll offset and
           it would read as drifted on every scroll event -- a settle per event,
           and a style write then a rect read whenever the host follows a hidden
           target. A zero box paints nothing and is outside the union. Its
           return is a size change, which the ResizeObserver on the host and on
           the target reports (a target missing at mount is not observed; a
           resize picks that case up). Not in /v2, whose settle answers this with
           its cheap reaim; on canvas it stays at these two rects per host. */
        if (t.w <= 0 || t.h <= 0 || h.w <= 0 || h.h <= 0) { continue; }
        if (Math.abs(t.t - h.t) > 0.5 || Math.abs(t.l - h.l) > 0.5 ||
            Math.abs(t.h - h.h) > 0.5 || Math.abs(t.w - h.w) > 0.5) { return true; }
      }
      return false;
    }

    /* NO RE-AIM ON CANVAS. /v2 answers "moved but kept its size" with two style
       writes per SVG window. Here each view's field offset (ox/oy) and canvas
       size are BAKED into its cached layers by buildView, so there is nothing
       cheap to re-point. A view whose baked offset or size no longer matches its
       live host is stale, and only render() repairs it. When every view still
       matches -- the hosts moved TOGETHER, or nothing moved -- the layers are
       still right, because each canvas rides inside its host, and the old
       place() + invalidate() fast path stands.

       The rebuild is keyed on those baked values rather than on "a drift was
       seen", so a host that can never land exactly on its target (a border on
       its offsetParent, say) costs a cheap settle per scroll, never a rebuild. */
    function settle() {
      if (pending) { clearTimeout(pending); pending = 0; }
      /* Covers first: a mirroring host still carries the PREVIOUS box until it
         is re-synced, so measuring before this would compare the new layout
         against a stale host and skip the rebuild. ResizeObserver reports only
         real size changes, and a re-sync onto an unmoved target writes the same
         box, so a settle cannot feed the observer back into itself. */
      syncCovers();
      var i, r, v, rs = [], minL = Infinity, minT = Infinity, maxR = -Infinity, maxB = -Infinity;
      for (i = 0; i < hosts.length; i++) {
        r = rs[i] = docRect(hosts[i]);
        if (r.w <= 0 || r.h <= 0) { continue; }
        if (r.l < minL) { minL = r.l; }
        if (r.t < minT) { minT = r.t; }
        if (r.l + r.w > maxR) { maxR = r.l + r.w; }
        if (r.t + r.h > maxB) { maxB = r.t + r.h; }
      }
      /* SIZE HAS A 2 PX TOLERANCE; THE OFFSETS KEEP 0.5 PX.
         Measured on staging 2026-09-14 at 390 wide: lazy images inside a covered
         section grew its target by a fraction of a pixel (#flwrco-doc +0.328
         then +0.11, #tcg-doc +0.328) and moved the footer by the same amount.
         An exact test of ROUNDED sizes flips on that (7734.281 rounds to 7734,
         7734.609 to 7735) and rebuilt every view mid-scroll, 32 canvas size
         writes, for nothing visible: each canvas is
         stretched to its host box, so a backing store a pixel or two off its
         host paints the same picture. The test is against the BAKED sizes, so
         small changes still add up and rebuild once they pass 2 px. Position
         still keeps half a pixel, judged where each plane meets its neighbour:
         see seamKept() below. */
      var fresh = isFinite(minL) && Math.abs(Math.round(maxR - minL) - W) <= 2 && Math.abs(Math.round(maxB - minT) - H) <= 2;
      /* A zero-size host is skipped here exactly as the union above skips it.
         A display:none host measures as a zero box at the CURRENT scroll
         offset, so its baked offset would always read as stale and every
         settle would rebuild the whole field for a host that paints nothing.
         Once it has a box again it is compared as before. */
      for (i = 0; fresh && i < hosts.length; i++) {
        v = views[i]; r = rs[i];
        if (!v || v.host !== hosts[i] ||
            (r.w > 0 && r.h > 0 &&
             (Math.abs(v.w - Math.max(1, Math.round(r.w))) > 2 || Math.abs(v.h - Math.max(1, Math.round(r.h))) > 2 ||
              Math.abs(minL - r.l - v.ox) > 0.5 || !seamKept(i, rs, minT)))) { fresh = false; }
      }
      if (fresh) { place(); invalidate(); return; }
      render();
    }

    /* THE SEAM, JUDGED WHERE IT IS. A host moves whenever a host above it grows:
       on staging 2026-09-14 lazy images grew #flwrco-doc and the footer below
       it moved by the same amount. Against the union top that reads as a stale
       offset once the growth passes half a pixel (offline, one more +0.328
       image after the two traced ones rebuilt every view), yet the canvas
       above is stretched to its grown host, so its bottom row still lands on
       the top row of the host below and the plane is as continuous as a fresh
       bake would make it. What does break the plane is the GAP between two
       touching hosts changing, so the gap is compared, to the same half pixel,
       against the gap baked with the views. bh is the unrounded height
       buildView measured; the rounded h would add up to half a pixel of
       rounding to every comparison. Touching means within 3 px NOW OR AT THE
       BAKE: 3 px is how far a host can change size before the 2 px size test
       fires (half a pixel of rounding on each side), and a pair the change
       itself carried out of that window must still be compared, or its seam
       opens by about 3 px unseen (measured offline). A host with nothing
       touching it from above keeps the old test against the union top. */
    function seamKept(i, rs, minT) {
      var r = rs[i], v = views[i], j, q, u, touching = false;
      for (j = 0; j < rs.length; j++) {
        q = rs[j]; u = views[j];
        if (j === i || !u || q.w <= 0 || q.h <= 0 || q.t >= r.t ||
            q.l >= r.l + r.w || r.l >= q.l + q.w || (Math.abs(q.t + q.h - r.t) > 3 && Math.abs(u.oy - v.oy - u.bh) > 3)) { continue; }
        touching = true;
        if (Math.abs((u.oy - v.oy - u.bh) - (r.t - q.t - q.h)) > 0.5) { return false; }
      }
      return touching || Math.abs(minT - r.t - v.oy) <= 0.5;
    }

    /* The DEBOUNCED wrapper, for the events that arrive in bursts (resize, the
       ResizeObserver). The drift check calls settle() directly instead: routing
       it through this timer would let a continuing scroll reset the debounce on
       every frame and the seam would stay open for as long as the reader kept
       moving. */
    function relayout() {
      if (pending) { clearTimeout(pending); }
      pending = setTimeout(settle, 120);
    }

    if (!render()) { return null; }

    /* Does this field mirror anything? A field with no cover host must not pay
       for the drift check, so it is decided once here rather than per scroll
       event. */
    var hasCovers = false;
    for (var hc = 0; hc < hosts.length; hc++) {
      if (hosts[hc].getAttribute('data-hexfield-cover')) { hasCovers = true; }
    }

    /* REDUCED MOTION: one static frame and nothing else. No scroll listener, no
       pointer listener, no resize observer, no rAF. */
    if (!reduce.matches) {
      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', relayout);
      var grounds = [];
      for (var i2 = 0; i2 < hosts.length; i2++) {
        var g2 = hosts[i2].parentElement;
        /* TENANT INGEST FIX -- DO NOT SIMPLIFY THIS TO parentElement.
           Under section-blob every host lands in its own builder wrapper, and
           those wrappers collapse to height 0: measured on the live page, host 1's
           parent is a `div.col` at 0px (the real ground, `section.mc-section`, is
           three levels up) and host 2 sits under a stack of 0px `.sgb-component`
           wrappers. A listener on a zero-height element NEVER receives
           pointermove, so the pointer light stays parked off-screen and the
           section's glow is simply dead -- which is exactly what shipped when this
           walk was dropped in the canvas port.
           onMove reads only e.clientX/e.clientY, so a larger ground is
           behaviour-identical. */
        var groundWithBox = g2;
        while (groundWithBox && groundWithBox.parentElement &&
               groundWithBox.getBoundingClientRect().height < 1) {
          groundWithBox = groundWithBox.parentElement;
        }
        g2 = groundWithBox || g2;
        if (g2 && grounds.indexOf(g2) < 0) {
          grounds.push(g2);
          g2.addEventListener('pointermove', onMove, { passive: true });
          g2.addEventListener('pointerenter', onEnter);
          g2.addEventListener('pointerleave', onLeave);
        }
      }
      if ('ResizeObserver' in window) {
        var ro = new ResizeObserver(relayout);
        for (var j2 = 0; j2 < hosts.length; j2++) { ro.observe(hosts[j2]); }
        /* AND THE MIRRORED ELEMENT. A cover host's box is written, not measured,
           so its own entry can never report the target changing size -- the
           footer growing a line of text would fire nothing. Observing the target
           closes that half; the scroll-time drift check closes the other half,
           which is the target MOVING. */
        for (var k2 = 0; k2 < hosts.length; k2++) {
          var csel = hosts[k2].getAttribute('data-hexfield-cover');
          var ctgt = csel && document.querySelector(csel);
          if (ctgt) { ro.observe(ctgt); }
        }
      }

      /* LATE LAYOUT, ONE MORE LOOK. A webfont swapping or an image arriving
         changes the document's height after the field has measured, and neither
         resizes a host. boot() already waits for LOAD, so the load hook only
         matters for a direct HexField.mount() before load; fonts.ready can still
         resolve after it. Both are one-shot: two settles at most, no standing
         cost. */
      if (hasCovers) {
        if (document.readyState !== 'complete') { window.addEventListener('load', settle, { once: true }); }
        if (document.fonts && document.fonts.ready) { document.fonts.ready.then(settle); }
      }
    }

    return {
      field: function () { return { l: L, t: T, w: W, h: H }; },
      config: function () { return cfg; },
      cells:  function () { return geo && geo.cells; }
    };
  }

  /* -- declarative boot ---------------------------------------------------- */
  function boot() {
    var nodes = document.querySelectorAll('[data-hexfield]');
    var groups = {}, order = [], i, k;
    for (i = 0; i < nodes.length; i++) {
      k = nodes[i].getAttribute('data-hexfield') || 'default';
      if (!groups[k]) { groups[k] = []; order.push(k); }
      groups[k].push(nodes[i]);
    }
    for (i = 0; i < order.length; i++) {
      var g = groups[order[i]];
      var opt = {}, n;
      for (n = 0; n < g.length; n++) {
        var a = g[n].getAttribute('data-hex-cols');
        var c = g[n].getAttribute('data-hex-alpha');
        var s = g[n].getAttribute('data-hex-clear');
        if (a && !isNaN(+a)) { opt.cols = +a; }
        if (c && !isNaN(+c)) { opt.edgeAlpha = +c; }
        if (s) { opt.clearSel = s; }
      }
      var inst = mount(g, opt);
      if (inst) { window.HexField.instances.push(inst); }
    }
  }

  window.HexField = { mount: mount, instances: [] };

  /* Measured after LOAD, not after parse: the field's height is the sum of two
     real page regions, and those are not final until webfonts and the footer
     imagery have settled. */
  if (document.readyState === 'complete') { boot(); }
  else { window.addEventListener('load', boot, { once: true }); }
}());
