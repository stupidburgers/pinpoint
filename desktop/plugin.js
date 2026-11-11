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
function localDelta(prev, cur, seenIds, coveredRules) {
  if (!prev) return null
  const covered = Array.isArray(coveredRules) ? new Set(coveredRules) : (coveredRules instanceof Set ? coveredRules : null)
  const allowAll = covered === null && coveredRules === undefined
  const isCovered = (id) => allowAll ? true : (covered ? covered.has(String(id).split('@', 1)[0]) : false)
  const prevIds = new Set(prev.map(f => f.id))
  const seen = new Set(seenIds || [])
  prevIds.forEach(id => seen.add(id))
  const curIds = new Set(cur.map(f => f.id))
  const fixed = [...prevIds].filter(id => !curIds.has(id) && isCovered(id))
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

function pinpointEngine(e){"use strict";e=e||{};var t="0.1.0",n=window.__pinpoint;if(n&&n.version===t)return n;if(n&&"function"==typeof n.destroy)try{n.destroy()}catch(e){}var r=document,i=r.documentElement,a=[],o=!1,l=0,s=!1,u="",c=null,f=null,d=0,h=[];function p(e,t){return(e=String(null==e?"":e)).length>t?e.slice(0,t):e}function m(e){return String(null==e?"":e).replace(/[\t\n\r]+/g," ").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g,"").replace(/ {2,}/g," ").trim()}function g(e){return String(e||"").replace(/\s+/g," ").trim().toLowerCase().slice(0,40)}function v(e){try{var t=new URL(e),n=t.protocol+"//"+t.host.toLowerCase()+t.pathname.replace(/\/+$/,"");0===t.hash.indexOf("#/")&&(n+=t.hash);var r=[];return t.searchParams.forEach(function(e,t){/^utm_/i.test(t)||"fbclid"===t||"gclid"===t||r.push([t,e])}),r.sort(function(e,t){return e[0]<t[0]?-1:e[0]>t[0]?1:e[1]<t[1]?-1:e[1]>t[1]?1:0}),r.length&&(n+="?"+r.map(function(e){return e[0]+"="+e[1]}).join("&")),n}catch(e){return""}}function b(e){for(var t=2166136261,n=0;n<e.length;n++)t^=e.charCodeAt(n),t=Math.imul(t,16777619);return(t>>>0).toString(16).padStart(8,"0")}var x={},y=null,w=null;function M(e){return"none"===e?0:parseFloat(e)}function A(e,t){return/%$/.test(e)?parseFloat(e)/100*t:M(e)}function C(e){return null==e?1:Math.max(0,Math.min(1,/%$/.test(e)?parseFloat(e)/100:M(e)))}function E(e,t,n){if(0===t)return[255*n,255*n,255*n];var r=n<.5?n*(1+t):n+t-n*t,i=2*n-r;function a(e){return 255*((e=(e+1)%1)<1/6?i+6*(r-i)*e:e<.5?r:e<2/3?i+(r-i)*(2/3-e)*6:i)}return[a((e=(e%360+360)%360/360)+1/3),a(e),a(e-1/3)]}function k(e){var t=String(null==e?"":e).trim().toLowerCase();if(!t)return null;if(Object.prototype.hasOwnProperty.call(x,t))return x[t];var n,i,a=null;if("transparent"===t)a={r:0,g:0,b:0,a:0};else if((n=/^#([0-9a-f]{3,8})$/.exec(t))&&[3,4,6,8].indexOf(n[1].length)>=0){var o=n[1];o.length<6&&(o=o.replace(/./g,function(e){return e+e})),a={r:parseInt(o.substr(0,2),16),g:parseInt(o.substr(2,2),16),b:parseInt(o.substr(4,2),16),a:8===o.length?parseInt(o.substr(6,2),16)/255:1}}else if((n=/^(rgba?|hsla?|color)\(\s*([^)]*)\)$/.exec(t))&&0!==t.indexOf("color-mix")){i=n[2].split(/[\s,\/]+/).filter(Boolean);var l=n[1];if("rgb"===l||"rgba"===l)i.length>=3&&(a={r:A(i[0],255),g:A(i[1],255),b:A(i[2],255),a:C(i[3])});else if("hsl"===l||"hsla"===l){if(i.length>=3){var s=E(parseFloat(i[0]),A(i[1],1),A(i[2],1));a={r:s[0],g:s[1],b:s[2],a:C(i[3])}}}else"srgb"===i[0]&&i.length>=4&&(a={r:255*A(i[1],1),g:255*A(i[2],1),b:255*A(i[3],1),a:C(i[4])});a&&(isNaN(a.r)||isNaN(a.g)||isNaN(a.b)||isNaN(a.a))&&(a=null)}return a||(a=function(e){try{w||((y=r.createElement("canvas")).width=1,y.height=1,w=y.getContext("2d",{willReadFrequently:!0})),w.fillStyle="#fe0102",w.fillStyle=e;var t=w.fillStyle;w.fillStyle="#01fe02",w.fillStyle=e;var n=w.fillStyle;if("#fe0102"===t&&"#01fe02"===n)return null;w.clearRect(0,0,1,1),w.fillRect(0,0,1,1);var i=w.getImageData(0,0,1,1).data;return{r:i[0],g:i[1],b:i[2],a:Math.round(i[3]/255*1e3)/1e3}}catch(e){return null}}(t)),a&&(a={r:Math.round(Math.max(0,Math.min(255,a.r))),g:Math.round(Math.max(0,Math.min(255,a.g))),b:Math.round(Math.max(0,Math.min(255,a.b))),a:a.a}),x[t]=a,a}function S(e){return(e/=255)<=.04045?e/12.92:Math.pow((e+.055)/1.055,2.4)}function N(e){return.2126*S(e.r)+.7152*S(e.g)+.0722*S(e.b)}function L(e,t){var n=N(e),r=N(t);return(Math.max(n,r)+.05)/(Math.min(n,r)+.05)}function T(e){return((e=Math.max(0,Math.min(255,Math.round(e))))<16?"0":"")+e.toString(16)}function R(e){return"#"+T(e.r)+T(e.g)+T(e.b)}function D(e,t){var n=e.a,r=null==t.a?1:t.a,i=n+r*(1-n);return i<=0?{r:0,g:0,b:0,a:0}:{r:(e.r*n+t.r*r*(1-n))/i,g:(e.g*n+t.g*r*(1-n))/i,b:(e.b*n+t.b*r*(1-n))/i,a:i}}function I(e,t,n){var r=function(e,t,n){e/=255,t/=255,n/=255;var r=Math.max(e,t,n),i=Math.min(e,t,n),a=(r+i)/2,o=0,l=0,s=r-i;return s>0&&(l=a>.5?s/(2-r-i):s/(r+i),o=r===e?(t-n)/s+(t<n?6:0):r===t?(n-e)/s+2:(e-t)/s+4,o*=60),[o,l,a]}(e.r,e.g,e.b),i=n+.05,a=null;if([-1,1].forEach(function(e){for(var n=.5;n<=100;n+=.5){var o=r[2]+e*n/100;if(o<0||o>1)break;var l=E(r[0],r[1],o),s={r:Math.round(l[0]),g:Math.round(l[1]),b:Math.round(l[2])};if(L(s,t)>=i){(!a||n<a.d)&&(a={d:n,c:s,dir:e<0?"darker":"lighter"});break}}}),a)return{hex:R(a.c),dir:a.dir,reachable:!0};var o=L({r:255,g:255,b:255},t)>L({r:0,g:0,b:0},t);return{hex:o?"#ffffff":"#000000",dir:o?"lighter":"darker",reachable:!1}}var F=/\d{4,}|[0-9a-f]{8,}|^(radix-|:r|react-|ember)/i,O=[/^(css|sc|jsx|_)[-_]?[a-z0-9]{5,}$/i,/^[a-z]{1,3}[0-9a-f]{5,}$/],z=/^[\w#.\-:>\[\]="'()*~+,\/ $]+$/,$={SCRIPT:1,STYLE:1,NOSCRIPT:1,TEMPLATE:1,HEAD:1,META:1,LINK:1,TITLE:1,BASE:1};function j(e){var t=e.getRootNode&&e.getRootNode();return!t||9!==t.nodeType&&11!==t.nodeType?e.ownerDocument:t}function B(e,t){try{return e.querySelectorAll(t)}catch(e){return[]}}function H(e){var t,n=e.getAttribute&&e.getAttribute("id");return!n||F.test(n)||/\s/.test(n)?"":1===B(j(e),'[id="'+(t=n,String(t).replace(/\\/g,"\\\\").replace(/"/g,'\\"')+'"]')).length?n:""}function P(e){for(var t=[],n=e.classList||[],r=0;r<n.length&&t.length<2;r++){var i=n[r];/^[A-Za-z_-][\w-]*$/.test(i)&&(O[0].test(i)||O[1].test(i)||t.push(i))}return t}function V(e){var t=j(e);if(t&&11===t.nodeType)return t.host;var n=e.ownerDocument&&e.ownerDocument.defaultView;try{return n&&n.frameElement&&n.frameElement.ownerDocument?n.frameElement:null}catch(e){return null}}function _(e,t,n){if(e.length>200||!z.test(e))return!1;var r=B(n,e);return 1===r.length&&r[0]===t}function q(e,t){var n=e.localName,r=e.parentNode,i=n;t||(i+=P(e).map(function(e){return"."+e}).join(""));var a=[],o=0;if(r&&r.children)for(var l=0;l<r.children.length;l++){var s=r.children[l];s.localName===n&&(a.push(s),s===e&&(o=a.length))}if(a.length>1){var u=0;if(!t)for(var c=0;c<a.length;c++)a[c].matches(i)&&u++;(t||u>1||i===n)&&(i+=":nth-of-type("+o+")")}return i}function W(e){var t=function(e,t){if(9===t.nodeType&&e===t.documentElement)return"html";var n,r,i=e.localName,a=H(e);if(a&&_(n="#"+CSS.escape(a),e,t))return n;if((r=e.getAttribute("name"))&&!/["\\]/.test(r)&&_(n=i+'[name="'+r+'"]',e,t))return n;if((r=e.getAttribute("href"))&&!/["\\]/.test(r)&&_(n=i+'[href="'+r+'"]',e,t))return n;if((r=e.getAttribute("src"))&&(r=(r=r.split("#")[0].split("?")[0]).slice(r.lastIndexOf("/")+1))&&!/["\\]/.test(r)&&_(n=i+'[src$="'+r+'"]',e,t))return n;for(var o=[],l=e;l&&1===l.nodeType;){var s=l!==e&&H(l);if(s?o.unshift("#"+CSS.escape(s)):o.unshift(q(l,!1)),_(n=o.join(" > "),e,t))return n;if(s)break;l=l.parentNode&&1===l.parentNode.nodeType?l.parentNode:null}for(o=[],l=e;l&&1===l.nodeType;)o.unshift(q(l,!0)),l=l.parentNode&&1===l.parentNode.nodeType?l.parentNode:null;if((n=o.join(" > ")).length>200){for(;o.length>1&&o.join(" > ").length>200;)o.shift();n=o.join(" > ")}return n}(e,j(e)),n=V(e);return n&&n!==e&&(t=W(n)+" >>> "+t),t}function X(e){try{for(var t=String(e).split(" >>> "),n=r,i=null,a=0;a<t.length;a++){if(!n)return null;if(!(i=n.querySelector(t[a])))return null;n=i.shadowRoot||i.contentDocument||null}return i}catch(e){return null}}var U={a:"link",button:"button",img:"img",select:"combobox",textarea:"textbox",summary:"button",h1:"heading",h2:"heading",h3:"heading",h4:"heading",h5:"heading",h6:"heading"},Y={checkbox:"checkbox",radio:"radio",range:"slider",button:"button",submit:"button",reset:"button",image:"button",search:"searchbox"};function K(e){var t=e.getAttribute("role");if(t)return m(t.split(/\s+/)[0]).toLowerCase();var n=e.localName;return"input"===n?Y[(e.getAttribute("type")||"text").toLowerCase()]||"textbox":("a"!==n||e.hasAttribute("href"))&&U[n]||""}function Z(e,t){t=t||200;var n="";return function e(r){for(var i=r.firstChild;i&&n.length<t;i=i.nextSibling)3===i.nodeType?n+=i.nodeValue+" ":1!==i.nodeType||$[i.nodeName]||i.hasAttribute("data-pp-root")||e(i)}(e),n.replace(/\s+/g," ").trim().slice(0,t)}function G(e){var t,n=H(e);if(n)return"#"+n;if(t=e.getAttribute("name"))return"name:"+t;if(t=e.getAttribute("href"))return"href:"+function(e){try{var t=new URL(e,location.href);return t.pathname+t.search+t.hash}catch(t){return e}}(t);if(t=e.getAttribute("src"))return"src:"+(t=t.split("#")[0].split("?")[0]).slice(t.lastIndexOf("/")+1);var r=e===e.ownerDocument.documentElement||"body"===e.localName?"":g(Z(e,80));return r?"text:"+r:""}function J(e){for(var t=[],n=e.parentElement||V(e),r=0;n&&r<4;){var i=H(n);if(t.push(n.localName+(i?"#"+i:"")),i)break;n=n.parentElement||V(n),r++}return t.join(">")}function Q(e,t,n){return[e,n&&0===n.indexOf("heading")?"heading":t.localName,K(t),G(t)+(n?"~"+n:""),J(t)].join("|")}function ee(e,t,n,r){return e+"@"+b(Q(e,t,n)+(r?"|#"+r:""))}function te(e){return Math.round(100*e)/100}function ne(e){var t=ve.nb&&ve.nb.get(e);if(t)return t;ve.nb=ve.nb||new Map;var n=be(e);return t={bg:k(n.backgroundColor)||{r:0,g:0,b:0,a:0},img:"none"!==n.backgroundImage&&""!==n.backgroundImage,op:parseFloat(n.opacity),pos:"static"!==n.position},isNaN(t.op)&&(t.op=1),ve.nb.set(e,t),t}function re(e){var t=ve.pl&&ve.pl.get(e);return void 0!==t||(ve.pl=ve.pl||new Map,t=!1,ne(e).pos&&["::before","::after"].forEach(function(n){var r=e.ownerDocument.defaultView.getComputedStyle(e,n);"none"!==r.content&&"normal"!==r.content&&"none"!==r.display&&("absolute"!==r.position&&"fixed"!==r.position||("none"!==r.backgroundImage||(k(r.backgroundColor)||{a:0}).a>.01)&&(t=!0))}),ve.pl.set(e,t)),t}function ie(e,t){for(var n,r=t,i=e,a=!1;i;){var o=ne(i);if(r.a<.99&&(o.img||re(i))){a=!0;break}if(o.bg.a>0&&(r=D(r,o.bg)),o.op<1&&(r={r:r.r,g:r.g,b:r.b,a:r.a*o.op}),r.a>=.99&&Ee(i).op>=.999){r={r:r.r,g:r.g,b:r.b,a:1};break}i=xe(i)}return a?null:(n=D(r,function(e){var t=e.ownerDocument,n=t.defaultView.getComputedStyle(t.documentElement).colorScheme||"";return/\bdark\b/.test(n)&&(!/\blight\b/.test(n)||window.matchMedia&&matchMedia("(prefers-color-scheme: dark)").matches)?{r:18,g:18,b:18,a:1}:{r:255,g:255,b:255,a:1}}(e)),{r:Math.round(n.r),g:Math.round(n.g),b:Math.round(n.b),a:n.a})}var ae={img:1,video:1,canvas:1,svg:1,picture:1,iframe:1,object:1,embed:1};var oe={option:1,optgroup:1,textarea:1,select:1,input:1};function le(e){if("inline"!==be(e).display)return!1;var t=e.parentNode;if(!t)return!1;for(var n=t.firstChild;n;n=n.nextSibling)if(3===n.nodeType&&/\S/.test(n.nodeValue))return!0;return!1}function se(){if(ve.tg)return ve.tg;var e=[];return ve.els.forEach(function(t){if(function(e){var t=e.localName;if("a"===t)return e.hasAttribute("href");if("button"===t||"select"===t||"textarea"===t||"summary"===t)return!0;if("input"===t)return"hidden"!==(e.getAttribute("type")||"").toLowerCase();var n=e.getAttribute("role");if(n&&/^(button|link|checkbox|tab|menuitem)$/.test(n.trim().split(/\s+/)[0].toLowerCase()))return!0;var r=e.getAttribute("tabindex");return null!==r&&parseInt(r,10)>=0}(t)&&!Ne(t)&&ke(t)){var n=Me(t);n.w<=1&&n.h<=1||e.push({el:t,r:n,inl:le(t)})}}),ve.tg=e,e}function ue(e,t,n){var r=Math.max(n.x-e,0,e-(n.x+n.w)),i=Math.max(n.y-t,0,t-(n.y+n.h));return Math.sqrt(r*r+i*i)}var ce=[/\.(png|jpe?g|gif|svg|webp)$/i,/^img[_-]?\d+/i];var fe={hidden:1,submit:1,button:1,reset:1,image:1};var de=/^(button|link|tab|menuitem)$/;function he(e){var t=/^h([1-6])$/.exec(e.localName);if(t)return+t[1];if("heading"===(e.getAttribute("role")||"").trim().toLowerCase()){var n=parseInt(e.getAttribute("aria-level"),10);return n>=1&&n<=9?n:2}return 0}function pe(e){return!e||"none"===e||"initial"===e}function me(e){return"none"===e.outlineStyle||/^0(px)?$/.test(e.outlineWidth||"")}function ge(e){var t=e.style,n=me(t),r=function(e){return!((!e.outlineStyle||"none"===e.outlineStyle||/^0(px)?$/.test(e.outlineWidth||""))&&pe(e.boxShadow)&&!(e.borderColor||e.borderTopColor||e.borderBottomColor||e.borderLeftColor||e.borderRightColor)&&!e.backgroundColor&&!e.background&&(!e.textDecorationLine||"none"===e.textDecorationLine)&&(!e.textDecoration||"none"===e.textDecoration)&&pe(e.filter))}(t),i=[];return n||r?(String(e.selectorText).split(/,(?![^(]*\))/).forEach(function(e){if((e=e.trim())&&!/:not\(\s*:focus/.test(e)&&!/:has\(/.test(e)){var t=e.split(/\s*[>+~]\s*|\s+(?![^(]*\))/),a=t[t.length-1],o=/:focus/.test(a)||/:focus-within/.test(e);if(n||o){var l=e.replace(/:focus-visible|:focus-within|:focus/g,"").trim();l&&!/[>+~]$/.test(l)||(l+="*"),i.push({sel:l,focus:o,rm:n,rep:r&&o})}}}),i):i}var ve=null;function be(e){var t=ve.cs.get(e);return t||(t=e.ownerDocument.defaultView.getComputedStyle(e),ve.cs.set(e,t)),t}function xe(e){return e.parentElement||V(e)}function ye(e){if(e===window)return{x:0,y:0};var t=ve.fo.get(e);if(!t){t={x:0,y:0};try{var n=e.frameElement,r=n.getBoundingClientRect(),i=ye(n.ownerDocument.defaultView);t={x:r.left+n.clientLeft+i.x,y:r.top+n.clientTop+i.y}}catch(e){}ve.fo.set(e,t)}return t}function we(e,t){var n=ye(t.ownerDocument.defaultView);return{x:e.left+n.x+ve.sx,y:e.top+n.y+ve.sy,w:e.width,h:e.height}}function Me(e){var t=ve.rc.get(e);return t||(t=we(e.getBoundingClientRect(),e),ve.rc.set(e,t)),t}function Ae(e,t){var n=Math.min(e.x+e.w,t.x+t.w)-Math.max(e.x,t.x),r=Math.min(e.y+e.h,t.y+t.h)-Math.max(e.y,t.y);return n>0&&r>0?n*r:0}var Ce=/^rect\(\s*0(px)?[ ,]+0(px)?[ ,]+0(px)?[ ,]+0(px)?\s*\)$/;function Ee(e){var t=ve.ly.get(e);if(t)return t;var n=be(e),r=xe(e),i=r?Ee(r):{op:1,clip:null,hide:!1,blend:!1},a=i.op*(parseFloat(n.opacity)||0),o=i.clip,l=i.hide,s=e.localName;if("html"!==s&&"body"!==s){var u=n.overflowX,c=n.overflowY,f="hidden"===u||"clip"===u,d="hidden"===c||"clip"===c;if(f||d){var h=Me(e),p={x:f?h.x:-1e9,y:d?h.y:-1e9,w:f?h.w:2e9,h:d?h.h:2e9};if((f&&h.w<2||d&&h.h<2)&&(l=!0),o){var m=Math.max(o.x,p.x),g=Math.max(o.y,p.y);p={x:m,y:g,w:Math.min(o.x+o.w,p.x+p.w)-m,h:Math.min(o.y+o.h,p.y+p.h)-g}}o=p}}return n.clip&&"auto"!==n.clip&&Ce.test(n.clip)&&(l=!0),/^inset\(\s*(50|100)%/.test(n.clipPath||"")&&(l=!0),t={op:a,clip:o,hide:l,blend:!!(i.blend||n.mixBlendMode&&"normal"!==n.mixBlendMode||n.filter&&"none"!==n.filter||"none"!==(n.backdropFilter||n.webkitBackdropFilter||"none")),ovc:!(!i.ovc&&"auto"!==u&&"scroll"!==u&&"hidden"!==u&&"clip"!==u&&"fixed"!==n.position)},ve.ly.set(e,t),t}function ke(e){var t=ve.vs.get(e);if(void 0!==t)return t;if(t=!1,"visible"===be(e).visibility&&e.getClientRects().length>0){var n=Ee(e),r=Me(e);t=n.op>=.01&&!n.hide&&r.w>0&&r.h>0&&r.x+r.w>0&&r.y+r.h>0&&(!n.clip||Ae(n.clip,r)>0)}return ve.vs.set(e,t),t}function Se(e){return"hidden"!==be(e).visibility&&e.getClientRects().length>0&&!e.closest('[aria-hidden="true"]')}function Ne(e){return!!e.closest('[disabled],[aria-disabled="true"],:disabled')}var Le=[];function Te(e){for(var t=e.ownerDocument,n=0;n<Le.length;n++)if(Le[n][0]===t)return Le[n][1];var r=t.createRange();return Le.push([t,r]),r}function Re(e){var t=ve.tx.get(e);if(void 0!==t)return t;t=null;for(var n=null,r=1e9,i=1e9,a=-1e9,o=-1e9,l={},s=0,u=0,c=e.firstChild;c;c=c.nextSibling)if(3===c.nodeType&&/\S/.test(c.nodeValue)){u+=c.nodeValue.replace(/\s/g,"").length,(n=n||Te(e)).selectNodeContents(c);for(var f=n.getClientRects(),d=0;d<f.length;d++){var h=we(f[d],e);if(!(h.w<=0||h.h<=0)){r=Math.min(r,h.x),i=Math.min(i,h.y),a=Math.max(a,h.x+h.w),o=Math.max(o,h.y+h.h);var p=Math.round(h.y/3);l[p]||(l[p]=1,s++)}}}return u&&a>r&&(t={box:{x:r,y:i,w:a-r,h:o-i},lines:s,chars:u}),ve.tx.set(e,t),t}function De(e,t){if(!t)return!1;if("visible"!==be(e).visibility)return!1;var n=Ee(e),r=t.box;return!(n.op<.01||n.hide||r.x+r.w<=0||r.y+r.h<=0)&&(!n.clip||Ae(n.clip,r)>0)}function Ie(e){var t="";return["::before","::after"].forEach(function(n){var r=e.ownerDocument.defaultView.getComputedStyle(e,n).content;if(r&&"none"!==r&&"normal"!==r){var i=/^(["'])([\s\S]*)\1$/.exec(r);if(i){var a=i[2].replace(/\\([0-9a-f]{1,6}) ?/gi,function(e,t){try{return String.fromCodePoint(parseInt(t,16))}catch(e){return""}});a=a.replace(/[\ue000-\uf8ff]/g,""),t+=a}}}),t}function Fe(e,t,n){var r="";return function e(i,a){if(!(a>8))for(var o=i.firstChild;o;o=o.nextSibling)if(3!==o.nodeType){if(1===o.nodeType&&!o.hasAttribute("data-pp-root")){var l=o.localName;if("script"!==l&&"style"!==l&&"template"!==l&&"noscript"!==l&&(!n||"select"!==l&&"textarea"!==l&&"input"!==l&&"button"!==l)&&(t||"true"!==o.getAttribute("aria-hidden")&&"none"!==be(o).display)){var s=o.getAttribute("aria-label");if(s&&/\S/.test(s))r+=s+" ";else if("img"===l||"input"===l&&"image"===o.getAttribute("type"))r+=(o.getAttribute("alt")||o.getAttribute("title")||"")+" ";else if("svg"!==l)t||(r+=Ie(o)),e(o,a+1);else{var u=o.querySelector("title");r+=(u?u.textContent:o.getAttribute("title")||"")+" "}}}}else r+=o.nodeValue+" "}(e,0),t||(r+=Ie(e)),r.replace(/\s+/g," ").trim()}function Oe(e){var t=function(e,t){var n=(e.getAttribute(t)||"").split(/\s+/).filter(Boolean),r=j(e),i="";return n.forEach(function(t){var n=(r.getElementById?r.getElementById(t):null)||e.ownerDocument.getElementById(t);n&&(i+=" "+(n.getAttribute("aria-label")||Fe(n,!0,!1)))}),i.trim()}(e,"aria-labelledby");return t||((t=e.getAttribute("aria-label"))&&/\S/.test(t)?t.trim():"")}var ze={};function $e(e,t,n,r){r=r||{},ve.raw.push({rule:e,el:t,sev:n,o:r,order:null==ve.idx.get(t)?1e9:ve.idx.get(t)})}function je(e,t){var n=ve.skipped[e]||(ve.skipped[e]={});n[t]=(n[t]||0)+1}function Be(e){ve.limits.indexOf(e)<0&&ve.limits.push(e)}var He={high:0,medium:1,low:2},Pe={high:8,medium:4,low:1},Ve=[];var _e={};function qe(e,t,n){ze[e]=n||{},Ve.push({id:e,fn:t})}qe("a11y.contrast",function(){var e=0;ve.els.forEach(function(t){if(!oe[t.localName]){var n=Re(t);if(n&&De(t,n)&&!Ne(t)){var r=be(t),i=k(r.webkitTextFillColor)||k(r.color);if(i&&!(i.a<.02)){ve.checked["a11y.contrast"]++;var a=Ee(t);if(a.blend)return je("a11y.contrast","blend"),void e++;for(var o=function(){if(ve.cands)return ve.cands;var e=[];return ve.els.forEach(function(t){var n=be(t);if("static"!==n.position||"none"!==n.transform){var r=ne(t);(ae[t.localName]||r.img||r.bg.a>.01)&&ke(t)&&e.push({el:t,box:Me(t)})}}),ve.cands=e,e}(),l=!1,s=0;s<o.length&&!l;s++){var u=o[s];u.el===t||u.el.contains(t)||Ae(u.box,n.box)>0&&(l=!0)}if(l)return je("a11y.contrast","overlap"),void e++;var c=ie(t,{r:0,g:0,b:0,a:0}),f=ie(t,i);if(!c||!f)return je("a11y.contrast","image"),void e++;var d=parseFloat(r.fontSize)||16,h=parseInt(r.fontWeight,10)||400,p=d>=24||d>=18.66&&h>=700,m=ve.aaa?p?4.5:7:p?3:4.5,g=L(f,c);if(!(g>=m)){var v=I(f,c,m),b=i.a<1||a.op<1?" (effective colour; text is semi-transparent)":"";$e("a11y.contrast",t,g<3?"high":"medium",{wcag:ve.aaa?"1.4.6":"1.4.3",note:"Contrast "+te(g)+":1, needs "+m+":1"+b,fix:v.reachable?("darker"===v.dir?"Darken":"Lighten")+" text to "+v.hex+" or "+v.dir+" (on "+R(c)+")":"No text colour reaches "+m+":1 on "+R(c)+"; change the background",measured:{ratio:te(g),need:m,fg:R(f),bg:R(c),px:Math.round(10*d)/10}})}}}}}),e&&Be("contrast: "+e+" text element(s) skipped (background image/gradient, overlapping layer or blend mode); never guessed")},{sev:"high"}),qe("a11y.tap-target",function(){var e=se(),t=ve.tapMin,n=ve.tapAdv,r={},i=64;e.forEach(function(e,n){e.small=Math.round(100*Math.min(e.r.w,e.r.h))/100<t,e.cx=e.r.x+e.r.w/2,e.cy=e.r.y+e.r.h/2,function(e,t,n){for(var r=Math.floor((e.x-t)/i);r<=Math.floor((e.x+e.w+t)/i);r++)for(var a=Math.floor((e.y-t)/i);a<=Math.floor((e.y+e.h+t)/i);a++)n(r+","+a)}(e.r,24,function(e){(r[e]=r[e]||[]).push(n)})}),e.forEach(function(a,o){ve.checked["a11y.tap-target"]++;var l=Math.round(100*Math.min(a.r.w,a.r.h))/100;if(!a.inl){var s=Math.round(a.r.w),u=Math.round(a.r.h);if(a.small){for(var c=r[Math.floor(a.cx/i)+","+Math.floor(a.cy/i)]||[],f=!1,d=0;d<c.length&&!f;d++){var h=e[c[d]];h===a||h.el.contains(a.el)||a.el.contains(h.el)||(ue(a.cx,a.cy,h.r)<12||h.small&&Math.hypot(a.cx-h.cx,a.cy-h.cy)<24)&&(f=!0)}if(!f)return;$e("a11y.tap-target",a.el,"medium",{wcag:"2.5.8",note:"Target is "+s+"×"+u+"px; minimum is "+t+"×"+t+"px and neighbours are too close",fix:"Make it at least "+t+"×"+t+"px (44×44 recommended) or keep other targets 24px away",measured:{w:s,h:u,min:t}})}else n>0&&l<n&&$e("a11y.tap-target",a.el,"low",{wcag:"2.5.5",note:"Target is "+s+"×"+u+"px; "+n+"×"+n+"px is the recommended size",fix:"Enlarge the clickable area to "+n+"×"+n+"px (padding is enough)",measured:{w:s,h:u,min:n}})}})}),qe("a11y.img-alt",function(){ve.els.forEach(function(e){var t=e.localName,n=(e.getAttribute("role")||"").trim().split(/\s+/)[0].toLowerCase(),r="";if("img"===t?r="img":"input"===t&&"image"===(e.getAttribute("type")||"").toLowerCase()?r="input":"img"===n&&(r="role"),r&&Se(e)){var i=Me(e);if(!("img"===r&&i.w<=1&&i.h<=1)){ve.checked["a11y.img-alt"]++;var a=Oe(e)||(e.getAttribute("title")||"").trim();if("role"===r&&!a&&"svg"===t){var o=e.querySelector("title");a=o?o.textContent.trim():""}var l=e.getAttribute("alt"),s="";if("img"===r){if("presentation"===n||"none"===n)return;if(null===l){if(a)return;s="Image has no alt attribute"}else if(/\S/.test(l)){if(!ce[0].test(l.trim())&&!ce[1].test(l.trim()))return;s="Alt text looks like a file name"}else{if(!n||a)return;s='Empty alt but role="'+p(m(n),20)+'" needs a name'}}else if("input"===r){if(l&&/\S/.test(l)||a)return;s="Image button has no accessible name"}else{if(a)return;s='role="img" has no accessible name'}$e("a11y.img-alt",e,"high",{wcag:"1.1.1",note:s,fix:'Add alt text that describes the image purpose, or alt="" if purely decorative',measured:{w:Math.round(i.w),h:Math.round(i.h)}})}}})}),qe("a11y.form-label",function(){ve.els.forEach(function(e){var t=e.localName;if(("input"===t||"select"===t||"textarea"===t)&&("input"!==t||!fe[(e.getAttribute("type")||"text").toLowerCase()])&&Se(e)&&(ve.checked["a11y.form-label"]++,!(Oe(e)||function(e){var t="",n=e.labels;if(n)for(var r=0;r<n.length;r++)t+=" "+Fe(n[r],!0,!0);return t.trim()}(e)||(e.getAttribute("title")||"").trim()))){var n=/\S/.test(e.getAttribute("placeholder")||"");$e("a11y.form-label",e,"high",{wcag:"1.3.1",note:n?"Field has only a placeholder; a placeholder is not a label":"Form field has no accessible name",fix:"Add a visible <label for> (or aria-label) that names the field",measured:{placeholder:n?1:0}})}})}),qe("a11y.control-name",function(){ve.els.forEach(function(e){var t=e.localName,n=(e.getAttribute("role")||"").trim().split(/\s+/)[0].toLowerCase();("button"===t||"a"===t&&e.hasAttribute("href")||de.test(n))&&Se(e)&&(ve.checked["a11y.control-name"]++,Oe(e)||Fe(e,!1,!1)||(e.getAttribute("title")||"").trim()||$e("a11y.control-name",e,"high",{wcag:"4.1.2",note:("a"===t?"Link":"Control")+" has no accessible name (icon-only?)",fix:"Add aria-label or visible text that says what it does",measured:{}}))})}),qe("a11y.heading-order",function(){var e=[];ve.all.forEach(function(t){var n=he(t);n&&Se(t)&&e.push({el:t,level:n})}),ve.checked["a11y.heading-order"]=e.length;var t=0,n=0;e.forEach(function(e){var r;!(Oe(r=e.el)||Fe(r,!1,!1))&&$e("a11y.heading-order",e.el,"low",{wcag:"2.4.6",variant:"heading:empty",note:"Heading <h"+e.level+"> is empty",fix:"Add heading text or remove the empty heading",measured:{level:e.level}}),1===e.level&&++n>1&&$e("a11y.heading-order",e.el,"low",{wcag:"1.3.1",variant:"heading:multi-h1",note:"More than one h1 on the page",fix:"Keep one h1 for the page title; use h2 for sections",measured:{level:1}}),t&&e.level-t>1&&$e("a11y.heading-order",e.el,"low",{wcag:"1.3.1",variant:"heading:jump",note:"Heading level jumps from h"+t+" to h"+e.level,fix:"Use h"+(t+1)+" here (do not skip levels)",measured:{from:t,to:e.level}}),t=e.level}),n||$e("a11y.heading-order",e.length?e[0].el:r.querySelector("body")||i,"low",{wcag:"2.4.6",variant:"heading:no-h1",note:"Page has no h1",fix:"Add one h1 that names the page",measured:{headings:e.length}})}),qe("a11y.focus-indicator",function(){var e=new Map,t=0;function n(e,t){for(var i=0;i<e.length;i++){var a=e[i];void 0!==a.selectorText&&a.style?ge(a).forEach(function(e){t.push(e)}):"undefined"!=typeof CSSMediaRule&&a instanceof CSSMediaRule?matchMedia(a.media.mediaText).matches&&n(a.cssRules,t):"undefined"!=typeof CSSSupportsRule&&a instanceof CSSSupportsRule?CSS.supports(a.conditionText)&&n(a.cssRules,t):"undefined"!=typeof CSSLayerBlockRule&&a instanceof CSSLayerBlockRule?n(a.cssRules,t):a.styleSheet&&r(a.styleSheet,t)}}function r(e,r){var i;try{i=e.cssRules}catch(e){return void t++}i&&n(i,r)}ve.els.forEach(function(t){if(function(e){var t=e.localName;if("a"===t)return e.hasAttribute("href");if("input"===t)return"hidden"!==(e.getAttribute("type")||"").toLowerCase();if("button"===t||"select"===t||"textarea"===t||"summary"===t)return!0;if(e.hasAttribute("contenteditable")&&"false"!==e.getAttribute("contenteditable"))return!0;var n=e.getAttribute("tabindex");return null!==n&&parseInt(n,10)>=0}(t)&&!Ne(t)&&ke(t)){ve.checked["a11y.focus-indicator"]++;var n,i,a=(n=j(t),(i=e.get(n))||(i=[],e.set(n,i),[].slice.call(n.styleSheets||[]).concat([].slice.call(n.adoptedStyleSheets||[])).forEach(function(e){e.disabled||e.media&&e.media.mediaText&&!matchMedia(e.media.mediaText).matches||r(e,i)}),i)),o=!1,l=!1,s=t.style;s&&me(s)&&(o=!0);for(var u=0;u<a.length;u++){var c=a[u];if(c.rm&&!o||c.rep&&!l){var f=!1;try{f=t.matches(c.sel)}catch(e){}f&&(c.rm&&(o=!0),c.rep&&(l=!0))}}o&&!l&&$e("a11y.focus-indicator",t,"medium",{wcag:"2.4.7",heuristic:!0,confidence:"medium",note:"Focus outline removed by author CSS; no :focus-visible style replaces it",fix:"Add :focus-visible{outline:2px solid currentColor;outline-offset:2px}",measured:{}})}}),t&&Be("cross-origin stylesheets not scanned: "+t)}),qe("a11y.lang",function(){ve.checked["a11y.lang"]=1,/\S/.test(i.getAttribute("lang")||"")||$e("a11y.lang",i,"medium",{wcag:"3.1.1",note:"<html> has no lang attribute",fix:'Add lang="en" (or the page language) to <html>',measured:{}})}),qe("a11y.page-title",function(){ve.checked["a11y.page-title"]=1,/\S/.test(r.title||"")||$e("a11y.page-title",r.querySelector("title")||i,"low",{wcag:"2.4.2",anchorEl:i,note:"Page has no <title> text",fix:"Add a short, unique <title> that names the page",measured:{}})}),qe("a11y.viewport-zoom",function(){var e=r.querySelectorAll('meta[name="viewport" i]');if(ve.checked["a11y.viewport-zoom"]=e.length,e.length){var t=e[e.length-1],n=(t.getAttribute("content")||"").toLowerCase(),a=!1,o=-1;n.split(/[,;]/).forEach(function(e){var t=e.split("="),n=(t[0]||"").trim(),r=(t[1]||"").trim();if("user-scalable"!==n||"no"!==r&&"0"!==r||(a=!0),"maximum-scale"===n){var i=parseFloat(r);isNaN(i)||(o=i,i<2&&(a=!0))}}),a&&$e("a11y.viewport-zoom",t,"medium",{wcag:"1.4.4",anchorEl:i,note:"Viewport meta blocks pinch zoom (user-scalable=no or maximum-scale<2)",fix:"Remove user-scalable=no and maximum-scale from the viewport meta",measured:{maxScale:o}})}}),qe("layout.h-overflow",function(){ve.checked["layout.h-overflow"]=1;var e=ve.vw,t=At().scrollWidth;if(!(t<=e+1)){var n=r.querySelector("body"),a=be(i),o=n?be(n):null;if(s(a.overflowX)||"visible"===a.overflowX&&o&&s(o.overflowX))Be("horizontal overflow of "+(t-e)+"px is hidden by overflow-x on the root; not reported");else{var l=[];ve.all.forEach(function(t){if(t.ownerDocument===r&&t!==i){var n=be(t);if("hidden"!==n.visibility&&0!==t.getClientRects().length&&"none"===n.transform){var a=Me(t),o=Math.ceil(a.x+a.w-e);if(!(o<1||Ee(t).ovc)){for(var s=t.parentElement;s&&s!==i;s=s.parentElement)if(!Ee(s).ovc&&Me(s).x+Me(s).w>e+1&&"hidden"!==be(s).visibility)return;l.push({el:t,over:o,order:ve.idx.get(t)})}}}}),l.sort(function(e,t){return t.over-e.over||e.order-t.order}),l.length?l.slice(0,5).forEach(function(t){$e("layout.h-overflow",t.el,"medium",{wcag:"1.4.10",note:"Extends "+t.over+"px beyond the "+e+"px viewport, causing horizontal scrolling",fix:"Constrain its width (max-width:100%, wrapping) or let it scroll in its own container",measured:{over:t.over,vw:e}})}):$e("layout.h-overflow",i,"medium",{wcag:"1.4.10",confidence:"medium",note:"Page is "+(t-e)+"px wider than the viewport; source element not identified",fix:"Constrain the widest element (images, tables, fixed widths)",measured:{over:t-e,vw:e}})}}function s(e){return"hidden"===e||"clip"===e}}),qe("type.text-small",function(){ve.els.forEach(function(e){if(!oe[e.localName]&&"sub"!==e.localName&&"sup"!==e.localName){var t=Re(e);if(t){var n=be(e),r=parseFloat(n.fontSize);r>=1&&(ve.checked["type.text-small"]++,r>=12||!De(e,t)||/small-caps/.test(n.fontVariantCaps||"")||e.closest("sub,sup")||$e("type.text-small",e,(r=Math.round(10*r)/10)<10?"medium":"low",{wcag:"1.4.4",note:"Text is "+r+"px; below 12px",fix:"Use at least 12px (14-16px for body text)",measured:{px:r}}))}}})}),qe("type.line-height",function(){ve.els.forEach(function(e){var t,n=Re(e);if(!(!n||n.lines<2||oe[e.localName]||"inline"===(t=be(e)).display||he(e))){var r=t.lineHeight;if("normal"!==r){var i=parseFloat(r),a=parseFloat(t.fontSize);i>0&&a>0&&(ve.checked["type.line-height"]++,!De(e,n)||i>=1.2*a-.05||$e("type.line-height",e,"low",{wcag:"1.4.12",note:"Line height "+te(i)+"px is "+te(i/a)+"× the "+te(a)+"px font size; at least 1.2× is needed",fix:"Set line-height to 1.5 (never below 1.2) on this text",measured:{lineHeight:te(i),fontSize:te(a),lines:n.lines}}))}}})}),qe("spacing.tight-targets",function(){var e=se().filter(function(e){return!e.inl&&Math.min(e.r.w,e.r.h)<44}),t={};function n(e,t,n){for(var r=Math.floor((e.x-t)/64);r<=Math.floor((e.x+e.w+t)/64);r++)for(var i=Math.floor((e.y-t)/64);i<=Math.floor((e.y+e.h+t)/64);i++)n(r+","+i)}e.forEach(function(e,r){n(e.r,0,function(e){(t[e]=t[e]||[]).push(r)})}),e.forEach(function(r,i){ve.checked["spacing.tight-targets"]++;var a=null,o={};n(r.r,8,function(n){(t[n]||[]).forEach(function(t){if(!(t>=i||o[t])){o[t]=1;var n=e[t];if(!n.el.contains(r.el)&&!r.el.contains(n.el)){var l=Math.max(n.r.x-(r.r.x+r.r.w),r.r.x-(n.r.x+n.r.w),0),s=Math.max(n.r.y-(r.r.y+r.r.h),r.r.y-(n.r.y+n.r.h),0),u=Math.sqrt(l*l+s*s);u<8&&(null===a||u<a)&&(a=u)}}})}),null!==a&&(a=Math.round(10*a)/10,$e("spacing.tight-targets",r.el,"low",{wcag:"2.5.8",note:"Only "+a+"px from the previous small target (both under 44px)",fix:"Leave at least 8px between small targets or enlarge them to 44px",measured:{gap:a}}))})});var We=null,Xe=null,Ue=null,Ye=null,Ke=null,Ze=null,Ge=null,Je=[],Qe={},et="",tt="",nt=!1,rt="",it={high:"#e5484d",medium:"#f5a623",low:"#3b82f6",fixed:"#30a46c",dismissed:"#8b8d98"},at=[[26,0],[0,26],[-26,0],[0,-26],[26,26],[-26,26],[26,-26],[-26,-26]];function ot(t){return e.colors&&e.colors[t]||it[t]}function lt(e,t,n){var i=r.createElement(e);return t&&(i.className=t),null!=n&&(i.textContent=n),i}function st(){We?We.isConnected||i.appendChild(We):((We=lt("div")).setAttribute("data-pp-root",""),We.style.cssText="position:fixed;inset:0;z-index:2147483647;pointer-events:none;margin:0;padding:0;border:0;background:none;",(Xe=We.attachShadow({mode:"open"})).appendChild(lt("style","",["*{box-sizing:border-box}[hidden]{display:none!important}",".lines{position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible}",".hover,.tip,.card{position:absolute;left:0;top:0}",".hover{border:2px dashed #111;outline:2px dashed #fff;pointer-events:none}.hover.flash{animation:pp-f 1.2s ease-out}",".pin{position:absolute;left:0;top:0;width:24px;height:24px;border-radius:50%;border:2px solid #fff;padding:0;margin:0;font:700 12px/1 system-ui,sans-serif;color:#000;cursor:pointer;pointer-events:auto;box-shadow:0 1px 4px rgba(0,0,0,.5)}",".pin:focus-visible,.card button:focus-visible{outline:3px solid #111;outline-offset:2px}",".pin.high{background:"+ot("high")+"}.pin.medium{background:"+ot("medium")+"}.pin.low{background:"+ot("low")+"}",".pin.fixed{background:"+ot("fixed")+"}.pin.dismissed{background:"+ot("dismissed")+"}",'.pin.new::after{content:"";position:absolute;left:-6px;top:-6px;right:-6px;bottom:-6px;border-radius:50%;border:2px solid #111;animation:pp-p 1.4s ease-out infinite}',".tip{background:#111;color:#fff;font:12px/1.4 system-ui,sans-serif;padding:4px 8px;border-radius:6px;max-width:260px;pointer-events:none}",".card{width:272px;background:#fff;color:#111;border:1px solid #c8c8d0;border-radius:8px;padding:10px;font:13px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.3);pointer-events:auto}",".card p{margin:4px 0}.card .ch{font-weight:700}.card .row{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}",".card button{min-height:28px;padding:0 8px;border:1px solid #555;background:#f2f2f5;color:#111;border-radius:6px;font:600 12px system-ui,sans-serif;cursor:pointer}",".card button.go{background:#111;color:#fff}","@keyframes pp-p{from{opacity:1;transform:scale(.8)}to{opacity:0;transform:scale(1.4)}}@keyframes pp-f{0%,60%{outline-width:6px}100%{outline-width:2px}}","@media (prefers-reduced-motion:reduce){.pin.new::after,.hover.flash{animation:none}}"].join(""))),(Ue=r.createElementNS("http://www.w3.org/2000/svg","svg")).setAttribute("class","lines"),Ue.setAttribute("aria-hidden","true"),Ye=lt("div"),Ke=lt("div","hover"),Ze=lt("div","tip"),Ge=lt("div","card"),Ke.hidden=Ze.hidden=Ge.hidden=!0,[Ue,Ke,Ye,Ze,Ge].forEach(function(e){Xe.appendChild(e)}),i.appendChild(We))}function ut(){Je.forEach(function(e){clearTimeout(e.timer)}),Je=[],et="",tt="",Ye&&(Ye.textContent="",Ue.textContent="",Ke.hidden=Ze.hidden=Ge.hidden=!0),f&&(f.disconnect(),f.observe(i))}function ct(){ut(),We&&We.parentNode&&We.parentNode.removeChild(We),We=null}function ft(){return Je.filter(function(e){return!e.lost&&!e.faded&&!e.off}).length}function dt(e){return b(g("html"===e.localName||"body"===e.localName?"":Z(e,80)))}function ht(e){var t=e.anchor||{},n=X(e.selector);if(n&&n.localName===t.tag&&(dt(n)===t.textHash||t.ref&&n.getAttribute("id")===t.ref))return n;for(var i=t.tag?r.getElementsByTagName(t.tag):[],a=null,o=0,l=e.rect||{},s=String(t.path||"").split(">"),u=0;u<i.length;u++){var c=i[u];if(!Nt(c)){var f=0,d=J(c).split(">"),h=0;for(dt(c)===t.textHash&&(f+=3),t.ref&&c.getAttribute("id")===t.ref&&(f+=3),t.nameAttr&&c.getAttribute("name")===t.nameAttr&&(f+=2);h<s.length&&h<d.length&&s[h]===d[h];)h++;f+=2*h/Math.max(s.length,d.length,1);var p=c.getBoundingClientRect(),m=Math.hypot(p.left+p.width/2+window.pageXOffset-(l.x+l.w/2),p.top+p.height/2+window.pageYOffset-(l.y+l.h/2));(f+=m<100?1:m<400?.5:0)>o&&(o=f,a=c)}}return o>=4?a:null}function pt(e,t,n){return Math.max(t,Math.min(n,e))}function mt(){if(We){We.isConnected||i.appendChild(We);var e=At().clientWidth,t=At().clientHeight,n=[];Je.forEach(function(i){var a,o=!0;if(!i.faded&&(i.el&&i.el.isConnected||(i.el=ht(i.f),i.el&&f&&f.observe(i.el)),i.lost=!i.el,i.el&&(i.el===i.el.ownerDocument.documentElement||"body"===i.el.localName?a={left:0,top:0,right:e,bottom:t,width:e,height:t}:(a=i.el.getBoundingClientRect()).width&&a.height||(a={left:0,top:0,right:e,bottom:t,width:e,height:t}),i.vr=a,!(a.right<=0||a.bottom<=0||a.left>=e||a.top>=t)))){var l=pt(a.left,14,e-14),s=pt(a.top,14,t-14),u=function(e,t,n,r,i){for(var a=[e,t],o=-1,l=0;l<=8;l++)for(var s=0===l?[[0,0]]:at,u=0;u<s.length;u++){for(var c=pt(e+s[u][0]*l,14,n-14),f=pt(t+s[u][1]*l,14,r-14),d=1e9,h=0;h<i.length;h++)d=Math.min(d,Math.hypot(i[h][0]-c,i[h][1]-f));if(d>=26)return[c,f];d>o&&(o=d,a=[c,f])}return a}(l,s,e,t,n);n.push(u),o=!1,i.px===u[0]&&i.py===u[1]||(i.px=u[0],i.py=u[1],i.pin.style.transform="translate("+(u[0]-12)+"px,"+(u[1]-12)+"px)");var c=function(e){return e.line||(e.line=r.createElementNS("http://www.w3.org/2000/svg","line"),e.line.setAttribute("stroke-width","1"),Ue.appendChild(e.line)),e.line}(i),d=Math.hypot(u[0]-l,u[1]-s)>14;c.style.display=d?"":"none",d&&(c.setAttribute("x1",l),c.setAttribute("y1",s),c.setAttribute("x2",u[0]),c.setAttribute("y2",u[1]),c.setAttribute("stroke",ot(i.f.sev)))}if(i.off=o&&!i.lost&&!i.faded,i.pin.hidden=o,o&&i.line&&(i.line.style.display="none"),o&&et===i.f.id&&wt(),!o&&et===i.f.id){var h=Ge.offsetWidth,p=Ge.offsetHeight;Ge.style.transform="translate("+pt(i.px+16,4,Math.max(4,e-h-4))+"px,"+pt(i.py+16,4,Math.max(4,t-p-4))+"px)"}o||tt!==i.f.id||xt(i)}),rt=gt()}}function gt(){var e="";return Je.forEach(function(t){if(t.el&&t.el.isConnected){var n=t.el.getBoundingClientRect();e+=Math.round(n.left)+","+Math.round(n.top)+","+Math.round(n.width)+";"}else e+="x;"}),e}function vt(){!nt&&Je.length&&(nt=!0,requestAnimationFrame(function(){nt=!1,s||mt()}))}function bt(e){return e.slice(e.indexOf(".")+1)}function xt(e){var t=e.vr;t&&(Ke.style.transform="translate("+t.left+"px,"+t.top+"px)",Ke.style.width=Math.max(t.width,4)+"px",Ke.style.height=Math.max(t.height,4)+"px",Ke.style.borderColor=ot(e.f.sev),Ke.hidden=!1)}function yt(){if(tt="",Ke.hidden=!0,Ze.hidden=!0,et){var e=Je.filter(function(e){return e.f.id===et})[0];e&&(tt=et,xt(e))}}function wt(){et="",Ge&&(Ge.hidden=!0)}function Mt(t){var n=Qe[t.f.id]||"open";t.pin.className="pin "+t.f.sev+("open"===n?"":" "+n),t.pin.textContent="fixed"===n?"✓":String(t.num),t.pin.setAttribute("aria-label","Pinpoint "+t.num+": "+bt(t.f.rule)+("open"===n?"":" ("+n+")")),"fixed"!==n||t.timer||(t.timer=setTimeout(function(){t.faded=!0,s||mt()},e.fadeMs>=0?e.fadeMs:8e3)),"fixed"!==n&&t.timer&&(clearTimeout(t.timer),t.timer=0,t.faded=!1)}function At(){return r.scrollingElement||i}function Ct(){return Date.now()}function Et(e){e.t=Ct(),a.push(e),a.length>200&&a.shift()}function kt(e){l++,o||(o=!0,Et({type:"dirty",reason:e}))}function St(e,t,n,r){e.addEventListener(t,n,r),h.push([e,t,n,r])}function Nt(e){for(;e;){if(e===We)return!0;e=e.parentNode||e.host||null}return!1}function Lt(){var e=v(location.href);e!==u&&(u=e,kt("navigation"))}var Tt={protocol:1,version:t,audit:function(e){var t="undefined"!=typeof performance?performance.now():Date.now();e=e||{};var n={protocol:1,url:p(location.href,300),key:v(location.href),title:"",viewport:{w:0,h:0,dpr:1},scroll:{w:0,h:0},t:Ct(),score:100,counts:{high:0,medium:0,low:0},byRule:{},findings:[],stats:{elements:0,ms:0,checked:{},skipped:{}},limits:[],errors:[]};try{n.title=p(m(r.title),80),n.viewport={w:At().clientWidth,h:At().clientHeight,dpr:window.devicePixelRatio||1},n.scroll={w:At().scrollWidth,h:At().scrollHeight},ve={opts:e,cs:new Map,fo:new Map,rc:new Map,ly:new Map,vs:new Map,tx:new Map,idx:new Map,raw:[],skipped:{},checked:{},limits:[],sx:window.pageXOffset||0,sy:window.pageYOffset||0,tapMin:e.tapMin>0?e.tapMin:24,tapAdv:void 0===e.tapAdvisory?44:e.tapAdvisory,aaa:"AAA"===e.contrast,vw:At().clientWidth,vh:At().clientHeight};var i=function(){var e=[],t=0,n=0;return function i(a,o){for(var l=r.createTreeWalker(a,1,{acceptNode:function(e){return $[e.nodeName]&&"HEAD"!==e.nodeName||"HEAD"===e.nodeName||!ve.opts._overlay&&e.hasAttribute("data-pp-root")||"http://www.w3.org/2000/svg"===e.namespaceURI&&"svg"!==e.localName?2:1}}),s=l.nextNode();s;s=l.nextNode())if(e.push(s),s.shadowRoot?i(s.shadowRoot,o):s.localName.indexOf("-")>0&&0===s.childNodes.length&&window.customElements&&customElements.get(s.localName)&&n++,"iframe"===s.localName||"frame"===s.localName){var u=null;try{u=s.contentDocument}catch(e){}u&&u.documentElement&&o<2?i(u,o+1):(!u||o>=2)&&t++}}(r,0),t&&Be("iframes not scanned (cross-origin or deeper than 2): "+t),n&&Be("possible closed shadow roots not scanned: "+n),e}();if(i.forEach(function(e,t){ve.idx.set(e,t)}),ve.all=i,ve.els=i,n.stats.elements=i.length,i.length>5e3){var a=ve.sy-2*ve.vh,l=ve.sy+3*ve.vh;ve.els=i.filter(function(e){var t=Me(e);return t.y+t.h>=a&&t.y<=l}),Be("large page ("+i.length+" elements): audited the viewport +- 2 screens only")}var s=Array.isArray(e.rules)&&e.rules.length?e.rules:null;s&&s.forEach(function(e){ze[e]||n.errors.push({rule:String(e),message:"unknown rule"})}),Ve.forEach(function(e){if(!(s&&s.indexOf(e.id)<0)){ve.checked[e.id]=0;try{e.fn()}catch(t){n.errors.push({rule:e.id,message:p(m(t&&t.message),120)})}}}),function(e,t){var n={},r={};(t.suppress||[]).forEach(function(e){r[e]=1});var i=[];ve.raw.forEach(function(e){var t=Q(e.rule,e.el,e.o.variant),a=n[t]=(n[t]||0)+1;e.id=ee(e.rule,e.el,e.o.variant,a>1?a-1:0),r[e.id]||i.push(e)}),i.sort(function(e,t){return He[e.sev]-He[t.sev]||e.order-t.order||(e.rule<t.rule?-1:e.rule>t.rule?1:0)||(e.id<t.id?-1:1)});var a={},o=0;i.forEach(function(t){var n=a[t.rule]=(a[t.rule]||0)+1;o+=Pe[t.sev]*(n<=5?1:.25),e.counts[t.sev]++}),e.byRule=a,e.score=Math.max(0,Math.min(100,Math.floor(100-o+.5)));var l=t.maxFindings>0?t.maxFindings:200,s=i.slice(0,l);i.length>s.length&&Be("findings truncated: showing "+s.length+" of "+i.length);_e={},s.forEach(function(t,n){var r,i,a=t.o,o=a.rect||Me(a.anchorEl||t.el),l={id:t.id,rule:t.rule,sev:t.sev};a.wcag&&(l.wcag=a.wcag),a.heuristic&&(l.heuristic=!0),l.confidence=a.confidence||"high",l.selector=p(m(W(t.el)),200),l.label=function(e){var t=e.localName,n=P(e)[0];n&&(t+="."+n);var r=m(Z(e,60));if("html"!==e.localName&&"body"!==e.localName||(r=""),r){var i=40-t.length-3;i>1&&(t+=" '"+(r.length>i?r.slice(0,i-1)+"…":r)+"'")}return p(m(t),40)}(t.el),l.note=p(m(a.note),200),l.fix=p(m(a.fix),200),l.measured=a.measured||{},l.rect=function(e){return{x:Math.round(e.x),y:Math.round(e.y),w:Math.round(e.w),h:Math.round(e.h)}}(o),l.anchor=(r=t.el,i=Z(r,80),"html"!==r.localName&&"body"!==r.localName||(i=""),{tag:r.localName,role:K(r),name:p(m(r.getAttribute("aria-label")||i||r.getAttribute("alt")||""),40),textHash:b(g(i)),ref:p(m(r.getAttribute("id")||""),80),path:p(m(J(r)),120),nameAttr:p(m(r.getAttribute("name")||""),60)}),l.pin=n+1,_e[l.id]=n,e.findings.push(l)})}(n,e)}catch(e){n.errors.push({rule:"engine",message:p(m(e&&e.message),120)})}return n.stats.ms=Math.round(10*(("undefined"!=typeof performance?performance.now():Date.now())-t))/10,ve&&(n.stats.checked=ve.checked,n.stats.skipped=ve.skipped,n.limits=ve.limits.slice()),ve=null,o=!1,n},render:function(e,t){var n=[];try{var r=(t=t||{}).pinLimit>0?t.pinLimit:60,i=(Array.isArray(e)?e:[]).filter(function(e){return e&&e.id&&e.selector&&e.anchor});function a(e){return null!=_e[e.id]?_e[e.id]:1e6+(e.rect?1e4*e.rect.y+e.rect.x:0)}(i=i.map(function(e,t){return{f:e,i:t}})).sort(function(e,t){return He[e.f.sev]-He[t.f.sev]||a(e.f)-a(t.f)||e.i-t.i}),ut(),st(),Qe={},Object.keys(t.statuses||{}).forEach(function(e){Qe[e]=t.statuses[e]}),i.forEach(function(e,t){if(!(Je.length>=r)){var i=e.f,a=ht(i);if(a){"number"!=typeof i.pin&&(i.pin=t+1);var o={f:i,el:a,num:i.pin,pin:lt("button","pin"),px:null,py:null};o.pin.type="button",o.pin.addEventListener("click",function(e){e.stopPropagation(),Et({type:"pin-click",id:i.id}),et===i.id?wt():function(e){var t=e.f,n=t.measured||{};Ge.textContent="",Ge.appendChild(lt("div","ch","#"+e.num+" · "+bt(t.rule)+" · "+t.sev)),Ge.appendChild(lt("p","",t.note));var r=Object.keys(n).map(function(e){return e+" "+n[e]}).join(", ");r&&Ge.appendChild(lt("p","","Measured: "+r)),Ge.appendChild(lt("p","","Fix: "+t.fix));var i=lt("div","row");[["Fix with Hermes","go",function(){Et({type:"fix",id:t.id})}],["Dismiss","",function(){Et({type:"dismiss",id:t.id}),Qe[t.id]="dismissed",Mt(e),wt()}],["Copy selector","",function(e){var n=e.currentTarget;try{navigator.clipboard.writeText(t.selector).then(function(){n.textContent="Copied"},function(){n.textContent="Copy failed"})}catch(e){n.textContent="Copy failed"}}]].forEach(function(e){var t=lt("button",e[1],e[0]);t.type="button",t.addEventListener("click",e[2]),i.appendChild(t)}),Ge.appendChild(i),Ge.hidden=!1,et=t.id,tt=t.id,mt()}(o)}),o.pin.addEventListener("mouseenter",function(){tt=i.id,xt(o),Ze.textContent=i.note,Ze.hidden=!1,Ze.style.transform="translate("+(o.px+16)+"px,"+(o.py+16)+"px)"}),o.pin.addEventListener("focus",function(){tt=i.id,xt(o)}),o.pin.addEventListener("mouseleave",yt),o.pin.addEventListener("blur",yt),Ye.appendChild(o.pin),Je.push(o),Mt(o),f&&f.observe(a)}else n.push(i.id)}}),mt()}catch(o){}return{pinned:ft(),lost:n}},setStatuses:function(e){try{Object.keys(e||{}).forEach(function(t){Qe[t]=e[t]}),Je.forEach(function(t){e&&e[t.f.id]&&Mt(t)}),mt()}catch(e){}},focusPin:function(e){var t=Je.filter(function(t){return t.f.id===e})[0];if(!t)return!1;if(t.el&&t.el.isConnected||(t.el=ht(t.f)),!t.el)return!1;try{t.el.scrollIntoView({block:"center",inline:"nearest"})}catch(e){}return mt(),tt=e,xt(t),Ke.classList.remove("flash"),Ke.offsetWidth,Ke.classList.add("flash"),setTimeout(function(){!s&&Ke&&(Ke.classList.remove("flash"),tt===e&&et!==e&&yt())},1300),!0},clear:function(){ct(),rt=""},drain:function(){var e=a;return a=[],e},probe:function(){return Lt(),{protocol:1,version:t,url:p(location.href,80),key:p(u,60),ready:"complete"===r.readyState,pins:ft(),dirty:o,vw:At().clientWidth,vh:At().clientHeight,docVersion:l}},destroy:function(){if(!s){s=!0;try{ct()}catch(e){}c&&c.disconnect(),f&&f.disconnect(),clearInterval(d);for(var e=0;e<h.length;e++){var t=h[e];t[0].removeEventListener(t[1],t[2],t[3])}h=[],window.__pinpoint===Tt&&delete window.__pinpoint}}};return!0===e.test&&(Tt.__test={parseColor:k,ratio:L,lum:N,suggestFix:I,fnv1a:b,sanitize:m,selectorFor:W,resolve:X,fingerprint:Q,idFor:ee,urlKey:v,hex:R,over:D,layout:mt}),u=v(location.href),"function"==typeof MutationObserver&&(c=new MutationObserver(function(e){for(var t=!1,n=0;n<e.length&&!t;n++){var r=e[n];if(!Nt(r.target)){if("childList"===r.type){for(var i=[].slice.call(r.addedNodes).concat([].slice.call(r.removedNodes)),a=!1,o=0;o<i.length;o++)i[o].hasAttribute&&i[o].hasAttribute("data-pp-root")||(a=!0);if(!a)continue}t=!0}}t&&(kt("mutation"),vt())}),St(window,"scroll",vt,{capture:!0,passive:!0}),["transitionend","animationend","load"].forEach(function(e){St(window,e,vt,!0)}),St(r,"pointerdown",function(e){!et||e.composedPath&&e.composedPath().indexOf(We)>=0||wt()},!0),St(r,"keydown",function(e){"Escape"===e.key&&et&&wt()},!0),r.fonts&&r.fonts.ready&&r.fonts.ready.then(vt),d=setInterval(function(){Je.length&&"visible"===r.visibilityState&&gt()!==rt&&vt()},1e3),c.observe(document.documentElement,{childList:!0,subtree:!0,attributes:!0,attributeFilter:["style","class","hidden"]})),"function"==typeof ResizeObserver&&(f=new ResizeObserver(function(){vt()})).observe(i),St(window,"resize",function(){kt("resize"),vt()}),St(window,"load",function(){kt("load"),vt()}),St(window,"popstate",Lt),St(window,"hashchange",Lt),window.__pinpoint=Tt,Tt}

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
    if (!delta) delta = localDelta(prev.findings, res.findings, prev.seen, res.rules_covered || (res.stats && res.stats.checked ? Object.keys(res.stats.checked) : []))
    const fixedF = delta && prev.findings ? prev.findings.filter(f => delta.fixed.includes(f.id)) : []
    const curIds = new Set(res.findings.map(f => f.id))
    const fixedIds = new Set(fixedF.map(f => f.id))
    const unresolved = prev.findings ? prev.findings.filter(f => f && f.id && !curIds.has(f.id) && !fixedIds.has(f.id) && !prev.dismissed.some(d => d.id === f.id)) : []
    const prevScore = delta && typeof delta.prev_score === 'number' ? delta.prev_score : prev.score != null ? prev.score : null

    let lost = []
    const pin = a.pin !== false
    if (pin) {
      const { list, statuses } = applyPins([...res.findings, ...unresolved], fixedF, delta)
      const rr = (await callApi('render', [list, { statuses, pinLimit: 60 }])).v
      lost = (rr && rr.lost) || []
    } else {
      await callApi('clear', [])
    }
    const after = (await callApi('probe', [])).v
    M.auditedVersion = M.lastVersion = after ? after.docVersion : -1
    M.dirtySince = 0

    M.mem[key] = { findings: [...res.findings, ...unresolved], dismissed: prev.dismissed, seen: new Set([...prev.seen, ...res.findings.map(f => f.id)]), score: res.score }
    if (!pyOn()) localSave(key, { findings: [...res.findings, ...unresolved], dismissed: prev.dismissed, seen: [...M.mem[key].seen], score: res.score })
    C.storage.set('lastKey', key); C.storage.set('active', true)
    M.active = true; M.lastMissingHref = ''; M.resume = null; M.skip = 0
    if (M.fadeUndo) { M.fadeUndo(); M.fadeUndo = null }
    setUi({ phase: 'result', result: res, url: res.url || probe.url, key, prevScore, delta, fixed: fixedF, dismissed: prev.dismissed, lost, selected: '', pinsShown: pin })
    ensurePoll()
    if (fixedF.length && pin) {
      M.fadeUndo = C.setTimeout(() => {
        if (M.seq !== mySeq) return
        void (async () => {
          try { const { list, statuses } = applyPins([...res.findings, ...unresolved], [], delta); await callApi('render', [list, { statuses, pinLimit: 60 }]); setUi({ fixed: [] }) } catch (e) { /* page gone */ }
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
  let claimToken = ''
  try { const ar = await C.rest('/ack/' + encodeURIComponent(id), { method: 'POST', body: { window: WIN } }); claimToken = ar && typeof ar.claim_token === 'string' ? ar.claim_token : '' } catch (e) {
    log('ack not granted', { id, status: httpStatusOf(e) }); return
  }
  log('request claimed', { id })
  if (Object.keys(C.storage.get('grants', {}) || {}).length === 0) {
    host.notify({ kind: 'info', title: 'Pinpoint', message: 'Pinpoint will ask permission to run on this site. Choose \u201cAllow on this site\u201d.' })
  }
  let sent = false
  const post = async body => { sent = true; await C.rest('/result', { method: 'POST', body: { request_id: id, claim_token: claimToken, ...body } }) }
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
.pp button:focus-visible,.pp-chip:focus-visible,.pp-main:focus-visible,.pp-opt:focus-within,.pp-row:focus-within{outline:2px solid var(--ui-accent);outline-offset:2px;border-radius:6px}
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
