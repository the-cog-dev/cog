// One-off helper to XOR-obfuscate strings for embedding in trollbox-config.ts.
// Matches the _ck key and deobf function used by the config module.
const KEY = 'CogTrollboxV1_2026'
const input = process.argv[2]
if (!input) {
  console.error('Usage: tsx scripts/trollbox-obfuscate.ts <string-to-obfuscate>')
  process.exit(1)
}
const ct = Array.from(input).map((ch, i) => ch.charCodeAt(0) ^ KEY.charCodeAt(i % KEY.length))
console.log('[' + ct.join(',') + ']')
