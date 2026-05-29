import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { BoardElement, BoardPage } from '../../shared/types'
import { BoardElementView } from './BoardElementView'

// Exported so callers/toolbar can reference the tool state shape.
export interface ToolState {
  kind: 'select' | 'note' | 'text'
}

const DEFAULT_TOOL: ToolState = { kind: 'select' }

interface BoardPageCanvasProps {
  page: BoardPage
  tool?: ToolState
  onChange: (p: BoardPage) => void
}

export function BoardPageCanvas({
  page,
  tool = DEFAULT_TOOL,
  onChange,
}: BoardPageCanvasProps): React.ReactElement {
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Refs so the native wheel handler always sees current values
  const zoomRef = useRef(zoom)
  const panRef = useRef(pan)
  zoomRef.current = zoom
  panRef.current = pan

  // Pan-drag state (left-button drag on empty canvas in select mode)
  const isPanningRef = useRef(false)
  const panStartRef = useRef({ mouseX: 0, mouseY: 0, panX: 0, panY: 0 })

  const viewportRef = useRef<HTMLDivElement>(null)

  // ── Native wheel listener (passive:false so we can preventDefault) ──────────
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return

    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault()

        const rect = el.getBoundingClientRect()
        const screenX = e.clientX - rect.left
        const screenY = e.clientY - rect.top

        const oldZoom = zoomRef.current
        const delta = e.deltaY > 0 ? -0.1 : 0.1
        const newZoom = Math.min(4.0, Math.max(0.1, oldZoom + delta))

        const p = panRef.current
        const canvasX = (screenX - p.x) / oldZoom
        const canvasY = (screenY - p.y) / oldZoom
        const newPanX = screenX - canvasX * newZoom
        const newPanY = screenY - canvasY * newZoom

        setZoom(newZoom)
        setPan({ x: newPanX, y: newPanY })
      } else {
        // Plain scroll → pan
        const target = e.target as HTMLElement
        if (target === el || target.closest('[data-board-canvas]')) {
          e.preventDefault()
          const p = panRef.current
          setPan({ x: p.x - e.deltaX, y: p.y - e.deltaY })
        }
      }
    }

    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [])

  // ── Canvas background mouse handlers (pan drag + element creation) ──────────
  const handleCanvasMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Only fire when clicking the background itself, not an element
      if ((e.target as HTMLElement).closest('[data-board-element]')) return

      if (tool.kind === 'select') {
        // Start panning via left-button drag
        if (e.button === 0) {
          e.preventDefault()
          isPanningRef.current = true
          panStartRef.current = {
            mouseX: e.clientX,
            mouseY: e.clientY,
            panX: panRef.current.x,
            panY: panRef.current.y,
          }
          setSelectedId(null)
        }
      }
    },
    [tool.kind]
  )

  const handleCanvasMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!isPanningRef.current) return
    const s = panStartRef.current
    setPan({
      x: s.panX + (e.clientX - s.mouseX),
      y: s.panY + (e.clientY - s.mouseY),
    })
  }, [])

  const handleCanvasMouseUp = useCallback(() => {
    isPanningRef.current = false
  }, [])

  // Click on background to create elements (note / text)
  const handleCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if ((e.target as HTMLElement).closest('[data-board-element]')) return
      if (tool.kind === 'select') return

      const rect = viewportRef.current?.getBoundingClientRect()
      if (!rect) return

      const screenX = e.clientX - rect.left
      const screenY = e.clientY - rect.top
      const canvasX = (screenX - pan.x) / zoom
      const canvasY = (screenY - pan.y) / zoom

      const maxZ = page.elements.reduce((acc, el) => Math.max(acc, el.z), 0)
      const id = crypto.randomUUID()

      let newEl: BoardElement
      if (tool.kind === 'note') {
        newEl = {
          type: 'note',
          id,
          x: canvasX - 80,
          y: canvasY - 60,
          w: 160,
          h: 120,
          text: '',
          color: '#ffd400',
          z: maxZ + 1,
        }
      } else {
        newEl = {
          type: 'text',
          id,
          x: canvasX - 100,
          y: canvasY - 20,
          w: 200,
          h: 40,
          text: 'Text',
          fontSize: 16,
          z: maxZ + 1,
        }
      }

      onChange({ ...page, elements: [...page.elements, newEl] })
      setSelectedId(id)
    },
    [tool, pan, zoom, page, onChange]
  )

  // ── Element callbacks ────────────────────────────────────────────────────────
  const handleElementChange = useCallback(
    (updated: BoardElement) => {
      onChange({
        ...page,
        elements: page.elements.map((el) => (el.id === updated.id ? updated : el)),
      })
    },
    [page, onChange]
  )

  const handleElementDelete = useCallback(
    (id: string) => {
      onChange({ ...page, elements: page.elements.filter((el) => el.id !== id) })
      setSelectedId(null)
    },
    [page, onChange]
  )

  const isPanning = isPanningRef.current

  return (
    <div
      ref={viewportRef}
      style={{
        position: 'absolute',
        inset: 0,
        top: 44, // below the board navigator bar
        overflow: 'hidden',
        background: '#101010',
        cursor: isPanning ? 'grabbing' : tool.kind === 'select' ? 'default' : 'crosshair',
        userSelect: 'none',
      }}
      onMouseDown={handleCanvasMouseDown}
      onMouseMove={handleCanvasMouseMove}
      onMouseUp={handleCanvasMouseUp}
      onMouseLeave={handleCanvasMouseUp}
      onClick={handleCanvasClick}
    >
      {/* Transformed canvas — zoom + pan applied here */}
      <div
        data-board-canvas
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          transformOrigin: '0 0',
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
        }}
      >
        {page.elements.map((el) => (
          <div key={el.id} data-board-element>
            <BoardElementView
              element={el}
              zoom={zoom}
              selected={selectedId === el.id}
              onSelect={() => setSelectedId(el.id)}
              onChange={handleElementChange}
              onDelete={() => handleElementDelete(el.id)}
            />
          </div>
        ))}
      </div>

      {/* Zoom indicator — outside the transform */}
      <div
        style={{
          position: 'absolute',
          bottom: 12,
          right: 16,
          fontSize: 11,
          color: '#555',
          fontFamily: 'monospace',
          pointerEvents: 'none',
        }}
      >
        {Math.round(zoom * 100)}%
      </div>
    </div>
  )
}
