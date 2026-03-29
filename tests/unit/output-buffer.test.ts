import { describe, it, expect } from 'vitest'
import { OutputBuffer } from '../../src/main/shell/output-buffer'

describe('OutputBuffer', () => {
  it('stores and retrieves lines', () => {
    const buf = new OutputBuffer(10)
    buf.push('line 1')
    buf.push('line 2')
    expect(buf.getLines(10)).toEqual(['line 1', 'line 2'])
  })

  it('respects max capacity (rolling)', () => {
    const buf = new OutputBuffer(3)
    buf.push('a')
    buf.push('b')
    buf.push('c')
    buf.push('d')
    expect(buf.getLines(10)).toEqual(['b', 'c', 'd'])
  })

  it('returns only requested number of lines', () => {
    const buf = new OutputBuffer(100)
    for (let i = 0; i < 10; i++) buf.push(`line-${i}`)
    expect(buf.getLines(3)).toEqual(['line-7', 'line-8', 'line-9'])
  })

  it('handles raw data with newlines', () => {
    const buf = new OutputBuffer(100)
    buf.pushRaw('line1\nline2\nline3')
    expect(buf.getLines(10)).toEqual(['line1', 'line2', 'line3'])
  })
})
