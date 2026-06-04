import { useEffect, useRef } from 'react'
import type { BoardStroke } from '../../shared/types'
import type { ToolState } from '../components/BoardPageCanvas'

interface UseBoardDrawingOpts {
  canvasRef: React.RefObject<HTMLCanvasElement>
  tool: ToolState
  strokes: BoardStroke[]
  zoom: number
  pan: { x: number; y: number }
  viewport: { w: number; h: number }
  onCommit: (strokes: BoardStroke[]) => void
}

// ── coordinate helpers ──────────────────────────────────────────────────────

/** canvas-coord → screen pixel */
function toScreen(cx: number, cy: number, zoom: number, pan: { x: number; y: number }) {
  return { sx: cx * zoom + pan.x, sy: cy * zoom + pan.y }
}

/** pointer clientX/Y → canvas coord (given the overlay rect offset) */
function toCanvas(
  clientX: number,
  clientY: number,
  rectLeft: number,
  rectTop: number,
  zoom: number,
  pan: { x: number; y: number }
) {
  return {
    cx: (clientX - rectLeft - pan.x) / zoom,
    cy: (clientY - rectTop - pan.y) / zoom,
  }
}

// ── drawing helpers ─────────────────────────────────────────────────────────

function drawArrowhead(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  size: number
) {
  const angle = Math.atan2(y2 - y1, x2 - x1)
  const tipX = x2
  const tipY = y2
  ctx.beginPath()
  ctx.moveTo(tipX, tipY)
  ctx.lineTo(
    tipX - size * Math.cos(angle - Math.PI / 6),
    tipY - size * Math.sin(angle - Math.PI / 6)
  )
  ctx.moveTo(tipX, tipY)
  ctx.lineTo(
    tipX - size * Math.cos(angle + Math.PI / 6),
    tipY - size * Math.sin(angle + Math.PI / 6)
  )
  ctx.stroke()
}

// Exported so the headless page renderer (board-render-service) paints strokes
// with exactly the same logic as the live drawing overlay.
export function renderStroke(
  ctx: CanvasRenderingContext2D,
  stroke: BoardStroke,
  zoom: number,
  pan: { x: number; y: number }
) {
  if (stroke.points.length === 0) return
  ctx.strokeStyle = stroke.color
  ctx.lineWidth = stroke.width * zoom
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  if (stroke.tool === 'pen') {
    ctx.beginPath()
    const first = toScreen(stroke.points[0].x, stroke.points[0].y, zoom, pan)
    ctx.moveTo(first.sx, first.sy)
    for (let i = 1; i < stroke.points.length; i++) {
      const pt = toScreen(stroke.points[i].x, stroke.points[i].y, zoom, pan)
      ctx.lineTo(pt.sx, pt.sy)
    }
    ctx.stroke()
  } else if (stroke.tool === 'line') {
    if (stroke.points.length < 2) return
    const s = toScreen(stroke.points[0].x, stroke.points[0].y, zoom, pan)
    const e = toScreen(stroke.points[1].x, stroke.points[1].y, zoom, pan)
    ctx.beginPath()
    ctx.moveTo(s.sx, s.sy)
    ctx.lineTo(e.sx, e.sy)
    ctx.stroke()
  } else if (stroke.tool === 'arrow') {
    if (stroke.points.length < 2) return
    const s = toScreen(stroke.points[0].x, stroke.points[0].y, zoom, pan)
    const e = toScreen(stroke.points[1].x, stroke.points[1].y, zoom, pan)
    ctx.beginPath()
    ctx.moveTo(s.sx, s.sy)
    ctx.lineTo(e.sx, e.sy)
    ctx.stroke()
    const arrowSize = Math.max(10, stroke.width * zoom * 3)
    drawArrowhead(ctx, s.sx, s.sy, e.sx, e.sy, arrowSize)
  } else if (stroke.tool === 'ellipse') {
    if (stroke.points.length < 2) return
    const s = toScreen(stroke.points[0].x, stroke.points[0].y, zoom, pan)
    const e = toScreen(stroke.points[1].x, stroke.points[1].y, zoom, pan)
    const cx = (s.sx + e.sx) / 2
    const cy = (s.sy + e.sy) / 2
    const rx = Math.abs(e.sx - s.sx) / 2
    const ry = Math.abs(e.sy - s.sy) / 2
    if (rx < 0.5 || ry < 0.5) return
    ctx.beginPath()
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
    ctx.stroke()
  }
}

// ── eraser hit test ─────────────────────────────────────────────────────────

function distPointToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax
  const dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(px - ax, py - ay)
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

function strokeHitTest(
  stroke: BoardStroke,
  canvasX: number,
  canvasY: number,
  thresholdCanvas: number
): boolean {
  const pts = stroke.points
  if (pts.length === 0) return false
  if (pts.length === 1) {
    return Math.hypot(pts[0].x - canvasX, pts[0].y - canvasY) < thresholdCanvas
  }
  // For pen: test each segment; for others (line/arrow/ellipse): just the two endpoints + segment
  for (let i = 0; i < pts.length - 1; i++) {
    if (
      distPointToSegment(canvasX, canvasY, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y) <
      thresholdCanvas
    )
      return true
  }
  return false
}

// ── main hook ───────────────────────────────────────────────────────────────

export function useBoardDrawing({
  canvasRef,
  tool,
  strokes,
  zoom,
  pan,
  viewport,
  onCommit,
}: UseBoardDrawingOpts): void {
  // Mutable refs so pointer-event handlers always see current values without
  // requiring re-registration on every render.
  const strokesRef = useRef(strokes)
  strokesRef.current = strokes
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const panRef = useRef(pan)
  panRef.current = pan
  const toolRef = useRef(tool)
  toolRef.current = tool
  const onCommitRef = useRef(onCommit)
  onCommitRef.current = onCommit

  // In-progress stroke state
  const activeRef = useRef<{
    id: string
    tool: BoardStroke['tool']
    points: { x: number; y: number }[]
  } | null>(null)

  // ── redraw ──────────────────────────────────────────────────────────────
  const redraw = (
    extraStroke?: BoardStroke | null,
    currentZoom = zoomRef.current,
    currentPan = panRef.current
  ) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, canvas.width, canvas.height)

    for (const s of strokesRef.current) {
      renderStroke(ctx, s, currentZoom, currentPan)
    }
    if (extraStroke) {
      renderStroke(ctx, extraStroke, currentZoom, currentPan)
    }
  }

  // Re-render when strokes / zoom / pan / viewport change
  useEffect(() => {
    // Resize canvas to match viewport (1:1, no devicePixelRatio scaling for simplicity)
    const canvas = canvasRef.current
    if (!canvas) return
    if (canvas.width !== viewport.w || canvas.height !== viewport.h) {
      canvas.width = viewport.w
      canvas.height = viewport.h
    }
    redraw(null, zoom, pan)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strokes, zoom, pan, viewport.w, viewport.h])

  // ── pointer event handlers ──────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const onPointerDown = (e: PointerEvent) => {
      const currentTool = toolRef.current
      if (
        currentTool.kind !== 'pen' &&
        currentTool.kind !== 'line' &&
        currentTool.kind !== 'arrow' &&
        currentTool.kind !== 'ellipse' &&
        currentTool.kind !== 'eraser'
      )
        return

      e.preventDefault()
      canvas.setPointerCapture(e.pointerId)

      const rect = canvas.getBoundingClientRect()
      const { cx, cy } = toCanvas(e.clientX, e.clientY, rect.left, rect.top, zoomRef.current, panRef.current)

      if (currentTool.kind === 'eraser') {
        // Erase on down too
        const threshold = 10 / zoomRef.current
        const filtered = strokesRef.current.filter(
          (s) => !strokeHitTest(s, cx, cy, threshold)
        )
        if (filtered.length !== strokesRef.current.length) {
          onCommitRef.current(filtered)
        }
        return
      }

      activeRef.current = {
        id: crypto.randomUUID(),
        tool: currentTool.kind as BoardStroke['tool'],
        points: [{ x: cx, y: cy }],
      }
    }

    const onPointerMove = (e: PointerEvent) => {
      const currentTool = toolRef.current
      const rect = canvas.getBoundingClientRect()
      const { cx, cy } = toCanvas(e.clientX, e.clientY, rect.left, rect.top, zoomRef.current, panRef.current)

      if (currentTool.kind === 'eraser' && e.buttons > 0) {
        const threshold = 10 / zoomRef.current
        const filtered = strokesRef.current.filter(
          (s) => !strokeHitTest(s, cx, cy, threshold)
        )
        if (filtered.length !== strokesRef.current.length) {
          onCommitRef.current(filtered)
        }
        return
      }

      if (!activeRef.current) return

      if (activeRef.current.tool === 'pen') {
        activeRef.current.points.push({ x: cx, y: cy })
        // Live redraw with in-progress stroke
        const preview: BoardStroke = {
          id: activeRef.current.id,
          tool: 'pen',
          color: toolRef.current.color,
          width: toolRef.current.width,
          points: activeRef.current.points,
        }
        redraw(preview)
      } else {
        // line / arrow / ellipse: replace end point for live preview
        activeRef.current.points = [activeRef.current.points[0], { x: cx, y: cy }]
        const preview: BoardStroke = {
          id: activeRef.current.id,
          tool: activeRef.current.tool,
          color: toolRef.current.color,
          width: toolRef.current.width,
          points: activeRef.current.points,
        }
        redraw(preview)
      }
    }

    const onPointerUp = (e: PointerEvent) => {
      const currentTool = toolRef.current
      if (currentTool.kind === 'eraser') return
      if (!activeRef.current) return

      const rect = canvas.getBoundingClientRect()
      const { cx, cy } = toCanvas(e.clientX, e.clientY, rect.left, rect.top, zoomRef.current, panRef.current)

      let finalPoints = activeRef.current.points
      if (activeRef.current.tool !== 'pen') {
        finalPoints = [activeRef.current.points[0], { x: cx, y: cy }]
      }

      // Only commit if we actually drew something meaningful
      if (finalPoints.length >= 2 || (activeRef.current.tool === 'pen' && finalPoints.length >= 1)) {
        const newStroke: BoardStroke = {
          id: activeRef.current.id,
          tool: activeRef.current.tool,
          color: toolRef.current.color,
          width: toolRef.current.width,
          points: finalPoints,
        }
        onCommitRef.current([...strokesRef.current, newStroke])
      }

      activeRef.current = null
      redraw(null)
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerUp)

    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
    }
    // Only re-register on canvas element change; everything else is via refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasRef])
}
