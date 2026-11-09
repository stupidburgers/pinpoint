// Real app orchestration with only SDK/page boundaries stubbed; no GUI/profile.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const root = new URL('../../', import.meta.url)
const bridge = fs.readFileSync(new URL('desktop/src/bridge.js', root), 'utf8').replace(/export /g, '')
const app = fs.readFileSync(new URL('desktop/src/app.js', root), 'utf8')
  .replace(/^import .*\n/gm, '').replace('/*@@BRIDGE@@*/', bridge).replace('export default', 'const plugin =')
function harness() {
  const ctx = vm.createContext({ console: { error() {} }, URL, setTimeout, clearTimeout, Date, Math,
    atom: initial => { let v = initial; return { get: () => v, set: x => { v = x } } },
    host: { notify() {} }, jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) })
  vm.runInContext(app + `
    const data = new Map(); let incoming, rendered;
    C = {storage:{get:(k,d)=>data.has(k)?data.get(k):d,set:(k,v)=>data.set(k,v)},setTimeout:()=>()=>{}};
    setUi({py:'off'});
    inject = async () => ({key:'https://proof.invalid',url:'https://proof.invalid/'});
    ensurePoll = () => {};
    callApi = async (method, args) => {
      if (method === 'render') rendered = args;
      return {v:method==='audit'?incoming:method==='probe'?{docVersion:1}:{lost:globalThis.lostIds||[]}};
    };
    globalThis.audit = async function(result, raw = false) {
      incoming = raw ? result : {url:'https://proof.invalid/', score:100, findings:[], stats:{checked:{},skipped:{}}, presentAnchors:['button|#buy|body'], presentComplete:true, ...result};
      const out = await doAudit({source:'agent'});
      if (!out.ok && !raw) throw new Error(JSON.stringify(out));
      const rows = [], kinds = {};
      function walk(x) {
        if (Array.isArray(x)) return x.forEach(walk);
        if (!x || !x.props) return;
        if (x.type === Row && x.props.kind === 'open') rows.push(x.props.f.id);
        if (x.type === Row) kinds[x.props.f.id] = x.props.kind + (x.props.lost ? '+lost' : '') + (x.props.notRechecked ? '+nr' : '');
        walk(x.props.children);
      }
      walk(resultView($ui.get()));
      return JSON.parse(JSON.stringify({out, rendered, rows, kinds, ui:{gone:$ui.get().gone, fixed:$ui.get().fixed}, stored:data.get('local')['https://proof.invalid'],
        prior:await previousFor('https://proof.invalid')}));
    };
    globalThis.setLost = ids => { globalThis.lostIds = ids };
    globalThis.reload = () => { M.mem = {}; setUi(initialUi()); setUi({py:'off'}); };
  `, ctx)
  return { audit: async (result, raw = false) => JSON.parse(JSON.stringify(await ctx.audit(result, raw))), reload: ctx.reload, setLost: ctx.setLost }
}
const f = { id: 'a11y.control-name@412214a1', rule: 'a11y.control-name', sev: 'high', anchor: { tag: 'button', sig: 'button|#buy|body' } }
const EVIDENCE = { stats: { checked: {}, skipped: {} }, presentAnchors: ['button|#buy|body'], presentComplete: true }
const resultCases = JSON.parse(fs.readFileSync(new URL('tests/shared/audit_result_cases.json', root), 'utf8'))
for (const c of resultCases) test('doAudit raw result boundary: ' + c.name, async () => {
  const ctx = harness()
  await ctx.audit({ findings: [f], rules_covered: [f.rule] })
  const incoming = {url:'https://proof.invalid/', score:100, findings:[], rules_covered:[f.rule], ...EVIDENCE, ...c.patch}
  for (const field of c.omit || []) delete incoming[field]
  const result = await ctx.audit(incoming, true)
  if (c.fixed) {
    assert.equal(result.out.ok, true)
    assert.deepEqual(result.out.delta.fixed, [f.id])
  } else {
    if (result.out.ok) assert.deepEqual(result.out.delta.fixed, [])
    assert.deepEqual(result.prior.findings.map(x => x.id), [f.id])
    assert.deepEqual(result.stored.findings.map(x => x.id), [f.id])
    const repair = await ctx.audit({ rules_covered: [f.rule] })
    assert.deepEqual(repair.out.delta.fixed, [f.id])
  }
})

test('three audits retain unresolved pins in memory, storage and presentation until measured repair', async () => {
  const ctx = harness()
  await ctx.audit({ findings: [f], rules_covered: [f.rule] })
  const partial = await ctx.audit({ rules_covered: ['a11y.img-alt'] })
  assert.deepEqual(partial.out.delta.fixed, [])
  assert.deepEqual(partial.out.delta.not_rechecked, [f.id])
  assert.deepEqual(partial.out.result.findings, [], 'never claim old findings were measured now')
  assert.deepEqual(partial.prior.findings.map(x => x.id), [f.id], 'memory must retain open pin')
  assert.deepEqual(partial.stored.findings.map(x => x.id), [f.id], 'storage must retain open pin')
  assert.deepEqual(partial.rows, [f.id], 'open row must remain available')
  assert.deepEqual(partial.rendered[0].map(x => x.id), [f.id], 'overlay must retain open pin')
  ctx.reload()
  const restored = await ctx.audit({ rules_covered: ['a11y.img-alt'] })
  assert.deepEqual(restored.prior.findings.map(x => x.id), [f.id])
  assert.deepEqual(restored.rows, [f.id])
  const repair = await ctx.audit({ rules_covered: [f.rule] })
  assert.deepEqual(repair.out.delta.fixed, [f.id])
  assert.deepEqual(repair.stored.findings, [])
  assert.deepEqual(repair.rows, [])
})

for (const [name, metadata] of Object.entries({
  missing: {}, malformed: { rules_covered: 'broken' }, empty_checked: { stats: { checked: {} } },
  requested_only: { rules: [f.rule] }, truncated: { rules_covered: [f.rule], limits: ['findings truncated: showing 200 of 201'] },
  flag_truncated: { rules_covered: [f.rule], truncated: true },
  engine_error: { rules_covered: [f.rule], errors: [{ rule: 'engine', message: 'failed' }] },
  rule_error: { rules_covered: [f.rule], errors: [{ rule: f.rule, message: 'failed' }] }
})) test('doAudit keeps absent pin unresolved for ' + name, async () => {
  const ctx = harness()
  await ctx.audit({ findings: [f], rules_covered: [f.rule] })
  const partial = await ctx.audit(metadata)
  assert.deepEqual(partial.out.delta.fixed, [])
  assert.deepEqual(partial.out.delta.not_rechecked, [f.id])
  assert.deepEqual(partial.stored.findings.map(x => x.id), [f.id])
})

test('pane shows the real verdict per row: gone is its own row, never fixed, and is not stored as open', async () => {
  const ctx = harness()
  await ctx.audit({ findings: [f], rules_covered: [f.rule] })
  const gone = await ctx.audit({ rules_covered: [f.rule], presentAnchors: ['div|#other|body'] })
  assert.deepEqual([gone.out.delta.fixed, gone.out.delta.gone, gone.out.delta.not_rechecked], [[], [f.id], []])
  assert.equal(gone.kinds[f.id], 'gone')
  assert.deepEqual(gone.ui.gone.map(x => x.id), [f.id])
  assert.deepEqual(gone.stored.findings, [], 'a gone pin is no longer an open overlay target')
  assert.deepEqual(gone.rendered[0], [], 'gone pins are not drawn as green fixed pins')
  assert.ok(gone.out.delta.receipt.includes('gone (element signature no longer on the page; NOT proof of a fix): 1'))
})

test("pane: 'can't locate' is an overlay caveat only; the verdict is unchanged", async () => {
  const ctx = harness()
  await ctx.audit({ findings: [f], rules_covered: [f.rule] })
  ctx.setLost([f.id])
  const fixed = await ctx.audit({ rules_covered: [f.rule] })
  assert.deepEqual(fixed.out.delta.fixed, [f.id])
  assert.equal(fixed.kinds[f.id], 'fixed+lost')
  ctx.reload()
  const again = await ctx.audit({ findings: [f], rules_covered: [f.rule] })
  assert.equal(again.kinds[f.id], 'open+lost')
  const unknown = await ctx.audit({ rules_covered: ['a11y.img-alt'] })
  assert.deepEqual(unknown.out.delta.not_rechecked, [f.id])
  assert.equal(unknown.kinds[f.id], 'open+lost+nr')
  ctx.setLost([])
})

test('pane: host stamps the audit options on findings; a page-supplied stamp is overwritten', async () => {
  const ctx = harness()
  await ctx.audit({ findings: [f], rules_covered: [f.rule] })
  const prior = await ctx.audit({ findings: [f], rules_covered: [f.rule] })
  assert.equal(prior.prior.findings[0].audit_sig, 'AA|44', 'host stamps the options the audit ran with')
  const forged = await ctx.audit({ findings: [{ ...f, audit_sig: 'AAA|0' }], rules_covered: [f.rule] })
  assert.equal(forged.prior.findings[0].audit_sig, 'AA|44', 'a page-supplied stamp is overwritten')
})
