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

/** Read a File as a base64 data URL, return the base64 portion and mime ext. */
function readFileAsBase64(file: File): Promise<{ base64: string; ext: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      // e.g. "data:image/png;base64,iVBOR..."
      const match = dataUrl.match(/^data:image\/([a-z0-9+]+);base64,(.+)$/)
      if (!match) { reject(new Error('Could not parse data URL')); return }
      resolve({ ext: match[1] === 'jpeg' ? 'jpg' : match[1], base64: match[2] })
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
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

  // Last known mouse position in screen coords (relative to viewport) for paste placement
  const lastMouseRef = useRef({ x: 0, y: 0 })

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

  // ── Image drop helper ──────────────────────────────────────────────────────
  /** Save an image File to disk and add it as a new element at the given canvas coords. */
  const addImageElement = useCallback(
    async (file: File, canvasX: number, canvasY: number) => {
      try {
        const { base64, ext } = await readFileAsBase64(file)
        const filename = await window.electronAPI.boardSaveImage(base64, ext)
        if (!filename) return
        const maxZ = page.elements.reduce((acc, el) => Math.max(acc, el.z), 0)
        const newEl: BoardElement = {
          type: 'image',
          id: crypto.randomUUID(),
          x: canvasX - 160,
          y: canvasY - 120,
          w: 320,
          h: 240,
          file: filename,
          z: maxZ + 1,
        }
        const updated = { ...page, elements: [...page.elements, newEl] }
        onChange(updated)
        setSelectedId(newEl.id)
      } catch (err) {
        console.error('[BoardPageCanvas] addImageElement failed:', err)
      }
    },
    [page, onChange]
  )

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

  const handleCanvasMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Track position for paste placement
      if (viewportRef.current) {
        const rect = viewportRef.current.getBoundingClientRect()
        lastMouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }
      }
      if (!isPanningRef.current) return
      const s = panStartRef.current
      setPan({
        x: s.panX + (e.clientX - s.mouseX),
        y: s.panY + (e.clientY - s.mouseY),
      })
    },
    []
  )

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

  // ── Paste handler ────────────────────────────────────────────────────────────
  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>) => {
      const items = e.clipboardData?.items
      if (!items) return
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          const file = items[i].getAsFile()
          if (!file) continue
          e.preventDefault()
          // Place at last known mouse position (or viewport center as fallback)
          const el = viewportRef.current
          const fallbackX = el ? el.clientWidth / 2 : 400
          const fallbackY = el ? el.clientHeight / 2 : 300
          const pos = lastMouseRef.current
          const screenX = pos.x || fallbackX
          const screenY = pos.y || fallbackY
          const p = panRef.current
          const z = zoomRef.current
          const canvasX = (screenX - p.x) / z
          const canvasY = (screenY - p.y) / z
          addImageElement(file, canvasX, canvasY)
          return
        }
      }
    },
    [addImageElement]
  )

  // ── Drag-and-drop handlers ───────────────────────────────────────────────────
  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // Allow drop only if there are image files
    const hasImage = Array.from(e.dataTransfer.items).some(
      (item) => item.kind === 'file' && item.type.startsWith('image/')
    )
    if (hasImage) e.preventDefault()
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      const files = Array.from(e.dataTransfer.files).filter((f) =>
        f.type.startsWith('image/')
      )
      if (files.length === 0) return
      const rect = viewportRef.current?.getBoundingClientRect()
      if (!rect) return
      const p = panRef.current
      const z = zoomRef.current
      // Place each image with slight offset so they don't stack exactly
      files.forEach((file, idx) => {
        const screenX = e.clientX - rect.left + idx * 20
        const screenY = e.clientY - rect.top + idx * 20
        const canvasX = (screenX - p.x) / z
        const canvasY = (screenY - p.y) / z
        addImageElement(file, canvasX, canvasY)
      })
    },
    [addImageElement]
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
      tabIndex={0}
      style={{
        position: 'absolute',
        inset: 0,
        top: 44, // below the board navigator bar
        overflow: 'hidden',
        background: '#101010',
        cursor: isPanning ? 'grabbing' : tool.kind === 'select' ? 'default' : 'crosshair',
        userSelect: 'none',
        outline: 'none',
      }}
      onMouseDown={handleCanvasMouseDown}
      onMouseMove={handleCanvasMouseMove}
      onMouseUp={handleCanvasMouseUp}
      onMouseLeave={handleCanvasMouseUp}
      onClick={handleCanvasClick}
      onPaste={handlePaste}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
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
