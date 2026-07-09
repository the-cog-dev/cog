import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock html-to-image so the rasterizer can be exercised in the node test env
// (real toPng needs a layout engine; its behavior is not under test here).
const toPngMock = vi.fn()
vi.mock('html-to-image', () => ({ toPng: (...args: unknown[]) => toPngMock(...args) }))

import { rasterizeNode, waitForImages } from '../../src/renderer/hooks/useBoardRasterizer'
import { computePageBounds } from '../../src/renderer/board-render-service'
import type { BoardPage } from '../../src/shared/types'

/** Minimal stand-in for a capture node containing <img> elements. */
function makeNode(imgs: Array<{ decode: () => Promise<void> }>): HTMLElement {
  return { querySelectorAll: vi.fn(() => imgs) } as unknown as HTMLElement
}

beforeEach(() => {
  toPngMock.mockReset()
})

describe('waitForImages', () => {
  it('awaits decode() on every image element', async () => {
    const decode1 = vi.fn(() => Promise.resolve())
    const decode2 = vi.fn(() => Promise.resolve())
    await waitForImages(makeNode([{ decode: decode1 }, { decode: decode2 }]))
    expect(decode1).toHaveBeenCalledTimes(1)
    expect(decode2).toHaveBeenCalledTimes(1)
  })

  it('tolerates a failing decode (broken image must not kill the render)', async () => {
    const bad = vi.fn(() => Promise.reject(new Error('EncodingError')))
    await expect(waitForImages(makeNode([{ decode: bad }]))).resolves.toBeUndefined()
  })
})

describe('rasterizeNode', () => {
  it('renders a node with an image element: waits for decode, returns bare base64', async () => {
    const decode = vi.fn(() => Promise.resolve())
    const node = makeNode([{ decode }])
    toPngMock.mockResolvedValue('data:image/png;base64,AAAABBBB')

    const b64 = await rasterizeNode(node, '#101010')

    expect(decode).toHaveBeenCalled()
    expect(b64).toBe('AAAABBBB')
  })

  it('calls toPng WITHOUT cacheBust (data-URL images must not be cache-busted)', async () => {
    toPngMock.mockResolvedValue('data:image/png;base64,XYZ')

    await rasterizeNode(makeNode([]), '#222222')

    expect(toPngMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cacheBust: false, backgroundColor: '#222222', pixelRatio: 1 })
    )
  })

  it('logs the real cause and returns null when toPng throws (no more silent catch)', async () => {
    const err = new Error('SecurityError: tainted canvas')
    toPngMock.mockRejectedValue(err)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const b64 = await rasterizeNode(makeNode([]))

    expect(b64).toBeNull()
    expect(spy).toHaveBeenCalledWith('[rasterizeNode] board page rasterization failed:', err)
    spy.mockRestore()
  })

  it('returns null when toPng yields a malformed data URL', async () => {
    toPngMock.mockResolvedValue('garbage-without-comma')

    const b64 = await rasterizeNode(makeNode([]))

    expect(b64).toBeNull()
  })
})

describe('computePageBounds (headless render sizing)', () => {
  const basePage: BoardPage = { id: 'p1', orderIndex: 1, elements: [], strokes: [] }

  it('returns the default viewport for an empty page', () => {
    expect(computePageBounds(basePage)).toEqual({ x: 0, y: 0, w: 800, h: 600 })
  })

  it('expands to include an image element placed beyond the viewport', () => {
    const page: BoardPage = {
      ...basePage,
      elements: [{ type: 'image', id: 'i1', x: 900, y: 700, w: 320, h: 240, file: 'photo.jpg', z: 1 }]
    }
    const b = computePageBounds(page)
    expect(b.x).toBe(0)
    expect(b.y).toBe(0)
    expect(b.w).toBe(900 + 320 + 40) // element right edge + padding
    expect(b.h).toBe(700 + 240 + 40)
  })

  it('includes negative-coordinate strokes and caps dimensions', () => {
    const page: BoardPage = {
      ...basePage,
      strokes: [{ id: 's1', tool: 'pen', color: '#fff', width: 4, points: [{ x: -100, y: -50 }, { x: 99999, y: 10 }] }]
    }
    const b = computePageBounds(page)
    expect(b.x).toBeLessThan(0)
    expect(b.y).toBeLessThan(0)
    expect(b.w).toBeLessThanOrEqual(4000)
    expect(b.h).toBeLessThanOrEqual(4000)
  })
})
