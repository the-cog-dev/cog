import { describe, expect, it } from 'vitest'
import { getSnapZone, getWindowSnap } from '../../src/renderer/hooks/useSnapZones'

describe('getSnapZone', () => {
  it('returns the top-left snap zone with quarter bounds', () => {
    expect(getSnapZone(10, 10, 1200, 800)).toEqual({
      zone: 'top-left',
      bounds: { x: 0, y: 0, width: 600, height: 400 }
    })
  })

  it('returns the top-right snap zone with quarter bounds', () => {
    expect(getSnapZone(1190, 10, 1200, 800)).toEqual({
      zone: 'top-right',
      bounds: { x: 600, y: 0, width: 600, height: 400 }
    })
  })

  it('returns the bottom-left snap zone with quarter bounds', () => {
    expect(getSnapZone(10, 790, 1200, 800)).toEqual({
      zone: 'bottom-left',
      bounds: { x: 0, y: 400, width: 600, height: 400 }
    })
  })

  it('returns the bottom-right snap zone with quarter bounds', () => {
    expect(getSnapZone(1190, 790, 1200, 800)).toEqual({
      zone: 'bottom-right',
      bounds: { x: 600, y: 400, width: 600, height: 400 }
    })
  })

  it('returns maximize when near only the top edge', () => {
    expect(getSnapZone(600, 10, 1200, 800)).toEqual({
      zone: 'maximize',
      bounds: { x: 0, y: 0, width: 1200, height: 800 }
    })
  })

  it('returns the left snap zone with left-half bounds', () => {
    expect(getSnapZone(10, 400, 1200, 800)).toEqual({
      zone: 'left',
      bounds: { x: 0, y: 0, width: 600, height: 800 }
    })
  })

  it('returns the right snap zone with right-half bounds', () => {
    expect(getSnapZone(1190, 400, 1200, 800)).toEqual({
      zone: 'right',
      bounds: { x: 600, y: 0, width: 600, height: 800 }
    })
  })

  it('returns the bottom snap zone with bottom-half bounds', () => {
    expect(getSnapZone(600, 790, 1200, 800)).toEqual({
      zone: 'bottom',
      bounds: { x: 0, y: 400, width: 1200, height: 400 }
    })
  })

  it('returns null when the pointer is not near any edge', () => {
    expect(getSnapZone(600, 400, 1200, 800)).toBeNull()
  })

  it('returns null for zero or negative workspace dimensions', () => {
    expect(getSnapZone(10, 10, 0, 800)).toBeNull()
    expect(getSnapZone(10, 10, 1200, 0)).toBeNull()
    expect(getSnapZone(10, 10, -1200, 800)).toBeNull()
    expect(getSnapZone(10, 10, 1200, -800)).toBeNull()
  })

  it('respects a custom threshold and includes exact threshold boundaries', () => {
    expect(getSnapZone(30, 300, 1200, 800, 40)).toEqual({
      zone: 'left',
      bounds: { x: 0, y: 0, width: 600, height: 800 }
    })

    expect(getSnapZone(41, 300, 1200, 800, 40)).toBeNull()

    expect(getSnapZone(1160, 300, 1200, 800, 40)).toEqual({
      zone: 'right',
      bounds: { x: 600, y: 0, width: 600, height: 800 }
    })
  })
})

describe('getWindowSnap', () => {
  const target = { id: 'b', x: 100, y: 100, width: 600, height: 400 }

  it('snaps to the right of a target window', () => {
    // Dragged window left edge at 700 (= target right edge), vertically overlapping
    const result = getWindowSnap(700, 150, 500, 300, [target], 20)
    expect(result).toEqual({
      zone: 'window-right',
      canvasBounds: { x: 700, y: 100, width: 600, height: 400 }
    })
  })

  it('snaps to the left of a target window', () => {
    // Dragged window right edge at 100 (= target left edge)
    const result = getWindowSnap(-500, 150, 600, 300, [target], 20)
    expect(result).toEqual({
      zone: 'window-left',
      canvasBounds: { x: -500, y: 100, width: 600, height: 400 }
    })
  })

  it('snaps to the bottom of a target window', () => {
    // Dragged window top edge at 500 (= target bottom edge)
    const result = getWindowSnap(200, 500, 400, 300, [target], 20)
    expect(result).toEqual({
      zone: 'window-bottom',
      canvasBounds: { x: 100, y: 500, width: 600, height: 400 }
    })
  })

  it('snaps to the top of a target window', () => {
    // Dragged window bottom edge at 100 (= target top edge)
    const result = getWindowSnap(200, -200, 400, 300, [target], 20)
    expect(result).toEqual({
      zone: 'window-top',
      canvasBounds: { x: 100, y: -300, width: 600, height: 400 }
    })
  })

  it('returns null when too far from any window', () => {
    const result = getWindowSnap(1200, 1200, 400, 300, [target], 20)
    expect(result).toBeNull()
  })

  it('picks the closest window when multiple are near', () => {
    const targetB = { id: 'c', x: 710, y: 100, width: 500, height: 400 }
    // Left edge at 705 — 5px from target right (700), 5px from targetB left (710)
    const result = getWindowSnap(705, 150, 400, 300, [target, targetB], 20)
    // 705 - 700 = 5 (right of target), 705 + 400 - 710 = 395 (not near targetB left)
    expect(result?.zone).toBe('window-right')
  })

  it('snapped window matches target size', () => {
    const result = getWindowSnap(700, 150, 300, 200, [target], 20)
    expect(result?.canvasBounds.width).toBe(target.width)
    expect(result?.canvasBounds.height).toBe(target.height)
  })
})
