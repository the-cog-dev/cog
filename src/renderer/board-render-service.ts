import type { BoardAppearance, BoardElement, BoardPage } from '../shared/types'
import { renderStroke } from './hooks/useBoardDrawing'

/**
 * Headless Sketchpad page renderer.
 *
 * The live render path (BoardPageCanvas -> rasterizeNode) only runs while a
 * page is open in the Workboard, so any page that was never (re)visited has no
 * render PNG and agents got a 409 from /board/pages/:n/render. This service
 * lets the main process request a render of ANY page at any time: it paints
 * the page onto an offscreen canvas (same stroke logic as the drawing overlay,
 * minimal-but-faithful element painting) and saves it via the existing
 * BOARD_SAVE_RENDER IPC.
 */

const MIN_W = 800
const MIN_H = 600
const MAX_DIM = 4000
const PAD = 40

interface Bounds { x: number; y: number; w: number; h: number }

/** Union of the default viewport at origin and all element/stroke extents. */
export function computePageBounds(page: BoardPage): Bounds {
  let minX = 0
  let minY = 0
  let maxX = MIN_W
  let maxY = MIN_H
  for (const el of page.elements) {
    minX = Math.min(minX, el.x - PAD)
    minY = Math.min(minY, el.y - PAD)
    maxX = Math.max(maxX, el.x + el.w + PAD)
    maxY = Math.max(maxY, el.y + el.h + PAD)
  }
  for (const s of page.strokes) {
    const r = s.width / 2 + PAD
    for (const p of s.points) {
      minX = Math.min(minX, p.x - r)
      minY = Math.min(minY, p.y - r)
      maxX = Math.max(maxX, p.x + r)
      maxY = Math.max(maxY, p.y + r)
    }
  }
  const w = Math.min(maxX - minX, MAX_DIM)
  const h = Math.min(maxY - minY, MAX_DIM)
  return { x: minX, y: minY, w, h }
}

/** Basic word wrap honoring explicit newlines. */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(' ')) {
      const candidate = line ? `${line} ${word}` : word
      if (line && ctx.measureText(candidate).width > maxWidth) {
        lines.push(line)
        line = word
      } else {
        line = candidate
      }
    }
    lines.push(line)
  }
  return lines
}

function drawWrappedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  maxHeight: number,
  fontSize: number,
  color: string
): void {
  ctx.font = `${fontSize}px sans-serif`
  ctx.fillStyle = color
  ctx.textBaseline = 'top'
  const lineHeight = fontSize * 1.5
  const lines = wrapText(ctx, text, maxWidth)
  for (let i = 0; i < lines.length; i++) {
    const ly = y + i * lineHeight
    if (ly + lineHeight > y + maxHeight) break
    ctx.fillText(lines[i], x, ly)
  }
}

function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** Load a board image (bare filename via IPC, or a data: URL) as an <img>. */
async function loadBoardImage(file: string): Promise<HTMLImageElement | null> {
  const src = file.startsWith('data:') ? file : await window.electronAPI.boardReadImage(file)
  if (!src) return null
  const img = new Image()
  img.src = src
  try {
    await img.decode()
  } catch (err) {
    console.error(`[board-render-service] image decode failed for "${file.slice(0, 64)}":`, err)
    return null
  }
  return img
}

async function drawElement(ctx: CanvasRenderingContext2D, el: BoardElement, ox: number, oy: number): Promise<void> {
  const x = el.x + ox
  const y = el.y + oy
  if (el.type === 'note') {
    // Mirror BoardElementView's note: colored rounded card + dark 13px text, 8px padding
    roundedRectPath(ctx, x, y, el.w, el.h, 6)
    ctx.fillStyle = el.color
    ctx.fill()
    drawWrappedText(ctx, el.text, x + 8, y + 8, el.w - 16, el.h - 16, 13, '#111')
  } else if (el.type === 'text') {
    // Mirror BoardElementView's text: light text, 4px padding
    drawWrappedText(ctx, el.text, x + 4, y + 4, el.w - 8, el.h - 8, el.fontSize, '#ddd')
  } else {
    const img = await loadBoardImage(el.file)
    if (!img) return // broken image degrades that element, not the page
    // object-fit: contain, centered (same as the live <img> styling)
    const scale = Math.min(el.w / img.naturalWidth, el.h / img.naturalHeight)
    const dw = img.naturalWidth * scale
    const dh = img.naturalHeight * scale
    ctx.drawImage(img, x + (el.w - dw) / 2, y + (el.h - dh) / 2, dw, dh)
  }
}

/** Render a full board page to a base64 PNG (no data: prefix). */
export async function renderPageToPngBase64(page: BoardPage, appearance: BoardAppearance): Promise<string> {
  const bounds = computePageBounds(page)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bounds.w)
  canvas.height = Math.round(bounds.h)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not acquire 2d canvas context')

  // Background (+ optional grid, 40px cells like the live board)
  ctx.fillStyle = appearance.bgColor
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  if (appearance.showGrid) {
    ctx.strokeStyle = appearance.gridColor
    ctx.lineWidth = 1
    for (let gx = -(bounds.x % 40); gx < canvas.width; gx += 40) {
      ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, canvas.height); ctx.stroke()
    }
    for (let gy = -(bounds.y % 40); gy < canvas.height; gy += 40) {
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(canvas.width, gy); ctx.stroke()
    }
  }

  // Elements in z order, then strokes on top (the live board layers the
  // drawing canvas above the elements layer).
  const sorted = [...page.elements].sort((a, b) => a.z - b.z)
  for (const el of sorted) {
    await drawElement(ctx, el, -bounds.x, -bounds.y)
  }
  for (const s of page.strokes) {
    renderStroke(ctx, s, 1, { x: -bounds.x, y: -bounds.y })
  }

  const dataUrl = canvas.toDataURL('image/png')
  const comma = dataUrl.indexOf(',')
  if (comma < 0) throw new Error('canvas.toDataURL returned no data')
  return dataUrl.slice(comma + 1)
}

let initialized = false

/**
 * Subscribe to main-process render requests. Mounted once from App so renders
 * work even when the Workboard panel is closed.
 */
export function initBoardRenderService(): void {
  if (initialized) return
  initialized = true
  console.log('[board-render-service] initialized')
  window.electronAPI.onBoardRenderRequest(async ({ pageId, requestId }) => {
    console.log(`[board-render-service] render request for page ${pageId}`)
    try {
      const pages = await window.electronAPI.boardListPages()
      const page = pages.find((p) => p.id === pageId)
      if (!page) throw new Error(`Board page ${pageId} not found`)
      const appearance = await window.electronAPI.getBoardAppearance()
      const b64 = await renderPageToPngBase64(page, appearance)
      await window.electronAPI.boardSaveRender(page.id, b64)
      window.electronAPI.boardRenderResult(requestId, true)
    } catch (err) {
      console.error('[board-render-service] render request failed:', err)
      window.electronAPI.boardRenderResult(requestId, false, err instanceof Error ? err.message : String(err))
    }
  })
}
