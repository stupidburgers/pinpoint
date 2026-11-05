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
  function testHooks() { return { urlKey: urlKey }; }

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
