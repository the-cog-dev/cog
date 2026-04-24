import { describe, it, expect } from 'vitest'
import { computePauseCountdown } from './usePauseCountdown'

describe('computePauseCountdown', () => {
  it('correct mm:ss mid-countdown', () => {
    const r = computePauseCountdown(125_000, 0)
    expect(r.mm).toBe(2)
    expect(r.ss).toBe('05')
    expect(r.secsRemaining).toBe(125)
    expect(r.expired).toBe(false)
  })
  it('pads ss to two digits for single-digit seconds', () => {
    expect(computePauseCountdown(5_000, 0).ss).toBe('05')
  })
  it('pads ss to two digits for zero seconds of a full minute', () => {
    // 60s remaining: mm=1, ss=00
    const r = computePauseCountdown(60_000, 0)
    expect(r.mm).toBe(1)
    expect(r.ss).toBe('00')
  })
  it('clamps to zero when past expiry', () => {
    const r = computePauseCountdown(1_000, 5_000)
    expect(r.secsRemaining).toBe(0)
    expect(r.mm).toBe(0)
    expect(r.ss).toBe('00')
    expect(r.expired).toBe(true)
  })
  it('never negative', () => {
    const r = computePauseCountdown(-10_000, 0)
    expect(r.secsRemaining).toBe(0)
    expect(r.expired).toBe(true)
  })
  it('exact expiry boundary is expired', () => {
    const r = computePauseCountdown(1_000, 1_000)
    expect(r.secsRemaining).toBe(0)
    expect(r.expired).toBe(true)
  })
  it('rounds sub-second fractions correctly', () => {
    // 1400ms remaining rounds to 1s
    expect(computePauseCountdown(1_400, 0).secsRemaining).toBe(1)
    // 1600ms remaining rounds to 2s
    expect(computePauseCountdown(1_600, 0).secsRemaining).toBe(2)
  })
})
