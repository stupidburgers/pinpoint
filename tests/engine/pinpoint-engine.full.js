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
   u.searchParams.forEach(function(v, n) { if (!/^utm_/i.test(n) && n !== 'fbclid' && n !== 'gclid') q.push([n, v]); });
   q.sort(function(a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0; });
   if (q.length) k += '?' + q.map(function(p) { return p[0] + '=' + p[1]; }).join('&');
   return k;
  } catch (e) { return ''; }
 }

 function fnv1a(str) {
  var h = 0x811c9dc5;
  for (var i = 0; i < str.length; i++) { h = h ^ str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
 }

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
   if (x.length < 6) x = x.replace(/./g, function(c) { return c + c; });
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
 function over(f, b) {
  var a = f.a, ba = b.a == null ? 1 : b.a, ao = a + ba * (1 - a);
  if (ao <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
   r: (f.r * a + b.r * ba * (1 - a)) / ao, g: (f.g * a + b.g * ba * (1 - a)) / ao,
   b: (f.b * a + b.b * ba * (1 - a)) / ao, a: ao
  };
 }
 function rnd(c) { return { r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b), a: c.a }; }
 function suggestFix(fg, bg, need) {
  var hsl = rgbToHsl(fg.r, fg.g, fg.b), target = need + 0.05, best = null;
  [-1, 1].forEach(function(dir) {
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
  if (!plain) seg += stableClasses(node).map(function(c) { return '.' + c; }).join('');
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
  var tag = variant && variant.indexOf('heading') === 0 ? 'heading' : el.localName;
  return [rule, tag, roleOf(el), stableKey(el) + (variant ? '~' + variant : ''), ancestorPath(el)].join('|');
 }
 function idFor(rule, el, variant, occ) {
  var fp = fingerprint(rule, el, variant) + (occ ? '|#' + occ : '');
  return rule + '@' + fnv1a(fp);
 }
 function testHooks() {
  return {
   parseColor: parseColor, ratio: ratio, lum: lum, suggestFix: suggestFix, fnv1a: fnv1a, sanitize: sanitize,
   selectorFor: selectorFor, resolve: resolveSel, fingerprint: fingerprint, idFor: idFor, urlKey: urlKey,
   hex: hex, over: over, layout: layout, inspect: inspect
  };
 }


 function fmt2(n) { return Math.round(n * 100) / 100; }
 function canvasFor(el) {
  var d = el.ownerDocument, cs = d.defaultView.getComputedStyle(d.documentElement), sch = cs.colorScheme || '';
  var dark = /\bdark\b/.test(sch) && (!/\blight\b/.test(sch) || (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches));
  return dark ? { r: 18, g: 18, b: 18, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
 }
 function nodeBg(n) {
  var m = X && X.nb && X.nb.get(n);
  if (m) return m;
  var cs = gcs(n), bg = parseColor(cs.backgroundColor) || { r: 0, g: 0, b: 0, a: 0 };
  m = { bg: bg, img: cs.backgroundImage !== 'none' && cs.backgroundImage !== '', op: parseFloat(cs.opacity), pos: cs.position !== 'static' };
  if (isNaN(m.op)) m.op = 1;
  if (X) { X.nb = X.nb || new Map(); X.nb.set(n, m); }
  return m;
 }
 function pseudoLayer(n) {
  var m = X && X.pl ? X.pl.get(n) : undefined;
  if (m !== undefined) return m;
  m = false;
  if (nodeBg(n).pos) {
   ['::before', '::after'].forEach(function(ps) {
    var c = n.ownerDocument.defaultView.getComputedStyle(n, ps);
    if (c.content === 'none' || c.content === 'normal' || c.display === 'none') return;
    if (c.position !== 'absolute' && c.position !== 'fixed') return;
    if (c.backgroundImage !== 'none' || (parseColor(c.backgroundColor) || { a: 0 }).a > 0.01) m = true;
   });
  }
  if (X) { X.pl = X.pl || new Map(); X.pl.set(n, m); }
  return m;
 }
 function composite(el, start) {
  var acc = start, n = el, unknown = false;
  while (n) {
   var nb = nodeBg(n);
   if (acc.a < 0.99 && (nb.img || pseudoLayer(n))) { unknown = true; break; }
   if (nb.bg.a > 0) acc = over(acc, nb.bg);
   if (nb.op < 1) acc = { r: acc.r, g: acc.g, b: acc.b, a: acc.a * nb.op };
   if (acc.a >= 0.99 && lay(n).op >= 0.999) { acc = { r: acc.r, g: acc.g, b: acc.b, a: 1 }; break; }
   n = parentEl(n);
  }
  if (unknown) return null;
  return rnd(over(acc, canvasFor(el)));
 }
 var MEDIA_TAGS = { img: 1, video: 1, canvas: 1, svg: 1, picture: 1, iframe: 1, object: 1, embed: 1 };
 function layerCandidates() {
  if (X.cands) return X.cands;
  var out = [];
  X.els.forEach(function(e) {
   var cs = gcs(e);
   if (cs.position === 'static' && cs.transform === 'none') return;
   var nb = nodeBg(e);
   if (!(MEDIA_TAGS[e.localName] || nb.img || nb.bg.a > 0.01)) return;
   if (!vis(e)) return;
   out.push({ el: e, box: rectOf(e) });
  });
  X.cands = out;
  return out;
 }
 var NOTEXT = { option: 1, optgroup: 1, textarea: 1, select: 1, input: 1 };

 function ruleContrast() {
  var skipN = 0;
  X.els.forEach(function(el) {
   if (NOTEXT[el.localName]) return;
   var ti = textInfo(el);
   if (!ti || !textVisible(el, ti)) return;
   if (isDisabled(el)) return;
   var cs = gcs(el), fg = parseColor(cs.webkitTextFillColor) || parseColor(cs.color);
   if (!fg || fg.a < 0.02) return;
   X.checked['a11y.contrast']++;
   var L = lay(el);
   if (L.blend) { skip('a11y.contrast', 'blend'); skipN++; return; }
   var cands = layerCandidates(), over_ = false;
   for (var i = 0; i < cands.length && !over_; i++) {
    var c = cands[i];
    if (c.el === el || c.el.contains(el)) continue;
    if (overlapArea(c.box, ti.box) > 0) over_ = true;
   }
   if (over_) { skip('a11y.contrast', 'overlap'); skipN++; return; }
   var bgv = composite(el, { r: 0, g: 0, b: 0, a: 0 }), fgv = composite(el, fg);
   if (!bgv || !fgv) { skip('a11y.contrast', 'image'); skipN++; return; }
   var px = parseFloat(cs.fontSize) || 16, w = parseInt(cs.fontWeight, 10) || 400;
   var large = px >= 24 || (px >= 18.66 && w >= 700);
   var need = X.aaa ? (large ? 4.5 : 7) : (large ? 3 : 4.5), r = ratio(fgv, bgv);
   if (r >= need) return;
   var sg = suggestFix(fgv, bgv, need), why = (fg.a < 1 || L.op < 1) ? ' (effective colour; text is semi-transparent)' : '';
   add('a11y.contrast', el, r < 3 ? 'high' : 'medium', {
    wcag: X.aaa ? '1.4.6' : '1.4.3',
    note: 'Contrast ' + fmt2(r) + ':1, needs ' + need + ':1' + why,
    fix: sg.reachable ? (sg.dir === 'darker' ? 'Darken' : 'Lighten') + ' text to ' + sg.hex + ' or ' + sg.dir + ' (on ' + hex(bgv) + ')'
     : 'No text colour reaches ' + need + ':1 on ' + hex(bgv) + '; change the background',
    measured: { ratio: fmt2(r), need: need, fg: hex(fgv), bg: hex(bgv), px: Math.round(px * 10) / 10 }
   });
  });
  if (skipN) limit('contrast: ' + skipN + ' text element(s) skipped (background image/gradient, overlapping layer or blend mode); never guessed');
 }

 function isTarget(el) {
  var t = el.localName;
  if (t === 'a') return el.hasAttribute('href');
  if (t === 'button' || t === 'select' || t === 'textarea' || t === 'summary') return true;
  if (t === 'input') return (el.getAttribute('type') || '').toLowerCase() !== 'hidden';
  var r = el.getAttribute('role');
  if (r && /^(button|link|checkbox|tab|menuitem)$/.test(r.trim().split(/\s+/)[0].toLowerCase())) return true;
  var ti = el.getAttribute('tabindex');
  return ti !== null && parseInt(ti, 10) >= 0;
 }
 function inlineInText(el) {
  if (gcs(el).display !== 'inline') return false;
  var p = el.parentNode;
  if (!p) return false;
  for (var c = p.firstChild; c; c = c.nextSibling) if (c.nodeType === 3 && /\S/.test(c.nodeValue)) return true;
  return false;
 }
 function targets() {
  if (X.tg) return X.tg;
  var out = [];
  X.els.forEach(function(el) {
   if (!isTarget(el) || isDisabled(el) || !vis(el)) return;
   var r = rectOf(el);
   if (r.w <= 1 && r.h <= 1) return;
   out.push({ el: el, r: r, inl: inlineInText(el) });
  });
  X.tg = out;
  return out;
 }
 function rectDist(px, py, r) {
  var dx = Math.max(r.x - px, 0, px - (r.x + r.w)), dy = Math.max(r.y - py, 0, py - (r.y + r.h));
  return Math.sqrt(dx * dx + dy * dy);
 }
 function ruleTap() {
  var T = targets(), min = X.tapMin, adv = X.tapAdv, grid = {}, CELL = 64;
  function cells(r, pad, fn) {
   for (var cx_ = Math.floor((r.x - pad) / CELL); cx_ <= Math.floor((r.x + r.w + pad) / CELL); cx_++)
    for (var cy_ = Math.floor((r.y - pad) / CELL); cy_ <= Math.floor((r.y + r.h + pad) / CELL); cy_++) fn(cx_ + ',' + cy_);
  }
  T.forEach(function(t, i) {
   t.small = Math.round(Math.min(t.r.w, t.r.h) * 100) / 100 < min;
   t.cx = t.r.x + t.r.w / 2; t.cy = t.r.y + t.r.h / 2;
   cells(t.r, 24, function(k) { (grid[k] = grid[k] || []).push(i); });
  });
  T.forEach(function(t, i) {
   X.checked['a11y.tap-target']++;
   var m = Math.round(Math.min(t.r.w, t.r.h) * 100) / 100;
   if (t.inl) return;
   var w = Math.round(t.r.w), h = Math.round(t.r.h);
   if (t.small) {
    var near = grid[Math.floor(t.cx / CELL) + ',' + Math.floor(t.cy / CELL)] || [], crowded = false;
    for (var k = 0; k < near.length && !crowded; k++) {
     var u = T[near[k]];
     if (u === t || u.el.contains(t.el) || t.el.contains(u.el)) continue;
     if (rectDist(t.cx, t.cy, u.r) < 12) crowded = true;
     else if (u.small && Math.hypot(t.cx - u.cx, t.cy - u.cy) < 24) crowded = true;
    }
    if (!crowded) return;
    add('a11y.tap-target', t.el, 'medium', {
     wcag: '2.5.8', note: 'Target is ' + w + '\u00d7' + h + 'px; minimum is ' + min + '\u00d7' + min + 'px and neighbours are too close',
     fix: 'Make it at least ' + min + '\u00d7' + min + 'px (44\u00d744 recommended) or keep other targets 24px away', measured: { w: w, h: h, min: min }
    });
   } else if (adv > 0 && m < adv) {
    add('a11y.tap-target', t.el, 'low', {
     wcag: '2.5.5', note: 'Target is ' + w + '\u00d7' + h + 'px; ' + adv + '\u00d7' + adv + 'px is the recommended size',
     fix: 'Enlarge the clickable area to ' + adv + '\u00d7' + adv + 'px (padding is enough)', measured: { w: w, h: h, min: adv }
    });
   }
  });
 }

 var FILE_ALT = [/\.(png|jpe?g|gif|svg|webp)$/i, /^img[_-]?\d+/i];
 function ruleImgAlt() {
  X.els.forEach(function(el) {
   var t = el.localName, role = (el.getAttribute('role') || '').trim().split(/\s+/)[0].toLowerCase(), kind = '';
   if (t === 'img') kind = 'img';
   else if (t === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'image') kind = 'input';
   else if (role === 'img') kind = 'role';
   if (!kind || !inTree(el)) return;
   var rc = rectOf(el);
   if (kind === 'img' && rc.w <= 1 && rc.h <= 1) return;
   X.checked['a11y.img-alt']++;
   var named = attrName(el) || (el.getAttribute('title') || '').trim();
   if (kind === 'role' && !named && t === 'svg') { var ti = el.querySelector('title'); named = ti ? ti.textContent.trim() : ''; }
   var alt = el.getAttribute('alt'), msg = '';
   if (kind === 'img') {
    if (role === 'presentation' || role === 'none') return;
    if (alt === null) { if (named) return; msg = 'Image has no alt attribute'; }
    else if (!/\S/.test(alt)) { if (!role || named) return; msg = 'Empty alt but role="' + clip(sanitize(role), 20) + '" needs a name'; }
    else if (FILE_ALT[0].test(alt.trim()) || FILE_ALT[1].test(alt.trim())) msg = 'Alt text looks like a file name';
    else return;
   } else if (kind === 'input') {
    if ((alt && /\S/.test(alt)) || named) return;
    msg = 'Image button has no accessible name';
   }else{
    if (named) return;
    msg = 'role="img" has no accessible name';
   }
   add('a11y.img-alt', el, 'high', { wcag: '1.1.1', note: msg, fix: 'Add alt text that describes the image purpose, or alt="" if purely decorative', measured: { w: Math.round(rc.w), h: Math.round(rc.h) } });
  });
 }

 var NOLABEL = { hidden: 1, submit: 1, button: 1, reset: 1, image: 1 };
 function labelText(el) {
  var out = '', ls = el.labels;
  if (ls) for (var i = 0; i < ls.length; i++) out += ' ' + contentName(ls[i], true, true);
  return out.trim();
 }
 function ruleFormLabel() {
  X.els.forEach(function(el) {
   var t = el.localName;
   if (!(t === 'input' || t === 'select' || t === 'textarea')) return;
   if (t === 'input' && NOLABEL[(el.getAttribute('type') || 'text').toLowerCase()]) return;
   if (!inTree(el)) return;
   X.checked['a11y.form-label']++;
   if (attrName(el) || labelText(el) || (el.getAttribute('title') || '').trim()) return;
   var ph = /\S/.test(el.getAttribute('placeholder') || '');
   add('a11y.form-label', el, 'high', {
    wcag: '1.3.1',
    note: ph ? 'Field has only a placeholder; a placeholder is not a label' : 'Form field has no accessible name',
    fix: 'Add a visible <label for> (or aria-label) that names the field', measured: { placeholder: ph ? 1 : 0 }
   });
  });
 }

 var NAMED_ROLES = /^(button|link|tab|menuitem)$/;
 function ruleControlName() {
  X.els.forEach(function(el) {
   var t = el.localName, r = (el.getAttribute('role') || '').trim().split(/\s+/)[0].toLowerCase();
   if (!(t === 'button' || (t === 'a' && el.hasAttribute('href')) || NAMED_ROLES.test(r))) return;
   if (!inTree(el)) return;
   X.checked['a11y.control-name']++;
   if (attrName(el) || contentName(el, false, false) || (el.getAttribute('title') || '').trim()) return;
   add('a11y.control-name', el, 'high', {
    wcag: '4.1.2', note: (t === 'a' ? 'Link' : 'Control') + ' has no accessible name (icon-only?)',
    fix: 'Add aria-label or visible text that says what it does', measured: {}
   });
  });
 }

 function headingLevel(el) {
  var m = /^h([1-6])$/.exec(el.localName);
  if (m) return +m[1];
  if ((el.getAttribute('role') || '').trim().toLowerCase() === 'heading') {
   var n = parseInt(el.getAttribute('aria-level'), 10);
   return n >= 1 && n <= 9 ? n : 2;
  }
  return 0;
 }
 function ruleHeadingOrder() {
  var hs = [];
  X.all.forEach(function(el) {
   var lv = headingLevel(el);
   if (lv && inTree(el)) hs.push({ el: el, level: lv });
  });
  X.checked['a11y.heading-order'] = hs.length;
  var prevL = 0, h1 = 0;
  hs.forEach(function(h) {
   var empty = !(el_text(h.el));
   if (empty) add('a11y.heading-order', h.el, 'low', { wcag: '2.4.6', variant: 'heading:empty', note: 'Heading <h' + h.level + '> is empty', fix: 'Add heading text or remove the empty heading', measured: { level: h.level } });
   if (h.level === 1) {
    h1++;
    if (h1 > 1) add('a11y.heading-order', h.el, 'low', { wcag: '1.3.1', variant: 'heading:multi-h1', note: 'More than one h1 on the page', fix: 'Keep one h1 for the page title; use h2 for sections', measured: { level: 1 } });
   }
   if (prevL && h.level - prevL > 1) add('a11y.heading-order', h.el, 'low', { wcag: '1.3.1', variant: 'heading:jump', note: 'Heading level jumps from h' + prevL + ' to h' + h.level, fix: 'Use h' + (prevL + 1) + ' here (do not skip levels)', measured: { from: prevL, to: h.level } });
   prevL = h.level;
  });
  if (!h1) {
   var first = hs.length ? hs[0].el : (doc.querySelector('body') || root);
   add('a11y.heading-order', first, 'low', { wcag: '2.4.6', variant: 'heading:no-h1', note: 'Page has no h1', fix: 'Add one h1 that names the page', measured: { headings: hs.length } });
  }
 }
 function el_text(el) { return attrName(el) || contentName(el, false, false); }

 function noneVal(v) { return !v || v === 'none' || v === 'initial'; }
 function setsOutlineNone(st) { return st.outlineStyle === 'none' || /^0(px)?$/.test(st.outlineWidth || ''); }
 function setsReplacement(st) {
  if (st.outlineStyle && st.outlineStyle !== 'none' && !/^0(px)?$/.test(st.outlineWidth || '')) return true;
  if (!noneVal(st.boxShadow)) return true;
  if (st.borderColor || st.borderTopColor || st.borderBottomColor || st.borderLeftColor || st.borderRightColor) return true;
  if (st.backgroundColor || st.background) return true;
  if (st.textDecorationLine && st.textDecorationLine !== 'none') return true;
  if (st.textDecoration && st.textDecoration !== 'none') return true;
  return !noneVal(st.filter);
 }
 function prepRule(r) {
  var st = r.style, rm = setsOutlineNone(st), rep = setsReplacement(st), out = [];
  if (!rm && !rep) return out;
  String(r.selectorText).split(/,(?![^(]*\))/).forEach(function(part) {
   part = part.trim();
   if (!part || /:not\(\s*:focus/.test(part) || /:has\(/.test(part)) return;
   var compounds = part.split(/\s*[>+~]\s*|\s+(?![^(]*\))/), last = compounds[compounds.length - 1];
   var focus = /:focus/.test(last) || /:focus-within/.test(part);
   if (!rm && !focus) return;
   var sel = part.replace(/:focus-visible|:focus-within|:focus/g, '').trim();
   if (!sel || /[>+~]$/.test(sel)) sel += '*';
   
   out.push({ sel: sel, focus: focus, rm: rm, rep: rep && focus });
  });
  return out;
 }
 function isFocusable(el) {
  var t = el.localName;
  if (t === 'a') return el.hasAttribute('href');
  if (t === 'input') return (el.getAttribute('type') || '').toLowerCase() !== 'hidden';
  if (t === 'button' || t === 'select' || t === 'textarea' || t === 'summary') return true;
  if (el.hasAttribute('contenteditable') && el.getAttribute('contenteditable') !== 'false') return true;
  var ti = el.getAttribute('tabindex');
  return ti !== null && parseInt(ti, 10) >= 0;
 }
 function ruleFocus() {
  var scopes = new Map(), xo = 0;
  function walkRules(list, out) {
   for (var i = 0; i < list.length; i++) {
    var r = list[i];
    if (r.selectorText !== undefined && r.style) { prepRule(r).forEach(function(p) { out.push(p); }); }
    else if (typeof CSSMediaRule !== 'undefined' && r instanceof CSSMediaRule) { if (matchMedia(r.media.mediaText).matches) walkRules(r.cssRules, out); }
    else if (typeof CSSSupportsRule !== 'undefined' && r instanceof CSSSupportsRule) { if (CSS.supports(r.conditionText)) walkRules(r.cssRules, out); }
    else if (typeof CSSLayerBlockRule !== 'undefined' && r instanceof CSSLayerBlockRule) walkRules(r.cssRules, out);
    else if (r.styleSheet) sheet(r.styleSheet, out);
   }
  }
  function sheet(sh, out) {
   var list;
   try { list = sh.cssRules; } catch (e) { xo++; return; }
   if (list) walkRules(list, out);
  }
  function scopeFor(rt) {
   var s = scopes.get(rt);
   if (s) return s;
   s = [];
   scopes.set(rt, s);
   var sheets = [].slice.call(rt.styleSheets || []).concat([].slice.call(rt.adoptedStyleSheets || []));
   sheets.forEach(function(sh) { if (sh.disabled) return; if (sh.media && sh.media.mediaText && !matchMedia(sh.media.mediaText).matches) return; sheet(sh, s); });
   return s;
  }
  X.els.forEach(function(el) {
   if (!isFocusable(el) || isDisabled(el) || !vis(el)) return;
   X.checked['a11y.focus-indicator']++;
   var rules = scopeFor(rootOf(el)), removal = false, repl = false, st = el.style;
   if (st && setsOutlineNone(st)) removal = true;
   for (var i = 0; i < rules.length; i++) {
    var p = rules[i];
    if (!((p.rm && !removal) || (p.rep && !repl))) continue;
    var hit = false;
    try { hit = el.matches(p.sel); } catch (e) {}
    if (!hit) continue;
    if (p.rm) removal = true;
    if (p.rep) repl = true;
   }
   if (removal && !repl) {
    add('a11y.focus-indicator', el, 'medium', {
     wcag: '2.4.7', heuristic: true, confidence: 'medium',
     note: 'Focus outline removed by author CSS; no :focus-visible style replaces it',
     fix: 'Add :focus-visible{outline:2px solid currentColor;outline-offset:2px}', measured: {}
    });
   }
  });
  if (xo) limit('cross-origin stylesheets not scanned: ' + xo);
 }

 function ruleLang() {
  X.checked['a11y.lang'] = 1;
  if (!/\S/.test(root.getAttribute('lang') || '')) {
   add('a11y.lang', root, 'medium', { wcag: '3.1.1', note: '<html> has no lang attribute', fix: 'Add lang="en" (or the page language) to <html>', measured: {} });
  }
 }
 function ruleTitle() {
  X.checked['a11y.page-title'] = 1;
  if (!/\S/.test(doc.title || '')) {
   var t = doc.querySelector('title');
   add('a11y.page-title', t || root, 'low', { wcag: '2.4.2', anchorEl: root, note: 'Page has no <title> text', fix: 'Add a short, unique <title> that names the page', measured: {} });
  }
 }
 function ruleViewportZoom() {
  var metas = doc.querySelectorAll('meta[name="viewport" i]');
  X.checked['a11y.viewport-zoom'] = metas.length;
  if (!metas.length) return;
  var m = metas[metas.length - 1], c = (m.getAttribute('content') || '').toLowerCase(), bad = false, max = -1;
  c.split(/[,;]/).forEach(function(kv) {
   var p = kv.split('='), k = (p[0] || '').trim(), v = (p[1] || '').trim();
   if (k === 'user-scalable' && (v === 'no' || v === '0')) bad = true;
   if (k === 'maximum-scale') { var n = parseFloat(v); if (!isNaN(n)) { max = n; if (n < 2) bad = true; } }
  });
  if (bad) add('a11y.viewport-zoom', m, 'medium', { wcag: '1.4.4', anchorEl: root, note: 'Viewport meta blocks pinch zoom (user-scalable=no or maximum-scale<2)', fix: 'Remove user-scalable=no and maximum-scale from the viewport meta', measured: { maxScale: max } });
 }

 function ruleHOverflow() {
 X.checked['layout.h-overflow'] = 1;
 var vw = X.vw, sw = se().scrollWidth;
 if (sw <= vw + 1) return;
 var bodyEl = doc.querySelector('body'), rs = gcs(root), bs = bodyEl ? gcs(bodyEl) : null;
 function clipX(v) { return v === 'hidden' || v === 'clip'; }
 if (clipX(rs.overflowX) || (rs.overflowX === 'visible' && bs && clipX(bs.overflowX))) {
  limit('horizontal overflow of ' + (sw - vw) + 'px is hidden by overflow-x on the root; not reported');
  return;
 }
 var cands = [];
 X.all.forEach(function(el) {
  if (el.ownerDocument !== doc || el === root) return;
  var cs = gcs(el);
  if (cs.visibility === 'hidden' || el.getClientRects().length === 0 || cs.transform !== 'none') return;
  var r = rectOf(el), o = Math.ceil(r.x + r.w - vw);
  if (o < 1 || lay(el).ovc) return;
  for (var p = el.parentElement; p && p !== root; p = p.parentElement) if (!lay(p).ovc && rectOf(p).x + rectOf(p).w > vw + 1 && gcs(p).visibility !== 'hidden') return;
  cands.push({ el: el, over: o, order: X.idx.get(el) });
 });
 cands.sort(function(a, b) { return b.over - a.over || a.order - b.order; });
 if (!cands.length) {
  add('layout.h-overflow', root, 'medium', { wcag: '1.4.10', confidence: 'medium', note: 'Page is ' + (sw - vw) + 'px wider than the viewport; source element not identified', fix: 'Constrain the widest element (images, tables, fixed widths)', measured: { over: sw - vw, vw: vw } });
  return;
 }
 cands.slice(0, 5).forEach(function(c) {
  add('layout.h-overflow', c.el, 'medium', { wcag: '1.4.10', note: 'Extends ' + c.over + 'px beyond the ' + vw + 'px viewport, causing horizontal scrolling', fix: 'Constrain its width (max-width:100%, wrapping) or let it scroll in its own container', measured: { over: c.over, vw: vw } });
 });
}

 function ruleTextSmall() {
  X.els.forEach(function(el) {
   if (NOTEXT[el.localName] || el.localName === 'sub' || el.localName === 'sup') return;
   var ti = textInfo(el);
   if (!ti) return;
   var cs = gcs(el), px = parseFloat(cs.fontSize);
   if (!(px >= 1)) return;
   X.checked['type.text-small']++;
   if (px >= 12 || !textVisible(el, ti)) return;
   if (/small-caps/.test(cs.fontVariantCaps || '') || el.closest('sub,sup')) return;
   px = Math.round(px * 10) / 10;
   add('type.text-small', el, px < 10 ? 'medium' : 'low', { wcag: '1.4.4', note: 'Text is ' + px + 'px; below 12px', fix: 'Use at least 12px (14-16px for body text)', measured: { px: px } });
  });
 }
 function ruleLineHeight() {
  X.els.forEach(function(el) {
   var cs0 = null;
   var ti = textInfo(el);
   if (!ti || ti.lines < 2 || NOTEXT[el.localName]) return;
   cs0 = gcs(el);
   if (cs0.display === 'inline' || headingLevel(el)) return;
   var lh = cs0.lineHeight;
   if (lh === 'normal') return;
   var l = parseFloat(lh), fs = parseFloat(cs0.fontSize);
   if (!(l > 0) || !(fs > 0)) return;
   X.checked['type.line-height']++;
   if (!textVisible(el, ti) || l >= 1.2 * fs - 0.05) return;
   add('type.line-height', el, 'low', {
    wcag: '1.4.12', note: 'Line height ' + fmt2(l) + 'px is ' + fmt2(l / fs) + '\u00d7 the ' + fmt2(fs) + 'px font size; at least 1.2\u00d7 is needed',
    fix: 'Set line-height to 1.5 (never below 1.2) on this text', measured: { lineHeight: fmt2(l), fontSize: fmt2(fs), lines: ti.lines }
   });
  });
 }

 function ruleTight() {
  var T = targets().filter(function(t) { return !t.inl && Math.min(t.r.w, t.r.h) < 44; });
  var grid = {}, CELL = 64;
  function cells(r, pad, fn) {
   for (var a = Math.floor((r.x - pad) / CELL); a <= Math.floor((r.x + r.w + pad) / CELL); a++)
    for (var b = Math.floor((r.y - pad) / CELL); b <= Math.floor((r.y + r.h + pad) / CELL); b++) fn(a + ',' + b);
  }
  T.forEach(function(t, i) { cells(t.r, 0, function(k) { (grid[k] = grid[k] || []).push(i); }); });
  T.forEach(function(t, j) {
   X.checked['spacing.tight-targets']++;
   var best = null, seen = {};
   cells(t.r, 8, function(k) {
    (grid[k] || []).forEach(function(i) {
     if (i >= j || seen[i]) return;
     seen[i] = 1;
     var u = T[i];
     if (u.el.contains(t.el) || t.el.contains(u.el)) return;
     var dx = Math.max(u.r.x - (t.r.x + t.r.w), t.r.x - (u.r.x + u.r.w), 0), dy = Math.max(u.r.y - (t.r.y + t.r.h), t.r.y - (u.r.y + u.r.h), 0);
     var gap = Math.sqrt(dx * dx + dy * dy);
     if (gap < 8 && (best === null || gap < best)) best = gap;
    });
   });
   if (best !== null) {
    best = Math.round(best * 10) / 10;
    add('spacing.tight-targets', t.el, 'low', { wcag: '2.5.8', note: 'Only ' + best + 'px from the previous small target (both under 44px)', fix: 'Leave at least 8px between small targets or enlarge them to 44px', measured: { gap: best } });
   }
  });
 }


 var X = null;
 function gcs(el) {
  if (!X) return el.ownerDocument.defaultView.getComputedStyle(el);
  var c = X.cs.get(el);
  if (!c) { c = el.ownerDocument.defaultView.getComputedStyle(el); X.cs.set(el, c); }
  return c;
 }
 function parentEl(el) { return el.parentElement || hostOf(el); }
 function frameOff(w) {
  if (w === window) return { x: 0, y: 0 };
  var o = X && X.fo ? X.fo.get(w) : null;
  if (!o) {
   o = { x: 0, y: 0 };
   try {
    var fe = w.frameElement, b = fe.getBoundingClientRect(), p = frameOff(fe.ownerDocument.defaultView);
    o = { x: b.left + fe.clientLeft + p.x, y: b.top + fe.clientTop + p.y };
   } catch (e) {}
   if (X) X.fo.set(w, o);
  }
  return o;
 }
 function toPage(b, el) {
  var o = frameOff(el.ownerDocument.defaultView);
  var sx = X ? X.sx : (window.pageXOffset || 0), sy = X ? X.sy : (window.pageYOffset || 0);
  return { x: b.left + o.x + sx, y: b.top + o.y + sy, w: b.width, h: b.height };
 }
 function rectOf(el) {
  var r = X && X.rc ? X.rc.get(el) : null;
  if (!r) { r = toPage(el.getBoundingClientRect(), el); if (X) X.rc.set(el, r); }
  return r;
 }
 function overlapArea(a, b) {
  var w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
 }
 var NOCLIP = /^rect\(\s*0(px)?[ ,]+0(px)?[ ,]+0(px)?[ ,]+0(px)?\s*\)$/;
 function lay(el) {
  var m = X && X.ly ? X.ly.get(el) : null;
  if (m) return m;
  var cs = gcs(el), p = parentEl(el), pm = p ? lay(p) : { op: 1, clip: null, hide: false, blend: false };
  var op = pm.op * (parseFloat(cs.opacity) || 0), clipR = pm.clip, hide = pm.hide;
  var tag = el.localName;
  if (tag !== 'html' && tag !== 'body') {
   var ox = cs.overflowX, oy = cs.overflowY, cx_ = ox === 'hidden' || ox === 'clip', cy_ = oy === 'hidden' || oy === 'clip';
   if (cx_ || cy_) {
    var r = rectOf(el), reg = { x: cx_ ? r.x : -1e9, y: cy_ ? r.y : -1e9, w: cx_ ? r.w : 2e9, h: cy_ ? r.h : 2e9 };
    if ((cx_ && r.w < 2) || (cy_ && r.h < 2)) hide = true;
    if (clipR) {
     var x0 = Math.max(clipR.x, reg.x), y0 = Math.max(clipR.y, reg.y);
     reg = { x: x0, y: y0, w: Math.min(clipR.x + clipR.w, reg.x + reg.w) - x0, h: Math.min(clipR.y + clipR.h, reg.y + reg.h) - y0 };
    }
    clipR = reg;
   }
  }
  if (cs.clip && cs.clip !== 'auto' && NOCLIP.test(cs.clip)) hide = true;
  if (/^inset\(\s*(50|100)%/.test(cs.clipPath || '')) hide = true;
  var blend = pm.blend || (cs.mixBlendMode && cs.mixBlendMode !== 'normal') || (cs.filter && cs.filter !== 'none') ||
   ((cs.backdropFilter || cs.webkitBackdropFilter || 'none') !== 'none');
  m = { op: op, clip: clipR, hide: hide, blend: !!blend, ovc: !!(pm.ovc || ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip' || cs.position === 'fixed') };
  if (X) X.ly.set(el, m);
  return m;
 }
 function vis(el) {
  var v = X.vs.get(el);
  if (v !== undefined) return v;
  v = false;
  var cs = gcs(el);
  if (cs.visibility === 'visible' && el.getClientRects().length > 0) {
   var L = lay(el), r = rectOf(el);
   v = L.op >= 0.01 && !L.hide && r.w > 0 && r.h > 0 && r.x + r.w > 0 && r.y + r.h > 0 && (!L.clip || overlapArea(L.clip, r) > 0);
  }
  X.vs.set(el, v);
  return v;
 }
 function inTree(el) {
  return gcs(el).visibility !== 'hidden' && el.getClientRects().length > 0 && !el.closest('[aria-hidden="true"]');
 }
 function isDisabled(el) { return !!el.closest('[disabled],[aria-disabled="true"],:disabled'); }
 var ranges = [];
 function rangeFor(el) {
  var d = el.ownerDocument;
  for (var i = 0; i < ranges.length; i++) if (ranges[i][0] === d) return ranges[i][1];
  var r = d.createRange(); ranges.push([d, r]);
  return r;
 }
 function textInfo(el) {
  var t = X.tx.get(el);
  if (t !== undefined) return t;
  t = null;
  var rg = null, x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, tops = {}, lines = 0, chars = 0;
  for (var c = el.firstChild; c; c = c.nextSibling) {
   if (c.nodeType !== 3 || !/\S/.test(c.nodeValue)) continue;
   chars += c.nodeValue.replace(/\s/g, '').length;
   rg = rg || rangeFor(el);
   rg.selectNodeContents(c);
   var rs = rg.getClientRects();
   for (var i = 0; i < rs.length; i++) {
    var b = toPage(rs[i], el);
    if (b.w <= 0 || b.h <= 0) continue;
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
    var k = Math.round(b.y / 3);
    if (!tops[k]) { tops[k] = 1; lines++; }
   }
  }
  if (chars && x1 > x0) t = { box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, lines: lines, chars: chars };
  X.tx.set(el, t);
  return t;
 }
 function textVisible(el, ti) {
  if (!ti) return false;
  var cs = gcs(el);
  if (cs.visibility !== 'visible') return false;
  var L = lay(el), b = ti.box;
  if (L.op < 0.01 || L.hide || b.x + b.w <= 0 || b.y + b.h <= 0) return false;
  return !L.clip || overlapArea(L.clip, b) > 0;
 }

 function pseudoText(el) {
  var out = '';
  ['::before', '::after'].forEach(function(ps) {
   var c = el.ownerDocument.defaultView.getComputedStyle(el, ps).content;
   if (!c || c === 'none' || c === 'normal') return;
   var m = /^(["'])([\s\S]*)\1$/.exec(c);
   if (!m) return;
   var s = m[2].replace(/\\([0-9a-f]{1,6}) ?/gi, function(a, h) { try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return ''; } });
   s = s.replace(/[\ue000-\uf8ff]/g, '');
   out += s;
  });
  return out;
 }
 function contentName(el, hidden, skipControls) {
  var out = '';
  (function walk(n, d) {
   if (d > 8) return;
   for (var c = n.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 3) { out += c.nodeValue + ' '; continue; }
    if (c.nodeType !== 1 || c.hasAttribute('data-pp-root')) continue;
    var tag = c.localName;
    if (tag === 'script' || tag === 'style' || tag === 'template' || tag === 'noscript') continue;
    if (skipControls && (tag === 'select' || tag === 'textarea' || tag === 'input' || tag === 'button')) continue;
    if (!hidden && (c.getAttribute('aria-hidden') === 'true' || gcs(c).display === 'none')) continue;
    var al = c.getAttribute('aria-label');
    if (al && /\S/.test(al)) { out += al + ' '; continue; }
    if (tag === 'img' || (tag === 'input' && c.getAttribute('type') === 'image')) { out += (c.getAttribute('alt') || c.getAttribute('title') || '') + ' '; continue; }
    if (tag === 'svg') {
     var ti = c.querySelector('title');
     out += (ti ? ti.textContent : c.getAttribute('title') || '') + ' ';
     continue;
    }
    if (!hidden) out += pseudoText(c);
    walk(c, d + 1);
   }
  })(el, 0);
  if (!hidden) out += pseudoText(el);
  return out.replace(/\s+/g, ' ').trim();
 }
 function refText(el, attr) {
  var ids = (el.getAttribute(attr) || '').split(/\s+/).filter(Boolean), rt = rootOf(el), out = '';
  ids.forEach(function(id) {
   var t = (rt.getElementById ? rt.getElementById(id) : null) || el.ownerDocument.getElementById(id);
   if (t) out += ' ' + (t.getAttribute('aria-label') || contentName(t, true, false));
  });
  return out.trim();
 }
 function attrName(el) {
  var v = refText(el, 'aria-labelledby');
  if (v) return v;
  v = el.getAttribute('aria-label');
  return v && /\S/.test(v) ? v.trim() : '';
 }

 var RULE_META = {};
 function add(rule, el, sev, o) {
  o = o || {};
  X.raw.push({ rule: rule, el: el, sev: sev, o: o, order: X.idx.get(el) == null ? 1e9 : X.idx.get(el) });
 }
 function skip(rule, why) {
  var s = X.skipped[rule] || (X.skipped[rule] = {});
  s[why] = (s[why] || 0) + 1;
 }
 function limit(s) { if (X.limits.indexOf(s) < 0) X.limits.push(s); }

 function collect() {
  var all = [], xframes = 0, maybeClosed = 0;
  function walkRoot(rt, depth) {
   var tw = doc.createTreeWalker(rt, 1, {
    acceptNode: function(n) {
     if (SKIP_TAGS[n.nodeName] && n.nodeName !== 'HEAD') return 2;
     if (n.nodeName === 'HEAD') return 2;
     if (!X.opts._overlay && n.hasAttribute('data-pp-root')) return 2;
     if (n.namespaceURI === 'http://www.w3.org/2000/svg' && n.localName !== 'svg') return 2;
     return 1;
    }
   });
   for (var n = tw.nextNode(); n; n = tw.nextNode()) {
    all.push(n);
    if (n.shadowRoot) walkRoot(n.shadowRoot, depth);
    else if (n.localName.indexOf('-') > 0 && n.childNodes.length === 0 && window.customElements && customElements.get(n.localName)) maybeClosed++;
    if (n.localName === 'iframe' || n.localName === 'frame') {
     var cd = null;
     try { cd = n.contentDocument; } catch (e) {}
     if (cd && cd.documentElement && depth < 2) walkRoot(cd, depth + 1);
     else if (!cd || depth >= 2) xframes++;
    }
   }
  }
  walkRoot(doc, 0);
  if (xframes) limit('iframes not scanned (cross-origin or deeper than 2): ' + xframes);
  if (maybeClosed) limit('possible closed shadow roots not scanned: ' + maybeClosed);
  return all;
 }

 var SEV_RANK = { high: 0, medium: 1, low: 2 };
 var SEV_W = { high: 8, medium: 4, low: 1 };
 var RULES = [];

 function describe(el) {
  var s = el.localName, cl = stableClasses(el)[0];
  if (cl) s += '.' + cl;
  var t = sanitize(textOf(el, 60));
  if (el.localName === 'html' || el.localName === 'body') t = '';
  if (t) {
   var room = 40 - s.length - 3;
   if (room > 1) s += " '" + (t.length > room ? t.slice(0, room - 1) + '\u2026' : t) + "'";
  }
  return clip(sanitize(s), 40);
 }
 function anchorOf(el) {
  var tx = textOf(el, 80);
  if (el.localName === 'html' || el.localName === 'body') tx = '';
  return {
   tag: el.localName, role: roleOf(el), name: clip(sanitize(el.getAttribute('aria-label') || tx || el.getAttribute('alt') || ''), 40),
   textHash: fnv1a(normText(tx)), ref: clip(sanitize(el.getAttribute('id') || ''), 80), path: clip(sanitize(ancestorPath(el)), 120),
   nameAttr: clip(sanitize(el.getAttribute('name') || ''), 60), sig: anchorSig(el)
  };
 }
 function roundRect(r) { return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) }; }
 function anchorSig(el) { return el.localName + '|' + stableKey(el) + '|' + clip(sanitize(ancestorPath(el)), 120); }
 function fmtPx(v) { var n = parseFloat(v); return isNaN(n) ? '0px' : (Math.round(n * 10) / 10) + 'px'; }
 function fmtBox(cs, p) {
  var t = Math.round(parseFloat(cs[p + 'Top']) || 0), r = Math.round(parseFloat(cs[p + 'Right']) || 0);
  var b = Math.round(parseFloat(cs[p + 'Bottom']) || 0), l = Math.round(parseFloat(cs[p + 'Left']) || 0);
  return t === r && r === b && b === l ? t + 'px' : t === b && r === l ? t + 'px ' + r + 'px' : t + 'px ' + r + 'px ' + b + 'px ' + l + 'px';
 }
 function fmtBorder(cs) {
  var bw = Math.round(parseFloat(cs.borderTopWidth) || 0), bs = cs.borderTopStyle || 'none', bc = parseColor(cs.borderTopColor);
  return bw > 0 && bs !== 'none' ? bw + 'px ' + bs + (bc ? ' ' + hex(bc) : '') : '0px none';
 }
 function inspect(target) {
  var el = null;
  if (!target) el = selectedEl && selectedEl.isConnected ? selectedEl : null;
  else if (typeof target === 'string') el = resolveSel(target);
  else if (target && target.nodeType === 1) el = target;
  if (!el || el.nodeType !== 1 || inOverlay(el) || !el.isConnected) return null;
  var cs = gcs(el), r = roundRect(toPage(el.getBoundingClientRect(), el));
  var fgC = parseColor(cs.color), bgCol = composite(el, { r: 0, g: 0, b: 0, a: 0 });
  if (!bgCol) { var dc = parseColor(cs.backgroundColor); bgCol = dc && dc.a > 0 ? over(dc, canvasFor(el)) : canvasFor(el); }
  var fgEff = fgC ? (composite(el, fgC) || (fgC.a < 1 ? over(fgC, bgCol) : fgC)) : null;
  var cr = fgEff && bgCol ? fmt2(ratio(fgEff, bgCol)) : null;
  var sel = clip(sanitize(selectorFor(el)), 200);
  var pEl = el.parentElement && !inOverlay(el.parentElement) ? el.parentElement : null;
  var pSel = pEl ? clip(sanitize(selectorFor(pEl)), 200) : null;
  var fList = [];
  if (lastAudit && Array.isArray(lastAudit.findings)) {
   lastAudit.findings.forEach(function(f) {
    if (f && f.selector === sel) fList.push({ id: f.id, rule: f.rule, sev: f.sev, note: f.note, fix: f.fix });
   });
  }
  var kids = 0;
  if (el.children) {
   for (var i = 0; i < el.children.length; i++) if (!inOverlay(el.children[i])) kids++;
  }
  var rawName = el_text(el) || (el.localName === 'html' || el.localName === 'body' ? '' : textOf(el, 60)) || '';
  var ff = (cs.fontFamily || '').split(',')[0].replace(/['"]/g, '').trim();
  return {
   selector: sel,
   tag: el.localName || '',
   role: roleOf(el) || '',
   name: clip(sanitize(rawName), 80),
   label: describe(el),
   rect: r,
   boxModel: { margin: fmtBox(cs, 'margin'), padding: fmtBox(cs, 'padding'), border: fmtBorder(cs) },
   typography: {
    fontFamily: clip(sanitize(ff), 60),
    fontSize: fmtPx(cs.fontSize),
    fontWeight: clip(sanitize(String(cs.fontWeight || '400')), 20),
    lineHeight: cs.lineHeight === 'normal' ? 'normal' : fmtPx(cs.lineHeight),
    color: fgC ? hex(fgC) : clip(sanitize(cs.color || ''), 30)
   },
   layout: {
    display: clip(sanitize(cs.display || ''), 30),
    position: clip(sanitize(cs.position || ''), 30),
    flexDirection: clip(sanitize(cs.flexDirection || ''), 30),
    justifyContent: clip(sanitize(cs.justifyContent || ''), 40),
    alignItems: clip(sanitize(cs.alignItems || ''), 40),
    gap: clip(sanitize(!cs.gap || cs.gap === 'normal' ? '0px' : cs.gap), 30),
    zIndex: clip(sanitize(cs.zIndex || 'auto'), 20)
   },
   colors: {
    fg: fgC ? hex(fgC) : clip(sanitize(cs.color || ''), 30),
    bg: bgCol ? hex(bgCol) : '#ffffff',
    contrastRatio: cr
   },
   parentSelector: pSel,
   childCount: kids,
   findings: fList
  };
 }

 function audit(opts) {
  var t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  opts = opts || {};
  var res = {
   protocol: PROTOCOL, url: clip(location.href, 300), key: urlKey(location.href), title: '', viewport: { w: 0, h: 0, dpr: 1 },
   scroll: { w: 0, h: 0 }, t: now(), score: 100, counts: { high: 0, medium: 0, low: 0 }, byRule: {}, findings: [],
   stats: { elements: 0, ms: 0, checked: {}, skipped: {} }, limits: [], errors: []
  };
  try {
   res.title = clip(sanitize(doc.title), 80);
   res.viewport = { w: se().clientWidth, h: se().clientHeight, dpr: window.devicePixelRatio || 1 };
   res.scroll = { w: se().scrollWidth, h: se().scrollHeight };
   X = {
    opts: opts, cs: new Map(), fo: new Map(), rc: new Map(), ly: new Map(), vs: new Map(), tx: new Map(), idx: new Map(),
    raw: [], skipped: {}, checked: {}, limits: [], sx: window.pageXOffset || 0, sy: window.pageYOffset || 0,
    tapMin: opts.tapMin > 0 ? opts.tapMin : 24, tapAdv: opts.tapAdvisory === undefined ? 44 : opts.tapAdvisory,
    aaa: opts.contrast === 'AAA', vw: se().clientWidth, vh: se().clientHeight
   };
   var all = collect();
   all.forEach(function(e, i) { X.idx.set(e, i); });
   X.all = all;
   X.els = all;
   res.stats.elements = all.length;
   res.presentAnchors = all.slice(0, 2000).map(anchorSig);
   if (all.length > 5000) {
    var lo = X.sy - 2 * X.vh, hi = X.sy + 3 * X.vh;
    X.els = all.filter(function(e) { var r = rectOf(e); return r.y + r.h >= lo && r.y <= hi; });
    limit('large page (' + all.length + ' elements): audited the viewport +- 2 screens only');
   }
   var want = Array.isArray(opts.rules) && opts.rules.length ? opts.rules : null;
   if (want) want.forEach(function(r) { if (!RULE_META[r]) res.errors.push({ rule: String(r), message: 'unknown rule' }); });
   RULES.forEach(function(rl) {
    if (want && want.indexOf(rl.id) < 0) return;
    X.checked[rl.id] = 0;
    try { rl.fn(); } catch (e) { res.errors.push({ rule: rl.id, message: clip(sanitize(e && e.message), 120) }); }
   });
   finish(res, opts);
  } catch (e) {
   res.errors.push({ rule: 'engine', message: clip(sanitize(e && e.message), 120) });
  }
  res.stats.ms = Math.round(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0) * 10) / 10;
  if (X) {
   res.stats.checked = X.checked; res.stats.skipped = X.skipped; res.limits = X.limits.slice();
   var erroredRules = {};
   (res.errors || []).forEach(function(e) { if (e && e.rule) erroredRules[e.rule] = 1; });
   var covered = [];
   for (var k in X.checked) {
    if (Object.prototype.hasOwnProperty.call(X.checked, k) && !erroredRules[k]) covered.push(k);
   }
   // Coverage for absence-based deltas requires complete finding reporting.
   // A truncated list or failed finalization cannot disprove an old finding.
   res.rules_covered = erroredRules.engine || res.limits.some(function(s) { return /truncat/i.test(s); }) ? [] : covered;
  }
  X = null;
  dirty = false;
  lastAudit = res;
  if (opts && opts.inspectSelector) {
   try { res.inspected = inspect(opts.inspectSelector); } catch (e) { res.inspected = null; }
  }
  return res;
 }
 var lastAudit = null, rankOf = {};

 function finish(res, opts) {
  var seen = {}, sup = {};
  (opts.suppress || []).forEach(function(s) { sup[s] = 1; });
  var items = [];
  X.raw.forEach(function(r) {
   var fp = fingerprint(r.rule, r.el, r.o.variant), n = seen[fp] = (seen[fp] || 0) + 1;
   r.id = idFor(r.rule, r.el, r.o.variant, n > 1 ? n - 1 : 0);
   if (!sup[r.id]) items.push(r);
  });
  items.sort(function(a, b) {
   return SEV_RANK[a.sev] - SEV_RANK[b.sev] || a.order - b.order || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0) || (a.id < b.id ? -1 : 1);
  });
  var perRule = {}, penalty = 0;
  items.forEach(function(r) {
   var n = perRule[r.rule] = (perRule[r.rule] || 0) + 1;
   penalty += SEV_W[r.sev] * (n <= 5 ? 1 : 0.25);
   res.counts[r.sev]++;
  });
  res.byRule = perRule;
  res.score = Math.max(0, Math.min(100, Math.floor(100 - penalty + 0.5)));
  var max = opts.maxFindings > 0 ? opts.maxFindings : 200, kept = items.slice(0, max);
  if (items.length > kept.length) limit('findings truncated: showing ' + kept.length + ' of ' + items.length);
  rankOf = {};
  kept.forEach(function(r, i) {
   var o = r.o, rc = o.rect || rectOf(o.anchorEl || r.el);
   var f = {
    id: r.id, rule: r.rule, sev: r.sev
   };
   if (o.wcag) f.wcag = o.wcag;
   if (o.heuristic) f.heuristic = true;
   f.confidence = o.confidence || 'high';
   f.selector = clip(sanitize(selectorFor(r.el)), 200);
   f.label = describe(r.el);
   f.note = clip(sanitize(o.note), 200);
   f.fix = clip(sanitize(o.fix), 200);
   f.measured = o.measured || {};
   f.rect = roundRect(rc);
   f.anchor = anchorOf(r.el);
   f.pin = i + 1;
   rankOf[f.id] = i;
   res.findings.push(f);
  });
 }

 function register(id, fn, meta) { RULE_META[id] = meta || {}; RULES.push({ id: id, fn: fn }); }

 register('a11y.contrast', ruleContrast, { sev: 'high' });
 register('a11y.tap-target', ruleTap);
 register('a11y.img-alt', ruleImgAlt);
 register('a11y.form-label', ruleFormLabel);
 register('a11y.control-name', ruleControlName);
 register('a11y.heading-order', ruleHeadingOrder);
 register('a11y.focus-indicator', ruleFocus);
 register('a11y.lang', ruleLang);
 register('a11y.page-title', ruleTitle);
 register('a11y.viewport-zoom', ruleViewportZoom);
 register('layout.h-overflow', ruleHOverflow);
 register('type.text-small', ruleTextSmall);
 register('type.line-height', ruleLineHeight);
 register('spacing.tight-targets', ruleTight);

 var overlayHost = null, sh = null, svgEl = null, pinsEl = null, hoverEl = null, tipEl = null, cardEl = null, inspBoxEl = null, inspHudEl = null;
 var entries = [], statusMap = {}, openId = '', hoverId = '', rafP = false, lastSum = '';
 var inspectMode = false, inspectLocked = false, selectedEl = null, inspectHoverEl = null;
 var COL = { high: '#e5484d', medium: '#f5a623', low: '#3b82f6', fixed: '#30a46c', dismissed: '#8b8d98' };
 var OFF = [[26, 0], [0, 26], [-26, 0], [0, -26], [26, 26], [-26, 26], [26, -26], [-26, -26]];
 function col(k) { return (config.colors && config.colors[k]) || COL[k]; }
 function mk(tag, cls, text) {
  var e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
 }
 function overlayCss() {return ['*{box-sizing:border-box}[hidden]{display:none!important}','.lines{position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible}','.hover,.tip,.card,.ibox,.ihud{position:absolute;left:0;top:0}','.hover{border:2px dashed #111;outline:2px dashed #fff;pointer-events:none}.hover.flash{animation:pp-f 1.2s ease-out}','.ibox{border:2px solid #2563eb;background:rgba(37,99,235,.08);outline:1px dashed #fff;pointer-events:none}.ibox.locked{border-color:#7c3aed;background:rgba(124,58,237,.1)}','.ihud{background:#111;color:#fff;font:11px/1.35 ui-monospace,monospace;padding:6px 8px;border-radius:6px;max-width:300px;pointer-events:none;box-shadow:0 4px 14px rgba(0,0,0,.35)}','.ihud .ht{font-weight:700;color:#93c5fd;margin-bottom:2px}.ihud .hm{color:#e5e7eb}','.pin{position:absolute;left:0;top:0;width:24px;height:24px;border-radius:50%;border:2px solid #fff;padding:0;margin:0;font:700 12px/1 system-ui,sans-serif;color:#000;cursor:pointer;pointer-events:auto;box-shadow:0 1px 4px rgba(0,0,0,.5)}','.pin:focus-visible,.card button:focus-visible,.card input:focus-visible{outline:3px solid #111;outline-offset:2px}','.pin.high{background:' + col('high') + '}.pin.medium{background:' + col('medium') + '}.pin.low{background:' + col('low') + '}','.pin.fixed{background:' + col('fixed') + '}.pin.dismissed{background:' + col('dismissed') + '}','.pin.new::after{content:"";position:absolute;left:-6px;top:-6px;right:-6px;bottom:-6px;border-radius:50%;border:2px solid #111;animation:pp-p 1.4s ease-out infinite}','.tip{background:#111;color:#fff;font:12px/1.4 system-ui,sans-serif;padding:4px 8px;border-radius:6px;max-width:260px;pointer-events:none}','.card{width:288px;background:#fff;color:#111;border:1px solid #c8c8d0;border-radius:8px;padding:10px;font:13px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.3);pointer-events:auto}','.card p{margin:4px 0}.card .ch{font-weight:700}.card .meta{font:11px/1.35 ui-monospace,monospace;color:#333;background:#f4f4f6;padding:4px 6px;border-radius:4px;margin:4px 0}','.card .row{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}','.card button{min-height:28px;min-width:28px;padding:0 8px;border:1px solid #555;background:#f2f2f5;color:#111;border-radius:6px;font:600 12px system-ui,sans-serif;cursor:pointer}','.card button.chip{font:500 11px system-ui,sans-serif;padding:0 6px}','.card button.go{background:#111;color:#fff}','.card input{width:100%;min-height:28px;padding:4px 6px;border:1px solid #555;border-radius:6px;font:12px system-ui,sans-serif;color:#111;background:#fff;margin-top:6px}','@keyframes pp-p{from{opacity:1;transform:scale(.8)}to{opacity:0;transform:scale(1.4)}}@keyframes pp-f{0%,60%{outline-width:6px}100%{outline-width:2px}}','@media (prefers-reduced-motion:reduce){.pin.new::after,.hover.flash{animation:none}}'].join('');}
 function ensureOverlay() {
  if (overlayHost) { if (!overlayHost.isConnected) root.appendChild(overlayHost); return; }
  overlayHost = mk('div');
  overlayHost.setAttribute('data-pp-root', '');
  overlayHost.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;margin:0;padding:0;border:0;background:none;';
  sh = overlayHost.attachShadow({ mode: 'open' });
  sh.appendChild(mk('style', '', overlayCss()));
  svgEl = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svgEl.setAttribute('class', 'lines');
  svgEl.setAttribute('aria-hidden', 'true');
  pinsEl = mk('div'); hoverEl = mk('div', 'hover'); tipEl = mk('div', 'tip'); cardEl = mk('div', 'card');
  inspBoxEl = mk('div', 'ibox'); inspHudEl = mk('div', 'ihud');
  hoverEl.hidden = tipEl.hidden = cardEl.hidden = inspBoxEl.hidden = inspHudEl.hidden = true;
  [svgEl, hoverEl, inspBoxEl, pinsEl, tipEl, inspHudEl, cardEl].forEach(function(n) { sh.appendChild(n); });
  root.appendChild(overlayHost);
 }
 function teardown() {
  entries.forEach(function(e) { clearTimeout(e.timer); });
  entries = []; openId = ''; hoverId = '';
  if (pinsEl) { pinsEl.textContent = ''; svgEl.textContent = ''; hoverEl.hidden = tipEl.hidden = cardEl.hidden = true; }
  if (inspBoxEl && !inspectMode) { inspBoxEl.hidden = inspHudEl.hidden = true; }
  if (ro) { ro.disconnect(); ro.observe(root); }
 }
 function removeOverlay() {
  inspectMode = false; inspectLocked = false; selectedEl = null; inspectHoverEl = null;
  teardown();
  if (overlayHost && overlayHost.parentNode) overlayHost.parentNode.removeChild(overlayHost);
  overlayHost = null;
 }
 function pinCount() { return entries.filter(function(e) { return !e.lost && !e.faded && !e.off; }).length; }
 function clear() { removeOverlay(); lastSum = ''; }

 function nodeHash(el) { return fnv1a(normText(el.localName === 'html' || el.localName === 'body' ? '' : textOf(el, 80))); }
 function resolveFinding(f) {
  var a = f.anchor || {}, el = resolveSel(f.selector);
  if (el && el.localName === a.tag && (nodeHash(el) === a.textHash || (a.ref && el.getAttribute('id') === a.ref))) return el;
  var list = a.tag ? doc.getElementsByTagName(a.tag) : [], best = null, bs = 0, r0 = f.rect || {};
  var want = String(a.path || '').split('>');
  for (var i = 0; i < list.length; i++) {
   var c = list[i];
   if (inOverlay(c)) continue;
   var s = 0, cp = ancestorPath(c).split('>'), m = 0;
   if (nodeHash(c) === a.textHash) s += 3;
   if (a.ref && c.getAttribute('id') === a.ref) s += 3;
   if (a.nameAttr && c.getAttribute('name') === a.nameAttr) s += 2;
   while (m < want.length && m < cp.length && want[m] === cp[m]) m++;
   s += 2 * m / Math.max(want.length, cp.length, 1);
   var b = c.getBoundingClientRect(), d = Math.hypot(b.left + b.width / 2 + window.pageXOffset - (r0.x + r0.w / 2), b.top + b.height / 2 + window.pageYOffset - (r0.y + r0.h / 2));
   s += d < 100 ? 1 : d < 400 ? 0.5 : 0;
   if (s > bs) { bs = s; best = c; }
  }
  return bs >= 4 ? best : null;
 }

 function clampN(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
 function place(ax, ay, vw, vh, placed) {
  var best = [ax, ay], bd = -1;
  for (var ring = 0; ring <= 8; ring++) {
   var offs = ring === 0 ? [[0, 0]] : OFF;
   for (var i = 0; i < offs.length; i++) {
    var x = clampN(ax + offs[i][0] * ring, 14, vw - 14), y = clampN(ay + offs[i][1] * ring, 14, vh - 14), md = 1e9;
    for (var j = 0; j < placed.length; j++) md = Math.min(md, Math.hypot(placed[j][0] - x, placed[j][1] - y));
    if (md >= 26) return [x, y];
    if (md > bd) { bd = md; best = [x, y]; }
   }
  }
  return best;
 }
 function lineFor(e) {
  if (!e.line) { e.line = doc.createElementNS('http://www.w3.org/2000/svg', 'line'); e.line.setAttribute('stroke-width', '1'); svgEl.appendChild(e.line); }
  return e.line;
 }
 function layout() {
  if (!overlayHost) return;
  if (!overlayHost.isConnected) root.appendChild(overlayHost);
  var vw = se().clientWidth, vh = se().clientHeight, placed = [];
  entries.forEach(function(e) {
   var hide = true;
   if (!e.faded) {
    if (!e.el || !e.el.isConnected) { e.el = resolveFinding(e.f); if (e.el && ro) ro.observe(e.el); }
    e.lost = !e.el;
    if (e.el) {
     var r;
     if (e.el === e.el.ownerDocument.documentElement || e.el.localName === 'body') r = { left: 0, top: 0, right: vw, bottom: vh, width: vw, height: vh };
     else { r = e.el.getBoundingClientRect(); if (!r.width || !r.height) r = { left: 0, top: 0, right: vw, bottom: vh, width: vw, height: vh }; }
     e.vr = r;
     if (!(r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh)) {
      var ax = clampN(r.left, 14, vw - 14), ay = clampN(r.top, 14, vh - 14), p = place(ax, ay, vw, vh, placed);
      placed.push(p);
      hide = false;
      if (e.px !== p[0] || e.py !== p[1]) { e.px = p[0]; e.py = p[1]; e.pin.style.transform = 'translate(' + (p[0] - 12) + 'px,' + (p[1] - 12) + 'px)'; }
      var ln = lineFor(e), far = Math.hypot(p[0] - ax, p[1] - ay) > 14;
      ln.style.display = far ? '' : 'none';
      if (far) { ln.setAttribute('x1', ax); ln.setAttribute('y1', ay); ln.setAttribute('x2', p[0]); ln.setAttribute('y2', p[1]); ln.setAttribute('stroke', col(e.f.sev)); }
     }
    }
   }
   e.off = hide && !e.lost && !e.faded;
  e.pin.hidden = hide;
   if (hide && e.line) e.line.style.display = 'none';
   if (hide && openId === e.f.id) closeCard();
   if (!hide && openId === e.f.id) {
    var cw = cardEl.offsetWidth, ch = cardEl.offsetHeight;
    cardEl.style.transform = 'translate(' + clampN(e.px + 16, 4, Math.max(4, vw - cw - 4)) + 'px,' + clampN(e.py + 16, 4, Math.max(4, vh - ch - 4)) + 'px)';
   }
   if (!hide && hoverId === e.f.id) showHover(e);
  });
  lastSum = sumRects();
 }
 function sumRects() {
  var s = '';
  entries.forEach(function(e) {
   if (e.el && e.el.isConnected) { var r = e.el.getBoundingClientRect(); s += Math.round(r.left) + ',' + Math.round(r.top) + ',' + Math.round(r.width) + ';'; } else s += 'x;';
  });
  return s;
 }
 function scheduleLayout() {
  if (rafP || !entries.length) return;
  rafP = true;
  requestAnimationFrame(function() { rafP = false; if (!destroyed) layout(); });
 }
 function short(rule) { return rule.slice(rule.indexOf('.') + 1); }
 function showHover(e) {
  var r = e.vr;
  if (!r) return;
  hoverEl.style.transform = 'translate(' + r.left + 'px,' + r.top + 'px)';
  hoverEl.style.width = Math.max(r.width, 4) + 'px'; hoverEl.style.height = Math.max(r.height, 4) + 'px';
  hoverEl.style.borderColor = col(e.f.sev);
  hoverEl.hidden = false;
 }
 function hideHover() { hoverId = ''; hoverEl.hidden = true; tipEl.hidden = true; if (openId) { var o = entries.filter(function(e) { return e.f.id === openId; })[0]; if (o) { hoverId = openId; showHover(o); } } }
 function closeCard() { openId = ''; if (cardEl) { cardEl.classList.remove('dcard'); cardEl.hidden = true; } }
 function openCard(e) {
  var f = e.f, m = f.measured || {};
  cardEl.textContent = '';
  cardEl.appendChild(mk('div', 'ch', '#' + e.num + ' \u00b7 ' + short(f.rule) + ' \u00b7 ' + f.sev));
  cardEl.appendChild(mk('p', '', f.note));
  var ms = Object.keys(m).map(function(k) { return k + ' ' + m[k]; }).join(', ');
  if (ms) cardEl.appendChild(mk('p', '', 'Measured: ' + ms));
  cardEl.appendChild(mk('p', '', 'Fix: ' + f.fix));
  var row = mk('div', 'row');
  [['Fix with Hermes', 'go', function() { push({ type: 'fix', id: f.id }); }],
   ['Dismiss', '', function() { push({ type: 'dismiss', id: f.id }); statusMap[f.id] = 'dismissed'; applyStatus(e); closeCard(); }],
   ['Copy selector', '', function(ev) {
    var b = ev.currentTarget;
    try { navigator.clipboard.writeText(f.selector).then(function() { b.textContent = 'Copied'; }, function() { b.textContent = 'Copy failed'; }); } catch (x) { b.textContent = 'Copy failed'; }
   }]].forEach(function(d) {
   var b = mk('button', d[1], d[0]);
   b.type = 'button';
   b.addEventListener('click', d[2]);
   row.appendChild(b);
  });
  cardEl.appendChild(row);
  cardEl.hidden = false; openId = f.id; hoverId = f.id;
  layout();
 }
 function applyStatus(e) {
  var s = statusMap[e.f.id] || 'open';
  e.pin.className = 'pin ' + e.f.sev + (s === 'open' ? '' : ' ' + s);
  e.pin.textContent = s === 'fixed' ? '\u2713' : String(e.num);
  e.pin.setAttribute('aria-label', 'Pinpoint ' + e.num + ': ' + short(e.f.rule) + (s === 'open' ? '' : ' (' + s + ')'));
  if (s === 'fixed' && !e.timer) e.timer = setTimeout(function() { e.faded = true; if (!destroyed) layout(); }, config.fadeMs >= 0 ? config.fadeMs : 8000);
  if (s !== 'fixed' && e.timer) { clearTimeout(e.timer); e.timer = 0; e.faded = false; }
 }
 function setStatuses(map) {
  try {
   Object.keys(map || {}).forEach(function(id) { statusMap[id] = map[id]; });
   entries.forEach(function(e) { if (map && map[e.f.id]) applyStatus(e); });
   layout();
  } catch (x) {}
 }
 function render(findings, opts) {
  var lost = [];
  try {
   opts = opts || {};
   var limit_ = opts.pinLimit > 0 ? opts.pinLimit : 60, list = (Array.isArray(findings) ? findings : []).filter(function(f) { return f && f.id && f.selector && f.anchor; });
   list = list.map(function(f, i) { return { f: f, i: i }; });
   function ord(f) { return rankOf[f.id] != null ? rankOf[f.id] : 1e6 + (f.rect ? f.rect.y * 10000 + f.rect.x : 0); }
   list.sort(function(a, b) { return SEV_RANK[a.f.sev] - SEV_RANK[b.f.sev] || ord(a.f) - ord(b.f) || a.i - b.i; });
   teardown();
   ensureOverlay();
   statusMap = {};
   Object.keys(opts.statuses || {}).forEach(function(k) { statusMap[k] = opts.statuses[k]; });
   list.forEach(function(it, idx) {
    if (entries.length >= limit_) return;
    var f = it.f, el = resolveFinding(f);
    if (!el) { lost.push(f.id); return; }
    if (typeof f.pin !== 'number') f.pin = idx + 1;
    var e = { f: f, el: el, num: f.pin, pin: mk('button', 'pin'), px: null, py: null };
    e.pin.type = 'button';
    e.pin.addEventListener('click', function(ev) { ev.stopPropagation(); push({ type: 'pin-click', id: f.id }); if (openId === f.id) closeCard(); else openCard(e); });
    e.pin.addEventListener('mouseenter', function() { hoverId = f.id; showHover(e); tipEl.textContent = f.note; tipEl.hidden = false; tipEl.style.transform = 'translate(' + (e.px + 16) + 'px,' + (e.py + 16) + 'px)'; });
    e.pin.addEventListener('focus', function() { hoverId = f.id; showHover(e); });
    e.pin.addEventListener('mouseleave', hideHover);
    e.pin.addEventListener('blur', hideHover);
    pinsEl.appendChild(e.pin);
    entries.push(e);
    applyStatus(e);
    if (ro) ro.observe(el);
   });
   layout();
  } catch (x) {}
  return { pinned: pinCount(), lost: lost };
 }
 function focusPin(id) {
  var e = entries.filter(function(n) { return n.f.id === id; })[0];
  if (!e) return false;
  if (!e.el || !e.el.isConnected) { e.el = resolveFinding(e.f); }
  if (!e.el) return false;
  try { e.el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (x) {}
  layout();
  hoverId = id; showHover(e);
  hoverEl.classList.remove('flash');
  void hoverEl.offsetWidth;
  hoverEl.classList.add('flash');
  setTimeout(function() { if (!destroyed && hoverEl) { hoverEl.classList.remove('flash'); if (hoverId === id && openId !== id) hideHover(); } }, 1300);
  return true;
 }
 function startTracking() {
  listen(window, 'scroll', scheduleLayout, { capture: true, passive: true });
  ['transitionend', 'animationend', 'load'].forEach(function(t) { listen(window, t, scheduleLayout, true); });
  listen(doc, 'pointermove', onInspectMove, true);
  listen(doc, 'click', onInspectClick, true);
  listen(doc, 'pointerdown', function(ev) { if (openId && openId !== '__design__' && !(ev.composedPath && ev.composedPath().indexOf(overlayHost) >= 0)) closeCard(); }, true);
  listen(doc, 'keydown', function(ev) {
   if (inspectMode) { onInspectKey(ev); return; }
   if (ev.key === 'Escape' && openId) closeCard();
  }, true);
  if (doc.fonts && doc.fonts.ready) doc.fonts.ready.then(scheduleLayout);
  wd = setInterval(function() { if (entries.length && doc.visibilityState === 'visible' && sumRects() !== lastSum) scheduleLayout(); }, 1000);
 }

 function showInspectHud(el, locked) {
  if (!el || !el.isConnected || inOverlay(el)) return;
  ensureOverlay();
  var info = inspect(el);
  if (!info) return;
  var r = el.getBoundingClientRect(), vw = se().clientWidth, vh = se().clientHeight;
  inspBoxEl.className = 'ibox' + (locked ? ' locked' : '');
  inspBoxEl.style.transform = 'translate(' + Math.round(r.left) + 'px,' + Math.round(r.top) + 'px)';
  inspBoxEl.style.width = Math.max(Math.round(r.width), 4) + 'px';
  inspBoxEl.style.height = Math.max(Math.round(r.height), 4) + 'px';
  inspBoxEl.hidden = false;
  inspHudEl.textContent = '';
  inspHudEl.appendChild(mk('div', 'ht', info.tag + ' · ' + info.selector + ' (' + info.rect.w + '×' + info.rect.h + ')'));
  inspHudEl.appendChild(mk('div', 'hm', 'pad ' + info.boxModel.padding + ' · mar ' + info.boxModel.margin + ' · ' + info.layout.display));
  inspHudEl.appendChild(mk('div', 'hm', info.typography.fontFamily + ' ' + info.typography.fontSize + '/' + info.typography.lineHeight + ' · ' + info.colors.fg + ' on ' + info.colors.bg + (info.colors.contrastRatio ? ' (' + info.colors.contrastRatio + ':1)' : '')));
  inspHudEl.hidden = false;
  var hw = inspHudEl.offsetWidth || 220, hh = inspHudEl.offsetHeight || 54;
  var hx = clampN(Math.round(r.left), 4, Math.max(4, vw - hw - 4));
  var hy = r.top > hh + 8 ? Math.round(r.top - hh - 6) : clampN(Math.round(r.bottom + 6), 4, Math.max(4, vh - hh - 4));
  inspHudEl.style.transform = 'translate(' + hx + 'px,' + hy + 'px)';
 }
 function openDesignCard(el) {
  var info = inspect(el);
  if (!info) return;
  ensureOverlay();
  cardEl.classList.add('dcard');
  cardEl.textContent = '';
  cardEl.appendChild(mk('div', 'ch', 'Design · ' + info.label));
  cardEl.appendChild(mk('div', 'meta', info.selector + ' · ' + info.rect.w + '×' + info.rect.h + ' · pad ' + info.boxModel.padding + ' · mar ' + info.boxModel.margin));
  cardEl.appendChild(mk('div', 'meta', info.typography.fontFamily + ' ' + info.typography.fontSize + ' (' + info.typography.fontWeight + ') · ' + info.colors.fg + ' / ' + info.colors.bg + (info.colors.contrastRatio ? ' (' + info.colors.contrastRatio + ':1)' : '')));
  var navRow = mk('div', 'row');
  [['↑ Parent', 'parent', 'Select parent element'],
   ['↓ Child', 'child', 'Select first child element'],
   ['← Prev', 'prev', 'Select previous sibling'],
   ['→ Next', 'next', 'Select next sibling']].forEach(function(n) {
   var nb = mk('button', 'chip', n[0]);
   nb.type = 'button';
   nb.setAttribute('aria-label', n[2]);
   nb.addEventListener('click', function(ev) { ev.stopPropagation(); inspectStep(n[1]); });
   navRow.appendChild(nb);
  });
  cardEl.appendChild(navRow);
  var inp = mk('input');
  inp.type = 'text';
  inp.placeholder = 'Design instruction for Hermes…';
  inp.setAttribute('aria-label', 'Design instruction for Hermes');
  var chipRow = mk('div', 'row');
  ['Spacing & alignment', 'Typography hierarchy', 'Contrast & polish', 'Responsive layout'].forEach(function(preset) {
   var cb = mk('button', 'chip dchip', preset);
   cb.type = 'button';
   cb.setAttribute('aria-label', 'Preset: ' + preset);
   cb.addEventListener('click', function(ev) {
    ev.stopPropagation();
    inp.value = inp.value ? inp.value + ' — ' + preset : preset;
   });
   chipRow.appendChild(cb);
  });
  cardEl.appendChild(chipRow);
  cardEl.appendChild(inp);
  var actRow = mk('div', 'row');
  [['Send to Hermes', 'go', 'Send selected element to Hermes', function(ev) {
    ev.stopPropagation();
    var fresh = inspect(el) || info;
    push({ type: 'design', target: fresh, note: clip(sanitize(inp.value || ''), 240) });
   }],
   ['Copy Selector', '', 'Copy CSS selector', function(ev) {
    ev.stopPropagation();
    var b = ev.currentTarget;
    try { navigator.clipboard.writeText(info.selector).then(function() { b.textContent = 'Copied'; }, function() { b.textContent = 'Copy failed'; }); } catch (x) { b.textContent = 'Copy failed'; }
   }],
   ['Close', '', 'Exit Design Mode', function(ev) {
    ev.stopPropagation();
    setInspectMode(false);
   }]].forEach(function(d) {
   var b = mk('button', d[1], d[0]);
   b.type = 'button';
   b.setAttribute('aria-label', d[2]);
   b.addEventListener('click', d[3]);
   actRow.appendChild(b);
  });
  cardEl.appendChild(actRow);
  cardEl.hidden = false;
  openId = '__design__';
  var r = el.getBoundingClientRect(), vw = se().clientWidth, vh = se().clientHeight;
  var cw = cardEl.offsetWidth || 288, ch = cardEl.offsetHeight || 220;
  var cx = clampN(Math.round(r.left), 4, Math.max(4, vw - cw - 4));
  var cy = clampN(Math.round(r.bottom + 8), 4, Math.max(4, vh - ch - 4));
  cardEl.style.transform = 'translate(' + cx + 'px,' + cy + 'px)';
 }
 function onInspectMove(ev) {
  if (!inspectMode || inspectLocked) return;
  if (ev.composedPath && ev.composedPath().indexOf(overlayHost) >= 0) return;
  var t = ev.target;
  if (!t || t.nodeType !== 1 || inOverlay(t)) return;
  inspectHoverEl = t;
  showInspectHud(t, false);
 }
 function onInspectClick(ev) {
  if (!inspectMode) return;
  if (ev.composedPath && ev.composedPath().indexOf(overlayHost) >= 0) return;
  var t = ev.target;
  if (!t || t.nodeType !== 1 || inOverlay(t)) return;
  ev.preventDefault();
  ev.stopPropagation();
  selectedEl = t;
  inspectHoverEl = t;
  inspectLocked = true;
  showInspectHud(t, true);
  openDesignCard(t);
  push({ type: 'inspect-select', target: inspect(t) });
 }
 function onInspectKey(ev) {
  var tg = ev.target;
  if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.isContentEditable)) {
   if (ev.key === 'Escape') { ev.preventDefault(); setInspectMode(false); }
   return;
  }
  if (ev.key === 'Escape') { ev.preventDefault(); setInspectMode(false); return; }
  var map = { ArrowUp: 'parent', ArrowDown: 'child', ArrowLeft: 'prev', ArrowRight: 'next' };
  if (map[ev.key]) { ev.preventDefault(); inspectStep(map[ev.key]); }
 }
 function setInspectMode(enabled) {
  inspectMode = !!enabled;
  inspectLocked = false;
  if (inspectMode) {
   ensureOverlay();
   var cur = selectedEl && selectedEl.isConnected ? selectedEl : (inspectHoverEl && inspectHoverEl.isConnected ? inspectHoverEl : null);
   if (cur) showInspectHud(cur, false);
  } else {
   if (inspBoxEl) inspBoxEl.hidden = true;
   if (inspHudEl) inspHudEl.hidden = true;
   if (openId === '__design__') closeCard();
  }
  return { inspecting: inspectMode, selected: selectedEl && selectedEl.isConnected ? inspect(selectedEl) : null };
 }
 function inspectStep(dir) {
  var cur = (selectedEl && selectedEl.isConnected ? selectedEl : null) || (inspectHoverEl && inspectHoverEl.isConnected ? inspectHoverEl : null) || doc.body || root;
  if (!cur) return null;
  var next = null;
  if (dir === 'parent') {
   var p = cur.parentElement;
   if (p && !inOverlay(p)) next = p;
  } else if (dir === 'child') {
   if (cur.children) {
    for (var i = 0; i < cur.children.length; i++) {
     if (!inOverlay(cur.children[i])) { next = cur.children[i]; break; }
    }
   }
  } else if (dir === 'prev') {
   var pv = cur.previousElementSibling;
   while (pv && inOverlay(pv)) pv = pv.previousElementSibling;
   if (pv) next = pv;
  } else if (dir === 'next') {
   var nx = cur.nextElementSibling;
   while (nx && inOverlay(nx)) nx = nx.nextElementSibling;
   if (nx) next = nx;
  }
  if (next) {
   selectedEl = next;
   inspectHoverEl = next;
   if (inspectMode) {
    inspectLocked = true;
    showInspectHud(next, true);
    openDesignCard(next);
   }
  }
  return selectedEl && selectedEl.isConnected ? inspect(selectedEl) : null;
 }

 function se() { return doc.scrollingElement || root; }
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
   url: clip(location.href, 60), key: clip(lastKey, 45),
   ready: doc.readyState === 'complete', pins: pinCount(), dirty: dirty,
   vw: se().clientWidth, vh: se().clientHeight, docVersion: docVersion,
   inspecting: !!inspectMode,
   selected: selectedEl && selectedEl.isConnected ? inspect(selectedEl) : null
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
  inspect: inspect, setInspectMode: setInspectMode, inspectStep: inspectStep,
  clear: clear, drain: drain, probe: probe, destroy: destroy
 };
 if (config.test === true) api.__test = testHooks();

 lastKey = urlKey(location.href);
 if (typeof MutationObserver === 'function') {
  mo = new MutationObserver(onMutations);
  startTracking();
  mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
 }
 if (typeof ResizeObserver === 'function') {
  ro = new ResizeObserver(function() { scheduleLayout(); });
  ro.observe(root);
 }
 listen(window, 'resize', function() { markDirty('resize'); scheduleLayout(); });
 listen(window, 'load', function() { markDirty('load'); scheduleLayout(); });
 listen(window, 'popstate', checkNavigation);
 listen(window, 'hashchange', checkNavigation);
 window.__pinpoint = api;
 return api;
}
