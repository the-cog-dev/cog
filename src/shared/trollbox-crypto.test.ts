import { describe, it, expect } from 'vitest'
import { canonicalJSON, nickToColor, signAdmin, verifyAdmin, sealFp, openFp } from './trollbox-crypto'
import { ed25519, x25519 } from '@noble/curves/ed25519'

describe('canonicalJSON', () => {
  it('sorts keys alphabetically', () => {
    expect(canonicalJSON({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
  })
  it('drops sig field', () => {
    expect(canonicalJSON({ a: 1, sig: 'ff' })).toBe('{"a":1}')
  })
  it('recurses into nested objects', () => {
    expect(canonicalJSON({ z: { b: 1, a: 2 } })).toBe('{"z":{"a":2,"b":1}}')
  })
  it('preserves arrays in order', () => {
    expect(canonicalJSON({ a: [3, 1, 2] })).toBe('{"a":[3,1,2]}')
  })
  it('only strips sig at the top level (nested sig preserved)', () => {
    expect(canonicalJSON({ outer: { sig: 'nested', data: 1 } }))
      .toBe('{"outer":{"data":1,"sig":"nested"}}')
  })
})

describe('nickToColor', () => {
  it('is deterministic', () => {
    expect(nickToColor('satoshi')).toBe(nickToColor('satoshi'))
  })
  it('returns a 7-char hex color', () => {
    const c = nickToColor('hello')
    expect(c).toMatch(/^#[0-9a-f]{6}$/)
  })
  it('different nicks produce different colors', () => {
    expect(nickToColor('a')).not.toBe(nickToColor('b'))
  })
  it('avoids unreadably-dark colors (sum > 200)', () => {
    const hex = nickToColor('x').slice(1)
    const r = parseInt(hex.slice(0, 2), 16)
    const g = parseInt(hex.slice(2, 4), 16)
    const b = parseInt(hex.slice(4, 6), 16)
    expect(r + g + b).toBeGreaterThan(200)
  })
})

describe('signAdmin / verifyAdmin', () => {
  const priv = ed25519.utils.randomPrivateKey()
  const pub = ed25519.getPublicKey(priv)
  const wrongPub = ed25519.getPublicKey(ed25519.utils.randomPrivateKey())

  it('round-trips sign → verify', () => {
    const payload = { type: 'admin.delete', target_id: 'abc', ts: 123 }
    const signed = signAdmin(payload, priv)
    expect(verifyAdmin(signed, pub)).toBe(true)
  })

  it('rejects tampered payload', () => {
    const payload = { type: 'admin.delete', target_id: 'abc', ts: 123 }
    const signed = signAdmin(payload, priv)
    const tampered = { ...signed, target_id: 'xyz' }
    expect(verifyAdmin(tampered, pub)).toBe(false)
  })

  it('rejects wrong public key', () => {
    const payload = { type: 'admin.delete', target_id: 'abc', ts: 123 }
    const signed = signAdmin(payload, priv)
    expect(verifyAdmin(signed, wrongPub)).toBe(false)
  })

  it('returns false for malformed input (no throw)', () => {
    expect(verifyAdmin({ type: 'x' } as any, pub)).toBe(false)
    expect(verifyAdmin(null as any, pub)).toBe(false)
  })
})

describe('sealFp / openFp', () => {
  const recipientPriv = x25519.utils.randomPrivateKey()
  const recipientPub = x25519.getPublicKey(recipientPriv)
  const wrongPriv = x25519.utils.randomPrivateKey()

  it('round-trips seal → open', () => {
    const fp = 'a3f8c21d0b91'
    const blob = sealFp(fp, recipientPub)
    expect(openFp(blob, recipientPriv, recipientPub)).toBe(fp)
  })

  it('each seal produces a different blob (ephemeral key)', () => {
    const fp = 'a3f8c21d0b91'
    expect(sealFp(fp, recipientPub)).not.toBe(sealFp(fp, recipientPub))
  })

  it('open returns null with wrong private key (no throw)', () => {
    const blob = sealFp('a3f8c21d0b91', recipientPub)
    expect(openFp(blob, wrongPriv, x25519.getPublicKey(wrongPriv))).toBe(null)
  })

  it('open returns null for malformed blob', () => {
    expect(openFp('not-base64!!!', recipientPriv, recipientPub)).toBe(null)
    expect(openFp('', recipientPriv, recipientPub)).toBe(null)
  })
})
