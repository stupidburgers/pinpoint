// Pure helpers for the Pinpoint desktop half. No SDK, no DOM, no side effects.
// Inlined into desktop/plugin.js by scripts/build-desktop.mjs
// (the `export ` keyword is stripped there) and unit-tested directly with `node --test`.

export const REQUEST_CODES = ['no_preview', 'consent_denied', 'origin_blocked', 'page_unreachable', 'engine_error', 'navigated', 'page_mismatch']

// Control chars (C0, DEL, C1) and bidi overrides/isolates: page text is untrusted data.
const BAD_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g

export function cleanText(value, cap) {
  const s = String(value == null ? '' : value).replace(BAD_CHARS, '').replace(/\s+/g, ' ').trim()
  if (!cap || s.length <= cap) return s
  return s.slice(0, Math.max(0, cap - 1)).trimEnd() + '\u2026'
}

// executeJavaScript rejection text -> wire code (SPEC 4.2 / 8.2)
export function mapExecError(err) {
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

export function httpStatusOf(err) {
  if (err && typeof err.status === 'number') return err.status
  const m = /\b(4\d\d|5\d\d)\b/.exec(err && err.message ? err.message : String(err || ''))
  return m ? Number(m[1]) : 0
}

export function isWebUrl(href) {
  return /^https?:\/\//i.test(String(href || ''))
}

// Same normalisation as the Python store (SPEC 4.3; table in tests/shared/url_key_cases.json).
// Engine/probe `key` is authoritative when present; this is the fallback for pages without an engine.
export function urlKey(href) {
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

export function originOf(href) {
  try { return new URL(String(href)).origin } catch (e) { return '' }
}

const SEV_RANK = { high: 0, medium: 1, low: 2 }

export function sortFindings(findings) {
  return (findings || []).map((f, i) => [f, i]).sort((a, b) => {
    const ra = SEV_RANK[a[0].sev] ?? 3, rb = SEV_RANK[b[0].sev] ?? 3
    return ra - rb || (a[0].pin || 1e9) - (b[0].pin || 1e9) || a[1] - b[1]
  }).map(p => p[0])
}

export function groupBySeverity(findings) {
  const out = { high: [], medium: [], low: [] }
  for (const f of sortFindings(findings)) (out[f.sev] || out.low).push(f)
  return out
}

// ----- prompts (SPEC 8.5) -----
const MAX_PROMPT = 700

export function buildPinPrompt(f, url, pinNo) {
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

export function buildFixAllPrompt(findings, url, max) {
  const cap = max || 8
  const list = sortFindings(findings).filter(f => f.sev === 'high').slice(0, cap)
  const lines = list.map(f =>
    '#' + (f.pin || '?') + ' [' + cleanText(f.rule, 32) + '] `' + cleanText(f.selector, 90).replace(/`/g, "'") + '` - ' + cleanText(f.note, 80) + ' (' + cleanText(f.id, 60) + ')')
  return ['Pinpoint: fix these ' + list.length + ' high-severity findings on ' + cleanText(url, 100), ...lines,
    'Change the SOURCE (not built output). Call pinpoint_audit afterwards to verify.'].join('\n')
}

// ----- rate limiter (SPEC 8.4) -----
export function createRateLimiter(opts) {
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
// Only completed reporting can prove absence; never infer scope from findings or requested rules.
export function usableFindings(findings) {
  return Array.isArray(findings) && findings.every(f => f && typeof f === 'object' && !Array.isArray(f) && typeof f.id === 'string' && f.id.trim())
}

export function auditCoverage(res) {
  if (!res || !usableFindings(res.findings)) return []
  const errors = Object.prototype.hasOwnProperty.call(res, 'errors') ? res.errors : []
  const limits = Object.prototype.hasOwnProperty.call(res, 'limits') ? res.limits : []
  if (!Array.isArray(errors) || !Array.isArray(limits)) return []
  if (limits.some(x => typeof x !== 'string' || !x.trim()) || res.truncated || limits.some(x => /truncat/i.test(x))) return []
  if (errors.some(e => !e || typeof e !== 'object' || Array.isArray(e) || typeof e.rule !== 'string' || !e.rule.trim() || e.rule === 'engine')) return []
  const errored = new Set(errors.map(e => e.rule))
  let covered = []
  if (Object.prototype.hasOwnProperty.call(res, 'rules_covered')) {
    if (!Array.isArray(res.rules_covered) || !res.rules_covered.every(r => typeof r === 'string' && r)) return []
    covered = res.rules_covered
  } else {
    const checked = res.stats && res.stats.checked
    if (checked && typeof checked === 'object' && !Array.isArray(checked)) {
      covered = Object.keys(checked).filter(r => r && typeof checked[r] === 'number' && Number.isFinite(checked[r]) && checked[r] >= 0)
    }
  }
  return covered.filter(r => !errored.has(r))
}

export function classifyAuditState(res) {
  if (!res || !usableFindings(res.findings)) return { state: 'error', covered: [], reason: 'invalid audit report' }
  const errors = Object.prototype.hasOwnProperty.call(res, 'errors') ? res.errors : []
  const limits = Object.prototype.hasOwnProperty.call(res, 'limits') ? res.limits : []
  if (!Array.isArray(errors) || !Array.isArray(limits)) return { state: 'unknown', covered: [], reason: 'invalid metadata' }
  if (errors.some(e => !e || typeof e !== 'object' || Array.isArray(e) || typeof e.rule !== 'string' || !e.rule.trim())) {
    return { state: 'error', covered: [], reason: 'malformed error entry' }
  }
  if (errors.some(e => e.rule === 'engine')) {
    return { state: 'error', covered: [], reason: cleanText((errors.find(e => e.rule === 'engine') || {}).message || 'engine error', 80) }
  }
  if (limits.some(x => typeof x !== 'string' || !x.trim())) {
    return { state: 'unknown', covered: [], reason: 'malformed limit entry' }
  }
  const covered = auditCoverage(res)
  if (res.truncated || limits.some(x => /truncat/i.test(x))) {
    return { state: 'partial', covered, reason: 'findings truncated' }
  }
  if (errors.length > 0) {
    return { state: 'partial', covered, reason: 'rule error (' + errors.map(e => e.rule).join(', ') + ')' }
  }
  if (limits.length > 0) {
    return { state: 'partial', covered, reason: cleanText(limits[0], 80) }
  }
  if (!covered.length) {
    return { state: 'unknown', covered: [], reason: 'missing rule coverage' }
  }
  if (covered.length < 14) {
    return { state: 'partial', covered, reason: covered.length + ' of 14 rules checked' }
  }
  return { state: 'complete', covered, reason: '' }
}

export function localDelta(prev, cur, seenIds, coveredRules) {
  if (!prev) return null
  const prevIds = new Set(prev.map(f => f.id))
  const seen = new Set(seenIds || [])
  prevIds.forEach(id => seen.add(id))
  const curIds = new Set(cur.map(f => f.id))
  const coveredSet = new Set(Array.isArray(coveredRules) && coveredRules.every(r => typeof r === 'string' && r) ? coveredRules : [])

  const fixed = []
  const notRechecked = []

  for (const f of prev) {
    const id = f && f.id
    if (!id || curIds.has(id)) continue
    const rule = (f && f.rule) || (typeof id === 'string' && id.includes('@') ? id.split('@')[0] : '')
    if (!rule || !coveredSet.has(rule)) {
      notRechecked.push(id)
    } else {
      fixed.push(id)
    }
  }

  const added = [...curIds].filter(id => !seen.has(id))
  const remaining = [...curIds].filter(id => prevIds.has(id)).length
  const out = { fixed, new: added, remaining }
  out.not_rechecked = notRechecked
  out.unresolved = notRechecked
  return out
}

export function normalizeDelta(d) {
  if (!d || typeof d !== 'object') return null
  const arr = x => (Array.isArray(x) ? x.map(String) : [])
  if (!Array.isArray(d.fixed) && !Array.isArray(d.new)) return null
  const out = {
    prev_score: typeof d.prev_score === 'number' ? d.prev_score : null,
    fixed: arr(d.fixed), new: arr(d.new),
    remaining: typeof d.remaining === 'number' ? d.remaining : Array.isArray(d.remaining) ? d.remaining.length : 0
  }
  if (Array.isArray(d.not_rechecked)) out.not_rechecked = arr(d.not_rechecked)
  if (Array.isArray(d.unresolved)) out.unresolved = arr(d.unresolved)
  return out
}

export function scoreToast(prevScore, score, fixedCount) {
  if (typeof prevScore !== 'number') return 'Pinpoint: score ' + score
  const diff = score - prevScore
  const sign = diff > 0 ? '+' : diff < 0 ? '\u2212' : '\u00b1'
  return 'Pinpoint: ' + prevScore + ' \u2192 ' + score + ' (' + sign + Math.abs(diff) + ')' + (fixedCount ? ', ' + fixedCount + ' fixed' : '')
}

// ----- misc -----
export function parsePending(res) {
  const list = Array.isArray(res) ? res : res && Array.isArray(res.requests) ? res.requests : res && Array.isArray(res.pending) ? res.pending : []
  return list.map(x => ({ request_id: String(x.request_id || x.id || ''), args: x.args || {}, session_id: x.session_id || '' })).filter(x => x.request_id)
}

export function buildAuditOpts(args, prefs, suppress) {
  const a = args || {}
  const p = prefs || {}
  const o = { maxFindings: 200, tapAdvisory: p.tapAdvisory === 0 ? 0 : 44, contrast: p.contrast === 'AAA' ? 'AAA' : 'AA' }
  if (Array.isArray(a.rules) && a.rules.length) o.rules = a.rules.map(String).slice(0, 20)
  if (suppress && suppress.length) o.suppress = suppress.slice(0, 400)
  if (typeof a.inspectSelector === 'string' && a.inspectSelector.trim()) o.inspectSelector = cleanText(a.inspectSelector, 200)
  return o
}

export function formatDesignPrompt(target, pageUrl, userNote) {
  const t = target && typeof target === 'object' ? target : {}
  const url = cleanText(pageUrl, 120) || 'current page'
  const label = cleanText(t.label || t.tag || 'element', 60)
  const sel = cleanText(t.selector || t.tag || 'body', 140)
  const r = t.rect || {}
  const bm = t.boxModel || {}
  const ty = t.typography || {}
  const ly = t.layout || {}
  const cl = t.colors || {}
  const dims = (typeof r.w === 'number' && typeof r.h === 'number') ? r.w + '×' + r.h + 'px' : 'n/a'
  const boxLine = 'Box: ' + dims + ', pad ' + cleanText(bm.padding || '0px', 32) + ', mar ' + cleanText(bm.margin || '0px', 32) + (bm.border && bm.border !== '0px none' ? ', border ' + cleanText(bm.border, 36) : '')
  const typeLine = 'Type: ' + cleanText(ty.fontFamily || 'sans-serif', 32) + ' ' + cleanText(ty.fontSize || '', 16) + '/' + cleanText(ty.lineHeight || '', 16) + ' w' + cleanText(ty.fontWeight || '400', 10)
  const layLine = 'Layout: ' + cleanText(ly.display || 'block', 20) + (ly.position && ly.position !== 'static' ? ' ' + cleanText(ly.position, 16) : '') + (ly.flexDirection && ly.display && ly.display.includes('flex') ? ' (' + cleanText(ly.flexDirection, 16) + ', align ' + cleanText(ly.alignItems || 'normal', 20) + ', justify ' + cleanText(ly.justifyContent || 'normal', 20) + ', gap ' + cleanText(ly.gap || '0px', 16) + ')' : '')
  const colLine = 'Colors: fg ' + cleanText(cl.fg || ty.color || '', 20) + ' on bg ' + cleanText(cl.bg || '', 20) + (typeof cl.contrastRatio === 'number' ? ' (' + cl.contrastRatio + ':1)' : '')
  const fList = Array.isArray(t.findings) ? t.findings.slice(0, 2).map(f => cleanText(f.rule, 28) + ' (' + cleanText(f.sev, 8) + '): ' + cleanText(f.note, 60)).join('; ') : ''
  const note = cleanText(userNote, 180) || 'Refine spacing, visual hierarchy, and accessibility polish.'
  const lines = [
    'Design Mode target on ' + url + ':',
    '- Element: ' + label + ' (`' + sel + '`)',
    '- ' + boxLine,
    '- ' + typeLine,
    '- ' + layLine,
    '- ' + colLine
  ]
  if (fList) lines.push('- Findings: ' + fList)
  lines.push('Instruction: ' + note)
  lines.push('After editing, call `pinpoint_audit` to verify.')
  let out = lines.join('\n')
  if (out.length > 700) out = out.slice(0, 697) + '...'
  return out
}

export function formatFixReceipt(score, prevScore, fixed, remaining, pageUrl) {
  const url = cleanText(pageUrl, 100) || 'page'
  const diff = typeof prevScore === 'number' && typeof score === 'number' ? score - prevScore : null
  const sign = diff !== null ? (diff > 0 ? '+' + diff : diff < 0 ? '−' + Math.abs(diff) : '±0') : ''
  const scorePart = typeof prevScore === 'number' ? prevScore + ' → ' + score + ' (' + sign + ')' : 'score ' + score
  const fx = Array.isArray(fixed) ? fixed : []
  const rules = [...new Set(fx.map(f => cleanText((f && f.rule) || String(f || '').split('@')[0], 30)).filter(Boolean))]
  return 'Pinpoint Fix Receipt (' + url + '): ' + scorePart + ' · ' + fx.length + ' fixed' + (rules.length ? ' [' + rules.slice(0, 4).join(', ') + ']' : '') + ' · ' + (typeof remaining === 'number' ? remaining : 0) + ' remaining'
}

// Failure copy shown in the pane for each code
export function errorCopy(code) {
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

export function scoreTone(score) {
  return score >= 90 ? 'good' : score >= 60 ? 'warn' : 'bad'
}
