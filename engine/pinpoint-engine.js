function pinpointEngine(config) {
  'use strict';
  config = config || {};
  var VERSION = '0.1.0', PROTOCOL = 1;
  var prev = window.__pinpoint;
  if (prev && prev.version === VERSION) return prev;
  if (prev && typeof prev.destroy === 'function') { try { prev.destroy(); } catch (e) {} }

  var doc = document, root = doc.documentElement;
  var queue = [], dirty = false, docVersion = 0, destroyed = false;
  var lastKey = '', mo = null, ro = null, wd = 0, listeners = [];

  function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) : s; }
  function sanitize(s) {
    return String(s == null ? '' : s).replace(/[\t\n\r]+/g, ' ')
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, '')
      .replace(/ {2,}/g, ' ').trim();
  }
  function normText(s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 40); }
  function urlKey(href) {
    try {
      var u = new URL(href), k = u.protocol + '//' + u.host.toLowerCase() + u.pathname.replace(/\/+$/, '');
      if (u.hash.indexOf('#/') === 0) k += u.hash;
      var q = [];
      u.searchParams.forEach(function (v, n) { if (!/^utm_/i.test(n) && n !== 'fbclid' && n !== 'gclid') q.push([n, v]); });
      q.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0; });
      if (q.length) k += '?' + q.map(function (p) { return p[0] + '=' + p[1]; }).join('&');
      return k;
    } catch (e) { return ''; }
  }

  // ----- hashing (no bit shifts) -----
  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) { h = h ^ str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  // ----- colour -----
  var colorCache = {}, cv = null, cx = null;
  function num(t) { return t === 'none' ? 0 : parseFloat(t); }
  function pct(t, scale) { return /%$/.test(t) ? parseFloat(t) / 100 * scale : num(t); }
  function alphaTok(t) { return t == null ? 1 : Math.max(0, Math.min(1, /%$/.test(t) ? parseFloat(t) / 100 : num(t))); }
  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    if (s === 0) return [l * 255, l * 255, l * 255];
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    function f(t) {
      t = (t + 1) % 1;
      return 255 * (t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p);
    }
    return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
  }
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, h = 0, s = 0, d = mx - mn;
    if (d > 0) {
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h *= 60;
    }
    return [h, s, l];
  }
  function canvasColor(s) {
    try {
      if (!cx) { cv = doc.createElement('canvas'); cv.width = 1; cv.height = 1; cx = cv.getContext('2d', { willReadFrequently: true }); }
      cx.fillStyle = '#fe0102'; cx.fillStyle = s; var a = cx.fillStyle;
      cx.fillStyle = '#01fe02'; cx.fillStyle = s; var b = cx.fillStyle;
      if (a === '#fe0102' && b === '#01fe02') return null;
      cx.clearRect(0, 0, 1, 1); cx.fillRect(0, 0, 1, 1);
      var d = cx.getImageData(0, 0, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: Math.round(d[3] / 255 * 1000) / 1000 };
    } catch (e) { return null; }
  }
  function parseColor(str) {
    var s = String(str == null ? '' : str).trim().toLowerCase();
    if (!s) return null;
    if (Object.prototype.hasOwnProperty.call(colorCache, s)) return colorCache[s];
    var out = null, m, t;
    if (s === 'transparent') out = { r: 0, g: 0, b: 0, a: 0 };
    else if ((m = /^#([0-9a-f]{3,8})$/.exec(s)) && [3, 4, 6, 8].indexOf(m[1].length) >= 0) {
      var x = m[1];
      if (x.length < 6) x = x.replace(/./g, function (c) { return c + c; });
      out = { r: parseInt(x.substr(0, 2), 16), g: parseInt(x.substr(2, 2), 16), b: parseInt(x.substr(4, 2), 16), a: x.length === 8 ? parseInt(x.substr(6, 2), 16) / 255 : 1 };
    } else if ((m = /^(rgba?|hsla?|color)\(\s*([^)]*)\)$/.exec(s)) && s.indexOf('color-mix') !== 0) {
      t = m[2].split(/[\s,\/]+/).filter(Boolean);
      var fn = m[1];
      if (fn === 'rgb' || fn === 'rgba') {
        if (t.length >= 3) out = { r: pct(t[0], 255), g: pct(t[1], 255), b: pct(t[2], 255), a: alphaTok(t[3]) };
      } else if (fn === 'hsl' || fn === 'hsla') {
        if (t.length >= 3) {
          var c3 = hslToRgb(parseFloat(t[0]), pct(t[1], 1), pct(t[2], 1));
          out = { r: c3[0], g: c3[1], b: c3[2], a: alphaTok(t[3]) };
        }
      } else if (t[0] === 'srgb' && t.length >= 4) {
        out = { r: pct(t[1], 1) * 255, g: pct(t[2], 1) * 255, b: pct(t[3], 1) * 255, a: alphaTok(t[4]) };
      }
      if (out && (isNaN(out.r) || isNaN(out.g) || isNaN(out.b) || isNaN(out.a))) out = null;
    }
    if (!out) out = canvasColor(s);
    if (out) out = { r: Math.round(Math.max(0, Math.min(255, out.r))), g: Math.round(Math.max(0, Math.min(255, out.g))), b: Math.round(Math.max(0, Math.min(255, out.b))), a: out.a };
    colorCache[s] = out;
    return out;
  }
  function lin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function lum(c) { return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b); }
  function ratio(a, b) {
    var l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }
  function hex2(n) { n = Math.max(0, Math.min(255, Math.round(n))); return (n < 16 ? '0' : '') + n.toString(16); }
  function hex(c) { return '#' + hex2(c.r) + hex2(c.g) + hex2(c.b); }
  // alpha-composite fg over bg (bg may be translucent); result rounded to 8 bit
  function over(f, b) {
    var a = f.a, ba = b.a == null ? 1 : b.a, ao = a + ba * (1 - a);
    if (ao <= 0) return { r: 0, g: 0, b: 0, a: 0 };
    return {
      r: (f.r * a + b.r * ba * (1 - a)) / ao, g: (f.g * a + b.g * ba * (1 - a)) / ao,
      b: (f.b * a + b.b * ba * (1 - a)) / ao, a: ao
    };
  }
  function rnd(c) { return { r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b), a: c.a }; }
  // smallest HSL-lightness change of fg that reaches need + 0.05 on bg
  function suggestFix(fg, bg, need) {
    var hsl = rgbToHsl(fg.r, fg.g, fg.b), target = need + 0.05, best = null;
    [-1, 1].forEach(function (dir) {
      for (var d = 0.5; d <= 100; d += 0.5) {
        var l = hsl[2] + dir * d / 100;
        if (l < 0 || l > 1) break;
        var rgb = hslToRgb(hsl[0], hsl[1], l), c = { r: Math.round(rgb[0]), g: Math.round(rgb[1]), b: Math.round(rgb[2]) };
        if (ratio(c, bg) >= target) {
          if (!best || d < best.d) best = { d: d, c: c, dir: dir < 0 ? 'darker' : 'lighter' };
          break;
        }
      }
    });
    if (best) return { hex: hex(best.c), dir: best.dir, reachable: true };
    var w = { r: 255, g: 255, b: 255 }, k = { r: 0, g: 0, b: 0 }, useW = ratio(w, bg) > ratio(k, bg);
    return { hex: useW ? '#ffffff' : '#000000', dir: useW ? 'lighter' : 'darker', reachable: false };
  }

  // ----- tree helpers -----
  var GEN_ID = /\d{4,}|[0-9a-f]{8,}|^(radix-|:r|react-|ember)/i;
  var HASH_CLASS = [/^(css|sc|jsx|_)[-_]?[a-z0-9]{5,}$/i, /^[a-z]{1,3}[0-9a-f]{5,}$/];
  var SAFE_SEL = /^[\w#.\-:>\[\]="'()*~+,\/ $]+$/;
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, META: 1, LINK: 1, TITLE: 1, BASE: 1 };
  function cssStr(v) { return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
  function rootOf(el) { var r = el.getRootNode && el.getRootNode(); return r && (r.nodeType === 9 || r.nodeType === 11) ? r : el.ownerDocument; }
  function qs(rt, s) { try { return rt.querySelectorAll(s); } catch (e) { return []; } }
  function stableId(el) {
    var id = el.getAttribute && el.getAttribute('id');
    if (!id || GEN_ID.test(id) || /\s/.test(id)) return '';
    var rt = rootOf(el);
    return qs(rt, '[id="' + cssStr(id) + '"]').length === 1 ? id : '';
  }
  function stableClasses(el) {
    var out = [], cl = el.classList || [];
    for (var i = 0; i < cl.length && out.length < 2; i++) {
      var c = cl[i];
      if (!/^[A-Za-z_-][\w-]*$/.test(c)) continue;
      if (HASH_CLASS[0].test(c) || HASH_CLASS[1].test(c)) continue;
      out.push(c);
    }
    return out;
  }
  function hostOf(el) {
    var rt = rootOf(el);
    if (rt && rt.nodeType === 11) return rt.host;
    var w = el.ownerDocument && el.ownerDocument.defaultView;
    try { return w && w.frameElement && w.frameElement.ownerDocument ? w.frameElement : null; } catch (e) { return null; }
  }
  function okSel(s, el, rt) {
    if (s.length > 200 || !SAFE_SEL.test(s)) return false;
    var l = qs(rt, s);
    return l.length === 1 && l[0] === el;
  }
  function segFor(node, plain) {
    var tag = node.localName, par = node.parentNode, seg = tag;
    if (!plain) seg += stableClasses(node).map(function (c) { return '.' + c; }).join('');
    var sibs = [], idx = 0;
    if (par && par.children) {
      for (var i = 0; i < par.children.length; i++) {
        var s = par.children[i];
        if (s.localName === tag) { sibs.push(s); if (s === node) idx = sibs.length; }
      }
    }
    if (sibs.length > 1) {
      var same = 0;
      if (!plain) for (var j = 0; j < sibs.length; j++) if (sibs[j].matches(seg)) same++;
      if (plain || same > 1 || seg === tag) seg += ':nth-of-type(' + idx + ')';
    }
    return seg;
  }
  function selIn(el, rt) {
    if (rt.nodeType === 9 && el === rt.documentElement) return 'html';
    var tag = el.localName, s, v;
    var id = stableId(el);
    if (id) { s = '#' + CSS.escape(id); if (okSel(s, el, rt)) return s; }
    if ((v = el.getAttribute('name')) && !/["\\]/.test(v)) { s = tag + '[name="' + v + '"]'; if (okSel(s, el, rt)) return s; }
    if ((v = el.getAttribute('href')) && !/["\\]/.test(v)) { s = tag + '[href="' + v + '"]'; if (okSel(s, el, rt)) return s; }
    if ((v = el.getAttribute('src'))) {
      v = v.split('#')[0].split('?')[0]; v = v.slice(v.lastIndexOf('/') + 1);
      if (v && !/["\\]/.test(v)) { s = tag + '[src$="' + v + '"]'; if (okSel(s, el, rt)) return s; }
    }
    var parts = [], node = el;
    while (node && node.nodeType === 1) {
      var aid = node !== el && stableId(node);
      if (aid) { parts.unshift('#' + CSS.escape(aid)); } else parts.unshift(segFor(node, false));
      s = parts.join(' > ');
      if (okSel(s, el, rt)) return s;
      if (aid) break;
      node = node.parentNode && node.parentNode.nodeType === 1 ? node.parentNode : null;
    }
    parts = []; node = el;
    while (node && node.nodeType === 1) { parts.unshift(segFor(node, true)); node = node.parentNode && node.parentNode.nodeType === 1 ? node.parentNode : null; }
    s = parts.join(' > ');
    if (s.length > 200) { while (parts.length > 1 && parts.join(' > ').length > 200) parts.shift(); s = parts.join(' > '); }
    return s;
  }
  function selectorFor(el) {
    var rt = rootOf(el), s = selIn(el, rt), h = hostOf(el);
    if (h && h !== el) s = selectorFor(h) + ' >>> ' + s;
    return s;
  }
  function resolveSel(sel) {
    try {
      var parts = String(sel).split(' >>> '), cur = doc, el = null;
      for (var i = 0; i < parts.length; i++) {
        if (!cur) return null;
        el = cur.querySelector(parts[i]);
        if (!el) return null;
        cur = el.shadowRoot || (el.contentDocument || null);
      }
      return el;
    } catch (e) { return null; }
  }
  var IMPLICIT = { a: 'link', button: 'button', img: 'img', select: 'combobox', textarea: 'textbox', summary: 'button', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading' };
  var INPUT_ROLE = { checkbox: 'checkbox', radio: 'radio', range: 'slider', button: 'button', submit: 'button', reset: 'button', image: 'button', search: 'searchbox' };
  function roleOf(el) {
    var r = el.getAttribute('role');
    if (r) return sanitize(r.split(/\s+/)[0]).toLowerCase();
    var t = el.localName;
    if (t === 'input') return INPUT_ROLE[(el.getAttribute('type') || 'text').toLowerCase()] || 'textbox';
    if (t === 'a' && !el.hasAttribute('href')) return '';
    return IMPLICIT[t] || '';
  }
  function textOf(el, max) {
    max = max || 200;
    var out = '';
    (function walk(n) {
      for (var c = n.firstChild; c && out.length < max; c = c.nextSibling) {
        if (c.nodeType === 3) out += c.nodeValue + ' ';
        else if (c.nodeType === 1 && !SKIP_TAGS[c.nodeName] && !c.hasAttribute('data-pp-root')) walk(c);
      }
    })(el);
    return out.replace(/\s+/g, ' ').trim().slice(0, max);
  }
  function hrefKey(h) {
    try { var u = new URL(h, location.href); return u.pathname + u.search + u.hash; } catch (e) { return h; }
  }
  function stableKey(el) {
    var id = stableId(el), v;
    if (id) return '#' + id;
    if ((v = el.getAttribute('name'))) return 'name:' + v;
    if ((v = el.getAttribute('href'))) return 'href:' + hrefKey(v);
    if ((v = el.getAttribute('src'))) { v = v.split('#')[0].split('?')[0]; return 'src:' + v.slice(v.lastIndexOf('/') + 1); }
    var t = el === el.ownerDocument.documentElement || el.localName === 'body' ? '' : normText(textOf(el, 80));
    return t ? 'text:' + t : '';
  }
  function ancestorPath(el) {
    var out = [], n = el.parentElement || hostOf(el), i = 0;
    while (n && i < 4) {
      var id = stableId(n);
      out.push(n.localName + (id ? '#' + id : ''));
      if (id) break;
      n = n.parentElement || hostOf(n); i++;
    }
    return out.join('>');
  }
  function fingerprint(rule, el, variant) {
    var tag = variant === 'heading' ? 'heading' : el.localName;
    return [rule, tag, roleOf(el), stableKey(el), ancestorPath(el)].join('|');
  }
  function idFor(rule, el, variant, occ) {
    var fp = fingerprint(rule, el, variant) + (occ ? '|#' + occ : '');
    return rule + '@' + fnv1a(fp);
  }
  function testHooks() {
    return {
      parseColor: parseColor, ratio: ratio, lum: lum, suggestFix: suggestFix, fnv1a: fnv1a, sanitize: sanitize,
      selectorFor: selectorFor, resolve: resolveSel, fingerprint: fingerprint, idFor: idFor, urlKey: urlKey,
      hex: hex, over: over
    };
  }

  //@@UTIL

  //@@RULES

  function audit() {
    return { protocol: PROTOCOL, findings: [], errors: [], score: 100, counts: { high: 0, medium: 0, low: 0 } };
  }

  var overlayHost = null;
  function pinCount() { return 0; }
  function removeOverlay() {}
  function scheduleLayout() {}
  function render() { return { pinned: 0, lost: [] }; }
  function setStatuses() {}
  function focusPin() { return false; }
  function clear() {}

  // ---------- live tracking / events ----------
  function now() { return Date.now(); }
  function push(ev) { ev.t = now(); queue.push(ev); if (queue.length > 200) queue.shift(); }
  function markDirty(reason) {
    docVersion++;
    if (!dirty) { dirty = true; push({ type: 'dirty', reason: reason }); }
  }
  function listen(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    listeners.push([target, type, fn, opts]);
  }
  function inOverlay(n) {
    while (n) {
      if (n === overlayHost) return true;
      n = n.parentNode || n.host || null;
    }
    return false;
  }
  function onMutations(recs) {
    var real = false;
    for (var i = 0; i < recs.length && !real; i++) {
      var r = recs[i];
      if (inOverlay(r.target)) continue;
      if (r.type === 'childList') {
        var nodes = [].slice.call(r.addedNodes).concat([].slice.call(r.removedNodes));
        var other = false;
        for (var j = 0; j < nodes.length; j++) if (!(nodes[j].hasAttribute && nodes[j].hasAttribute('data-pp-root'))) other = true;
        if (!other) continue;
      }
      real = true;
    }
    if (real) { markDirty('mutation'); scheduleLayout(); }
  }
  function checkNavigation() {
    var k = urlKey(location.href);
    if (k !== lastKey) { lastKey = k; markDirty('navigation'); }
  }

  function probe() {
    checkNavigation();
    return {
      protocol: PROTOCOL, version: VERSION,
      url: clip(location.href, 80), key: clip(lastKey, 60),
      ready: doc.readyState === 'complete', pins: pinCount(), dirty: dirty,
      vw: root.clientWidth, vh: root.clientHeight, docVersion: docVersion
    };
  }
  function drain() { var q = queue; queue = []; return q; }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    try { removeOverlay(); } catch (e) {}
    if (mo) mo.disconnect();
    if (ro) ro.disconnect();
    clearInterval(wd);
    for (var i = 0; i < listeners.length; i++) { var l = listeners[i]; l[0].removeEventListener(l[1], l[2], l[3]); }
    listeners = [];
    if (window.__pinpoint === api) delete window.__pinpoint;
  }

  var api = {
    protocol: PROTOCOL, version: VERSION,
    audit: audit, render: render, setStatuses: setStatuses, focusPin: focusPin,
    clear: clear, drain: drain, probe: probe, destroy: destroy
  };
  if (config.test === true) api.__test = testHooks();

  lastKey = urlKey(location.href);
  if (typeof MutationObserver === 'function') {
    mo = new MutationObserver(onMutations);
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
  }
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(function () { scheduleLayout(); });
    ro.observe(root);
  }
  listen(window, 'resize', function () { markDirty('resize'); scheduleLayout(); });
  listen(window, 'load', function () { markDirty('load'); scheduleLayout(); });
  listen(window, 'popstate', checkNavigation);
  listen(window, 'hashchange', checkNavigation);
  window.__pinpoint = api;
  return api;
}
