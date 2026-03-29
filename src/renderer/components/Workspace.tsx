import React, { useRef, useCallback, useState, useEffect } from 'react'
import { FloatingWindow } from './FloatingWindow'
import { TerminalWindow } from './TerminalWindow'
import { ZoomControls } from './ZoomControls'
import type { WindowState } from '../hooks/useWindowManager'
import type { AgentState } from '../../shared/types'

const STATUS_COLORS: Record<string, string> = {
  idle: '#888',
  active: '#4caf50',
  working: '#ffc107',
  disconnected: '#f44336'
}

interface WorkspaceProps {
  windows: WindowState[]
  agents: AgentState[]
  zoom: number
  pan: { x: number; y: number }
  onSetZoom: (level: number) => void
  onSetPan: (x: number, y: number) => void
  onZoomToFit: (viewportWidth: number, viewportHeight: number) => void
  onFocusWindow: (id: string) => void
  onMinimizeWindow: (id: string) => void
  onCloseWindow: (id: string) => void
  onDragStop: (id: string, x: number, y: number) => void
  onResizeStop: (id: string, x: number, y: number, width: number, height: number) => void
}

export function Workspace({
  windows,
  agents,
  zoom,
  pan,
  onSetZoom,
  onSetPan,
  onZoomToFit,
  onFocusWindow,
  onMinimizeWindow,
  onCloseWindow,
  onDragStop,
  onResizeStop
}: WorkspaceProps): React.ReactElement {
  const viewportRef = useRef<HTMLDivElement>(null)
  const [isPanning, setIsPanning] = useState(false)
  const panStartRef = useRef({ x: 0, y: 0 })
  const [transitionEnabled, setTransitionEnabled] = useState(false)
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [maximizedId, setMaximizedId] = useState<string | null>(null)

  // Clean up maximizedId if the window is removed
  useEffect(() => {
    if (maximizedId && !windows.find(w => w.id === maximizedId)) {
      setMaximizedId(null)
    }
  }, [windows, maximizedId])

  // Use refs for zoom/pan so the native wheel handler stays current
  const zoomRef = useRef(zoom)
  const panRef = useRef(pan)
  zoomRef.current = zoom
  panRef.current = pan

  // Native wheel handler (passive: false so preventDefault works)
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return

    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        // Ctrl+Scroll = zoom centered on cursor
        e.preventDefault()

        setTransitionEnabled(false)
        if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current)
        scrollTimeoutRef.current = setTimeout(() => setTransitionEnabled(true), 150)

        const rect = el.getBoundingClientRect()
        const screenX = e.clientX - rect.left
        const screenY = e.clientY - rect.top

        const oldZoom = zoomRef.current
        const delta = e.deltaY > 0 ? -0.1 : 0.1
        const newZoom = Math.min(2.0, Math.max(0.25, oldZoom + delta))

        const p = panRef.current
        const canvasX = (screenX - p.x) / oldZoom
        const canvasY = (screenY - p.y) / oldZoom
        const newPanX = screenX - canvasX * newZoom
        const newPanY = screenY - canvasY * newZoom

        onSetZoom(newZoom)
        onSetPan(newPanX, newPanY)
      } else {
        // Bare scroll on empty canvas = pan vertically
        // Only pan if the event target is the viewport or canvas (not a terminal)
        const target = e.target as HTMLElement
        if (target === el || target.closest('[data-canvas]')) {
          e.preventDefault()
          const p = panRef.current
          onSetPan(p.x - e.deltaX, p.y - e.deltaY)
        }
      }
    }

    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [onSetZoom, onSetPan])

  // Middle-click drag = pan
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 1) {
      e.preventDefault()
      setIsPanning(true)
      panStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y }
    }
  }, [pan])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning) return
    onSetPan(e.clientX - panStartRef.current.x, e.clientY - panStartRef.current.y)
  }, [isPanning, onSetPan])

  const handleMouseUp = useCallback(() => {
    setIsPanning(false)
  }, [])

  const handleMaximize = useCallback((id: string) => {
    setMaximizedId(prev => prev === id ? null : id)
  }, [])

  const handleFitAll = useCallback(() => {
    if (!viewportRef.current) return
    const rect = viewportRef.current.getBoundingClientRect()
    setTransitionEnabled(true)
    onZoomToFit(rect.width, rect.height)
    setTimeout(() => setTransitionEnabled(false), 300)
  }, [onZoomToFit])

  const handleReset = useCallback(() => {
    setTransitionEnabled(true)
    onSetZoom(1.0)
    onSetPan(0, 0)
    setTimeout(() => setTransitionEnabled(false), 300)
  }, [onSetZoom, onSetPan])

  return (
    <div
      ref={viewportRef}
      style={{
        flex: 1,
        position: 'relative',
        overflow: 'hidden',
        backgroundColor: '#111',
        cursor: isPanning ? 'grabbing' : 'default'
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      {/* Canvas — transformed by zoom/pan */}
      <div
        data-canvas
        style={{
          transformOrigin: '0 0',
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transition: transitionEnabled ? 'transform 0.2s ease' : 'none',
          position: 'absolute',
          top: 0,
          left: 0
        }}
      >
        {windows.map(win => {
          const agent = agents.find(a => a.id === win.id)
          const statusColor = agent ? STATUS_COLORS[agent.status] ?? '#888' : undefined
          const title = agent
            ? `${agent.name} (${agent.cli}) \u00B7 ${agent.role}`
            : win.title

          return (
            <FloatingWindow
              key={win.id}
              id={win.id}
              title={title}
              statusColor={statusColor}
              x={win.x}
              y={win.y}
              width={win.width}
              height={win.height}
              zoom={zoom}
              zIndex={win.zIndex}
              minimized={win.minimized}
              maximized={maximizedId === win.id}
              viewportRef={viewportRef}
              onFocus={() => onFocusWindow(win.id)}
              onMinimize={() => onMinimizeWindow(win.id)}
              onMaximize={() => handleMaximize(win.id)}
              onClose={() => onCloseWindow(win.id)}
              onDragStop={(nx, ny) => onDragStop(win.id, nx, ny)}
              onResizeStop={(nx, ny, w, h) => onResizeStop(win.id, nx, ny, w, h)}
            >
              <TerminalWindow agentId={win.id} />
            </FloatingWindow>
          )
        })}
      </div>

      {/* Zoom controls — outside canvas transform */}
      <ZoomControls
        zoom={zoom}
        onZoomIn={() => onSetZoom(Math.min(2.0, zoom + 0.1))}
        onZoomOut={() => onSetZoom(Math.max(0.25, zoom - 0.1))}
        onReset={handleReset}
        onFitAll={handleFitAll}
      />
    </div>
  )
}
