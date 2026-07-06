import { describe, it, expect } from 'vitest'
import { stripAnsi } from './ansi'

describe('stripAnsi', () => {
  it('removes SGR color sequences', () => {
    expect(stripAnsi('\x1b[38;5;12mhello\x1b[0m world')).toBe('hello world')
  })

  it('removes cursor-control and erase sequences', () => {
    expect(stripAnsi('\x1b[2K\x1b[1Gprompt> done')).toBe('prompt> done')
  })

  it('removes OSC title/hyperlink sequences', () => {
    expect(stripAnsi('\x1b]0;my title\x07text')).toBe('text')
    expect(stripAnsi('\x1b]8;;https://x.test\x1b\\link\x1b]8;;\x1b\\')).toBe('link')
  })

  it('removes charset designations and carriage returns', () => {
    expect(stripAnsi('\x1b(Bspinner\r')).toBe('spinner')
  })

  it('keeps newlines, tabs, and plain text untouched', () => {
    expect(stripAnsi('a\tb\nplain')).toBe('a\tb\nplain')
  })
})
