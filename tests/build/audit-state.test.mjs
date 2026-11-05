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
      return {v:method==='audit'?incoming:method==='probe'?{docVersion:1}:{lost:[]}};
    };
    globalThis.audit = async function(result) {
      incoming = {url:'https://proof.invalid/', score:100, findings:[], ...result};
      const out = await doAudit({source:'agent'});
      if (!out.ok) throw new Error(JSON.stringify(out));
      const rows = [];
      function walk(x) {
        if (Array.isArray(x)) return x.forEach(walk);
        if (!x || !x.props) return;
        if (x.type === Row && x.props.kind === 'open') rows.push(x.props.f.id);
        walk(x.props.children);
      }
      walk(resultView($ui.get()));
      return JSON.parse(JSON.stringify({out, rendered, rows, stored:data.get('local')['https://proof.invalid'],
        prior:await previousFor('https://proof.invalid')}));
    };
    globalThis.reload = () => { M.mem = {}; setUi(initialUi()); setUi({py:'off'}); };
  `, ctx)
  return { audit: async result => JSON.parse(JSON.stringify(await ctx.audit(result))), reload: ctx.reload }
}
const f = { id: 'a11y.control-name@412214a1', rule: 'a11y.control-name', sev: 'high' }

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
