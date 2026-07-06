#!/usr/bin/env node
// Encode a GitHub PAT into the obfuscated `_bt` byte array the bug-report
// button uses (src/main/index.ts). Run this LOCALLY so the raw token never
// lands in chat, logs, or a committed plaintext file — only the XOR-obfuscated
// numbers (which already live in the public repo by design) are emitted.
//
// Usage:
//   node scripts/encode-bug-token.mjs <PAT>            # print the line to paste
//   node scripts/encode-bug-token.mjs <PAT> --write    # patch src/main/index.ts in place
//   BUG_PAT=<PAT> node scripts/encode-bug-token.mjs    # pass via env instead of argv
//
// Matches the deobfuscation in src/main/index.ts: byte[i] = pat[i] ^ key[i % key.length]

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const KEY = 'TheCogBugReporter2026'
const INDEX_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main', 'index.ts')

const args = process.argv.slice(2)
const write = args.includes('--write')
const pat = (args.find(a => !a.startsWith('--')) ?? process.env.BUG_PAT ?? '').trim()

if (!pat) {
  console.error('No PAT provided. Pass it as the first argument or set BUG_PAT.')
  process.exit(1)
}
if (!pat.startsWith('github_pat_') && !pat.startsWith('ghp_')) {
  console.error(`Warning: "${pat.slice(0, 8)}…" doesn't look like a GitHub PAT — continuing anyway.`)
}

const bytes = Array.from(pat).map((ch, i) => ch.charCodeAt(0) ^ KEY.charCodeAt(i % KEY.length))

// Round-trip guard: never emit an array that doesn't decode back to the input.
const decoded = bytes.map((c, i) => String.fromCharCode(c ^ KEY.charCodeAt(i % KEY.length))).join('')
if (decoded !== pat) {
  console.error('Encoding failed round-trip check — aborting.')
  process.exit(1)
}

const line = `  const _bt = [${bytes.join(',')}]`

if (write) {
  const src = readFileSync(INDEX_PATH, 'utf8')
  const re = /^ {2}const _bt = \[[0-9,]+\]$/m
  if (!re.test(src)) {
    console.error(`Could not find the "_bt" line in ${INDEX_PATH}. Patch it by hand.`)
    process.exit(1)
  }
  writeFileSync(INDEX_PATH, src.replace(re, line), 'utf8')
  console.log(`✓ Patched ${INDEX_PATH} with the new bug-report token (prefix ${pat.slice(0, 11)}, len ${pat.length}).`)
} else {
  console.log(`Replace the "_bt" line in src/main/index.ts (~line 2627) with:\n`)
  console.log(line)
  console.log(`\nOr re-run with --write to patch the file automatically.`)
}
