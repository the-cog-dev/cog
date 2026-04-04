import React from 'react'
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
}

export function LinkOverlay({
  links, groups, windows, agents, zoom, pan,
  drawing, drawFrom, drawTo
}: LinkOverlayProps): React.ReactElement {

  const getPortPosition = (agentName: string): { x: number; y: number } | null => {
    const agent = agents.find(a => a.name === agentName)
    if (!agent) return null
    const win = windows.find(w => w.id === agent.id)
    if (!win) return null
    return {
      x: (win.x + win.width) * zoom + pan.x,
      y: (win.y + win.height / 2) * zoom + pan.y
    }
  }

  const getGroupColor = (from: string, to: string): string => {
    for (const group of groups) {
      if (group.members.includes(from) && group.members.includes(to)) {
        return group.color
      }
    }
    return '#666'
  }

  return (
    <svg style={{
      position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
      pointerEvents: 'none', zIndex: 1
    }}>
      {links.map((link, i) => {
        const fromPos = getPortPosition(link.from)
        const toPos = getPortPosition(link.to)
        if (!fromPos || !toPos) return null
        const color = getGroupColor(link.from, link.to)
        const cpOffset = Math.abs(toPos.x - fromPos.x) * 0.4 + 40
        return (
          <path
            key={`${link.from}-${link.to}-${i}`}
            d={`M ${fromPos.x} ${fromPos.y} C ${fromPos.x + cpOffset} ${fromPos.y}, ${toPos.x - cpOffset} ${toPos.y}, ${toPos.x} ${toPos.y}`}
            stroke={color}
            strokeWidth={2}
            fill="none"
            opacity={0.6}
          />
        )
      })}
      {drawing && drawFrom && drawTo && (
        <line
          x1={drawFrom.x} y1={drawFrom.y}
          x2={drawTo.x} y2={drawTo.y}
          stroke="#4a9eff" strokeWidth={2} strokeDasharray="5,5" opacity={0.8}
        />
      )}
    </svg>
  )
}
