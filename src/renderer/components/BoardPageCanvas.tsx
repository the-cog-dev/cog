import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { BoardElement, BoardPage } from '../../shared/types'
import { BoardElementView } from './BoardElementView'
import { useBoardDrawing } from '../hooks/useBoardDrawing'
import { useBoardHistory } from '../hooks/useBoardHistory'
import { rasterizeNode } from '../hooks/useBoardRasterizer'
import { useContainCanvasScroll } from '../hooks/useContainCanvasScroll'

// Exported so callers/toolbar can reference the tool state shape.
export interface ToolState {
  kind: 'select' | 'note' | 'text' | 'image' | 'pen' | 'line' | 'arrow' | 'ellipse' | 'eraser'
  color: string
  width: number
}

const DEFAULT_TOOL: ToolState = { kind: 'select', color: '#ffd400', width: 4 }

// Shared styles for the zoom control overlay
const zoomBtnStyle: React.CSSProperties = {
  background: '#222',
  color: '#ccc',
  border: '1px solid #444',
  borderRadius: 4,
  width: 24,
  height: 24,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  fontSize: 14,
  lineHeight: 1,
  padding: 0,
  flexShrink: 0,
}

const zoomLabelStyle: React.CSSProperties = {
  background: '#222',
  color: '#ccc',
  border: '1px solid #444',
  borderRadius: 4,
  fontSize: 10,
  fontFamily: 'monospace',
  padding: '0 6px',
  height: 24,
  display: 'flex',
  alignItems: 'center',
  cursor: 'pointer',
  userSelect: 'none',
  flexShrink: 0,
}

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
  const [viewport, setViewport] = useState({ w: 800, h: 600 })

  // Per-page undo/redo — commit() wraps onChange for all user-initiated edits.
  const { commit } = useBoardHistory({ page, onChange })

  // Drawing overlay canvas ref
  const drawingCanvasRef = useRef<HTMLCanvasElement>(null)

  // Capture wrapper ref — wraps the elements layer + drawing canvas for rasterization
  const captureWrapperRef = useRef<HTMLDivElement>(null)
  // Stable refs for unmount cleanup (avoids stale closure issues)
  const captureWrapperNodeRef = useRef<HTMLDivElement | null>(null)
  const pageIdRef = useRef<string>(page.id)

  // Refs so handlers always see current values without stale closures
  const zoomRef = useRef(zoom)
  const panRef = useRef(pan)
  zoomRef.current = zoom
  panRef.current = pan

  // Wheel guard — stops wheel events from bubbling to the agent canvas behind the board
  const attachWheelGuard = useContainCanvasScroll<HTMLDivElement>()

  // Pan-drag state (left-button drag on empty canvas in select mode)
  const isPanningRef = useRef(false)
  const panStartRef = useRef({ mouseX: 0, mouseY: 0, panX: 0, panY: 0 })

  // Last known mouse position in screen coords (relative to viewport) for paste placement
  const lastMouseRef = useRef({ x: 0, y: 0 })

  const viewportRef = useRef<HTMLDivElement>(null)

  // ── zoomTo: pivot zoom around the viewport center ────────────────────────
  // Given a new zoom level, adjusts pan so the canvas point currently under
  // the viewport center stays fixed after the zoom change.
  const zoomTo = useCallback(
    (newZoom: number) => {
      const clamped = Math.min(3, Math.max(0.25, newZoom))
      const { w, h } = viewport
      const cx = w / 2
      const cy = h / 2
      const oldZoom = zoomRef.current
      const p = panRef.current
      // Canvas point currently under the viewport center
      const canvasX = (cx - p.x) / oldZoom
      const canvasY = (cy - p.y) / oldZoom
      // Adjust pan so that same canvas point is still under center after zoom
      const newPanX = cx - canvasX * clamped
      const newPanY = cy - canvasY * clamped
      setZoom(clamped)
      setPan({ x: newPanX, y: newPanY })
    },
    [viewport]
  )

  // ── Track viewport size for the drawing canvas ───────────────────────────
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
      setViewport({ w: Math.round(width), h: Math.round(height) })
    })
    ro.observe(el)
    // Initialise immediately
    setViewport({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  // ── Keep stable refs in sync so unmount cleanup can use them ────────────
  useEffect(() => {
    captureWrapperNodeRef.current = captureWrapperRef.current
    pageIdRef.current = page.id
  })

  // ── Debounced render-on-edit: save PNG 1500ms after any page change ──────
  useEffect(() => {
    const node = captureWrapperRef.current
    if (!node) return
    const id = page.id
    const timer = setTimeout(() => {
      rasterizeNode(node).then((b64) => {
        if (b64) window.electronAPI.boardSaveRender(id, b64).catch(() => {})
      })
    }, 1500)
    return () => clearTimeout(timer)
  }, [page])

  // ── Fire-and-forget render on unmount ────────────────────────────────────
  useEffect(() => {
    return () => {
      const node = captureWrapperNodeRef.current
      const id = pageIdRef.current
      if (!node) return
      rasterizeNode(node).then((b64) => {
        if (b64) window.electronAPI.boardSaveRender(id, b64).catch(() => {})
      })
    }
  }, [])

  // ── Freehand drawing layer ───────────────────────────────────────────────
  useBoardDrawing({
    canvasRef: drawingCanvasRef,
    tool,
    strokes: page.strokes,
    zoom,
    pan,
    viewport,
    onCommit: (newStrokes) => commit({ ...page, strokes: newStrokes }),
  })

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
        commit(updated)
        setSelectedId(newEl.id)
      } catch (err) {
        console.error('[BoardPageCanvas] addImageElement failed:', err)
      }
    },
    [page, commit]
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
      if (tool.kind !== 'note' && tool.kind !== 'text') return

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

      commit({ ...page, elements: [...page.elements, newEl] })
      setSelectedId(id)
    },
    [tool, pan, zoom, page, commit]
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
      commit({
        ...page,
        elements: page.elements.map((el) => (el.id === updated.id ? updated : el)),
      })
    },
    [page, commit]
  )

  const handleElementDelete = useCallback(
    (id: string) => {
      commit({ ...page, elements: page.elements.filter((el) => el.id !== id) })
      setSelectedId(null)
    },
    [page, commit]
  )

  const isPanning = isPanningRef.current

  return (
    <div
      ref={(node) => {
        ;(viewportRef as React.MutableRefObject<HTMLDivElement | null>).current = node
        attachWheelGuard(node)
      }}
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
      {/* Capture wrapper — rasterized for agent vision; contains both layers */}
      <div
        ref={captureWrapperRef}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: viewport.w,
          height: viewport.h,
          pointerEvents: 'none',
        }}
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
            pointerEvents: 'auto',
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

        {/* Drawing canvas overlay — sits above elements, receives pointer events only when a draw tool is active */}
        <canvas
          ref={drawingCanvasRef}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: viewport.w,
            height: viewport.h,
            zIndex: 10,
            pointerEvents:
              tool.kind === 'pen' ||
              tool.kind === 'line' ||
              tool.kind === 'arrow' ||
              tool.kind === 'ellipse' ||
              tool.kind === 'eraser'
                ? 'auto'
                : 'none',
          }}
        />
      </div>

      {/* Zoom controls — outside the transform, bottom-right */}
      <div
        style={{
          position: 'absolute',
          bottom: 12,
          right: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          pointerEvents: 'auto',
          zIndex: 20,
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          title="Zoom out"
          onClick={(e) => { e.stopPropagation(); zoomTo(zoom - 0.2) }}
          style={zoomBtnStyle}
        >
          −
        </button>
        <span
          title="Reset zoom"
          onClick={(e) => { e.stopPropagation(); setZoom(1); setPan({ x: 0, y: 0 }) }}
          style={zoomLabelStyle}
        >
          {Math.round(zoom * 100)}%
        </span>
        <button
          title="Zoom in"
          onClick={(e) => { e.stopPropagation(); zoomTo(zoom + 0.2) }}
          style={zoomBtnStyle}
        >
          ＋
        </button>
      </div>
    </div>
  )
}
