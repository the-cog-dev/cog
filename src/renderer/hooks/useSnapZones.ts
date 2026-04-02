export type SnapZone =
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'
  | 'maximize'
  | 'window-left'
  | 'window-right'
  | 'window-top'
  | 'window-bottom'

export interface SnapBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface SnapZoneInfo {
  zone: SnapZone
  bounds: SnapBounds
}

export interface WindowBounds {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export function getSnapZone(
  mouseX: number,
  mouseY: number,
  workspaceWidth: number,
  workspaceHeight: number,
  threshold = 20
): SnapZoneInfo | null {
  if (workspaceWidth <= 0 || workspaceHeight <= 0) return null

  const halfWidth = workspaceWidth / 2
  const halfHeight = workspaceHeight / 2
  const quarterWidth = workspaceWidth / 2
  const quarterHeight = workspaceHeight / 2

  const nearLeft = mouseX <= threshold
  const nearRight = mouseX >= workspaceWidth - threshold
  const nearTop = mouseY <= threshold
  const nearBottom = mouseY >= workspaceHeight - threshold

  if (nearTop && nearLeft) {
    return { zone: 'top-left', bounds: { x: 0, y: 0, width: quarterWidth, height: quarterHeight } }
  }

  if (nearTop && nearRight) {
    return { zone: 'top-right', bounds: { x: halfWidth, y: 0, width: quarterWidth, height: quarterHeight } }
  }

  if (nearBottom && nearLeft) {
    return { zone: 'bottom-left', bounds: { x: 0, y: halfHeight, width: quarterWidth, height: quarterHeight } }
  }

  if (nearBottom && nearRight) {
    return { zone: 'bottom-right', bounds: { x: halfWidth, y: halfHeight, width: quarterWidth, height: quarterHeight } }
  }

  if (nearTop) {
    return { zone: 'maximize', bounds: { x: 0, y: 0, width: workspaceWidth, height: workspaceHeight } }
  }

  if (nearLeft) {
    return { zone: 'left', bounds: { x: 0, y: 0, width: halfWidth, height: workspaceHeight } }
  }

  if (nearRight) {
    return { zone: 'right', bounds: { x: halfWidth, y: 0, width: halfWidth, height: workspaceHeight } }
  }

  if (nearBottom) {
    return { zone: 'bottom', bounds: { x: 0, y: halfHeight, width: workspaceWidth, height: halfHeight } }
  }

  return null
}

/**
 * Detect snap to another window's edge. All coordinates in canvas space.
 * Returns canvas-space bounds for where the window should snap.
 * The snapped window matches the target window's size.
 */
export function getWindowSnap(
  dragX: number,
  dragY: number,
  dragWidth: number,
  dragHeight: number,
  others: WindowBounds[],
  threshold: number
): { zone: SnapZone; canvasBounds: SnapBounds } | null {
  let best: { zone: SnapZone; canvasBounds: SnapBounds; distance: number } | null = null
  const dragCenterX = dragX + dragWidth / 2
  const dragCenterY = dragY + dragHeight / 2

  for (const other of others) {
    const otherCenterX = other.x + other.width / 2
    const otherCenterY = other.y + other.height / 2
    const yRange = other.height / 2 + dragHeight / 2 + threshold
    const xRange = other.width / 2 + dragWidth / 2 + threshold

    // Snap to RIGHT of other: dragged left edge near other's right edge
    const distRight = Math.abs(dragX - (other.x + other.width))
    if (distRight < threshold && Math.abs(dragCenterY - otherCenterY) < yRange) {
      if (!best || distRight < best.distance) {
        best = {
          zone: 'window-right',
          canvasBounds: { x: other.x + other.width, y: other.y, width: other.width, height: other.height },
          distance: distRight
        }
      }
    }

    // Snap to LEFT of other: dragged right edge near other's left edge
    const distLeft = Math.abs((dragX + dragWidth) - other.x)
    if (distLeft < threshold && Math.abs(dragCenterY - otherCenterY) < yRange) {
      if (!best || distLeft < best.distance) {
        best = {
          zone: 'window-left',
          canvasBounds: { x: other.x - other.width, y: other.y, width: other.width, height: other.height },
          distance: distLeft
        }
      }
    }

    // Snap to BOTTOM of other: dragged top edge near other's bottom edge
    const distBottom = Math.abs(dragY - (other.y + other.height))
    if (distBottom < threshold && Math.abs(dragCenterX - otherCenterX) < xRange) {
      if (!best || distBottom < best.distance) {
        best = {
          zone: 'window-bottom',
          canvasBounds: { x: other.x, y: other.y + other.height, width: other.width, height: other.height },
          distance: distBottom
        }
      }
    }

    // Snap to TOP of other: dragged bottom edge near other's top edge
    const distTop = Math.abs((dragY + dragHeight) - other.y)
    if (distTop < threshold && Math.abs(dragCenterX - otherCenterX) < xRange) {
      if (!best || distTop < best.distance) {
        best = {
          zone: 'window-top',
          canvasBounds: { x: other.x, y: other.y - other.height, width: other.width, height: other.height },
          distance: distTop
        }
      }
    }
  }

  return best ? { zone: best.zone, canvasBounds: best.canvasBounds } : null
}
