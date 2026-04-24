import { hexToBytes } from '@noble/hashes/utils'

// XOR obfuscation pattern — same shape as src/main/community/community-client.ts.
// Not secret-security: the key is extractable from a shipped app binary. Scope is
// intentionally narrow (publish+subscribe on one channel via Supabase RLS), so the
// worst case if extracted is spam on the trollbox channel, which we handle via
// admin kill-switch + key rotation in a new release.
const _ck = 'CogTrollboxV1_2026'
const _urlCt = [43,27,19,36,1,85,67,67,16,4,14,56,89,52,89,66,64,92,32,21,19,48,8,29,24,6,11,0,86,37,68,47,83,82,83,69,38,65,4,59]
const _anonCt = [48,13,56,36,7,13,0,5,17,7,25,52,93,58,109,99,107,68,41,95,23,3,22,5,47,54,42,44,19,62,68,29,64,113,4,79,2,48,11,60,19,10,94,8,23,41]

const deobf = (ct: number[]): string =>
  ct.map((c, i) => String.fromCharCode(c ^ _ck.charCodeAt(i % _ck.length))).join('')

export const TROLLBOX_SUPABASE_URL = deobf(_urlCt)
export const TROLLBOX_SUPABASE_ANON = deobf(_anonCt)

export const TROLLBOX_CHANNEL = 'trollbox-v1'

// Public keys from scripts/trollbox-gen-keys.ts. Public by design; paired private
// keys live only in Nate's password manager and are pasted at runtime.
export const TROLLBOX_ADMIN_ED25519_PUBKEY = hexToBytes('c4af4b37c682cf6677fdd8a2cdf578d367683fd855184a6383403d248e275b6d')
export const TROLLBOX_ADMIN_X25519_PUBKEY  = hexToBytes('97160418f8db84248d2eb0353deca5d4089c1daeea92667c197b8e5aa7698d73')
