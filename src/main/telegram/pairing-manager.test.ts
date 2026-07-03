import { describe, it, expect, vi } from 'vitest'
import { PairingManager } from './pairing-manager'

describe('PairingManager', () => {
  it('pairs a user with a valid code and persists the change', () => {
    const onChange = vi.fn()
    const pm = new PairingManager({ onAllowlistChange: onChange })
    const code = pm.generateCode()
    expect(code).toMatch(/^\d{6}$/)
    expect(pm.tryPair(42, code)).toBe(true)
    expect(pm.isAllowed(42)).toBe(true)
    expect(onChange).toHaveBeenCalledWith([42])
  })

  it('rejects a wrong code without trusting the user', () => {
    const pm = new PairingManager()
    const code = pm.generateCode()
    const wrong = code === '000000' ? '000001' : '000000'  // guaranteed different
    expect(pm.tryPair(42, wrong)).toBe(false)
    expect(pm.isAllowed(42)).toBe(false)
  })

  it('consumes the code so it cannot be reused', () => {
    const pm = new PairingManager()
    const code = pm.generateCode()
    expect(pm.tryPair(1, code)).toBe(true)
    expect(pm.tryPair(2, code)).toBe(false)
    expect(pm.isAllowed(2)).toBe(false)
  })

  it('expires codes after the TTL using the injected clock', () => {
    let now = 0
    const pm = new PairingManager({ clock: () => now, codeTtlMs: 1000 })
    const code = pm.generateCode()
    now = 1001
    expect(pm.getActiveCode()).toBeNull()
    expect(pm.tryPair(7, code)).toBe(false)
  })

  it('revokes a trusted user and reports the change', () => {
    const onChange = vi.fn()
    const pm = new PairingManager({ initialAllowlist: [5], onAllowlistChange: onChange })
    expect(pm.isAllowed(5)).toBe(true)
    expect(pm.revoke(5)).toBe(true)
    expect(pm.isAllowed(5)).toBe(false)
    expect(onChange).toHaveBeenLastCalledWith([])
  })

  it('ignores undefined user IDs', () => {
    const pm = new PairingManager({ initialAllowlist: [1] })
    expect(pm.isAllowed(undefined)).toBe(false)
  })

  it('burns the code after too many failed attempts (anti-brute-force)', () => {
    const pm = new PairingManager({ maxAttempts: 3 })
    const code = pm.generateCode()
    const wrong = code === '000000' ? '000001' : '000000'
    for (let i = 0; i < 3; i++) expect(pm.tryPair(9, wrong)).toBe(false)
    // Code is now burned — even the real one no longer works.
    expect(pm.getActiveCode()).toBeNull()
    expect(pm.tryPair(9, code)).toBe(false)
    expect(pm.isAllowed(9)).toBe(false)
  })

  it('resets the failure counter when a fresh code is generated', () => {
    const pm = new PairingManager({ maxAttempts: 3 })
    let code = pm.generateCode()
    const wrong = code === '000000' ? '000001' : '000000'
    pm.tryPair(9, wrong)
    pm.tryPair(9, wrong)
    code = pm.generateCode()  // fresh code → fresh budget
    pm.tryPair(9, code === '000000' ? '000001' : '000000')
    pm.tryPair(9, code === '000000' ? '000001' : '000000')
    expect(pm.tryPair(9, code)).toBe(true)  // 2 failures < 3, still valid
  })
})
