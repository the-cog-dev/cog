/**
 * Canvas window placement + persistence.
 *
 * - nextSpawnBounds: where a newly-spawned agent window goes. Instead of the old
 *   30px diagonal cascade (which stacked new agents on top of each other), tile
 *   to the RIGHT of the existing windows in the tab, wrapping to a new row after
 *   a few columns. Pure + unit-tested.
 * - load/save/deleteWindowBounds: remember each agent window's position + size
 *   across restarts (localStorage keyed by the agent id, which the roster keeps
 *   stable across a respawn) so restored teams return to where you left them.
 */
export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

const DEFAULT_WIDTH = 600
const DEFAULT_HEIGHT = 400
const GAP = 20

/**
 * Bounds for a new window given the windows already in its tab. With none, use
 * (baseX, baseY) — the caller passes the viewport-centered point. Otherwise place
 * it just to the RIGHT of the rightmost existing window (aligned to the top row),
 * so spawns march left→right instead of stacking on top of each other. The
 * canvas pans/zooms, so a long row is fine — zoom-to-fit frames them all.
 */
export function nextSpawnBounds(
  existing: Bounds[],
  baseX: number,
  baseY: number,
  opts: { width?: number; height?: number; gap?: number } = {}
): Bounds {
  const width = opts.width ?? DEFAULT_WIDTH
  const height = opts.height ?? DEFAULT_HEIGHT
  const gap = opts.gap ?? GAP

  if (existing.length === 0) {
    return { x: baseX, y: baseY, width, height }
  }

  const topY = Math.min(...existing.map((w) => w.y))
  const maxRight = Math.max(...existing.map((w) => w.x + w.width))
  return { x: maxRight + gap, y: topY, width, height }
}

// ── Persistence (localStorage; agent id → bounds) ────────────────────────────

const STORAGE_KEY = 'cog.windowBounds.v1'

function readAll(): Record<string, Bounds> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeAll(map: Record<string, Bounds>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    /* storage full / unavailable — non-fatal, layout just won't persist */
  }
}

/** Saved bounds for one agent, or null if none stored. */
export function loadWindowBounds(id: string): Bounds | null {
  const b = readAll()[id]
  return b && Number.isFinite(b.x) ? b : null
}

/**
 * Merge one window's bounds into storage. MERGE (not replace) so a fresh boot —
 * where the renderer starts with no windows — can't wipe saved layout before the
 * respawn restores it.
 */
export function saveWindowBounds(id: string, bounds: Bounds): void {
  const map = readAll()
  map[id] = bounds
  writeAll(map)
}

/** Forget an agent's saved bounds (called when the user closes/kills it). */
export function deleteWindowBounds(id: string): void {
  const map = readAll()
  if (id in map) {
    delete map[id]
    writeAll(map)
  }
}
