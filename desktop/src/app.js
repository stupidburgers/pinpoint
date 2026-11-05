import { host, PALETTE_AREA, PANES_AREA, STATUSBAR_AREAS, useValue, atom } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useState } from 'react'

const ID = 'pinpoint'
const VERSION = '0.1.0'

/*@@BRIDGE@@*/

/*@@ENGINE@@*/

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
  unresolved: [],           // older open findings not measured in the latest result
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
  if (mem) return { findings: mem.findings.filter(f => !(mem.dismissed || []).some(d => d.id === f.id)), dismissed: mem.dismissed || [], seen: [...mem.seen], score: mem.score }
  const loc = localLoad(key)
  if (loc) return { findings: (loc.findings || []).filter(f => !(loc.dismissed || []).some(d => d.id === f.id)), dismissed: loc.dismissed || [], seen: loc.seen || [], score: loc.score }
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
    const covered = auditCoverage(res)
    if (!delta) delta = localDelta(prev.findings, res.findings, prev.seen, covered)
    const fixedF = delta && prev.findings ? prev.findings.filter(f => delta.fixed.includes(f.id)) : []
    const unresolved = delta && prev.findings ? prev.findings.filter(f =>
      (delta.not_rechecked || []).includes(f.id) && !res.findings.some(g => g.id === f.id)) : []
    const openFindings = [...res.findings, ...unresolved]
    const prevScore = delta && typeof delta.prev_score === 'number' ? delta.prev_score : prev.score != null ? prev.score : null

    let lost = []
    const pin = a.pin !== false
    if (pin) {
      const { list, statuses } = applyPins(openFindings, fixedF, delta)
      const rr = (await callApi('render', [list, { statuses, pinLimit: 60 }])).v
      lost = (rr && rr.lost) || []
    } else {
      await callApi('clear', [])
    }
    const after = (await callApi('probe', [])).v
    M.auditedVersion = M.lastVersion = after ? after.docVersion : -1
    M.dirtySince = 0

    M.mem[key] = { findings: openFindings, dismissed: prev.dismissed, seen: new Set([...prev.seen, ...res.findings.map(f => f.id)]), score: res.score }
    if (!pyOn()) localSave(key, { findings: openFindings, dismissed: prev.dismissed, seen: [...M.mem[key].seen], score: res.score })
    C.storage.set('lastKey', key); C.storage.set('active', true)
    M.active = true; M.lastMissingHref = ''; M.resume = null; M.skip = 0
    if (M.fadeUndo) { M.fadeUndo(); M.fadeUndo = null }
    setUi({ phase: 'result', result: res, url: res.url || probe.url, key, prevScore, delta, unresolved, fixed: fixedF, dismissed: prev.dismissed, lost, selected: '', pinsShown: pin })
    ensurePoll()
    if (fixedF.length && pin) {
      M.fadeUndo = C.setTimeout(() => {
        if (M.seq !== mySeq) return
        void (async () => {
          try { const { list, statuses } = applyPins(openFindings, [], delta); await callApi('render', [list, { statuses, pinLimit: 60 }]); setUi({ fixed: [] }) } catch (e) { /* page gone */ }
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
// Retained open pins are distinct from this audit's measured findings.
const currentFindings = s => s.result ? [...s.result.findings, ...(s.unresolved || [])] : []
const findingById = id => currentFindings($ui.get()).find(f => f.id === id)
async function fixFinding(id) {
  const f = findingById(id); if (!f) return
  log('fix pin', { id })
  await sendToAgent(buildPinPrompt(f, $ui.get().url, f.pin), 'Pin #' + (f.pin || '') + ' sent to Hermes')
}
async function fixAllHigh() {
  const s = $ui.get(); if (!s.result) return
  const open = currentFindings(s).filter(f => !s.dismissed.some(d => d.id === f.id))
  if (!open.some(f => f.sev === 'high')) { host.notify({ kind: 'info', title: 'Pinpoint', message: 'No high-severity findings.' }); return }
  await sendToAgent(buildFixAllPrompt(open, s.url, 8), 'High-severity findings sent to Hermes')
}
async function dismissFinding(id, why) {
  const f = findingById(id); if (!f) return
  const s = $ui.get()
  await storePost('/pins', { action: 'dismiss', url_key: s.key, ids: [id], reason: why || 'Dismissed in the Pinpoint pane' })
  const dismissed = [...s.dismissed.filter(d => d.id !== id), f]
  const mem = M.mem[s.key]; if (mem) mem.dismissed = dismissed
  if (!pyOn()) localSave(s.key, { findings: currentFindings(s), dismissed, seen: mem ? [...mem.seen] : [], score: s.result.score })
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
  if (!pyOn()) localSave(s.key, { findings: currentFindings(s), dismissed, seen: mem ? [...mem.seen] : [], score: s.result ? s.result.score : null })
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
  const open = currentFindings(s).filter(f => !dismissedIds.has(f.id))
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
