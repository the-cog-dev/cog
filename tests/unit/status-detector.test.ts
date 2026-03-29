import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StatusDetector } from '../../src/main/shell/status-detector'

describe('StatusDetector', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts in idle state', () => {
    const detector = new StatusDetector()
    expect(detector.status).toBe('idle')
  })

  it('transitions to working on data', () => {
    const detector = new StatusDetector()
    detector.onData('some output text')
    expect(detector.status).toBe('working')
  })

  it('transitions to active after prompt + silence', () => {
    const onChange = vi.fn()
    const detector = new StatusDetector({ promptRegex: />\s*$/, onChange })
    detector.onData('claude> ')
    expect(detector.status).toBe('working')

    vi.advanceTimersByTime(2500)
    expect(detector.status).toBe('active')
    expect(onChange).toHaveBeenCalledWith('active')
  })

  it('stays working if output continues after prompt-like text', () => {
    const detector = new StatusDetector({ promptRegex: />\s*$/ })
    detector.onData('value > 5 is valid')
    vi.advanceTimersByTime(1000)
    detector.onData('more output here')
    vi.advanceTimersByTime(2500)
    expect(detector.status).toBe('working')
  })

  it('strips ANSI codes before matching', () => {
    const onChange = vi.fn()
    const detector = new StatusDetector({ promptRegex: />\s*$/, onChange })
    detector.onData('\x1b[32mclaude>\x1b[0m ')
    vi.advanceTimersByTime(2500)
    expect(detector.status).toBe('active')
  })

  it('transitions to disconnected on exit', () => {
    const detector = new StatusDetector()
    detector.onExit()
    expect(detector.status).toBe('disconnected')
  })
})
