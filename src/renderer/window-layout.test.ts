import { describe, it, expect } from 'vitest'
import { nextSpawnBounds, type Bounds } from './window-layout'

const W = 600
const H = 400
const GAP = 20

describe('nextSpawnBounds', () => {
  it('places the first window at the base point', () => {
    expect(nextSpawnBounds([], 100, 80)).toEqual({ x: 100, y: 80, width: W, height: H })
  })

  it('tiles the second window to the right of the first (no overlap)', () => {
    const first: Bounds = { x: 100, y: 80, width: W, height: H }
    const b = nextSpawnBounds([first], 100, 80)
    expect(b.x).toBe(100 + W + GAP) // right of the first, plus a gap
    expect(b.y).toBe(80) // same row
    // and it genuinely doesn't overlap the first
    expect(b.x).toBeGreaterThanOrEqual(first.x + first.width)
  })

  it('keeps tiling right of the RIGHTMOST window, not the last-added', () => {
    const existing: Bounds[] = [
      { x: 100, y: 80, width: W, height: H },
      { x: 2000, y: 80, width: W, height: H } // user dragged one far right
    ]
    const b = nextSpawnBounds(existing, 100, 80)
    expect(b.x).toBe(2000 + W + GAP)
  })

  it('keeps marching right for a whole team (no stacking)', () => {
    const existing: Bounds[] = []
    let baseX = 100
    for (let i = 0; i < 5; i++) {
      const b = nextSpawnBounds(existing, baseX, 80)
      // each new window starts at or past the previous one's right edge
      for (const e of existing) expect(b.x).toBeGreaterThanOrEqual(e.x + e.width)
      existing.push(b)
    }
    // 5 distinct, left-to-right, non-overlapping x positions
    const xs = existing.map((e) => e.x)
    expect(new Set(xs).size).toBe(5)
    expect([...xs].sort((a, b) => a - b)).toEqual(xs)
  })

  it('aligns new windows to the top row of existing ones', () => {
    const existing: Bounds[] = [
      { x: 100, y: 200, width: W, height: H },
      { x: 800, y: 500, width: W, height: H }
    ]
    expect(nextSpawnBounds(existing, 100, 80).y).toBe(200) // topmost y
  })
})
