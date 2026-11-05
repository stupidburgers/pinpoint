// STAND-IN engine for Package C tests only (SPEC 4.1 API surface, 4 trivial rules, simplified pins).
// The real engine is engine/pinpoint-engine.js (Package B). Used via `build-desktop.mjs --engine`.
function pinpointEngine(config) {
  var VERSION = '0.1.0'
  var old = window.__pinpoint
  if (old && old.version === VERSION) return old
  if (old && old.destroy) old.destroy()
  var queue = [], dirty = null, docVersion = 0, root = null, last = [], statuses = {}
  var fnv = function (s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) } return ('00000000' + (h >>> 0).toString(16)).slice(-8) }
  var key = function () { var l = location; return (l.origin + l.pathname).replace(/\/+$/, '') }
  var sel = function (el) { if (el.id) return '#' + el.id; return el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/)[0] : '') }
  var rectOf = function (el) { var r = el.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height } }
  var mk = function (rule, sev, el, note, fix, measured) {
    return { id: rule + '@' + fnv(rule + '|' + el.tagName + '|' + (el.id || el.getAttribute('name') || (el.textContent || '').trim().slice(0, 40))), rule: rule, sev: sev, confidence: 'high',
      selector: sel(el), label: (el.tagName.toLowerCase() + ' ' + (el.textContent || '').trim().slice(0, 30)).trim(), note: note, fix: fix, measured: measured || {}, rect: rectOf(el),
      anchor: { tag: el.tagName.toLowerCase(), ref: el.id || '' } }
  }
  var api = {
    protocol: 1, version: VERSION,
    audit: function (opts) {
      var t0 = performance.now(), out = [], sup = (opts && opts.suppress) || []
      document.querySelectorAll('img:not([alt])').forEach(function (e) { out.push(mk('a11y.img-alt', 'high', e, 'Image has no alt attribute', 'Add alt text')) })
      document.querySelectorAll('button,a[href]').forEach(function (e) {
        var r = e.getBoundingClientRect()
        if (r.width && (r.width < 24 || r.height < 24)) out.push(mk('a11y.tap-target', 'medium', e, 'Target ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' < 24x24', 'Make it at least 24x24', { w: r.width, h: r.height, min: 24 }))
      })
      document.querySelectorAll('[data-lowc]').forEach(function (e) { out.push(mk('a11y.contrast', 'high', e, 'Contrast 1.92:1, needs 4.5:1', 'Darken text to #6b6b6b or darker', { ratio: 1.92, need: 4.5, fg: '#aaaaaa', bg: '#ffffff' })) })
      if (!document.documentElement.getAttribute('lang')) out.push(mk('a11y.lang', 'medium', document.documentElement, 'html has no lang', 'Add lang="en"'))
      out = out.filter(function (f) { return sup.indexOf(f.id) < 0 })
      var counts = { high: 0, medium: 0, low: 0 }, w = { high: 8, medium: 4, low: 1 }, pen = 0
      out.forEach(function (f, i) { counts[f.sev]++; pen += w[f.sev]; f.pin = i + 1 })
      last = out; dirty = null
      return { protocol: 1, url: location.href, key: key(), title: document.title, viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio }, scroll: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight },
        t: Date.now(), score: Math.max(0, 100 - pen), counts: counts, byRule: {}, findings: out, stats: { elements: document.getElementsByTagName('*').length, ms: Math.round(performance.now() - t0), checked: {} }, limits: [], errors: [] }
    },
    render: function (findings, opts) {
      api.clear(); statuses = (opts && opts.statuses) || {}
      root = document.createElement('div'); root.setAttribute('data-pp-root', '')
      root.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none'
      var sh = root.attachShadow({ mode: 'open' }), lost = [], n = 0
      var colors = { high: '#e5484d', medium: '#f5a623', low: '#3b82f6' }
      findings.forEach(function (f) {
        var el = null; try { el = document.querySelector(f.selector) } catch (e) {}
        if (!el) { lost.push(f.id); return }
        var r = el.getBoundingClientRect(), b = document.createElement('button')
        var st = statuses[f.id] || 'open'
        b.textContent = st === 'fixed' ? '\u2713' : String(f.pin || ++n)
        b.setAttribute('aria-label', 'Pinpoint ' + (f.pin || n) + ': ' + f.rule)
        b.style.cssText = 'position:fixed;left:' + Math.max(14, r.left) + 'px;top:' + Math.max(14, r.top) + 'px;width:24px;height:24px;border-radius:12px;border:2px solid #fff;color:#fff;font:700 12px system-ui;padding:0;pointer-events:auto;cursor:pointer;background:' + (st === 'fixed' ? '#30a46c' : colors[f.sev])
        b.onclick = function () { queue.push({ type: 'pin-click', id: f.id, t: Date.now() }); queue.push({ type: 'fix', id: f.id, t: Date.now() }) }
        sh.appendChild(b)
      })
      document.documentElement.appendChild(root)
      return { pinned: findings.length - lost.length, lost: lost }
    },
    setStatuses: function (m) { statuses = m || {} },
    focusPin: function (id) { return !!id },
    clear: function () { if (root) root.remove(); root = null },
    drain: function () { var q = queue; queue = []; return q },
    probe: function () { return { protocol: 1, version: VERSION, url: location.href, key: key(), ready: document.readyState === 'complete', pins: root ? root.shadowRoot.childNodes.length : 0, dirty: dirty != null, vw: innerWidth, vh: innerHeight, docVersion: docVersion } },
    destroy: function () { api.clear(); if (mo) mo.disconnect(); delete window.__pinpoint }
  }
  var mo = new MutationObserver(function (recs) {
    if (recs.every(function (r) { return r.target === root || (root && root.contains(r.target)) })) return
    docVersion++; dirty = 'mutation'; queue.push({ type: 'dirty', reason: 'mutation', t: Date.now() })
  })
  mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true })
  window.__pinpoint = api
  return api
}
