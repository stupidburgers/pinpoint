// H1: agent rendezvous request routing + receipt discipline (vm harness, no GUI/profile).
// Drives the REAL desktop/src/app.js handleRequest orchestration with only SDK/page
// boundaries stubbed: host.state focus atoms, ctx.rest wire recorder, page calls.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const root = new URL('../../', import.meta.url)
const bridge = fs.readFileSync(new URL('desktop/src/bridge.js', root), 'utf8').replace(/export /g, '')
const app = fs.readFileSync(new URL('desktop/src/app.js', root), 'utf8')
  .replace(/^import .*\n/gm, '').replace('/*@@BRIDGE@@*/', bridge).replace('export default', 'const plugin =')

const RECEIPT = 'rcpt-' + 'a'.repeat(40)

function harness() {
  const logs = []
  const posts = []
  const focus = { sid: 'sessA', owner: { connectionId: 'local', profile: 'default' } }
  const flags = { ack409: false, ackTransient: false, changeFocusDuringAudit: null, changeOwnerDuringAudit: null, noReceipt: false }
  const ctx = vm.createContext({
    console: { error: (...a) => logs.push(a.map(String).join(' ')) },
    URL, setTimeout, clearTimeout, Date, Math, JSON, TextEncoder, Promise,
    atom: initial => { let v = initial; return { get: () => v, set: x => { v = x } } },
    host: { notify() {}, state: {
      focusedSessionId: { get: () => focus.sid },
      focusedSessionOwner: { get: () => focus.owner }
    } },
    jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }),
    // Shared by reference into the vm realm so code executed via runInContext below
    // (not a closure captured from this outer scope) can read/mutate them directly.
    posts, flags, focus
  })
  vm.runInContext(app + `
    C = {
      storage: { get: (k, d) => d, set: () => {} },
      preview: { isAvailable: () => true },
      rest: async (path, opts) => {
        const body = opts && opts.body
        posts.push({ path, body })
        if (path.startsWith('/ack/')) {
          if (flags.ack409) { const e = new Error('conflict'); e.status = 409; throw e }
          if (flags.ackTransient) { flags.ackTransient = false; throw new Error('socket hang up') }
          return { claimed: true, receipt: flags.noReceipt ? '' : '${RECEIPT}' }
        }
        if (path === '/result') return { ok: true }
      },
      setTimeout: () => () => {}, setInterval: () => () => {}
    }
    inject = async () => ({ key: 'https://proof.invalid', url: 'https://proof.invalid/', docVersion: 1 })
    ensurePoll = () => {}
    callApi = async (method, args) => {
      if (method === 'audit') {
        if (flags.changeFocusDuringAudit) focus.sid = flags.changeFocusDuringAudit
        if (flags.changeOwnerDuringAudit) focus.owner = flags.changeOwnerDuringAudit
        return { v: { url: 'https://proof.invalid/', score: 90, findings: [], rules_covered: ['a11y.contrast'] } }
      }
      if (method === 'probe') return { v: { docVersion: 1 } }
      return { v: { lost: [] } }
    }
    globalThis.__handled = () => [...M.handled]
  `, ctx)
  return { ctx, logs, posts, focus, flags, handled: () => ctx.__handled() }
}

const reqFor = sid => ({ request_id: 'req1', args: { pin: false }, session_id: sid })

test('focused session match: claims with pv+session, echoes receipt on result', async () => {
  const h = harness()
  await h.ctx.handleRequest(reqFor('sessA'))
  const ack = h.posts.find(p => p.path === '/ack/req1')
  assert.ok(ack, 'ack must be posted')
  assert.equal(ack.body.pv, 2)
  assert.equal(ack.body.session_id, 'sessA')
  assert.ok(typeof ack.body.window === 'string' && ack.body.window.length > 0)
  const res = h.posts.find(p => p.path === '/result')
  assert.ok(res, 'result must be posted')
  assert.equal(res.body.receipt, RECEIPT)
  assert.equal(res.body.session_id, 'sessA')
  assert.equal(res.body.window, ack.body.window)
  assert.equal(res.body.pv, 2)
  assert.equal(res.body.ok, true)
})

test('receipt never reaches logs', async () => {
  const h = harness()
  await h.ctx.handleRequest(reqFor('sessA'))
  assert.ok(!h.logs.some(l => l.includes(RECEIPT)), h.logs.join('\n'))
})

test('another session focused: skip without ack and without poisoning dedupe', async () => {
  const h = harness()
  h.focus.sid = 'sessB'
  await h.ctx.handleRequest(reqFor('sessA'))
  assert.equal(h.posts.length, 0, 'no wire traffic for the wrong session')
  assert.ok(!h.handled().includes('req1'), 'skip must not mark the request handled')
  h.focus.sid = 'sessA'
  await h.ctx.handleRequest(reqFor('sessA'))
  assert.ok(h.posts.some(p => p.path === '/ack/req1'), 'delayed claim must work after focus changes')
})

test('empty tool session is an explicit unsupported policy, never any-window-wins', async () => {
  const h = harness()
  await h.ctx.handleRequest({ request_id: 'req1', args: {}, session_id: '' })
  assert.equal(h.posts.filter(p => p.path.startsWith('/ack/')).length, 0)
  assert.ok(!h.handled().includes('req1'))
})

test('no focused runtime id: unsupported, does not claim', async () => {
  const h = harness()
  h.focus.sid = null
  await h.ctx.handleRequest(reqFor('sessA'))
  assert.equal(h.posts.filter(p => p.path.startsWith('/ack/')).length, 0)
  assert.ok(!h.handled().includes('req1'))
})

test('lost claim (409) is terminal for this window; transient ack failure stays retryable', async () => {
  const h = harness()
  h.flags.ack409 = true
  await h.ctx.handleRequest(reqFor('sessA'))
  assert.ok(h.handled().includes('req1'), 'definitive refusal marks the request handled')

  const h2 = harness()
  h2.flags.ackTransient = true
  await h2.ctx.handleRequest(reqFor('sessA'))
  assert.ok(!h2.handled().includes('req1'), 'transient failure must not poison dedupe')
  await h2.ctx.handleRequest(reqFor('sessA'))
  assert.equal(h2.posts.filter(p => p.path.startsWith('/ack/')).length, 2, 'retry is allowed and reaches the server')
  assert.ok(h2.posts.some(p => p.path === '/result'))
})

test('ack granting no receipt fails visibly instead of an unbound result', async () => {
  const h = harness()
  h.flags.noReceipt = true
  await h.ctx.handleRequest(reqFor('sessA'))
  assert.equal(h.posts.filter(p => p.path === '/result').length, 0, 'no result may be posted without a receipt')
  assert.ok(h.logs.some(l => l.includes('receipt')))
})

test('focus change before delivery: explicit session_changed, never an all-clear', async () => {
  const h = harness()
  h.flags.changeFocusDuringAudit = 'sessB'
  await h.ctx.handleRequest(reqFor('sessA'))
  const res = h.posts.find(p => p.path === '/result')
  assert.ok(res, 'an error result must still be delivered')
  assert.equal(res.body.ok, false)
  assert.equal(res.body.code, 'session_changed')
  assert.equal(res.body.receipt, RECEIPT)
  assert.equal(res.body.session_id, 'sessA')
})

test('owner change before delivery: fails safely as session_changed', async () => {
  const h = harness()
  h.flags.changeOwnerDuringAudit = { connectionId: 'remote-9', profile: 'default' }
  await h.ctx.handleRequest(reqFor('sessA'))
  const res = h.posts.find(p => p.path === '/result')
  assert.ok(res, 'an error result must still be delivered')
  assert.equal(res.body.ok, false)
  assert.equal(res.body.code, 'session_changed')
  assert.equal(res.body.session_id, 'sessA')
})

test('oversize audit result is replaced by a bounded engine_error before posting', async () => {
  const h = harness()
  await vm.runInContext(`(async () => {
    callApi = async (method) => {
      if (method === 'audit') return { v: { url: 'https://proof.invalid/', score: 90, rules_covered: ['x'], findings: [{ id: 'a@1', blob: 'x'.repeat(400 * 1024) }] } }
      if (method === 'probe') return { v: { docVersion: 1 } }
      return { v: { lost: [] } }
    }
    await handleRequest({ request_id: 'req1', args: {}, session_id: 'sessA' })
  })()`, h.ctx)
  const res = h.posts.find(p => p.path === '/result')
  assert.ok(res, 'a bounded error result must still be delivered')
  assert.equal(res.body.ok, false)
  assert.equal(res.body.code, 'engine_error')
  assert.ok(new TextEncoder().encode(JSON.stringify(res.body)).length <= 256 * 1024)
})
