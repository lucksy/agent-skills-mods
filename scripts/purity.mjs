#!/usr/bin/env node
// The shared core (J1) stays pure: every surface (the mod, the CLI, the dashboard
// and later the VS Code extension) imports packages/core, so its files import
// only each other: no claude-code, no Node built-ins (the mods engine loads
// neither), no path that leaves packages/core. Prints each offence; exits 1 on any.
//
//   node scripts/purity.mjs [dir]     # default: packages/core next to this script

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'core'))

let files
try {
  if (!statSync(root).isDirectory()) throw new Error('not a directory')
  files = readdirSync(root, { recursive: true }).filter(f => /\.tsx?$/.test(f))
} catch {
  console.log(`no library at ${root}`)
  process.exit(1)
}
if (!files.length) {
  console.log(`no .ts files in ${root}`)
  process.exit(1)
}

const IMPORT = /^\s*(?:import|export)\b[^'"]*?\bfrom\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm
const bad = []
for (const file of files) {
  const text = readFileSync(join(root, file), 'utf8')
  for (const m of text.matchAll(IMPORT)) {
    const spec = m[1] ?? m[2] ?? m[3]
    const inside = spec.startsWith('.') && !relative(root, resolve(root, dirname(file), spec)).startsWith('..')
    if (!inside) bad.push(`${file}: imports ${spec}`)
  }
  // Comments may name the API they stand in for; code may not use it.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  if (/\$\.(?:ui|fs|tool|command|clock|session|process|store)\b/.test(code)) bad.push(`${file}: uses the Claude Code API ($.…)`)
}
for (const b of bad) console.log(b.split(sep).join('/'))
console.log(bad.length ? `${bad.length} offence${bad.length === 1 ? '' : 's'} in ${files.length} files` : `pure: ${files.length} files`)
process.exit(bad.length ? 1 : 0)
