#!/usr/bin/env node
// Builds desktop/plugin.js from desktop/src/app.js:
//   /*@@BRIDGE@@*/  <- desktop/src/bridge.js  (leading `export ` stripped)
//   /*@@ENGINE@@*/  <- engine/pinpoint-engine.js (verbatim, trailing `;` stripped)
// Disk desktop plugins are uncompiled single files and may only import the SDK, so everything is inlined.
//
//   node scripts/build-desktop.mjs            write desktop/plugin.js
//   node scripts/build-desktop.mjs --check    exit 1 if desktop/plugin.js differs from a fresh build
//   --engine <path>  use another engine file (tests, stubs)    --root <dir>  repo root override
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const flag = name => args.includes(name)
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(opt('--root') || path.join(here, '..'))
const enginePath = path.resolve(opt('--engine') || path.join(root, 'engine', 'pinpoint-engine.js'))
const appPath = path.join(root, 'desktop', 'src', 'app.js')
const bridgePath = path.join(root, 'desktop', 'src', 'bridge.js')
const outPath = path.resolve(opt('--out') || path.join(root, 'desktop', 'plugin.js'))

const norm = s => s.replace(/\r\n/g, '\n')
const fail = msg => { console.error('build-desktop: ' + msg); process.exit(2) }
const read = p => { try { return norm(fs.readFileSync(p, 'utf8')) } catch (e) { fail('cannot read ' + p) } }

export function build() {
  let app = read(appPath)
  const bridge = read(bridgePath).replace(/^export\s+(?=(const|function|let)\b)/gm, '').trimEnd()
  let engine = read(enginePath).trim().replace(/;+\s*$/, '')
  if (!/^(async\s+)?function\s+pinpointEngine\s*\(/m.test(engine)) fail('engine must declare `function pinpointEngine(config)` (SPEC 2)')
  for (const marker of ['/*@@BRIDGE@@*/', '/*@@ENGINE@@*/']) {
    if (app.split(marker).length !== 2) fail('app.js must contain exactly one ' + marker)
  }
  // function replacers: engine/bridge text may contain `$&`-style sequences
  app = app.replace('/*@@BRIDGE@@*/', () => bridge).replace('/*@@ENGINE@@*/', () => engine)
  const header = '// GENERATED - do not edit. Source: desktop/src/app.js + desktop/src/bridge.js + engine/pinpoint-engine.js\n' +
    '// Rebuild: node scripts/build-desktop.mjs\n'
  return header + app
}

const out = build()
if (flag('--check')) {
  let cur = null
  try { cur = norm(fs.readFileSync(outPath, 'utf8')) } catch (e) { /* missing counts as drift */ }
  if (cur !== out) { console.error('build-desktop: ' + path.relative(root, outPath) + ' is out of date (run node scripts/build-desktop.mjs)'); process.exit(1) }
  console.log('build-desktop: up to date (' + out.length + ' bytes)')
} else {
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, out)
  console.log('build-desktop: wrote ' + path.relative(root, outPath) + ' (' + out.length + ' bytes)')
}
