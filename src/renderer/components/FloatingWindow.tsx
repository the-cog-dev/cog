import React, { useCallback, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Rnd, type DraggableData, type RndDragEvent } from 'react-rnd'
import { getSnapZone, getWindowSnap, type SnapBounds, type SnapZoneInfo, type WindowBounds } from '../hooks/useSnapZones'
import type { AgentTheme } from '../../shared/types'
import { THEME_PRESETS, resolveTheme } from '../themes'

interface FloatingWindowProps {
  id: string
  title: string
  statusColor?: string
  x: number
  y: number
  width: number
  height: number
  zoom: number
  pan: { x: number; y: number }
  zIndex: number
  minimized: boolean
  maximized: boolean
  workspaceWidth: number
  workspaceHeight: number
  otherWindows: WindowBounds[]
  restoreBounds?: SnapBounds | null
  viewportRef?: React.RefObject<HTMLDivElement | null>
  onFocus: () => void
  onMinimize: () => void
  onMaximize: () => void
  onClose: () => void
  onDragStop: (x: number, y: number) => void
  onResizeStop: (x: number, y: number, width: number, height: number) => void
  onSnapPreviewChange: (info: SnapZoneInfo | null) => void
  onSnap: (bounds: SnapBounds, restoreBounds: SnapBounds) => void
  isAgent?: boolean
  groupColor?: string
  onLinkDragStart?: (e: React.MouseEvent) => void
  theme?: AgentTheme
  agentId?: string
  /**
   * Optional custom context menu for the window's title bar. When provided,
   * right-clicking the title bar opens THIS menu instead of the default agent
   * ThemeMenu. Panel windows (like Trollbox) use this hook to render their
   * own panel-specific theme menus. Agent windows should NOT pass this prop.
   *
   * Returns null to suppress any menu for a particular event.
   */
  onTitleBarContextMenu?: (
    event: React.MouseEvent,
    closeMenu: () => void
  ) => React.ReactNode | null
  onEditAgent?: (agentId: string) => void
  children: React.ReactNode
}

export function FloatingWindow({
  id,
  title,
  statusColor,
  x,
  y,
  width,
  height,
  zoom,
  pan,
  zIndex,
  minimized,
  maximized,
  workspaceWidth,
  workspaceHeight,
  otherWindows,
  restoreBounds,
  viewportRef,
  onFocus,
  onMinimize,
  onMaximize,
  onClose,
  onDragStop,
  onResizeStop,
  onSnapPreviewChange,
  onSnap,
  isAgent,
  groupColor,
  onLinkDragStart,
  theme,
  agentId,
  onTitleBarContextMenu,
  onEditAgent,
  children
}: FloatingWindowProps): React.ReactElement | null {
  const [dragSizeOverride, setDragSizeOverride] = useState<{ width: number; height: number } | null>(null)
  const [themeMenu, setThemeMenu] = useState<{ x: number; y: number } | null>(null)
  const [customMenu, setCustomMenu] = useState<React.ReactNode | null>(null)
  const resolvedTheme = resolveTheme(theme)

  const openThemeMenu = useCallback((e: React.MouseEvent) => {
    if (!isAgent || !agentId) return
    e.preventDefault()
    e.stopPropagation()
    setThemeMenu({ x: e.clientX, y: e.clientY })
  }, [isAgent, agentId])

  const openContextMenu = useCallback((e: React.MouseEvent) => {
    if (onTitleBarContextMenu) {
      e.preventDefault()
      e.stopPropagation()
      const closeMenu = () => setCustomMenu(null)
      const rendered = onTitleBarContextMenu(e, closeMenu)
      if (rendered !== null) {
        setCustomMenu(rendered)
      }
      return
    }
    openThemeMenu(e)
  }, [onTitleBarContextMenu, openThemeMenu])

  const applyPreset = useCallback(async (presetTheme: AgentTheme | null) => {
    if (!agentId) return
    setThemeMenu(null)
    await window.electronAPI.setAgentTheme(agentId, presetTheme)
  }, [agentId])

  const updateThemeField = useCallback(async (field: keyof AgentTheme, value: string) => {
    if (!agentId) return
    const next: AgentTheme = { ...(theme ?? {}), [field]: value }
    await window.electronAPI.setAgentTheme(agentId, next)
  }, [agentId, theme])

  // Rnd lives inside the CSS-transformed canvas. Positions are in canvas space.
  // CSS scale(zoom) handles visual scaling. No manual * zoom needed.
  const displayWidth = dragSizeOverride?.width ?? width
  const displayHeight = dragSizeOverride?.height ?? height

  const getSnapInfo = useCallback((event: RndDragEvent): SnapZoneInfo | null => {
    if (!viewportRef?.current) return null

    const point = 'touches' in event
      ? event.touches[0] ?? event.changedTouches[0]
      : event
    if (!point) return null

    const rect = viewportRef.current.getBoundingClientRect()
    const mouseX = point.clientX - rect.left
    const mouseY = point.clientY - rect.top
    return getSnapZone(mouseX, mouseY, workspaceWidth, workspaceHeight)
  }, [viewportRef, workspaceWidth, workspaceHeight])

  const activeRestoreBounds = useMemo(() => {
    if (restoreBounds) return restoreBounds
    return { x, y, width: displayWidth, height: displayHeight }
  }, [restoreBounds, x, y, displayWidth, displayHeight])

  const handleDragStart = useCallback(() => {
    if (restoreBounds) {
      setDragSizeOverride({ width: restoreBounds.width, height: restoreBounds.height })
    }
  }, [restoreBounds])

  const handleDrag = useCallback((e: RndDragEvent, data: DraggableData) => {
    // Edge snap takes priority
    const edgeSnap = getSnapInfo(e)
    if (edgeSnap) {
      onSnapPreviewChange(edgeSnap)
      return
    }

    // Window-to-window snap (canvas space)
    const dragW = dragSizeOverride?.width ?? width
    const dragH = dragSizeOverride?.height ?? height
    const winSnap = getWindowSnap(data.x, data.y, dragW, dragH, otherWindows, 20 / zoom)
    if (winSnap) {
      onSnapPreviewChange({
        zone: winSnap.zone,
        bounds: {
          x: winSnap.canvasBounds.x * zoom + pan.x,
          y: winSnap.canvasBounds.y * zoom + pan.y,
          width: winSnap.canvasBounds.width * zoom,
          height: winSnap.canvasBounds.height * zoom
        }
      })
      return
    }

    onSnapPreviewChange(null)
  }, [dragSizeOverride, getSnapInfo, onSnapPreviewChange, otherWindows, pan.x, pan.y, width, height, zoom])

  const handleDragStop = useCallback((e: RndDragEvent, data: DraggableData) => {
    onSnapPreviewChange(null)

    // Edge snap takes priority
    const edgeSnap = getSnapInfo(e)
    if (edgeSnap) {
      setDragSizeOverride(null)
      onSnap({
        x: (edgeSnap.bounds.x - pan.x) / zoom,
        y: (edgeSnap.bounds.y - pan.y) / zoom,
        width: edgeSnap.bounds.width / zoom,
        height: edgeSnap.bounds.height / zoom
      }, activeRestoreBounds)
      return
    }

    // Window-to-window snap (already in canvas space)
    const dragW = dragSizeOverride?.width ?? width
    const dragH = dragSizeOverride?.height ?? height
    const winSnap = getWindowSnap(data.x, data.y, dragW, dragH, otherWindows, 20 / zoom)
    if (winSnap) {
      setDragSizeOverride(null)
      onSnap(winSnap.canvasBounds, activeRestoreBounds)
      return
    }

    if (dragSizeOverride) {
      onResizeStop(data.x, data.y, dragSizeOverride.width, dragSizeOverride.height)
      setDragSizeOverride(null)
      return
    }

    onDragStop(data.x, data.y)
  }, [activeRestoreBounds, dragSizeOverride, getSnapInfo, onDragStop, onResizeStop, onSnap, onSnapPreviewChange, otherWindows, pan.x, pan.y, width, height, zoom])

  const handleResizeStop = useCallback((_e: any, _dir: any, ref: HTMLElement, _delta: any, position: { x: number; y: number }) => {
    setDragSizeOverride(null)
    onSnapPreviewChange(null)
    onResizeStop(
      position.x,
      position.y,
      parseInt(ref.style.width),
      parseInt(ref.style.height)
    )
  }, [onResizeStop, onSnapPreviewChange])

  // Minimized: hide but keep hooks alive (React requires consistent hook count)
  if (minimized) return null

  const themedWindowStyle: React.CSSProperties = {
    ...windowStyle,
    border: `1px solid ${resolvedTheme.border}`,
    backgroundColor: resolvedTheme.bg
  }
  const themedTitleBarStyle: React.CSSProperties = {
    ...titleBarStyle,
    backgroundColor: resolvedTheme.chrome
  }

  // Maximized: render via portal into viewport (outside canvas transform)
  if (maximized && viewportRef?.current) {
    return createPortal(
      <div style={{
        position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
        zIndex: 99998, display: 'flex', flexDirection: 'column',
        ...themedWindowStyle
      }}>
        <div
          className="window-titlebar"
          style={themedTitleBarStyle}
          onDoubleClick={onMaximize}
          onContextMenu={openContextMenu}
        >
          {statusColor && <div style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: statusColor, marginRight: 8 }} />}
          <span style={{ flex: 1, fontSize: '12px', color: '#ccc' }}>{title}</span>
          <button onMouseDown={e => e.stopPropagation()} onClick={onMinimize} style={btnStyle}>─</button>
          <button onMouseDown={e => e.stopPropagation()} onClick={onMaximize} style={btnStyle}>❐</button>
          <button onMouseDown={e => e.stopPropagation()} onClick={onClose} style={{ ...btnStyle, color: '#e55' }}>✕</button>
        </div>
        <div style={{ flex: 1, overflow: 'hidden' }}>{children}</div>
        {themeMenu && <ThemeMenu x={themeMenu.x} y={themeMenu.y} theme={theme} onClose={() => setThemeMenu(null)} onApplyPreset={applyPreset} onChangeField={updateThemeField} onEdit={onEditAgent && agentId ? () => onEditAgent(agentId) : undefined} />}
        {customMenu}
      </div>,
      viewportRef.current
    )
  }

  return (
    <Rnd
      position={{ x, y }}
      size={{ width: displayWidth, height: displayHeight }}
      style={{ ...themedWindowStyle, zIndex }}
      dragHandleClassName="window-titlebar"
      minWidth={300}
      minHeight={200}
      scale={zoom}
      onMouseDown={onFocus}
      onDragStart={handleDragStart}
      onDrag={handleDrag}
      onDragStop={handleDragStop}
      onResizeStop={handleResizeStop}
    >
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', position: 'relative' }}>
        <div
          className="window-titlebar"
          style={themedTitleBarStyle}
          onDoubleClick={onMaximize}
          onContextMenu={openContextMenu}
        >
          {statusColor && <div style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: statusColor, marginRight: 8 }} />}
          <span style={{ flex: 1, fontSize: '12px', color: '#ccc' }}>{title}</span>
          <button onMouseDown={e => e.stopPropagation()} onClick={onMinimize} style={btnStyle}>─</button>
          <button onMouseDown={e => e.stopPropagation()} onClick={onMaximize} style={btnStyle}>□</button>
          <button onMouseDown={e => e.stopPropagation()} onClick={onClose} style={{ ...btnStyle, color: '#e55' }}>✕</button>
        </div>
        {isAgent && onLinkDragStart && (
          <div
            onMouseDown={(e) => { e.stopPropagation(); onLinkDragStart(e) }}
            title="Drag to link with another agent"
            style={{
              position: 'absolute',
              left: 8,
              bottom: 8,
              width: 12,
              height: 12,
              borderRadius: '50%',
              backgroundColor: groupColor || '#666',
              border: '2px solid #444',
              cursor: 'crosshair',
              zIndex: 10,
              transition: 'transform 0.15s',
            }}
            onMouseEnter={e => (e.currentTarget.style.transform = 'scale(1.5)')}
            onMouseLeave={e => (e.currentTarget.style.transform = 'scale(1)')}
          />
        )}
        <div style={{ flex: 1, overflow: 'hidden' }}>{children}</div>
      </div>
      {themeMenu && <ThemeMenu x={themeMenu.x} y={themeMenu.y} theme={theme} onClose={() => setThemeMenu(null)} onApplyPreset={applyPreset} onChangeField={updateThemeField} onEdit={onEditAgent && agentId ? () => onEditAgent(agentId) : undefined} />}
      {customMenu}
    </Rnd>
  )
}

interface ThemeMenuProps {
  x: number
  y: number
  theme: AgentTheme | undefined
  onClose: () => void
  onApplyPreset: (theme: AgentTheme | null) => void
  onChangeField: (field: keyof AgentTheme, value: string) => void
  onEdit?: () => void
}

function ThemeMenu({ x, y, theme, onClose, onApplyPreset, onChangeField, onEdit }: ThemeMenuProps) {
  const resolved = resolveTheme(theme)
  const fields: { key: keyof AgentTheme; label: string }[] = [
    { key: 'chrome', label: 'Title Bar' },
    { key: 'border', label: 'Border' },
    { key: 'bg', label: 'Background' },
    { key: 'text', label: 'Text' }
  ]

  return createPortal(
    <>
      <div onClick={onClose} onContextMenu={e => { e.preventDefault(); onClose() }} style={{ position: 'fixed', inset: 0, zIndex: 100000 }} />
      <div style={{
        position: 'fixed', left: x, top: y, zIndex: 100001,
        backgroundColor: '#1a1a1a', border: '1px solid #444', borderRadius: '6px',
        padding: '8px', minWidth: '220px', boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
        fontFamily: 'monospace', color: '#ccc'
      }}>
        <div style={{ fontSize: '10px', color: '#888', textTransform: 'uppercase', marginBottom: '6px', padding: '0 4px' }}>
          Quick Themes
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '4px', marginBottom: '8px' }}>
          {THEME_PRESETS.map(preset => (
            <button
              key={preset.id}
              onClick={() => onApplyPreset(preset.id === 'default' ? null : preset.theme)}
              title={preset.label}
              style={{
                background: preset.theme.chrome,
                border: `1px solid ${preset.theme.border}`,
                borderRadius: '4px',
                color: preset.theme.text,
                cursor: 'pointer',
                fontSize: '14px',
                padding: '8px 0',
                lineHeight: 1
              }}
            >{preset.emoji}</button>
          ))}
        </div>

        <div style={{ fontSize: '10px', color: '#888', textTransform: 'uppercase', marginBottom: '6px', padding: '0 4px' }}>
          Custom Colors
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '8px' }}>
          {fields.map(f => (
            <label key={f.key} style={{
              display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px',
              padding: '4px 6px', backgroundColor: '#222', borderRadius: '3px'
            }}>
              <input
                type="color"
                value={resolved[f.key]}
                onChange={e => onChangeField(f.key, e.target.value)}
                style={{ width: '24px', height: '20px', border: 'none', background: 'transparent', cursor: 'pointer', padding: 0 }}
              />
              <span style={{ flex: 1 }}>{f.label}</span>
              <span style={{ color: '#666', fontSize: '10px' }}>{resolved[f.key]}</span>
            </label>
          ))}
        </div>

        <button
          onClick={() => onApplyPreset(null)}
          style={{
            width: '100%', padding: '6px', fontSize: '11px',
            background: 'transparent', border: '1px solid #444', borderRadius: '4px',
            color: '#888', cursor: 'pointer', fontFamily: 'monospace'
          }}
        >Reset to Default</button>
        {onEdit && (
          <>
            <div style={{ borderTop: '1px solid #333', margin: '8px 0' }} />
            <button
              onClick={() => { onEdit(); onClose() }}
              style={{
                width: '100%', padding: '6px', fontSize: '11px',
                background: 'transparent', border: '1px solid #444', borderRadius: '4px',
                color: '#aaa', cursor: 'pointer', fontFamily: 'monospace'
              }}
            >Edit agent…</button>
          </>
        )}
      </div>
    </>,
    document.body
  )
}

const windowStyle: React.CSSProperties = {
  border: '1px solid #333',
  borderRadius: '6px',
  overflow: 'hidden',
  backgroundColor: '#0d0d0d',
  boxShadow: '0 4px 20px rgba(0,0,0,0.5)'
}

const titleBarStyle: React.CSSProperties = {
  height: '32px',
  backgroundColor: '#1e1e1e',
  display: 'flex',
  alignItems: 'center',
  padding: '0 10px',
  cursor: 'grab',
  userSelect: 'none',
  flexShrink: 0
}

const btnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: '#888',
  cursor: 'pointer',
  padding: '0 6px',
  fontSize: '14px',
  lineHeight: '32px'
}
