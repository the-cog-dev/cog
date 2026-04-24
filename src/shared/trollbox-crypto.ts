import { sha256 } from '@noble/hashes/sha256'
import { ed25519, x25519 } from '@noble/curves/ed25519'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { xchacha20poly1305 } from '@noble/ciphers/chacha'
import { blake2b } from '@noble/hashes/blake2b'

// Canonical JSON: sorted keys, no whitespace, sig field removed.
// Used as the signing payload so sender and verifier agree on byte-level input.
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortKeys(stripSig(value)))
}

// Top-level only by design: the signature we add lives at the root of admin
// payloads. Nested "sig" fields inside user-controlled data must be preserved
// so signatures stay stable across any payload schema we might pass through.
function stripSig(v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const { sig: _drop, ...rest } = v as Record<string, unknown>
    return rest
  }
  return v
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) {
      sorted[k] = sortKeys((v as Record<string, unknown>)[k])
    }
    return sorted
  }
  return v
}

// Deterministic color from nickname. Two "satoshi"s will always share a shade,
// which is a feature — it makes impersonation visually obvious.
export function nickToColor(nick: string): string {
  const digest = sha256(new TextEncoder().encode(nick))
  // Bias channels away from darkness: each channel floor = 80 to stay readable on #1a1a1a
  const r = 80 + (digest[0] % 176)
  const g = 80 + (digest[1] % 176)
  const b = 80 + (digest[2] % 176)
  return '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('')
}

export function signAdmin<T extends object>(payload: T, edPriv: Uint8Array): T & { sig: string } {
  const msg = new TextEncoder().encode(canonicalJSON(payload))
  const sig = ed25519.sign(msg, edPriv)
  return { ...payload, sig: bytesToHex(sig) }
}

export function verifyAdmin(
  signed: { sig?: string } & object,
  edPub: Uint8Array
): boolean {
  try {
    if (!signed || typeof signed.sig !== 'string') return false
    const sigBytes = hexToBytes(signed.sig)
    const msg = new TextEncoder().encode(canonicalJSON(signed))
    return ed25519.verify(sigBytes, msg, edPub)
  } catch {
    return false
  }
}

// NaCl-compatible sealed box: ephemeral X25519 sender keypair + XChaCha20-Poly1305.
// nonce = blake2b(ephPub || recipientPub, 24 bytes) — matches libsodium crypto_box_seal.
// Wire format: base64(ephPub(32) || ciphertext || tag(16))
export function sealFp(fp: string, recipientPub: Uint8Array): string {
  const ephPriv = x25519.utils.randomPrivateKey()
  const ephPub = x25519.getPublicKey(ephPriv)
  const shared = x25519.getSharedSecret(ephPriv, recipientPub)
  const nonce = blake2b(concat(ephPub, recipientPub), { dkLen: 24 })
  const key = blake2b(shared, { dkLen: 32 })
  const cipher = xchacha20poly1305(key, nonce)
  const plaintext = new TextEncoder().encode(fp)
  const ct = cipher.encrypt(plaintext)
  return bytesToBase64(concat(ephPub, ct))
}

export function openFp(
  blob: string,
  recipientPriv: Uint8Array,
  recipientPub: Uint8Array
): string | null {
  try {
    const bytes = base64ToBytes(blob)
    // Minimum valid size: 32 (ephPub) + >=1 plaintext + 16 (tag) = 49 bytes.
    if (bytes.length < 32 + 1 + 16) return null
    const ephPub = bytes.slice(0, 32)
    const ct = bytes.slice(32)
    const shared = x25519.getSharedSecret(recipientPriv, ephPub)
    const nonce = blake2b(concat(ephPub, recipientPub), { dkLen: 24 })
    const key = blake2b(shared, { dkLen: 32 })
    const cipher = xchacha20poly1305(key, nonce)
    const pt = cipher.decrypt(ct)
    return new TextDecoder().decode(pt)
  } catch {
    return null
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function bytesToBase64(b: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(b).toString('base64')
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s)
}

function base64ToBytes(s: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64'))
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
