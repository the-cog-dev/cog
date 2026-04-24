import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  useTrollboxStyle,
  CHATROOM_PRESETS,
  CLI_PRESETS,
} from './useTrollboxStyle'

export interface TrollboxThemeMenuProps {
  event: React.MouseEvent
  closeMenu: () => void
}

export function TrollboxThemeMenu({
  event,
  closeMenu,
}: TrollboxThemeMenuProps): React.ReactElement | null {
  const { style, theme, setStyle, setTheme, setThemeWhole, resetTheme } = useTrollboxStyle()
  const menuRef = useRef<HTMLDivElement | null>(null)

  // Close on outside click + Escape.
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeMenu()
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu()
    }
    // Defer binding a tick so the click that opened us doesn't immediately close us.
    const t = setTimeout(() => {
      document.addEventListener('mousedown', onDocClick)
      document.addEventListener('keydown', onKey)
    }, 0)
    return () => {
      clearTimeout(t)
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [closeMenu])

  // Clamp menu position to viewport (approx 280x440 menu size).
  const MENU_W = 280
  const MENU_H = 440
  const left = Math.min(event.clientX, window.innerWidth - MENU_W - 8)
  const top = Math.min(event.clientY, window.innerHeight - MENU_H - 8)

  const presets = style === 'cli' ? CLI_PRESETS : CHATROOM_PRESETS

  const content = (
    <div
      ref={menuRef}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation() }}
      style={{
        position: 'fixed',
        left,
        top,
        width: MENU_W,
        background: '#1a1a1a',
        color: '#e0e0e0',
        border: '1px solid #333',
        padding: 12,
        zIndex: 10_000,
        fontFamily: 'Consolas, "SFMono-Regular", Menlo, Monaco, monospace',
        fontSize: 12,
        boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
      }}
    >
      {/* Style toggle */}
      <div style={{ color: '#888', marginBottom: 4 }}>style</div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        <StyleButton active={style === 'chatroom'} onClick={() => setStyle('chatroom')}>
          💬 Chatroom
        </StyleButton>
        <StyleButton active={style === 'cli'} onClick={() => setStyle('cli')}>
          💻 CLI
        </StyleButton>
      </div>

      <div style={{ borderTop: '1px solid #2a2a2a', margin: '4px 0 10px' }} />

      {/* Presets */}
      <div style={{ color: '#888', marginBottom: 4 }}>presets</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 12 }}>
        {presets.map(p => (
          <button
            key={p.id}
            onClick={() => setThemeWhole(p.theme)}
            title={p.label}
            style={presetButtonStyle}
          >
            {p.emoji}
          </button>
        ))}
      </div>

      <div style={{ borderTop: '1px solid #2a2a2a', margin: '4px 0 10px' }} />

      {/* Color pickers */}
      <div style={{ color: '#888', marginBottom: 4 }}>colors</div>
      <ColorRow label="bg"     value={theme.bg}     onChange={(v) => setTheme({ bg: v })} />
      <ColorRow label="text"   value={theme.text}   onChange={(v) => setTheme({ text: v })} />
      <ColorRow label="border" value={theme.border} onChange={(v) => setTheme({ border: v })} />
      <ColorRow label="chrome" value={theme.chrome} onChange={(v) => setTheme({ chrome: v })} />

      <div style={{ borderTop: '1px solid #2a2a2a', margin: '8px 0' }} />

      {/* Reset */}
      <button
        onClick={() => { resetTheme(); closeMenu() }}
        style={{
          width: '100%',
          background: '#2a2a2a',
          color: '#e0e0e0',
          border: '1px solid #444',
          padding: '6px 8px',
          cursor: 'pointer',
          fontFamily: 'inherit',
          fontSize: 12,
        }}
      >
        Reset {style} theme to default
      </button>
    </div>
  )

  return createPortal(content, document.body)
}

function StyleButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): React.ReactElement {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        background: active ? '#2a3a55' : '#1a1a1a',
        color: active ? '#e0e0e0' : '#888',
        border: `1px solid ${active ? '#445' : '#333'}`,
        padding: '6px 8px',
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontSize: 12,
      }}
    >
      {children}
    </button>
  )
}

const presetButtonStyle: React.CSSProperties = {
  width: 32,
  height: 32,
  background: '#0d0d0d',
  color: '#e0e0e0',
  border: '1px solid #333',
  cursor: 'pointer',
  fontSize: 18,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
}

function ColorRow({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (hex: string) => void
}): React.ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
      <span style={{ width: 50, color: '#888' }}>{label}:</span>
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: 30,
          height: 22,
          border: '1px solid #333',
          padding: 0,
          background: 'transparent',
          cursor: 'pointer',
        }}
      />
      <span style={{ color: '#666', fontSize: 11, fontFamily: 'inherit' }}>{value}</span>
    </div>
  )
}
