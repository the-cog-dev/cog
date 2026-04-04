import React, { useState } from 'react'
import type { WindowState } from '../hooks/useWindowManager'

interface LinkOverlayProps {
  links: Array<{ from: string; to: string }>
  groups: Array<{ id: string; color: string; members: string[] }>
  windows: WindowState[]
  agents: Array<{ id: string; name: string }>
  zoom: number
  pan: { x: number; y: number }
  drawing: boolean
  drawFrom: { x: number; y: number } | null
  drawTo: { x: number; y: number } | null
  onRemoveLink?: (from: string, to: string) => void
}

const MARGIN = 30 // spacing between lines and windows

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

// Build an orthogonal (90-degree only) path from A to B that routes around windows
function buildOrthogonalPath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  windows: Rect[],
  linkIndex: number
): string {
  // Exit right from source, enter left on target
  const exitX = from.x + MARGIN
  const enterX = to.x - MARGIN

  // Offset parallel lines so they don't overlap when multiple links exist
  const offset = (linkIndex % 5) * 8 - 16

  if (exitX < enterX) {
    // Simple case: target is to the right
    // Route: right → down/up → right → arrive
    const midX = (exitX + enterX) / 2 + offset
    return [
      `M ${from.x} ${from.y}`,
      `H ${midX}`,           // go right to midpoint
      `V ${to.y}`,           // go up/down to target height
      `H ${to.x}`,           // go right to target
    ].join(' ')
  } else {
    // Target is to the left or overlapping — route around
    // Go right, then up/down to clear both windows, then left, then down to target
    const clearY = Math.min(from.y, to.y) - 60 - Math.abs(offset)

    // If both are at similar height, route below instead
    const routeBelow = Math.abs(from.y - to.y) < 80
    const bypassY = routeBelow
      ? Math.max(from.y, to.y) + 80 + Math.abs(offset)
      : clearY

    return [
      `M ${from.x} ${from.y}`,
      `H ${exitX}`,           // exit right
      `V ${bypassY}`,         // go up/down to clear
      `H ${enterX}`,          // go left to target column
      `V ${to.y}`,            // go down/up to target height
      `H ${to.x}`,            // enter target
    ].join(' ')
  }
}

export function LinkOverlay({
  links, groups, windows, agents, zoom, pan,
  drawing, drawFrom, drawTo, onRemoveLink
}: LinkOverlayProps): React.ReactElement {
  const [hoveredLink, setHoveredLink] = useState<number | null>(null)

  const getWindowRect = (agentName: string): Rect | null => {
    const agent = agents.find(a => a.name === agentName)
    if (!agent) return null
    const win = windows.find(w => w.id === agent.id)
    if (!win) return null
    return { x: win.x, y: win.y, w: win.width, h: win.height }
  }

  const getRightPort = (agentName: string): { x: number; y: number } | null => {
    const rect = getWindowRect(agentName)
    if (!rect) return null
    return { x: rect.x + rect.w, y: rect.y + rect.h / 2 }
  }

  const getLeftPort = (agentName: string): { x: number; y: number } | null => {
    const rect = getWindowRect(agentName)
    if (!rect) return null
    return { x: rect.x, y: rect.y + rect.h / 2 }
  }

  const getGroupColor = (from: string, to: string): string => {
    for (const group of groups) {
      if (group.members.includes(from) && group.members.includes(to)) {
        return group.color
      }
    }
    return '#666'
  }

  // Collect all window rects for obstacle avoidance
  const allRects: Rect[] = windows.map(w => ({ x: w.x, y: w.y, w: w.width, h: w.height }))

  return (
    <svg style={{
      position: 'absolute', top: 0, left: 0, width: '10000px', height: '10000px',
      pointerEvents: 'none', zIndex: 9999, overflow: 'visible'
    }}>
      {links.map((link, i) => {
        const fromPos = getRightPort(link.from)
        const toPos = getLeftPort(link.to)
        if (!fromPos || !toPos) return null

        const color = getGroupColor(link.from, link.to)
        const pathD = buildOrthogonalPath(fromPos, toPos, allRects, i)
        const isHovered = hoveredLink === i

        // Midpoint for delete button (approximate — use average of from/to)
        const midX = (fromPos.x + toPos.x) / 2
        const midY = (fromPos.y + toPos.y) / 2

        return (
          <g key={`${link.from}-${link.to}-${i}`}>
            {/* Invisible fat hitbox */}
            <path
              d={pathD}
              stroke="transparent"
              strokeWidth={14}
              fill="none"
              strokeLinejoin="round"
              style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
              onMouseEnter={() => setHoveredLink(i)}
              onMouseLeave={() => setHoveredLink(null)}
            />
            {/* Visible orthogonal line */}
            <path
              d={pathD}
              stroke={color}
              strokeWidth={isHovered ? 2.5 : 1.5}
              fill="none"
              opacity={isHovered ? 0.9 : 0.4}
              strokeLinejoin="round"
              strokeLinecap="round"
              style={{ pointerEvents: 'none', transition: 'stroke-width 0.15s, opacity 0.15s' }}
            />
            {/* Delete button at midpoint */}
            {isHovered && onRemoveLink && (
              <>
                <circle
                  cx={midX} cy={midY} r={9}
                  fill="#2a1a1a" stroke="#f44336" strokeWidth={1.5}
                  style={{ pointerEvents: 'all', cursor: 'pointer' }}
                  onClick={() => onRemoveLink(link.from, link.to)}
                  onMouseEnter={() => setHoveredLink(i)}
                />
                <text
                  x={midX} y={midY + 1}
                  textAnchor="middle" dominantBaseline="middle"
                  fontSize={11} fill="#f44336" fontWeight="bold"
                  style={{ pointerEvents: 'none' }}
                >
                  x
                </text>
              </>
            )}
          </g>
        )
      })}
      {/* Drawing preview — orthogonal too */}
      {drawing && drawFrom && drawTo && (
        <path
          d={`M ${drawFrom.x} ${drawFrom.y} H ${(drawFrom.x + drawTo.x) / 2} V ${drawTo.y} H ${drawTo.x}`}
          stroke="#4a9eff" strokeWidth={2} strokeDasharray="5,5" opacity={0.8}
          fill="none" strokeLinejoin="round"
        />
      )}
    </svg>
  )
}
