// Shared fixture (tests/shared/delta_cases.json) through desktop/src/bridge.js localDelta.
// The same file drives tests/py/test_delta_cases.py against the Python store: both must agree.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const B = await import(new URL('../../desktop/src/bridge.js', import.meta.url))
const DATA = JSON.parse(fs.readFileSync(new URL('../shared/delta_cases.json', import.meta.url), 'utf8'))

for (const c of DATA.cases) {
  test('localDelta shared case: ' + c.name, () => {
    const result = JSON.parse(JSON.stringify(c.result))
    if (!c.setup) { assert.equal(B.localDelta(null, result.findings, [], result, null), null); return }
    const stamped = B.stampAuditOptions(c.setup.findings, c.setup.audit_options)
    const prev = stamped.filter(f => !c.setup.dismissed.includes(f.id))
    const seen = c.setup.findings.map(f => f.id)
    const d = B.localDelta(prev, result.findings, seen, result, c.setup.score)
    if (c.expect.rejected) { assert.equal(d, null); return }
    assert.ok(d, 'delta expected')
    for (const k of ['fixed', 'gone', 'not_rechecked', 'new']) assert.deepEqual(d[k], c.expect[k], k)
    assert.equal(d.remaining, c.expect.remaining)
    assert.deepEqual(d.unresolved, d.not_rechecked)
    assert.equal(d.prev_score, c.setup.score)
    assert.equal(typeof d.receipt, 'string')
  })
}

for (const r of DATA.receipts) {
  test('formatReceipt shared text: ' + r.name, () => {
    assert.equal(B.formatReceipt(r.prev_score, r.score, r.fixed, r.gone, r.remaining, r.not_rechecked), r.text)
  })
}

test('optionsSig matches the Python rule', () => {
  assert.equal(B.optionsSig({ contrast: 'AA', tapAdvisory: 44 }), 'AA|44')
  assert.equal(B.optionsSig({ contrast: 'AAA', tapAdvisory: 0 }), 'AAA|0')
  for (const bad of [null, {}, { contrast: 'AA' }, { contrast: 'X', tapAdvisory: 44 }, { contrast: 'AA', tapAdvisory: true },
    { contrast: 'AA', tapAdvisory: -1 }, { contrast: 'AA', tapAdvisory: '44' }, 'AA|44']) assert.equal(B.optionsSig(bad), null)
})
