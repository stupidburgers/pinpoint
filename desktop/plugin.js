// GENERATED - do not edit. Source: desktop/src/app.js + desktop/src/bridge.js + engine/pinpoint-engine.js
// Rebuild: node scripts/build-desktop.mjs
import { host, PALETTE_AREA, PANES_AREA, STATUSBAR_AREAS, useValue, atom } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useState } from 'react'

const ID = 'pinpoint'
const VERSION = '0.1.0'

// Pure helpers for the Pinpoint desktop half. No SDK, no DOM, no side effects.
// Inlined into desktop/plugin.js by scripts/build-desktop.mjs
// (the `export ` keyword is stripped there) and unit-tested directly with `node --test`.

const REQUEST_CODES = ['no_preview', 'consent_denied', 'origin_blocked', 'page_unreachable', 'engine_error', 'navigated', 'page_mismatch']

// Control chars (C0, DEL, C1) and bidi overrides/isolates: page text is untrusted data.
const BAD_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g

function cleanText(value, cap) {
  const s = String(value == null ? '' : value).replace(BAD_CHARS, '').replace(/\s+/g, ' ').trim()
  if (!cap || s.length <= cap) return s
  return s.slice(0, Math.max(0, cap - 1)).trimEnd() + '\u2026'
}

// executeJavaScript rejection text -> wire code (SPEC 4.2 / 8.2)
function mapExecError(err) {
  const raw = err && err.message ? err.message : String(err == null ? '' : err)
  const m = raw.toLowerCase()
  let code = 'engine_error'
  if (m.includes('not allowed')) code = 'consent_denied'
  else if (m.includes('no preview page') || m.includes('no preview')) code = 'no_preview'
  else if (m.includes('changed origin') || m.includes('origin changed') || m.includes('navigat')) code = 'navigated'
  else if (m.includes('web origin') || m.includes('only on a web page') || m.includes('http or https') || m.includes('about:blank') || m.includes('data:') || m.includes('file:') || m.includes('only http') || m.includes('non-web')) code = 'origin_blocked'
  else if (m.includes('net::') || m.includes('unreachable') || m.includes('err_') || m.includes('timed out')) code = 'page_unreachable'
  return { code, message: cleanText(raw, 240) || 'Unknown error' }
}

function httpStatusOf(err) {
  if (err && typeof err.status === 'number') return err.status
  const m = /\b(4\d\d|5\d\d)\b/.exec(err && err.message ? err.message : String(err || ''))
  return m ? Number(m[1]) : 0
}

function isWebUrl(href) {
  return /^https?:\/\//i.test(String(href || ''))
}

// Same normalisation as the Python store (SPEC 4.3; table in tests/shared/url_key_cases.json).
// Engine/probe `key` is authoritative when present; this is the fallback for pages without an engine.
function urlKey(href) {
  let u
  try { u = new URL(String(href)) } catch (e) { return '' }
  const proto = u.protocol.toLowerCase()
  let key = proto + '//' + u.host.toLowerCase() + u.pathname.replace(/\/+$/, '')
  const q = []
  for (const part of u.search.replace(/^\?/, '').split('&')) {
    if (!part) continue
    const i = part.indexOf('=')
    const k = i < 0 ? part : part.slice(0, i), v = i < 0 ? '' : part.slice(i + 1)
    if (/^utm_/i.test(k) || /^(fbclid|gclid)$/i.test(k)) continue
    q.push([k, v])
  }
  q.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
  if (q.length) key += '?' + q.map(p => p[0] + '=' + p[1]).join('&')
  if (u.hash.startsWith('#/')) key += u.hash.replace(/\/+$/, '')
  return key
}

function originOf(href) {
  try { return new URL(String(href)).origin } catch (e) { return '' }
}

const SEV_RANK = { high: 0, medium: 1, low: 2 }

function sortFindings(findings) {
  return (findings || []).map((f, i) => [f, i]).sort((a, b) => {
    const ra = SEV_RANK[a[0].sev] ?? 3, rb = SEV_RANK[b[0].sev] ?? 3
    return ra - rb || (a[0].pin || 1e9) - (b[0].pin || 1e9) || a[1] - b[1]
  }).map(p => p[0])
}

function groupBySeverity(findings) {
  const out = { high: [], medium: [], low: [] }
  for (const f of sortFindings(findings)) (out[f.sev] || out.low).push(f)
  return out
}

// ----- prompts (SPEC 8.5) -----
const MAX_PROMPT = 700

function buildPinPrompt(f, url, pinNo) {
  const id = cleanText(f.id, 80)
  const n = pinNo || f.pin || '?'
  const meas = f.measured || {}
  const colors = meas.fg && meas.bg ? ' (fg ' + cleanText(meas.fg, 24) + ' on ' + cleanText(meas.bg, 24) + ')' : ''
  const make = caps => {
    const sel = cleanText(f.selector, caps.sel).replace(/`/g, "'")
    const lines = [
      'Pinpoint: fix pin #' + n + ' [' + cleanText(f.rule, 40) + '] on ' + cleanText(url, caps.url),
      'Element: ' + cleanText(f.label, caps.label) + '  selector: `' + sel + '`',
      'Measured: ' + cleanText(f.note, caps.note) + colors + (f.fix ? '. Suggested: ' + cleanText(f.fix, caps.fix) : ''),
      'Change the SOURCE (not built output). Pinpoint re-audits on reload; or call pinpoint_audit to verify. finding id: ' + id
    ]
    return lines.join('\n')
  }
  const tiers = [
    { url: 120, label: 40, sel: 200, note: 160, fix: 120 },
    { url: 80, label: 40, sel: 120, note: 100, fix: 80 },
    { url: 60, label: 24, sel: 80, note: 70, fix: 50 },
    { url: 40, label: 16, sel: 50, note: 40, fix: 30 }
  ]
  for (const t of tiers) { const s = make(t); if (s.length <= MAX_PROMPT) return s }
  return make(tiers[tiers.length - 1]).slice(0, MAX_PROMPT)
}

function buildFixAllPrompt(findings, url, max) {
  const cap = max || 8
  const list = sortFindings(findings).filter(f => f.sev === 'high').slice(0, cap)
  const lines = list.map(f =>
    '#' + (f.pin || '?') + ' [' + cleanText(f.rule, 32) + '] `' + cleanText(f.selector, 90).replace(/`/g, "'") + '` - ' + cleanText(f.note, 80) + ' (' + cleanText(f.id, 60) + ')')
  return ['Pinpoint: fix these ' + list.length + ' high-severity findings on ' + cleanText(url, 100), ...lines,
    'Change the SOURCE (not built output). Call pinpoint_audit afterwards to verify.'].join('\n')
}

// ----- rate limiter (SPEC 8.4) -----
function createRateLimiter(opts) {
  const o = Object.assign({ minGapMs: 2000, perMinute: 30, now: () => Date.now() }, opts || {})
  let last = -Infinity
  let stamps = []
  let paused = false
  return {
    // kind: 'auto' counts toward the per-minute budget, 'manual' only honours the gap
    tryAcquire(kind) {
      const t = o.now()
      if (kind === 'auto' && paused) return { ok: false, reason: 'paused', wait: 0 }
      if (t - last < o.minGapMs) return { ok: false, reason: 'gap', wait: o.minGapMs - (t - last) }
      if (kind === 'auto') {
        stamps = stamps.filter(s => t - s < 60000)
        if (stamps.length >= o.perMinute) { paused = true; return { ok: false, reason: 'paused', wait: 0 } }
        stamps.push(t)
      }
      last = t
      return { ok: true, reason: '', wait: 0 }
    },
    isPaused: () => paused,
    reset() { paused = false; stamps = [] }
  }
}

// ----- delta (mirror of the Python rule, used in desktop-only mode and as UI fallback) -----
function localDelta(prev, cur, seenIds) {
  if (!prev) return null
  const prevIds = new Set(prev.map(f => f.id))
  const seen = new Set(seenIds || [])
  prevIds.forEach(id => seen.add(id))
  const curIds = new Set(cur.map(f => f.id))
  const fixed = [...prevIds].filter(id => !curIds.has(id))
  const added = [...curIds].filter(id => !seen.has(id))
  const remaining = [...curIds].filter(id => prevIds.has(id)).length
  return { fixed, new: added, remaining }
}

function normalizeDelta(d) {
  if (!d || typeof d !== 'object') return null
  const arr = x => (Array.isArray(x) ? x.map(String) : [])
  if (!Array.isArray(d.fixed) && !Array.isArray(d.new)) return null
  return {
    prev_score: typeof d.prev_score === 'number' ? d.prev_score : null,
    fixed: arr(d.fixed), new: arr(d.new),
    remaining: typeof d.remaining === 'number' ? d.remaining : Array.isArray(d.remaining) ? d.remaining.length : 0
  }
}

function scoreToast(prevScore, score, fixedCount) {
  if (typeof prevScore !== 'number') return 'Pinpoint: score ' + score
  const diff = score - prevScore
  const sign = diff > 0 ? '+' : diff < 0 ? '\u2212' : '\u00b1'
  return 'Pinpoint: ' + prevScore + ' \u2192 ' + score + ' (' + sign + Math.abs(diff) + ')' + (fixedCount ? ', ' + fixedCount + ' fixed' : '')
}

// ----- misc -----
function parsePending(res) {
  const list = Array.isArray(res) ? res : res && Array.isArray(res.requests) ? res.requests : res && Array.isArray(res.pending) ? res.pending : []
  return list.map(x => ({ request_id: String(x.request_id || x.id || ''), args: x.args || {}, session_id: x.session_id || '' })).filter(x => x.request_id)
}

function buildAuditOpts(args, prefs, suppress) {
  const a = args || {}
  const p = prefs || {}
  const o = { maxFindings: 200, tapAdvisory: p.tapAdvisory === 0 ? 0 : 44, contrast: p.contrast === 'AAA' ? 'AAA' : 'AA' }
  if (Array.isArray(a.rules) && a.rules.length) o.rules = a.rules.map(String).slice(0, 20)
  if (suppress && suppress.length) o.suppress = suppress.slice(0, 400)
  return o
}

// Failure copy shown in the pane for each code
function errorCopy(code) {
  switch (code) {
    case 'consent_denied': return { title: 'Permission denied', body: 'Denied for this session. Restart Desktop, or revoke and re-grant under Capabilities \u203a Plugins \u203a Pinpoint.' }
    case 'no_preview': return { title: 'No page open', body: 'Open a page in the Browser pane (Ctrl+Shift+L), then press Audit.' }
    case 'origin_blocked': return { title: 'This page can\u2019t be audited', body: 'Only http(s) pages can be inspected. file:, data: and about:blank are refused by Desktop.' }
    case 'navigated': return { title: 'Page changed', body: 'The page moved to another site while auditing. Press Audit to try again.' }
    case 'page_unreachable': return { title: 'Page unreachable', body: 'The page did not respond. Check that your dev server is running, then press Audit.' }
    case 'page_mismatch': return { title: 'Different page open', body: 'The open page is not the one the agent asked about.' }
    default: return { title: 'Audit failed', body: 'The in-page audit stopped with an error. Reload the page and press Audit.' }
  }
}

function scoreTone(score) {
  return score >= 90 ? 'good' : score >= 60 ? 'warn' : 'bad'
}

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
      hex: hex, over: over
    };
  }

  //@@UTIL

  // ===== rules 1-5 =====
  function fmt2(n) { return Math.round(n * 100) / 100; }
  function canvasFor(el) {
    var d = el.ownerDocument, cs = d.defaultView.getComputedStyle(d.documentElement), sch = cs.colorScheme || '';
    var dark = /\bdark\b/.test(sch) && (!/\blight\b/.test(sch) || (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches));
    return dark ? { r: 18, g: 18, b: 18, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
  }
  function nodeBg(n) {
    var m = X.nb && X.nb.get(n);
    if (m) return m;
    X.nb = X.nb || new Map();
    var cs = gcs(n), bg = parseColor(cs.backgroundColor) || { r: 0, g: 0, b: 0, a: 0 };
    m = { bg: bg, img: cs.backgroundImage !== 'none' && cs.backgroundImage !== '', op: parseFloat(cs.opacity), pos: cs.position !== 'static' };
    if (isNaN(m.op)) m.op = 1;
    X.nb.set(n, m);
    return m;
  }
  function pseudoLayer(n) {
    var m = X.pl && X.pl.get(n);
    if (m !== undefined) return m;
    X.pl = X.pl || new Map();
    m = false;
    if (nodeBg(n).pos) {
      ['::before', '::after'].forEach(function (ps) {
        var c = n.ownerDocument.defaultView.getComputedStyle(n, ps);
        if (c.content === 'none' || c.content === 'normal' || c.display === 'none') return;
        if (c.position !== 'absolute' && c.position !== 'fixed') return;
        if (c.backgroundImage !== 'none' || (parseColor(c.backgroundColor) || { a: 0 }).a > 0.01) m = true;
      });
    }
    X.pl.set(n, m);
    return m;
  }
  // composite `start` (top layer) down through the ancestor chain; opacity applies to the group so far
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
    X.els.forEach(function (e) {
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
    X.els.forEach(function (el) {
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

  // ----- tap targets -----
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
    X.els.forEach(function (el) {
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
    T.forEach(function (t, i) {
      t.small = Math.round(Math.min(t.r.w, t.r.h) * 100) / 100 < min;
      t.cx = t.r.x + t.r.w / 2; t.cy = t.r.y + t.r.h / 2;
      cells(t.r, 24, function (k) { (grid[k] = grid[k] || []).push(i); });
    });
    T.forEach(function (t, i) {
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

  // ----- images -----
  var FILE_ALT = [/\.(png|jpe?g|gif|svg|webp)$/i, /^img[_-]?\d+/i];
  function ruleImgAlt() {
    X.els.forEach(function (el) {
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
      } else {
        if (named) return;
        msg = 'role="img" has no accessible name';
      }
      add('a11y.img-alt', el, 'high', { wcag: '1.1.1', note: msg, fix: 'Add alt text that describes the image purpose, or alt="" if purely decorative', measured: { w: Math.round(rc.w), h: Math.round(rc.h) } });
    });
  }

  // ----- form controls -----
  var NOLABEL = { hidden: 1, submit: 1, button: 1, reset: 1, image: 1 };
  function labelText(el) {
    var out = '', ls = el.labels;
    if (ls) for (var i = 0; i < ls.length; i++) out += ' ' + contentName(ls[i], true, true);
    return out.trim();
  }
  function ruleFormLabel() {
    X.els.forEach(function (el) {
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

  // ----- control names -----
  var NAMED_ROLES = /^(button|link|tab|menuitem)$/;
  function ruleControlName() {
    X.els.forEach(function (el) {
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

  // ===== rules 6-14 =====
  // ----- headings -----
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
    X.all.forEach(function (el) {
      var lv = headingLevel(el);
      if (lv && inTree(el)) hs.push({ el: el, level: lv });
    });
    X.checked['a11y.heading-order'] = hs.length;
    var prevL = 0, h1 = 0;
    hs.forEach(function (h) {
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

  // ----- focus indicator (static CSSOM scan, never calls focus()) -----
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
    String(r.selectorText).split(/,(?![^(]*\))/).forEach(function (part) {
      part = part.trim();
      if (!part || /:not\(\s*:focus/.test(part) || /:has\(/.test(part)) return;
      var compounds = part.split(/\s*[>+~]\s*|\s+(?![^(]*\))/), last = compounds[compounds.length - 1];
      var focus = /:focus/.test(last) || /:focus-within/.test(part);
      if (!rm && !focus) return;
      var sel = part.replace(/:focus-visible|:focus-within|:focus/g, '').trim();
      if (!sel || /[>+~]$/.test(sel)) sel += '*';
      sel = sel.replace(/([>+~])\s*$/, '$1 *');
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
        if (r.selectorText !== undefined && r.style) { prepRule(r).forEach(function (p) { out.push(p); }); }
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
      sheets.forEach(function (sh) { if (sh.disabled) return; if (sh.media && sh.media.mediaText && !matchMedia(sh.media.mediaText).matches) return; sheet(sh, s); });
      return s;
    }
    X.els.forEach(function (el) {
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
          note: 'Author CSS removes the focus outline and no :focus/:focus-visible rule replaces it (static CSS scan)',
          fix: 'Add :focus-visible { outline: 2px solid currentColor; outline-offset: 2px } for this element', measured: {}
        });
      }
    });
    if (xo) limit('cross-origin stylesheets not scanned: ' + xo);
  }

  // ----- page level -----
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
    c.split(/[,;]/).forEach(function (kv) {
      var p = kv.split('='), k = (p[0] || '').trim(), v = (p[1] || '').trim();
      if (k === 'user-scalable' && (v === 'no' || v === '0')) bad = true;
      if (k === 'maximum-scale') { var n = parseFloat(v); if (!isNaN(n)) { max = n; if (n < 2) bad = true; } }
    });
    if (bad) add('a11y.viewport-zoom', m, 'medium', { wcag: '1.4.4', anchorEl: root, note: 'Viewport meta blocks pinch zoom (user-scalable=no or maximum-scale<2)', fix: 'Remove user-scalable=no and maximum-scale from the viewport meta', measured: { maxScale: max } });
  }

  // ----- horizontal overflow -----
  function ruleHOverflow() {
    X.checked['layout.h-overflow'] = 1;
    var vw = X.vw, sw = root.scrollWidth;
    if (sw <= vw + 1) return;
    var bodyEl = doc.querySelector('body'), rs = gcs(root), bs = bodyEl ? gcs(bodyEl) : null;
    function clipX(v) { return v === 'hidden' || v === 'clip'; }
    if (clipX(rs.overflowX) || (rs.overflowX === 'visible' && bs && clipX(bs.overflowX))) {
      limit('horizontal overflow of ' + (sw - vw) + 'px is hidden by overflow-x on the root; not reported');
      return;
    }
    var hk = new Map();
    function blocked(el) {
      var v = hk.get(el);
      if (v !== undefined) return v;
      var p = el.parentElement;
      v = false;
      if (p && p !== root && p !== bodyEl) {
        var ps = gcs(p);
        v = (ps.overflowX !== 'visible') || ps.position === 'fixed' || blocked(p);
      }
      hk.set(el, v);
      return v;
    }
    var cands = [];
    function exceeds(el) { var r = rectOf(el); return r.x + r.w > vw + 1; }
    X.all.forEach(function (el) {
      if (el.ownerDocument !== doc || el === root) return;
      var cs = gcs(el);
      if (cs.visibility === 'hidden' || cs.position === 'fixed' || el.getClientRects().length === 0) return;
      if (!exceeds(el) || blocked(el)) return;
      var p = el.parentElement;
      if (p && p !== root && exceeds(p) && !blocked(p) && gcs(p).visibility !== 'hidden') return;
      var r = rectOf(el);
      cands.push({ el: el, over: Math.ceil(r.x + r.w - vw), order: X.idx.get(el) });
    });
    cands.sort(function (a, b) { return b.over - a.over || a.order - b.order; });
    if (!cands.length) {
      add('layout.h-overflow', root, 'medium', { wcag: '1.4.10', confidence: 'medium', note: 'Page is ' + (sw - vw) + 'px wider than the viewport; the source element was not identified', fix: 'Find the element wider than the viewport (images, tables, long words, fixed widths) and constrain it', measured: { over: sw - vw, vw: vw } });
      return;
    }
    cands.slice(0, 5).forEach(function (c) {
      add('layout.h-overflow', c.el, 'medium', { wcag: '1.4.10', note: 'Extends ' + c.over + 'px beyond the ' + vw + 'px viewport and causes horizontal scrolling', fix: 'Constrain its width (max-width:100%, wrapping) or let it scroll inside its own container', measured: { over: c.over, vw: vw } });
    });
  }

  // ----- typography -----
  function ruleTextSmall() {
    X.els.forEach(function (el) {
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
    X.els.forEach(function (el) {
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

  // ----- tight targets -----
  function ruleTight() {
    var T = targets().filter(function (t) { return !t.inl && Math.min(t.r.w, t.r.h) < 44; });
    var grid = {}, CELL = 64;
    function cells(r, pad, fn) {
      for (var a = Math.floor((r.x - pad) / CELL); a <= Math.floor((r.x + r.w + pad) / CELL); a++)
        for (var b = Math.floor((r.y - pad) / CELL); b <= Math.floor((r.y + r.h + pad) / CELL); b++) fn(a + ',' + b);
    }
    T.forEach(function (t, i) { cells(t.r, 0, function (k) { (grid[k] = grid[k] || []).push(i); }); });
    T.forEach(function (t, j) {
      X.checked['spacing.tight-targets']++;
      var best = null, seen = {};
      cells(t.r, 8, function (k) {
        (grid[k] || []).forEach(function (i) {
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

  //@@RULES

  // ===== audit context & geometry helpers =====
  var X = null;
  function gcs(el) {
    var c = X.cs.get(el);
    if (!c) { c = el.ownerDocument.defaultView.getComputedStyle(el); X.cs.set(el, c); }
    return c;
  }
  function parentEl(el) { return el.parentElement || hostOf(el); }
  function frameOff(w) {
    if (w === window) return { x: 0, y: 0 };
    var o = X.fo.get(w);
    if (!o) {
      o = { x: 0, y: 0 };
      try {
        var fe = w.frameElement, b = fe.getBoundingClientRect(), p = frameOff(fe.ownerDocument.defaultView);
        o = { x: b.left + fe.clientLeft + p.x, y: b.top + fe.clientTop + p.y };
      } catch (e) {}
      X.fo.set(w, o);
    }
    return o;
  }
  function toPage(b, el) {
    var o = frameOff(el.ownerDocument.defaultView);
    return { x: b.left + o.x + X.sx, y: b.top + o.y + X.sy, w: b.width, h: b.height };
  }
  function rectOf(el) {
    var r = X.rc.get(el);
    if (!r) { r = toPage(el.getBoundingClientRect(), el); X.rc.set(el, r); }
    return r;
  }
  function overlapArea(a, b) {
    var w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? w * h : 0;
  }
  var NOCLIP = /^rect\(\s*0(px)?[ ,]+0(px)?[ ,]+0(px)?[ ,]+0(px)?\s*\)$/;
  // per-node layer info: cumulative opacity, clip region, hidden/blend flags
  function lay(el) {
    var m = X.ly.get(el);
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
    m = { op: op, clip: clipR, hide: hide, blend: !!blend };
    X.ly.set(el, m);
    return m;
  }
  // visually rendered and perceivable
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
  // present in the accessibility tree (display/visibility only)
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
  // own non-blank text nodes: union box (page coords), distinct line count, char count
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

  // ===== name computation =====
  function pseudoText(el) {
    var out = '';
    ['::before', '::after'].forEach(function (ps) {
      var c = el.ownerDocument.defaultView.getComputedStyle(el, ps).content;
      if (!c || c === 'none' || c === 'normal') return;
      var m = /^(["'])([\s\S]*)\1$/.exec(c);
      if (!m) return;
      var s = m[2].replace(/\\([0-9a-f]{1,6}) ?/gi, function (a, h) { try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return ''; } });
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
    ids.forEach(function (id) {
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

  // ===== finding collection =====
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
        acceptNode: function (n) {
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
      nameAttr: clip(sanitize(el.getAttribute('name') || ''), 60)
    };
  }
  function roundRect(r) { return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) }; }

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
      res.viewport = { w: root.clientWidth, h: root.clientHeight, dpr: window.devicePixelRatio || 1 };
      res.scroll = { w: root.scrollWidth, h: root.scrollHeight };
      X = {
        opts: opts, cs: new Map(), fo: new Map(), rc: new Map(), ly: new Map(), vs: new Map(), tx: new Map(), idx: new Map(),
        raw: [], skipped: {}, checked: {}, limits: [], sx: window.pageXOffset || 0, sy: window.pageYOffset || 0,
        tapMin: opts.tapMin > 0 ? opts.tapMin : 24, tapAdv: opts.tapAdvisory === undefined ? 44 : opts.tapAdvisory,
        aaa: opts.contrast === 'AAA', vw: root.clientWidth, vh: root.clientHeight
      };
      var all = collect();
      all.forEach(function (e, i) { X.idx.set(e, i); });
      X.all = all;
      X.els = all;
      res.stats.elements = all.length;
      if (all.length > 5000) {
        var lo = X.sy - 2 * X.vh, hi = X.sy + 3 * X.vh;
        X.els = all.filter(function (e) { var r = rectOf(e); return r.y + r.h >= lo && r.y <= hi; });
        limit('large page (' + all.length + ' elements): audited the viewport +- 2 screens only');
      }
      var want = Array.isArray(opts.rules) && opts.rules.length ? opts.rules : null;
      if (want) want.forEach(function (r) { if (!RULE_META[r]) res.errors.push({ rule: String(r), message: 'unknown rule' }); });
      RULES.forEach(function (rl) {
        if (want && want.indexOf(rl.id) < 0) return;
        X.checked[rl.id] = 0;
        try { rl.fn(); } catch (e) { res.errors.push({ rule: rl.id, message: clip(sanitize(e && e.message), 120) }); }
      });
      finish(res, opts);
    } catch (e) {
      res.errors.push({ rule: 'engine', message: clip(sanitize(e && e.message), 120) });
    }
    res.stats.ms = Math.round(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0) * 10) / 10;
    if (X) { res.stats.checked = X.checked; res.stats.skipped = X.skipped; res.limits = X.limits.slice(); }
    X = null;
    dirty = false;
    lastAudit = res;
    return res;
  }
  var lastAudit = null, rankOf = {};

  function finish(res, opts) {
    var seen = {}, sup = {};
    (opts.suppress || []).forEach(function (s) { sup[s] = 1; });
    var items = [];
    X.raw.forEach(function (r) {
      var fp = fingerprint(r.rule, r.el, r.o.variant), n = seen[fp] = (seen[fp] || 0) + 1;
      r.id = idFor(r.rule, r.el, r.o.variant, n > 1 ? n - 1 : 0);
      if (!sup[r.id]) items.push(r);
    });
    items.sort(function (a, b) {
      return SEV_RANK[a.sev] - SEV_RANK[b.sev] || a.order - b.order || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0) || (a.id < b.id ? -1 : 1);
    });
    var perRule = {}, penalty = 0;
    items.forEach(function (r) {
      var n = perRule[r.rule] = (perRule[r.rule] || 0) + 1;
      penalty += SEV_W[r.sev] * (n <= 5 ? 1 : 0.25);
      res.counts[r.sev]++;
    });
    res.byRule = perRule;
    res.score = Math.max(0, Math.min(100, Math.floor(100 - penalty + 0.5)));
    var max = opts.maxFindings > 0 ? opts.maxFindings : 200, kept = items.slice(0, max);
    if (items.length > kept.length) limit('findings truncated: showing ' + kept.length + ' of ' + items.length);
    rankOf = {};
    kept.forEach(function (r, i) {
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
  //@@REGISTER-END

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

// ============================================================================
// State
// ============================================================================
const WIN = 'w' + Math.random().toString(36).slice(2, 8)
const FIXED_FADE_MS = 8000
const QUIET_MS = 800
const RESUME_QUIET_MS = 600
const ENGINE_METHODS = ['audit', 'render', 'setStatuses', 'focusPin', 'clear', 'drain', 'probe', 'destroy']

const initialUi = () => ({
  phase: 'idle',            // idle | running | result | error
  source: 'user',           // user | auto | agent
  startedAt: 0,
  error: null,              // { code, message }
  result: null,             // last AuditResult
  url: '',
  key: '',
  prevScore: null,
  delta: null,              // { prev_score, fixed[], new[], remaining }
  fixed: [],                // findings fixed in the last re-audit (shown green)
  dismissed: [],            // findings the user/agent marked intentional
  lost: [],                 // ids the engine could not locate
  selected: '',
  py: 'unknown',            // unknown | on | off
  paused: false,
  stale: false,             // page changed under us and has no stored pins
  cleared: false,
  autoReaudit: true,
  hasGrant: false,
  pinsShown: false
})
const $ui = atom(initialUi())
const setUi = patch => $ui.set({ ...$ui.get(), ...patch })

let C = null                         // PluginContext of the live registration
const M = {                          // module state (rebuilt on hot reload; the page probe re-adopts, see adopt())
  active: false, inflight: 0, auditing: 0, chain: Promise.resolve(), lock: Promise.resolve(), handled: new Set(), seq: 0,
  mem: {},                           // url_key -> { findings, dismissed, seen:Set, score }  (python store is the source of truth)
  limiter: createRateLimiter(),
  dirtySince: 0, lastVersion: -1, auditedVersion: -1, resume: null, lastMissingHref: '', skip: 0,
  stopPoll: null, pollMs: 0, fadeUndo: null
}

function log(msg, data) {
  let line = '[pinpoint] ' + msg
  if (data !== undefined) { try { line += ' ' + JSON.stringify(data).slice(0, 600) } catch (e) { /* ignore */ } }
  console.error(line)
}

// ============================================================================
// Page access: ONLY through ctx.preview.executeJavaScript (declared capability + per-origin consent)
// ============================================================================
function injectScript(cfg) {
  return '(function(){try{var api=(' + pinpointEngine.toString() + ')(' + JSON.stringify(cfg || {}) + ');return {ok:true,probe:api.probe()}}catch(e){return {ok:false,error:String(e&&e.message||e)}}})()'
}
function apiScript(method, args) {
  if (!ENGINE_METHODS.includes(method)) throw new Error('bad method ' + method)
  return '(function(){var p=window.__pinpoint;if(!p||p.protocol!==1)return {__missing:true,href:location.href};try{return {v:p.' + method + '.apply(p,' + JSON.stringify(args || []) + ')}}catch(e){return {__err:String(e&&e.message||e)}}})()'
}
// Serialise every call to the page: an unanswered consent dialog must never interleave with polling.
function exec(code) {
  M.inflight++
  const run = () => C.preview.executeJavaScript(code)
  const p = M.chain.then(run, run)
  M.chain = p.catch(() => {})
  return p.finally(() => { M.inflight-- })
}
async function callApi(method, args) {
  const r = await exec(apiScript(method, args))
  if (r && r.__err) throw new Error(r.__err)
  return r
}
async function inject() {
  const r = await exec(injectScript({ host: 'desktop', version: VERSION }))
  if (!r || !r.ok) { const e = new Error((r && r.error) || 'engine failed to install'); e.engine = true; throw e }
  return r.probe
}

// ============================================================================
// Python half (store, rendezvous). Missing/disabled => desktop-only mode.
// ============================================================================
const pyOn = () => $ui.get().py === 'on'
async function checkHealth() {
  try { await C.rest('/health'); if ($ui.get().py !== 'on') log('python half: on'); setUi({ py: 'on' }) } catch (e) { if ($ui.get().py !== 'off') log('python half: off (' + cleanText(e && e.message, 80) + ')'); setUi({ py: 'off' }) }
}
async function storeGet(key) {
  if (!pyOn()) return null
  try { return await C.rest('/store?url_key=' + encodeURIComponent(key)) } catch (e) { log('store get failed ' + cleanText(e && e.message, 80)); return null }
}
async function storePost(path, body) {
  if (!pyOn()) return null
  try { return await C.rest(path, { method: 'POST', body }) } catch (e) { log('POST ' + path + ' failed ' + cleanText(e && e.message, 80)); return null }
}

// desktop-only mode: last audit per url_key kept in ctx.storage (capped to 10 keys)
function localLoad(key) { try { return (C.storage.get('local', {}) || {})[key] || null } catch (e) { return null } }
function localSave(key, entry) {
  try {
    const all = C.storage.get('local', {}) || {}
    all[key] = { ...entry, t: Date.now() }
    Object.keys(all).sort((a, b) => (all[b].t || 0) - (all[a].t || 0)).slice(10).forEach(k => delete all[k])
    C.storage.set('local', all)
  } catch (e) { /* storage full or unavailable: UI-only */ }
}

// previous pins for a page: { findings (open/new) | null if never audited, dismissed: Finding[], seen: ids, score }
async function previousFor(key) {
  const st = await storeGet(key)
  if (st && Array.isArray(st.pins)) {
    const live = st.pins.filter(p => p.status !== 'dismissed' && p.status !== 'fixed' && p.finding).map(p => p.finding)
    const dis = st.pins.filter(p => p.status === 'dismissed' && p.finding).map(p => p.finding)
    const known = live.length > 0 || !!st.last || st.pins.length > 0
    return { findings: known ? live : null, dismissed: dis, seen: st.pins.map(p => p.id), score: st.last ? st.last.score : null }
  }
  const mem = M.mem[key]
  if (mem) return { findings: mem.findings, dismissed: mem.dismissed || [], seen: [...mem.seen], score: mem.score }
  const loc = localLoad(key)
  if (loc) return { findings: loc.findings || [], dismissed: loc.dismissed || [], seen: loc.seen || [], score: loc.score }
  return { findings: null, dismissed: [], seen: [], score: null }
}

// ============================================================================
// Core: audit -> deliver -> diff -> render
// ============================================================================
function prefs() {
  return { autoReaudit: C.storage.get('autoReaudit', true) !== false, tapAdvisory: C.storage.get('tapAdvisory', 44), contrast: C.storage.get('contrast', 'AA') }
}
function rememberGrant(url) {
  const o = originOf(url); if (!o) return
  const g = C.storage.get('grants', {}) || {}
  if (!g[o]) { g[o] = true; C.storage.set('grants', g) }
  setUi({ hasGrant: true })
}

function applyPins(findings, fixed, delta) {
  const statuses = {}
  const newIds = new Set(delta ? delta.new : [])
  for (const f of findings) statuses[f.id] = newIds.has(f.id) ? 'new' : 'open'
  for (const f of fixed) statuses[f.id] = 'fixed'
  return { list: [...findings, ...fixed.filter(f => !findings.some(g => g.id === f.id))], statuses }
}

// Denied for this origin: stop touching the page and drop results that belong to a different site.
function denied(m) {
  M.active = false; C.storage.set('active', false)
  setUi({ phase: 'error', error: m, result: null, fixed: [], lost: [], pinsShown: false, delta: null, prevScore: null })
}

// One audit at a time: user, auto and agent audits queue behind each other.
function performAudit(o) {
  M.auditing++
  const run = () => doAudit(o)
  const p = M.lock.then(run, run)
  M.lock = p.catch(() => {})
  return p.finally(() => { M.auditing-- })
}

/**
 * source: 'user' | 'auto' | 'agent'. deliver(result) is awaited right after the audit and BEFORE drawing,
 * so the agent's tool call is answered as fast as possible.
 * Resolves { ok:true, result, delta } | { ok:false, code, message }.
 */
async function doAudit({ source, args, deliver }) {
  const a = args || {}
  const mySeq = ++M.seq
  if (source !== 'agent') {
    const gate = M.limiter.tryAcquire(source === 'auto' ? 'auto' : 'manual')
    if (!gate.ok && gate.reason === 'paused') { setUi({ paused: true }); return { ok: false, code: 'paused', message: 'paused' } }
    if (!gate.ok && source === 'auto') return { ok: false, code: 'throttled', message: 'throttled' }
    if (!gate.ok) { await new Promise(r => setTimeout(r, gate.wait)); M.limiter.tryAcquire('manual') }
  } else M.limiter.tryAcquire('manual')
  setUi({ phase: 'running', source, startedAt: Date.now(), error: null, paused: false, stale: false, cleared: false })
  if (source === 'user' && $ui.get().py === 'off') void checkHealth()
  try {
    const probe = await inject()
    const key = probe.key || urlKey(probe.url)
    if (a.expect_url && urlKey(a.expect_url) !== key) {
      const err = { ok: false, code: 'page_mismatch', message: 'Open page is ' + cleanText(key, 80) + ', not the expected page.' }
      setUi({ phase: 'error', error: { code: err.code, message: err.message } })
      return err
    }
    rememberGrant(probe.url)
    const prev = await previousFor(key)
    const opts = buildAuditOpts(a, prefs(), prev.dismissed.map(f => f.id))
    const res = (await callApi('audit', [opts])).v
    if (!res || !Array.isArray(res.findings)) throw new Error('engine returned no result')
    if (deliver) await deliver(res)

    // diff: python store answers for user/auto audits; local mirror otherwise (agent audits are stored by the tool)
    let delta = null
    if (source !== 'agent') {
      const posted = await storePost('/audit', { result: res, source })
      delta = normalizeDelta(posted && posted.delta)
    }
    if (!delta) delta = localDelta(prev.findings, res.findings, prev.seen)
    const fixedF = delta && prev.findings ? prev.findings.filter(f => delta.fixed.includes(f.id)) : []
    const prevScore = delta && typeof delta.prev_score === 'number' ? delta.prev_score : prev.score != null ? prev.score : null

    let lost = []
    const pin = a.pin !== false
    if (pin) {
      const { list, statuses } = applyPins(res.findings, fixedF, delta)
      const rr = (await callApi('render', [list, { statuses, pinLimit: 60 }])).v
      lost = (rr && rr.lost) || []
    } else {
      await callApi('clear', [])
    }
    const after = (await callApi('probe', [])).v
    M.auditedVersion = M.lastVersion = after ? after.docVersion : -1
    M.dirtySince = 0

    M.mem[key] = { findings: res.findings, dismissed: prev.dismissed, seen: new Set([...prev.seen, ...res.findings.map(f => f.id)]), score: res.score }
    if (!pyOn()) localSave(key, { findings: res.findings, dismissed: prev.dismissed, seen: [...M.mem[key].seen], score: res.score })
    C.storage.set('lastKey', key); C.storage.set('active', true)
    M.active = true; M.lastMissingHref = ''; M.resume = null; M.skip = 0
    if (M.fadeUndo) { M.fadeUndo(); M.fadeUndo = null }
    setUi({ phase: 'result', result: res, url: res.url || probe.url, key, prevScore, delta, fixed: fixedF, dismissed: prev.dismissed, lost, selected: '', pinsShown: pin })
    ensurePoll()
    if (fixedF.length && pin) {
      M.fadeUndo = C.setTimeout(() => {
        if (M.seq !== mySeq) return
        void (async () => {
          try { const { list, statuses } = applyPins(res.findings, [], delta); await callApi('render', [list, { statuses, pinLimit: 60 }]); setUi({ fixed: [] }) } catch (e) { /* page gone */ }
        })()
      }, FIXED_FADE_MS)
    }
    if (delta && prevScore != null && (fixedF.length || res.score !== prevScore) && source !== 'user') {
      host.notify({ kind: res.score >= prevScore ? 'success' : 'warning', title: 'Pinpoint', message: scoreToast(prevScore, res.score, fixedF.length).replace(/^Pinpoint: /, '') })
    }
    log('audit ok', { source, score: res.score, findings: res.findings.length, fixed: delta ? delta.fixed.length : 0, ms: res.stats && res.stats.ms })
    return { ok: true, result: res, delta }
  } catch (e) {
    const m = e && e.engine ? { code: 'engine_error', message: cleanText(e.message, 200) } : mapExecError(e)
    log('audit FAILED', m)
    if (m.code === 'consent_denied') { denied(m); return { ok: false, ...m } }
    setUi({ phase: 'error', error: m })
    return { ok: false, ...m }
  }
}

// ----------------------------------------------------------------------------
// Agent rendezvous (SPEC 4.2)
// ----------------------------------------------------------------------------
async function handleRequest(p) {
  const id = p && p.request_id
  if (!id || M.handled.has(id)) return
  if (!C.preview.isAvailable()) { log('request ignored (no preview in this window)', { id }); return }
  M.handled.add(id)
  if (M.handled.size > 200) M.handled.delete(M.handled.values().next().value)
  try { await C.rest('/ack/' + encodeURIComponent(id), { method: 'POST', body: { window: WIN } }) } catch (e) {
    log('ack not granted', { id, status: httpStatusOf(e) }); return
  }
  log('request claimed', { id })
  if (Object.keys(C.storage.get('grants', {}) || {}).length === 0) {
    host.notify({ kind: 'info', title: 'Pinpoint', message: 'Pinpoint will ask permission to run on this site. Choose \u201cAllow on this site\u201d.' })
  }
  let sent = false
  const post = async body => { sent = true; await C.rest('/result', { method: 'POST', body: { request_id: id, ...body } }) }
  try {
    const r = await performAudit({ source: 'agent', args: p.args, deliver: res => post({ ok: true, result: res }) })
    if (!r.ok && !sent) await post({ ok: false, code: r.code, message: r.message })
  } catch (e) {
    if (!sent) { try { await post({ ok: false, code: 'engine_error', message: cleanText(e && e.message, 200) }) } catch (e2) { log('result post failed ' + cleanText(e2 && e2.message, 80)) } }
  }
}
async function catchUpPending() {
  if (!pyOn() || !C.preview.isAvailable()) return
  try { for (const r of parsePending(await C.rest('/pending'))) void handleRequest(r) } catch (e) { /* older python half */ }
}

// ----------------------------------------------------------------------------
// Pin actions
// ----------------------------------------------------------------------------
async function sendToAgent(text, okMsg) {
  let ok = false
  try { ok = !!(await host.composer.submit(null, text)) } catch (e) { ok = false }
  if (ok) { host.notify({ kind: 'success', title: 'Pinpoint', message: okMsg || 'Sent to Hermes' }); return true }
  let drafted = false
  try { drafted = !!(await host.composer.insertText(null, text, { mode: 'block' })) } catch (e) { drafted = false }
  host.notify({ kind: 'info', title: 'Pinpoint', message: drafted ? 'Open a chat to send. The fix request is in your draft.' : 'Open a chat first, then press Fix again.' })
  return false
}
const findingById = id => { const r = $ui.get().result; return r ? r.findings.find(f => f.id === id) : null }
async function fixFinding(id) {
  const f = findingById(id); if (!f) return
  log('fix pin', { id })
  await sendToAgent(buildPinPrompt(f, $ui.get().url, f.pin), 'Pin #' + (f.pin || '') + ' sent to Hermes')
}
async function fixAllHigh() {
  const s = $ui.get(); if (!s.result) return
  const open = s.result.findings.filter(f => !s.dismissed.some(d => d.id === f.id))
  if (!open.some(f => f.sev === 'high')) { host.notify({ kind: 'info', title: 'Pinpoint', message: 'No high-severity findings.' }); return }
  await sendToAgent(buildFixAllPrompt(open, s.url, 8), 'High-severity findings sent to Hermes')
}
async function dismissFinding(id, why) {
  const f = findingById(id); if (!f) return
  const s = $ui.get()
  await storePost('/pins', { action: 'dismiss', url_key: s.key, ids: [id], reason: why || 'Dismissed in the Pinpoint pane' })
  const dismissed = [...s.dismissed.filter(d => d.id !== id), f]
  const mem = M.mem[s.key]; if (mem) mem.dismissed = dismissed
  if (!pyOn()) localSave(s.key, { findings: s.result.findings, dismissed, seen: mem ? [...mem.seen] : [], score: s.result.score })
  setUi({ dismissed })
  try { await callApi('setStatuses', [{ [id]: 'dismissed' }]) } catch (e) { /* page gone */ }
  log('dismissed', { id })
}
async function reopenFinding(id) {
  const s = $ui.get()
  await storePost('/pins', { action: 'reopen', url_key: s.key, ids: [id] })
  const mem = M.mem[s.key]
  const dismissed = s.dismissed.filter(f => f.id !== id)
  if (mem) mem.dismissed = dismissed
  if (!pyOn()) localSave(s.key, { findings: s.result ? s.result.findings : [], dismissed, seen: mem ? [...mem.seen] : [], score: s.result ? s.result.score : null })
  setUi({ dismissed })
  void performAudit({ source: 'user' })
}
async function locate(id) {
  setUi({ selected: id })
  try { await callApi('focusPin', [id]) } catch (e) { /* page gone */ }
}
async function clearPins() {
  M.active = false; C.storage.set('active', false); M.seq++
  try { await callApi('clear', []) } catch (e) { /* no page / no consent: nothing drawn */ }
  setUi({ pinsShown: false, cleared: true })
  log('cleared')
}

// ============================================================================
// Poll loop (SPEC 8.3)
// ============================================================================
function ensurePoll() {
  const want = $ui.get().pinsShown ? 500 : 1000
  if (M.stopPoll && M.pollMs === want) return
  if (M.stopPoll) M.stopPoll()
  M.pollMs = want
  M.stopPoll = C.setInterval(() => { void tick() }, want)
}

async function tick() {
  if (!M.active || M.inflight > 0 || M.auditing > 0 || !C.preview.isAvailable()) return
  if (M.skip > 0) { M.skip--; return }
  const now = Date.now()
  let r
  try { r = await callApi('probe', []) } catch (e) {
    const m = mapExecError(e)
    if (m.code === 'consent_denied') { denied(m); return }
    if (m.code === 'no_preview' || m.code === 'navigated') { M.skip = 2; return }
    log('probe err', m); M.skip = 4; return
  }
  if (r.__missing) return onEngineMissing(r.href)
  const p = r.v; if (!p) return
  const s = $ui.get()
  M.lastMissingHref = ''

  let events = []
  try { events = (await callApi('drain', [])).v || [] } catch (e) { events = [] }
  for (const ev of events) {
    if (ev.type === 'pin-click') setUi({ selected: ev.id })
    else if (ev.type === 'fix') void fixFinding(ev.id)
    else if (ev.type === 'dismiss') void dismissFinding(ev.id, 'Dismissed from the pin card')
  }

  const auto = prefs().autoReaudit
  if (M.limiter.isPaused()) return
  if (M.resume) {   // after a reload: wait for load + quiet, then re-audit
    if (!p.ready) { M.resume.since = 0; return }
    if (!M.resume.since || p.docVersion !== M.resume.ver) { M.resume.since = now; M.resume.ver = p.docVersion; return }
    if (now - M.resume.since >= RESUME_QUIET_MS) { M.resume = null; log('re-audit after reload'); await autoAudit() }
    return
  }
  if (s.key && p.key && p.key !== s.key) {   // SPA route change: engine survived, the page did not
    if (auto && await hasStored(p.key)) { M.resume = { since: 0, ver: -1 }; return }
    setUi({ stale: true }); return
  }
  if (p.dirty && p.docVersion !== M.auditedVersion && auto) {
    if (!M.dirtySince || p.docVersion !== M.lastVersion) { M.dirtySince = now; M.lastVersion = p.docVersion; return }
    if (now - M.dirtySince >= QUIET_MS) { M.dirtySince = 0; await autoAudit() }
  }
}

async function autoAudit() {
  const r = await performAudit({ source: 'auto' })
  if (!r.ok && r.code === 'paused') log('auto re-audit paused (page changing too fast)')
}

async function hasStored(key) {
  if (M.mem[key] && M.mem[key].findings.length) return true
  const st = await storeGet(key)
  if (st && Array.isArray(st.pins) && st.pins.some(p => p.status === 'open' || p.status === 'new')) return true
  const loc = localLoad(key)
  return !!(loc && loc.findings && loc.findings.length)
}

async function onEngineMissing(href) {
  if (M.lastMissingHref === href) { M.skip = 2; return }
  M.lastMissingHref = href
  if (!isWebUrl(href)) { setUi({ stale: true, pinsShown: false }); return }
  const key = urlKey(href)
  log('engine missing (reload/navigation)', { key })
  if (prefs().autoReaudit && await hasStored(key)) {
    try { const pr = await inject(); M.resume = { since: 0, ver: pr.docVersion }; setUi({ stale: false, key: pr.key || key }) } catch (e) { setUi({ stale: true }) }
  } else {
    setUi({ stale: true, pinsShown: false })
  }
}

// hot-reload adoption (C5): the page keeps our overlay when only the module instance was replaced
async function adopt() {
  try {
    if (!C.preview.isAvailable() || !C.storage.get('active', false)) return
    const r = await callApi('probe', [])
    M.active = true
    if (r.__missing) { ensurePoll(); log('adopt: engine absent, waiting for next audit'); return }
    log('adopt: engine present', { pins: r.v && r.v.pins })
    await performAudit({ source: 'auto' })
  } catch (e) { log('adopt failed ' + cleanText(e && e.message, 80)); M.active = false }
}

// ============================================================================
// UI (no JSX: disk plugins are uncompiled). All colours come from theme variables.
// ============================================================================
const CSS = `
.pp{--pp-high:var(--ui-red,var(--dt-destructive,currentColor));--pp-medium:var(--ui-yellow,var(--ui-orange,currentColor));--pp-low:var(--ui-accent,currentColor);--pp-good:var(--ui-green,currentColor);
  display:flex;flex-direction:column;height:100%;min-height:0;font-family:var(--dt-font-sans,inherit);font-size:12px;line-height:1.45;color:var(--ui-text-primary)}
.pp *{box-sizing:border-box}
.pp button{font:inherit;color:inherit;cursor:pointer}
.pp button:focus-visible,.pp-chip:focus-visible{outline:2px solid var(--ui-accent);outline-offset:2px;border-radius:6px}
.pp-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--ui-stroke-tertiary,var(--dt-border))}
.pp-title{font-size:13px;font-weight:650;letter-spacing:.01em;display:flex;align-items:center;gap:6px}
.pp-title svg{width:15px;height:15px;color:var(--ui-accent)}
.pp-url{flex:1;min-width:0;color:var(--ui-text-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:right;font-family:var(--dt-font-mono,ui-monospace,monospace);font-size:11px}
.pp-scroll{flex:1;min-height:0;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:12px}
.pp-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:28px;padding:0 10px;border-radius:7px;border:1px solid var(--ui-stroke-secondary,var(--dt-border));background:var(--ui-bg-secondary,transparent);transition:background .12s,border-color .12s}
.pp-btn:hover{background:var(--ui-control-hover-background,var(--ui-bg-tertiary))}
.pp-btn:disabled{opacity:.5;cursor:default}
.pp-btn svg{width:13px;height:13px;flex:none}
.pp-btn.primary{background:var(--ui-accent);border-color:var(--ui-accent);color:var(--dt-primary-foreground,var(--ui-bg-editor));font-weight:600}
.pp-btn.primary:hover{background:var(--ui-accent);filter:brightness(1.08)}
.pp-btn.ghost{border-color:transparent;background:transparent;color:var(--ui-text-secondary)}
.pp-btn.ghost:hover{background:var(--ui-control-hover-background,var(--ui-bg-tertiary));color:var(--ui-text-primary)}
.pp-btn.icon{width:28px;padding:0}
.pp-card{border:1px solid var(--ui-stroke-secondary,var(--dt-border));background:var(--ui-bg-card,var(--ui-bg-secondary));border-radius:10px;padding:12px}
.pp-card h3{margin:0 0 4px;font-size:13px;font-weight:650}
.pp-card p{margin:0 0 10px;color:var(--ui-text-secondary)}
.pp-card.err{border-color:color-mix(in srgb,var(--pp-high) 45%,transparent);background:color-mix(in srgb,var(--pp-high) 8%,transparent)}
.pp-banner{display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border-radius:8px;border:1px solid var(--ui-stroke-tertiary,var(--dt-border));background:var(--ui-bg-tertiary,transparent);color:var(--ui-text-secondary)}
.pp-banner svg{width:14px;height:14px;flex:none;margin-top:2px;color:var(--pp-medium)}
.pp-banner b{color:var(--ui-text-primary);font-weight:600}
.pp-banner .pp-btn{margin-left:auto;flex:none}
.pp-empty{display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center;padding:28px 12px;color:var(--ui-text-secondary)}
.pp-empty .glyph{width:44px;height:44px;border-radius:12px;display:grid;place-items:center;background:color-mix(in srgb,var(--ui-accent) 14%,transparent);color:var(--ui-accent)}
.pp-empty .glyph svg{width:22px;height:22px}
.pp-empty strong{color:var(--ui-text-primary);font-size:13px}
.pp-kbd{font-family:var(--dt-font-mono,ui-monospace,monospace);font-size:11px;padding:1px 5px;border-radius:4px;border:1px solid var(--ui-stroke-secondary,var(--dt-border));background:var(--ui-bg-secondary)}
.pp-run{display:flex;align-items:center;gap:10px;padding:18px 12px;justify-content:center;color:var(--ui-text-secondary)}
.pp-spin{width:18px;height:18px;border-radius:50%;border:2px solid var(--ui-stroke-secondary,var(--dt-border));border-top-color:var(--ui-accent);animation:pp-rot 1s linear infinite}
@keyframes pp-rot{to{transform:rotate(360deg)}}
.pp-summary{display:flex;align-items:center;gap:14px}
.pp-ring{position:relative;width:84px;height:84px;flex:none}
.pp-ring svg{width:84px;height:84px;transform:rotate(-90deg)}
.pp-ring circle{fill:none;stroke-width:7;stroke-linecap:round}
.pp-ring .track{stroke:var(--ui-stroke-secondary,var(--dt-border))}
.pp-ring .arc{transition:stroke-dashoffset .5s ease,stroke .2s}
.pp-ring .arc.good{stroke:var(--pp-good)}.pp-ring .arc.warn{stroke:var(--pp-medium)}.pp-ring .arc.bad{stroke:var(--pp-high)}
.pp-ring .num{position:absolute;inset:0;display:grid;place-items:center;font-size:24px;font-weight:700;font-variant-numeric:tabular-nums}
.pp-sum-side{display:flex;flex-direction:column;gap:7px;min-width:0}
.pp-delta{display:inline-flex;align-items:center;gap:6px;color:var(--ui-text-secondary)}
.pp-delta b{font-variant-numeric:tabular-nums;padding:1px 7px;border-radius:99px;font-weight:650;color:var(--ui-text-primary)}
.pp-delta b.up{background:color-mix(in srgb,var(--pp-good) 22%,transparent)}
.pp-delta b.down{background:color-mix(in srgb,var(--pp-high) 22%,transparent)}
.pp-counts{display:flex;gap:6px;flex-wrap:wrap}
.pp-pill{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:99px;border:1px solid var(--ui-stroke-tertiary,var(--dt-border));font-variant-numeric:tabular-nums}
.pp-dot{width:8px;height:8px;border-radius:50%;background:var(--c);flex:none}
.pp-sev-high{--c:var(--pp-high)}.pp-sev-medium{--c:var(--pp-medium)}.pp-sev-low{--c:var(--pp-low)}.pp-sev-fixed{--c:var(--pp-good)}.pp-sev-dismissed{--c:var(--ui-text-quaternary)}
.pp-actions{display:flex;gap:6px;flex-wrap:wrap}
.pp-opt{display:flex;align-items:center;gap:8px;color:var(--ui-text-secondary);cursor:pointer;user-select:none}
.pp-opt input{width:14px;height:14px;accent-color:var(--ui-accent);margin:0}
.pp-sec{display:flex;flex-direction:column;gap:4px}
.pp-sec>h4{margin:0;padding:2px 2px 4px;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--ui-text-tertiary);display:flex;align-items:center;gap:6px}
.pp-row{display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:start;padding:6px 6px 6px 8px;border-radius:9px;border:1px solid transparent;transition:background .12s,border-color .12s}
.pp-row:hover,.pp-row:focus-within{background:var(--ui-row-hover-background,var(--ui-bg-tertiary))}
.pp-row.sel{background:var(--ui-row-active-background,var(--ui-bg-secondary));border-color:color-mix(in srgb,var(--c) 55%,transparent)}
.pp-row.gone .pp-main{opacity:.7}
.pp-badge{margin-top:1px;min-width:22px;height:22px;border-radius:99px;display:grid;place-items:center;font-size:11px;font-weight:700;font-variant-numeric:tabular-nums;background:var(--c);color:var(--ui-bg-editor,var(--dt-primary-foreground))}
.pp-badge svg{width:12px;height:12px;stroke-width:3}
.pp-main{all:unset;box-sizing:border-box;display:block;min-width:0;cursor:pointer;border-radius:6px}
.pp-main:focus-visible{outline:2px solid var(--ui-accent);outline-offset:2px}
.pp-rule{font-weight:600}
.pp-tag{margin-left:6px;font-weight:500;font-size:10.5px;padding:0 6px;border-radius:99px;border:1px solid var(--ui-stroke-secondary,var(--dt-border));color:var(--ui-text-secondary)}
.pp-note{color:var(--ui-text-secondary);overflow-wrap:anywhere}
.pp-sel{color:var(--ui-text-tertiary);font-family:var(--dt-font-mono,ui-monospace,monospace);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block}
.pp-rowact{display:flex;gap:2px;opacity:0;transition:opacity .12s}
.pp-row:hover .pp-rowact,.pp-row:focus-within .pp-rowact,.pp-row.sel .pp-rowact{opacity:1}
.pp-foot{padding:8px 12px;border-top:1px solid var(--ui-stroke-tertiary,var(--dt-border));display:flex;align-items:center;gap:8px;color:var(--ui-text-tertiary)}
.pp-chip{display:inline-flex;align-items:center;gap:6px;height:100%;padding:0 8px;border:0;background:transparent;font-size:11px;color:var(--ui-text-secondary);cursor:pointer;border-radius:6px;font-variant-numeric:tabular-nums}
.pp-chip:hover{background:var(--ui-control-hover-background,var(--ui-bg-tertiary))}
.pp-chip .pp-dot{width:7px;height:7px}
.pp-chip .d{font-weight:650;color:var(--ui-text-primary)}
.pp-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (prefers-reduced-motion:reduce){.pp-spin{animation:none}.pp-ring .arc{transition:none}.pp-btn,.pp-row,.pp-rowact{transition:none}}
`

const h = (type, props, ...kids) => {
  const flat = kids.flat(Infinity).filter(k => k !== null && k !== undefined && k !== false)
  const p = { ...(props || {}) }
  if (flat.length === 0) return jsx(type, p)
  if (flat.length === 1) return jsx(type, { ...p, children: flat[0] })
  return jsxs(type, { ...p, children: flat })
}
const svg = paths => h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false' },
  paths.map((d, i) => typeof d === 'string' ? h('path', { key: i, d }) : h('circle', { key: i, cx: d[0], cy: d[1], r: d[2] })))
const ICON = {
  pin: () => svg(['M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0z', [12, 10, 3]]),
  refresh: () => svg(['M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8', 'M21 3v5h-5', 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16', 'M8 16H3v5']),
  send: () => svg(['M22 2 11 13', 'M22 2 15 22l-4-9-9-4 20-7z']),
  check: () => svg(['M20 6 9 17l-5-5']),
  x: () => svg(['M18 6 6 18', 'M6 6l12 12']),
  undo: () => svg(['M3 7v6h6', 'M21 17a9 9 0 0 0-15-6.7L3 13']),
  alert: () => svg(['m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3', 'M12 9v4', 'M12 17h.01']),
  target: () => svg([[12, 12, 10], [12, 12, 3], 'M22 12h-3', 'M5 12H2', 'M12 5V2', 'M12 22v-3'])
}
const RULE_NAMES = {
  'a11y.contrast': 'Contrast', 'a11y.tap-target': 'Tap target', 'a11y.img-alt': 'Image alt', 'a11y.form-label': 'Form label', 'a11y.control-name': 'Control name',
  'a11y.heading-order': 'Heading order', 'a11y.focus-indicator': 'Focus indicator', 'a11y.lang': 'Page language', 'a11y.page-title': 'Page title', 'a11y.viewport-zoom': 'Zoom blocked',
  'layout.h-overflow': 'Horizontal overflow', 'type.text-small': 'Small text', 'type.line-height': 'Line height', 'spacing.tight-targets': 'Tight targets'
}
const ruleName = r => RULE_NAMES[r] || String(r || '').split('.').pop()
const SEV_LABEL = { high: 'High', medium: 'Medium', low: 'Low' }

function Elapsed({ since }) {
  const [, bump] = useState(0)
  useEffect(() => { const t = window.setInterval(() => bump(n => n + 1), 500); return () => window.clearInterval(t) }, [])
  return h('span', null, Math.max(0, Math.round((Date.now() - since) / 1000)) + 's')
}

function Ring({ score }) {
  const R = 36, CIRC = 2 * Math.PI * R
  return h('div', { className: 'pp-ring', role: 'img', 'aria-label': 'Score ' + score + ' out of 100' },
    h('svg', { viewBox: '0 0 84 84', 'aria-hidden': 'true' },
      h('circle', { className: 'track', cx: 42, cy: 42, r: R }),
      h('circle', { className: 'arc ' + scoreTone(score), cx: 42, cy: 42, r: R, strokeDasharray: CIRC.toFixed(1), strokeDashoffset: (CIRC * (1 - Math.max(0, Math.min(100, score)) / 100)).toFixed(1) })),
    h('div', { className: 'num', 'aria-hidden': 'true' }, String(score)))
}

function Row({ f, kind, selected, lost }) {
  const sevClass = kind === 'fixed' ? 'pp-sev-fixed' : kind === 'dismissed' ? 'pp-sev-dismissed' : 'pp-sev-' + f.sev
  return h('div', { className: 'pp-row ' + sevClass + (selected ? ' sel' : '') + (kind !== 'open' || lost ? ' gone' : ''), 'data-pp-id': f.id },
    h('span', { className: 'pp-badge', 'aria-hidden': 'true' }, kind === 'fixed' ? ICON.check() : f.pin != null ? String(f.pin) : '\u2022'),
    h('button', { type: 'button', className: 'pp-main', onClick: () => void locate(f.id), 'aria-label': ruleName(f.rule) + ': ' + cleanText(f.note, 120) + '. Show on page', title: 'Scroll to this element' },
      h('div', { className: 'pp-rule' }, ruleName(f.rule),
        kind === 'fixed' ? h('span', { className: 'pp-tag' }, 'fixed') : null,
        kind === 'dismissed' ? h('span', { className: 'pp-tag' }, 'dismissed') : null,
        lost ? h('span', { className: 'pp-tag' }, 'can\u2019t locate') : null,
        f.heuristic ? h('span', { className: 'pp-tag', title: 'Heuristic check' }, 'heuristic') : null),
      h('div', { className: 'pp-note' }, cleanText(f.note, 160)),
      h('span', { className: 'pp-sel', title: cleanText(f.selector, 200) }, cleanText(f.selector, 90))),
    h('div', { className: 'pp-rowact' },
      kind === 'open' ? h('button', { type: 'button', className: 'pp-btn icon ghost', title: 'Fix with Hermes', 'aria-label': 'Fix pin ' + (f.pin || '') + ' with Hermes', onClick: () => void fixFinding(f.id) }, ICON.send()) : null,
      kind === 'open' ? h('button', { type: 'button', className: 'pp-btn icon ghost', title: 'Dismiss (intentional)', 'aria-label': 'Dismiss pin ' + (f.pin || ''), onClick: () => void dismissFinding(f.id) }, ICON.x()) : null,
      kind === 'dismissed' ? h('button', { type: 'button', className: 'pp-btn icon ghost', title: 'Reopen', 'aria-label': 'Reopen finding', onClick: () => void reopenFinding(f.id) }, ICON.undo()) : null))
}

function Banner({ children, action }) {
  return h('div', { className: 'pp-banner', role: 'status' }, ICON.alert(), h('div', null, children), action || null)
}

function resultView(s) {
  const r = s.result
  const out = []
  const dismissedIds = new Set(s.dismissed.map(f => f.id))
  const open = r.findings.filter(f => !dismissedIds.has(f.id))
  const counts = { high: 0, medium: 0, low: 0 }
  open.forEach(f => { if (counts[f.sev] != null) counts[f.sev]++ })
  const diff = typeof s.prevScore === 'number' ? r.score - s.prevScore : null
  out.push(h('div', { key: 'sum', className: 'pp-summary' },
    h(Ring, { score: r.score }),
    h('div', { className: 'pp-sum-side' },
      h('div', { className: 'pp-counts' }, ['high', 'medium', 'low'].map(k => h('span', { key: k, className: 'pp-pill pp-sev-' + k }, h('span', { className: 'pp-dot', 'aria-hidden': 'true' }), counts[k] + ' ' + SEV_LABEL[k]))),
      diff !== null && diff !== 0 ? h('div', { className: 'pp-delta', 'aria-live': 'polite' }, h('b', { className: diff > 0 ? 'up' : 'down' }, (diff > 0 ? '+' : '\u2212') + Math.abs(diff)), 'from ' + s.prevScore + (s.fixed.length ? ' \u00b7 ' + s.fixed.length + ' fixed' : '')) : null,
      h('div', { className: 'pp-actions' },
        h('button', { type: 'button', className: 'pp-btn', disabled: counts.high === 0, onClick: () => void fixAllHigh(), title: 'Send up to 8 high-severity findings to Hermes' }, ICON.send(), 'Fix all high')))))
  if (r.limits && r.limits.length) out.push(h('div', { key: 'lim', className: 'pp-note', style: { color: 'var(--ui-text-tertiary)' } }, 'Not checked: ' + r.limits.slice(0, 3).map(l => cleanText(l, 70)).join('; ')))
  const groups = groupBySeverity(open)
  for (const sev of ['high', 'medium', 'low']) {
    if (!groups[sev].length) continue
    out.push(h('section', { key: 'g' + sev, className: 'pp-sec pp-sev-' + sev, 'aria-label': SEV_LABEL[sev] + ' severity' },
      h('h4', null, h('span', { className: 'pp-dot', 'aria-hidden': 'true' }), SEV_LABEL[sev] + ' \u00b7 ' + groups[sev].length),
      groups[sev].map(f => h(Row, { key: f.id, f, kind: 'open', selected: s.selected === f.id, lost: s.lost.includes(f.id) }))))
  }
  if (!open.length) out.push(h('div', { key: 'clean', className: 'pp-empty' }, h('div', { className: 'glyph' }, ICON.check()), h('strong', null, 'Nothing to pin'), h('span', null, 'No findings from the checks that ran.')))
  if (s.fixed.length) out.push(h('section', { key: 'fx', className: 'pp-sec', 'aria-label': 'Fixed' }, h('h4', null, h('span', { className: 'pp-dot pp-sev-fixed', 'aria-hidden': 'true' }), 'Fixed \u00b7 ' + s.fixed.length), s.fixed.map(f => h(Row, { key: f.id, f, kind: 'fixed', selected: false, lost: false }))))
  if (s.dismissed.length) out.push(h('section', { key: 'ds', className: 'pp-sec', 'aria-label': 'Dismissed' }, h('h4', null, 'Dismissed \u00b7 ' + s.dismissed.length), s.dismissed.map(f => h(Row, { key: f.id, f, kind: 'dismissed', selected: false, lost: false }))))
  return out
}

function Pane() {
  const s = useValue($ui)
  const body = []
  if (s.py === 'off') body.push(h(Banner, { key: 'py' }, h('b', null, 'Python half is off. '), 'Pins stay in this app and the agent can\u2019t see them. Run ', h('span', { className: 'pp-kbd' }, 'hermes plugins enable pinpoint'), ' to allow agent audits.'))
  if (s.paused) body.push(h(Banner, { key: 'pause', action: h('button', { type: 'button', className: 'pp-btn', onClick: () => { M.limiter.reset(); setUi({ paused: false }); void performAudit({ source: 'user' }) } }, 'Resume') }, h('b', null, 'Paused. '), 'The page is changing too fast to re-audit.'))
  if (s.stale && s.result && s.phase !== 'running') body.push(h(Banner, { key: 'stale' }, h('b', null, 'Page changed. '), 'Press Audit to check this page.'))
  if (s.cleared && s.phase !== 'running') body.push(h(Banner, { key: 'clr' }, h('b', null, 'Pins cleared. '), 'Auto re-audit is off until you press Audit.'))

  if (s.phase === 'running') {
    body.push(h('div', { key: 'run', className: 'pp-run', role: 'status', 'aria-live': 'polite' }, h('span', { className: 'pp-spin', 'aria-hidden': 'true' }), h('span', null, s.source === 'agent' ? 'Auditing for Hermes' : 'Auditing page', '\u2026 ', h(Elapsed, { since: s.startedAt }))))
  }
  if (s.phase === 'error' && s.error) {
    const c = errorCopy(s.error.code)
    body.push(h('div', { key: 'err', className: 'pp-card err', role: 'alert' }, h('h3', null, c.title), h('p', null, c.body), h('div', { className: 'pp-actions' }, h('button', { type: 'button', className: 'pp-btn', onClick: () => void performAudit({ source: 'user' }) }, ICON.refresh(), 'Try again'))))
  }
  if (!s.result && s.phase === 'idle') {
    if (!s.hasGrant) {
      body.push(h('div', { key: 'consent', className: 'pp-card' },
        h('h3', null, 'Allow Pinpoint to inspect pages?'),
        h('p', null, 'Hermes will ask \u201cLet Pinpoint run scripts on this page?\u201d Choose ', h('b', null, 'Allow on this site'), '. Pinpoint reads computed styles and layout, never form values or cookies. Revoke any time: Capabilities \u203a Plugins \u203a Pinpoint.'),
        h('button', { type: 'button', className: 'pp-btn primary', onClick: () => void performAudit({ source: 'user' }) }, ICON.target(), 'Audit this page')))
    } else {
      body.push(h('div', { key: 'empty', className: 'pp-empty' }, h('div', { className: 'glyph' }, ICON.pin()), h('strong', null, 'No audit yet'), h('span', null, 'Open a page in the Browser pane, then Audit.'),
        h('button', { type: 'button', className: 'pp-btn primary', onClick: () => void performAudit({ source: 'user' }) }, ICON.target(), 'Audit page')))
    }
  }
  if (s.result) body.push(...resultView(s))

  return h('div', { className: 'pp' },
    h('div', { className: 'pp-head' },
      h('div', { className: 'pp-title' }, ICON.pin(), 'Pinpoint'),
      h('div', { className: 'pp-url', title: s.url }, s.url ? s.url.replace(/^https?:\/\//, '') : ''),
      h('button', { type: 'button', className: 'pp-btn primary', disabled: s.phase === 'running', onClick: () => void performAudit({ source: 'user' }) }, ICON.refresh(), s.result ? 'Re-audit' : 'Audit')),
    h('div', { className: 'pp-scroll' }, body),
    s.result ? h('div', { className: 'pp-foot' },
      h('label', { className: 'pp-opt' },
        h('input', { type: 'checkbox', checked: s.autoReaudit, onChange: e => { C.storage.set('autoReaudit', e.target.checked); setUi({ autoReaudit: e.target.checked }) } }),
        'Re-audit automatically'),
      h('span', { style: { flex: 1 } }),
      h('button', { type: 'button', className: 'pp-btn ghost', onClick: () => void clearPins(), title: 'Remove pins from the page' }, 'Clear pins')) : null)
}

function Chip() {
  const s = useValue($ui)
  const r = s.result
  const diff = r && typeof s.prevScore === 'number' ? r.score - s.prevScore : 0
  let label = 'Pinpoint', tone = null
  if (s.phase === 'running') label = 'Auditing\u2026'
  else if (r) { label = String(r.score); tone = scoreTone(r.score) }
  const tip = s.paused ? 'Pinpoint: paused (page changing too fast)'
    : s.py === 'off' ? 'Pinpoint: Python half off, agent features disabled. Click to audit.'
    : r ? 'Pinpoint score ' + r.score + (diff ? ' (' + (diff > 0 ? '+' : '\u2212') + Math.abs(diff) + ')' : '') + '. Click to re-audit.'
    : 'Pinpoint: click to audit the open page'
  const dot = tone === 'good' ? 'var(--ui-green)' : tone === 'warn' ? 'var(--ui-yellow)' : tone === 'bad' ? 'var(--ui-red)' : 'var(--ui-text-quaternary)'
  return h('button', { type: 'button', className: 'pp-chip', title: tip, 'aria-label': tip, onClick: () => void performAudit({ source: 'user' }) },
    h('span', { className: 'pp-dot', style: { background: dot }, 'aria-hidden': 'true' }),
    h('span', null, label),
    diff ? h('span', { className: 'd' }, (diff > 0 ? '+' : '\u2212') + Math.abs(diff)) : null,
    s.paused ? h('span', null, 'paused') : null)
}

// ============================================================================
// Plugin
// ============================================================================
export default {
  id: ID,
  name: 'Pinpoint',
  capabilities: ['preview.executeJavaScript'],
  register(ctx) {
    C = ctx
    log('register', { version: VERSION, win: WIN, preview: !!(ctx.preview && ctx.preview.isAvailable && ctx.preview.isAvailable()) })
    const prior = document.getElementById('pp-style'); if (prior) prior.remove()
    const style = document.createElement('style'); style.id = 'pp-style'; style.textContent = CSS
    document.head.appendChild(style)
    ctx.onDispose(() => { style.remove(); log('dispose') })

    setUi({ ...initialUi(), autoReaudit: prefs().autoReaudit, hasGrant: Object.keys(ctx.storage.get('grants', {}) || {}).length > 0 })
    M.limiter = createRateLimiter()

    ctx.registerMany([
      { id: 'audit', area: PALETTE_AREA, data: { id: 'pinpoint.audit', label: 'Pinpoint: audit page', keywords: ['pinpoint', 'audit', 'accessibility', 'contrast', 'pins'], run: () => void performAudit({ source: 'user' }) } },
      { id: 'reaudit', area: PALETTE_AREA, data: { id: 'pinpoint.reaudit', label: 'Pinpoint: re-audit', keywords: ['pinpoint', 'verify', 'recheck'], run: () => void performAudit({ source: 'user' }) } },
      { id: 'clear', area: PALETTE_AREA, data: { id: 'pinpoint.clear', label: 'Pinpoint: clear pins', keywords: ['pinpoint', 'remove', 'pins'], run: () => void clearPins() } },
      { id: 'fixhigh', area: PALETTE_AREA, data: { id: 'pinpoint.fixhigh', label: 'Pinpoint: send all high-severity to agent', keywords: ['pinpoint', 'fix', 'agent', 'high'], run: () => void fixAllHigh() } },
      { id: 'pane', area: PANES_AREA, title: 'Pinpoint', data: { placement: 'right', width: '340px' }, render: () => h(Pane, null) },
      { id: 'chip', area: STATUSBAR_AREAS.right, order: 140, render: () => h(Chip, null) }
    ])

    ctx.onDispose(host.onEvent('plugin.pinpoint.audit.request', ev => { void handleRequest(ev && ev.payload) }))
    ctx.onDispose(host.onEvent('plugin.pinpoint.pins.changed', ev => {
      const k = ev && ev.payload && ev.payload.url_key
      const s = $ui.get()
      if (!s.result || (k && k !== s.key)) return
      void (async () => {
        const st = await storeGet(s.key); if (!st || !Array.isArray(st.pins)) return
        const map = {}
        for (const p of st.pins) if (p.status === 'dismissed') map[p.id] = 'dismissed'
        for (const f of s.result.findings) if (!map[f.id]) map[f.id] = 'open'
        setUi({ dismissed: st.pins.filter(p => p.status === 'dismissed' && p.finding).map(p => p.finding) })
        try { await callApi('setStatuses', [map]) } catch (e) { /* page gone */ }
      })()
    }))
    ctx.addEventListener(window, 'focus', () => { void (async () => { await checkHealth(); await catchUpPending() })() })

    void (async () => { await checkHealth(); await catchUpPending(); ctx.setTimeout(() => void adopt(), 500) })()
  }
}
