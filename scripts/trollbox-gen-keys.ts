import { ed25519, x25519 } from '@noble/curves/ed25519'

const edPriv = ed25519.utils.randomPrivateKey()
const edPub = ed25519.getPublicKey(edPriv)

const xPriv = x25519.utils.randomPrivateKey()
const xPub = x25519.getPublicKey(xPriv)

const hex = (u: Uint8Array) => Buffer.from(u).toString('hex')

console.log('=== SAVE BOTH PRIVATE KEYS TO PASSWORD MANAGER ===')
console.log('ED25519 private (64 hex):', hex(edPriv))
console.log('X25519  private (32 hex):', hex(xPriv))
console.log('')
console.log('Paste-blob for admin drawer (96 bytes):')
console.log(hex(edPriv) + hex(xPriv))
console.log('')
console.log('=== EMBED BOTH PUBLIC KEYS IN src/shared/trollbox-config.ts ===')
console.log('ED25519 public (32 hex):', hex(edPub))
console.log('X25519  public (32 hex):', hex(xPub))
