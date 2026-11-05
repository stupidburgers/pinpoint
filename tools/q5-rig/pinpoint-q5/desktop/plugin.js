import { host, PALETTE_AREA, TRANSCRIPT_DIRECTIVE_AREA } from '@hermes/plugin-sdk'
import { jsx } from 'react/jsx-runtime'

const ID = 'pinpoint-q5'
const L = (m, d) => console.error('[' + ID + '] ' + m + (d !== undefined ? ' ' + JSON.stringify(d).slice(0, 1500) : ''))

export default {
  id: ID,
  name: 'Pinpoint Q5 probe',
  register(ctx) {
    L('register')
    ctx.onDispose(host.onEvent('*', ev => {
      const t = ev && ev.type
      if (typeof t === 'string' && (t.startsWith('tool.') || t.startsWith('plugin.'))) L('EVENT ' + t, t === 'tool.complete' ? { name: ev.payload.name, resultLen: String(ev.payload.result).length, head: String(ev.payload.result).slice(0, 120), tail: String(ev.payload.result).slice(-150) } : { session_id: ev.session_id, payload: ev.payload })
    }))
    ctx.onDispose(host.onEvent('plugin.pinpoint-q5.pins.set', ev => {
      L('CHANNEL-A plugin.pinpoint-q5.pins.set', ev && ev.payload)
    }))
    ctx.onDispose(host.onEvent('plugin.pinpoint-q5.audit.request', async ev => {
      const t0 = performance.now(); const p = ev.payload || {}
      try {
        await ctx.rest('/ack/' + p.request_id, { method: 'POST', body: {} })
        if (p.n === 999) { p.n = 2; await new Promise(r => setTimeout(r, 25000)) }
        const findings = Array.from({ length: p.n || 3 }, (_, i) => ({ id: 'contrast:#el' + i, rule: 'contrast', selector: '#el' + i, note: 'Contrast 1.92:1 < 4.5:1 ' + 'x'.repeat(150) }))
        const r = await ctx.rest('/result', { method: 'POST', body: { request_id: p.request_id, findings } })
        L('REQ answered', { rid: p.request_id, n: findings.length, ms: Math.round(performance.now() - t0), r })
      } catch (e) { L('REQ FAILED ' + (e && e.message || e)) }
    }))
    ctx.register({ id: 'submit', area: PALETTE_AREA, data: { id: 'q5.submit', label: 'Q5: composer.submit', keywords: ['q5'], run: async () => {
      const r = host.composer.submit(null, 'Pinpoint: fix pin #1 (contrast) on `#hero`')
      L('composer.submit returned', { r: String(r) })
    } } })
    ctx.register({ id: 'rest', area: PALETTE_AREA, data: { id: 'q5.rest', label: 'Q5: rest /state', keywords: ['q5'], run: async () => {
      try { L('CHANNEL-B ctx.rest /state', await ctx.rest('/state')) } catch (e) { L('rest FAILED ' + (e && e.message || e)) }
    } } })
    ctx.register({ id: 'dir', area: TRANSCRIPT_DIRECTIVE_AREA, data: { name: 'pinpoint', render: ({ attrs, sessionId }) => {
      L('CHANNEL-C directive render', { attrs, sessionId })
      return jsx('div', { id: 'pp-directive', children: 'PINPOINT DIRECTIVE ' + JSON.stringify(attrs) })
    } } })
    window.__ppq5 = { submit: (s, t) => host.composer.submit(s, t), rest: p => ctx.rest(p) }
  }
}
