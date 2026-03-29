import React, { useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Rnd } from 'react-rnd'

interface FloatingWindowProps {
  id: string
  title: string
  statusColor?: string
  x: number
  y: number
  width: number
  height: number
  zoom: number
  zIndex: number
  minimized: boolean
  maximized: boolean
  viewportRef?: React.RefObject<HTMLDivElement | null>
  onFocus: () => void
  onMinimize: () => void
  onMaximize: () => void
  onClose: () => void
  onDragStop: (x: number, y: number) => void
  onResizeStop: (x: number, y: number, width: number, height: number) => void
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
  zIndex,
  minimized,
  maximized,
  viewportRef,
  onFocus,
  onMinimize,
  onMaximize,
  onClose,
  onDragStop,
  onResizeStop,
  children
}: FloatingWindowProps): React.ReactElement | null {
  if (minimized) return null

  // Rnd lives inside the CSS-transformed canvas. Positions are in canvas space.
  // CSS scale(zoom) handles visual scaling. No manual * zoom needed.
  const handleDragStop = useCallback((_e: any, data: { x: number; y: number }) => {
    onDragStop(data.x, data.y)
  }, [onDragStop])

  const handleResizeStop = useCallback((_e: any, _dir: any, ref: HTMLElement, _delta: any, position: { x: number; y: number }) => {
    onResizeStop(
      position.x,
      position.y,
      parseInt(ref.style.width),
      parseInt(ref.style.height)
    )
  }, [onResizeStop])

  // Maximized: render via portal into viewport (outside canvas transform)
  if (maximized && viewportRef?.current) {
    return createPortal(
      <div style={{
        position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
        zIndex: 99998, display: 'flex', flexDirection: 'column',
        ...windowStyle
      }}>
        <div className="window-titlebar" style={titleBarStyle} onDoubleClick={onMaximize}>
          {statusColor && <div style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: statusColor, marginRight: 8 }} />}
          <span style={{ flex: 1, fontSize: '12px', color: '#ccc' }}>{title}</span>
          <button onClick={onMinimize} style={btnStyle}>─</button>
          <button onClick={onMaximize} style={btnStyle}>❐</button>
          <button onClick={onClose} style={{ ...btnStyle, color: '#e55' }}>✕</button>
        </div>
        <div style={{ flex: 1, overflow: 'hidden' }}>{children}</div>
      </div>,
      viewportRef.current
    )
  }

  return (
    <Rnd
      position={{ x, y }}
      size={{ width, height }}
      style={{ ...windowStyle, zIndex }}
      dragHandleClassName="window-titlebar"
      minWidth={300}
      minHeight={200}
      onMouseDown={onFocus}
      onDragStop={handleDragStop}
      onResizeStop={handleResizeStop}
    >
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
        <div className="window-titlebar" style={titleBarStyle} onDoubleClick={onMaximize}>
          {statusColor && <div style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: statusColor, marginRight: 8 }} />}
          <span style={{ flex: 1, fontSize: '12px', color: '#ccc' }}>{title}</span>
          <button onClick={onMinimize} style={btnStyle}>─</button>
          <button onClick={onMaximize} style={btnStyle}>□</button>
          <button onClick={onClose} style={{ ...btnStyle, color: '#e55' }}>✕</button>
        </div>
        <div style={{ flex: 1, overflow: 'hidden' }}>{children}</div>
      </div>
    </Rnd>
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
