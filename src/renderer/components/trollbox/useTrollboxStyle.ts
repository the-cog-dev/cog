import { useCallback, useEffect, useState } from 'react'

export type TrollboxStyle = 'chatroom' | 'cli'

// Same 4-field shape as AgentTheme, intentionally.
// - chatroom: `chrome` applies to the darker inset background for the input
//   area and code blocks (default #0d0d0d against the #1a1a1a main bg).
// - cli: `chrome` is unused in v1.
export interface TrollboxTheme {
  chrome?: string
  border?: string
  bg?: string
  text?: string
}

export const CHATROOM_DEFAULT_THEME: Required<TrollboxTheme> = {
  chrome: '#0d0d0d',
  border: '#2a2a2a',
  bg:     '#1a1a1a',
  text:   '#e0e0e0',
}

export const CLI_DEFAULT_THEME: Required<TrollboxTheme> = {
  chrome: '#1a1a1a',
  border: '#2a2a2a',
  bg:     '#0d0d0d',
  text:   '#e0e0e0',
}

const DEFAULTS: Record<TrollboxStyle, Required<TrollboxTheme>> = {
  chatroom: CHATROOM_DEFAULT_THEME,
  cli:      CLI_DEFAULT_THEME,
}

// 8 emoji presets for chatroom mode; matches agent theme palette vibes.
export const CHATROOM_PRESETS: Array<{ id: string; emoji: string; label: string; theme: TrollboxTheme }> = [
  { id: 'default',   emoji: '\u26AA', label: 'Default',   theme: CHATROOM_DEFAULT_THEME },
  { id: 'sunshine',  emoji: '\u2600\uFE0F', label: 'Sunshine',  theme: { bg: '#2a2410', text: '#fff4c2', border: '#5c4a1a', chrome: '#1a1500' } },
  { id: 'ocean',     emoji: '\u{1F30A}', label: 'Ocean',     theme: { bg: '#0a1e2a', text: '#c2e0ff', border: '#1a3a5c', chrome: '#001220' } },
  { id: 'crimson',   emoji: '\u{1F534}', label: 'Crimson',   theme: { bg: '#2a0a10', text: '#ffc2c8', border: '#5c1a24', chrome: '#200008' } },
  { id: 'forest',    emoji: '\u{1F332}', label: 'Forest',    theme: { bg: '#0d2010', text: '#c8f0cc', border: '#1f4a24', chrome: '#001a04' } },
  { id: 'royal',     emoji: '\u{1F451}', label: 'Royal',     theme: { bg: '#180a2a', text: '#d8c2ff', border: '#3a1a5c', chrome: '#100020' } },
  { id: 'dusk',      emoji: '\u{1F319}', label: 'Dusk',      theme: { bg: '#1a0a2a', text: '#e0c2ff', border: '#3a1a5c', chrome: '#100020' } },
  { id: 'bubblegum', emoji: '\u{1F36C}', label: 'Bubblegum', theme: { bg: '#2a0a20', text: '#ffc2e8', border: '#5c1a48', chrome: '#200010' } },
]

// 4 CLI presets with terminal-vibe palettes.
export const CLI_PRESETS: Array<{ id: string; emoji: string; label: string; theme: TrollboxTheme }> = [
  { id: 'default',   emoji: '\u26AA', label: 'Default',   theme: CLI_DEFAULT_THEME },
  { id: 'phosphor',  emoji: '\u{1F49A}', label: 'Phosphor',  theme: { bg: '#000000', text: '#00ff41', border: '#003b14', chrome: '#001a08' } },
  { id: 'amber',     emoji: '\u{1F7E0}', label: 'Amber',     theme: { bg: '#000000', text: '#ffb000', border: '#3b2a00', chrome: '#1a1200' } },
  { id: 'cyberdeck', emoji: '\u{1F338}', label: 'Cyberdeck', theme: { bg: '#0a0a1f', text: '#ff00c8', border: '#001e3b', chrome: '#0f1030' } },
]

const LS = {
  style:           'trollbox:style',
  themeChatroom:   'trollbox:theme:chatroom',
  themeCli:        'trollbox:theme:cli',
}

// ---- Pure helpers (directly testable without React) ----

export function readStyle(): TrollboxStyle {
  try {
    const v = localStorage.getItem(LS.style)
    return v === 'cli' ? 'cli' : 'chatroom'
  } catch {
    return 'chatroom'
  }
}

export function writeStyle(style: TrollboxStyle): void {
  try { localStorage.setItem(LS.style, style) } catch { /* ignore */ }
}

export function readTheme(style: TrollboxStyle): TrollboxTheme {
  const key = style === 'cli' ? LS.themeCli : LS.themeChatroom
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const out: TrollboxTheme = {}
    if (typeof parsed.chrome === 'string') out.chrome = parsed.chrome
    if (typeof parsed.border === 'string') out.border = parsed.border
    if (typeof parsed.bg === 'string')     out.bg     = parsed.bg
    if (typeof parsed.text === 'string')   out.text   = parsed.text
    return out
  } catch {
    return {}
  }
}

export function writeTheme(style: TrollboxStyle, theme: TrollboxTheme): void {
  const key = style === 'cli' ? LS.themeCli : LS.themeChatroom
  try { localStorage.setItem(key, JSON.stringify(theme)) } catch { /* ignore */ }
}

export function removeTheme(style: TrollboxStyle): void {
  const key = style === 'cli' ? LS.themeCli : LS.themeChatroom
  try { localStorage.removeItem(key) } catch { /* ignore */ }
}

export function resolveTheme(style: TrollboxStyle, override: TrollboxTheme): Required<TrollboxTheme> {
  return { ...DEFAULTS[style], ...override }
}

// ---- Module-level store (shared across all useTrollboxStyle instances) ----
//
// The panel and the theme menu both call useTrollboxStyle(). If each call
// owned its own React state, clicking a button in the menu wouldn't update
// the panel. A single module-level store + pub/sub lets every hook instance
// observe the same state.

interface Store {
  style: TrollboxStyle
  themes: Record<TrollboxStyle, TrollboxTheme>
}

const store: Store = {
  style: readStyle(),
  themes: {
    chatroom: readTheme('chatroom'),
    cli:      readTheme('cli'),
  },
}

const subscribers = new Set<() => void>()

function notify(): void {
  for (const cb of subscribers) cb()
}

function storeSetStyle(s: TrollboxStyle): void {
  if (store.style === s) return
  store.style = s
  writeStyle(s)
  notify()
}

function storeSetTheme(patch: TrollboxTheme): void {
  const current = store.themes[store.style]
  const next: TrollboxTheme = { ...current, ...patch }
  store.themes = { ...store.themes, [store.style]: next }
  writeTheme(store.style, next)
  notify()
}

function storeSetThemeWhole(theme: TrollboxTheme): void {
  store.themes = { ...store.themes, [store.style]: theme }
  writeTheme(store.style, theme)
  notify()
}

function storeResetTheme(): void {
  store.themes = { ...store.themes, [store.style]: {} }
  removeTheme(store.style)
  notify()
}

// ---- React hook (observes the module store) ----

export interface UseTrollboxStyleResult {
  style: TrollboxStyle
  theme: Required<TrollboxTheme>                 // resolved (defaults merged)
  setStyle: (s: TrollboxStyle) => void
  setTheme: (patch: TrollboxTheme) => void        // merges into current style
  setThemeWhole: (theme: TrollboxTheme) => void   // replaces whole theme (preset)
  resetTheme: () => void                          // wipes current style back to default
}

export function useTrollboxStyle(): UseTrollboxStyleResult {
  // Force a re-render when the shared store changes.
  const [, setTick] = useState(0)
  useEffect(() => {
    const onChange = () => setTick(t => t + 1)
    subscribers.add(onChange)
    return () => { subscribers.delete(onChange) }
  }, [])

  const setStyle        = useCallback((s: TrollboxStyle) => { storeSetStyle(s) }, [])
  const setTheme        = useCallback((patch: TrollboxTheme) => { storeSetTheme(patch) }, [])
  const setThemeWhole   = useCallback((theme: TrollboxTheme) => { storeSetThemeWhole(theme) }, [])
  const resetTheme      = useCallback(() => { storeResetTheme() }, [])

  const resolved = resolveTheme(store.style, store.themes[store.style])

  return {
    style: store.style,
    theme: resolved,
    setStyle,
    setTheme,
    setThemeWhole,
    resetTheme,
  }
}

// Exposed for tests — resets the module store so each test starts from a
// clean slate. Do NOT use from production code.
export function __resetStoreForTests(): void {
  store.style = readStyle()
  store.themes = {
    chatroom: readTheme('chatroom'),
    cli:      readTheme('cli'),
  }
}
