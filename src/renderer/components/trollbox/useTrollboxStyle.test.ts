import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  readStyle,
  writeStyle,
  readTheme,
  writeTheme,
  removeTheme,
  resolveTheme,
  CHATROOM_DEFAULT_THEME,
  CLI_DEFAULT_THEME,
  CHATROOM_PRESETS,
  CLI_PRESETS,
} from './useTrollboxStyle'

function makeLocalStorageStub(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size },
  } as Storage
}

beforeEach(() => {
  vi.unstubAllGlobals()
  vi.stubGlobal('localStorage', makeLocalStorageStub())
})

describe('readStyle', () => {
  it('defaults to chatroom when empty', () => {
    expect(readStyle()).toBe('chatroom')
  })
  it('reads stored cli', () => {
    localStorage.setItem('trollbox:style', 'cli')
    expect(readStyle()).toBe('cli')
  })
  it('coerces unknown values to chatroom', () => {
    localStorage.setItem('trollbox:style', 'weird')
    expect(readStyle()).toBe('chatroom')
  })
  it('returns chatroom when localStorage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('nope') },
    })
    expect(readStyle()).toBe('chatroom')
  })
})

describe('writeStyle', () => {
  it('writes to localStorage', () => {
    writeStyle('cli')
    expect(localStorage.getItem('trollbox:style')).toBe('cli')
  })
  it('silently survives localStorage throwing', () => {
    vi.stubGlobal('localStorage', {
      setItem: () => { throw new Error('nope') },
    })
    expect(() => writeStyle('cli')).not.toThrow()
  })
})

describe('readTheme', () => {
  it('returns {} when empty', () => {
    expect(readTheme('chatroom')).toEqual({})
    expect(readTheme('cli')).toEqual({})
  })
  it('reads valid stored theme', () => {
    localStorage.setItem('trollbox:theme:cli', JSON.stringify({ bg: '#000' }))
    expect(readTheme('cli')).toEqual({ bg: '#000' })
  })
  it('reads all 4 fields', () => {
    localStorage.setItem(
      'trollbox:theme:chatroom',
      JSON.stringify({ chrome: '#111', border: '#222', bg: '#333', text: '#444' }),
    )
    expect(readTheme('chatroom')).toEqual({
      chrome: '#111', border: '#222', bg: '#333', text: '#444',
    })
  })
  it('falls back to {} on malformed JSON', () => {
    localStorage.setItem('trollbox:theme:chatroom', 'not-json{')
    expect(readTheme('chatroom')).toEqual({})
  })
  it('strips non-string fields', () => {
    localStorage.setItem('trollbox:theme:cli', JSON.stringify({ bg: 123, text: '#fff' }))
    expect(readTheme('cli')).toEqual({ text: '#fff' })
  })
  it('returns {} when parsed value is not an object', () => {
    localStorage.setItem('trollbox:theme:cli', JSON.stringify('just a string'))
    expect(readTheme('cli')).toEqual({})
  })
  it('uses the correct key per style', () => {
    localStorage.setItem('trollbox:theme:chatroom', JSON.stringify({ bg: '#chat' }))
    localStorage.setItem('trollbox:theme:cli',      JSON.stringify({ bg: '#cli'  }))
    expect(readTheme('chatroom').bg).toBe('#chat')
    expect(readTheme('cli').bg).toBe('#cli')
  })
})

describe('writeTheme', () => {
  it('writes under correct key per style', () => {
    writeTheme('chatroom', { bg: '#abc' })
    expect(JSON.parse(localStorage.getItem('trollbox:theme:chatroom')!)).toEqual({ bg: '#abc' })
    writeTheme('cli', { text: '#def' })
    expect(JSON.parse(localStorage.getItem('trollbox:theme:cli')!)).toEqual({ text: '#def' })
  })
  it('silently survives localStorage throwing', () => {
    vi.stubGlobal('localStorage', {
      setItem: () => { throw new Error('nope') },
    })
    expect(() => writeTheme('chatroom', { bg: '#abc' })).not.toThrow()
  })
})

describe('removeTheme', () => {
  it('removes only the current style key', () => {
    writeTheme('chatroom', { bg: '#chat' })
    writeTheme('cli',      { bg: '#cli'  })
    removeTheme('cli')
    expect(localStorage.getItem('trollbox:theme:cli')).toBe(null)
    expect(localStorage.getItem('trollbox:theme:chatroom')).not.toBe(null)
  })
  it('silently survives localStorage throwing', () => {
    vi.stubGlobal('localStorage', {
      removeItem: () => { throw new Error('nope') },
    })
    expect(() => removeTheme('chatroom')).not.toThrow()
  })
})

describe('resolveTheme', () => {
  it('returns defaults when override is empty', () => {
    expect(resolveTheme('chatroom', {})).toEqual(CHATROOM_DEFAULT_THEME)
    expect(resolveTheme('cli', {})).toEqual(CLI_DEFAULT_THEME)
  })
  it('merges override over defaults (chatroom)', () => {
    const merged = resolveTheme('chatroom', { bg: '#ff00ff' })
    expect(merged.bg).toBe('#ff00ff')
    expect(merged.text).toBe(CHATROOM_DEFAULT_THEME.text)
    expect(merged.border).toBe(CHATROOM_DEFAULT_THEME.border)
    expect(merged.chrome).toBe(CHATROOM_DEFAULT_THEME.chrome)
  })
  it('merges override over defaults (cli)', () => {
    const merged = resolveTheme('cli', { text: '#00ff41', bg: '#000000' })
    expect(merged.bg).toBe('#000000')
    expect(merged.text).toBe('#00ff41')
    expect(merged.border).toBe(CLI_DEFAULT_THEME.border)
    expect(merged.chrome).toBe(CLI_DEFAULT_THEME.chrome)
  })
})

describe('default themes + presets', () => {
  it('both default themes have all 4 fields', () => {
    for (const t of [CHATROOM_DEFAULT_THEME, CLI_DEFAULT_THEME]) {
      expect(t.chrome).toBeTruthy()
      expect(t.border).toBeTruthy()
      expect(t.bg).toBeTruthy()
      expect(t.text).toBeTruthy()
    }
  })
  it('preset arrays have expected sizes + first is default', () => {
    expect(CHATROOM_PRESETS).toHaveLength(8)
    expect(CLI_PRESETS).toHaveLength(4)
    expect(CHATROOM_PRESETS[0].id).toBe('default')
    expect(CLI_PRESETS[0].id).toBe('default')
  })
  it('every preset has id, emoji, label, theme', () => {
    for (const p of [...CHATROOM_PRESETS, ...CLI_PRESETS]) {
      expect(p.id).toBeTruthy()
      expect(p.emoji).toBeTruthy()
      expect(p.label).toBeTruthy()
      expect(p.theme).toBeTruthy()
    }
  })
  it('preset ids are unique within each array', () => {
    const chatIds = CHATROOM_PRESETS.map(p => p.id)
    const cliIds  = CLI_PRESETS.map(p => p.id)
    expect(new Set(chatIds).size).toBe(chatIds.length)
    expect(new Set(cliIds).size).toBe(cliIds.length)
  })
})
