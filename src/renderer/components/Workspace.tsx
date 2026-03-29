import React from 'react'
import { FloatingWindow } from './FloatingWindow'
import { TerminalWindow } from './TerminalWindow'
import type { WindowState } from '../hooks/useWindowManager'
import type { AgentState } from '../../shared/types'

const STATUS_COLORS: Record<string, string> = {
  idle: '#888',
  active: '#4caf50',
  working: '#ffc107',
  disconnected: '#f44336'
}

interface WorkspaceProps {
  windows: WindowState[]
  agents: AgentState[]
  onFocusWindow: (id: string) => void
  onMinimizeWindow: (id: string) => void
  onCloseWindow: (id: string) => void
}

export function Workspace({
  windows,
  agents,
  onFocusWindow,
  onMinimizeWindow,
  onCloseWindow
}: WorkspaceProps): React.ReactElement {
  return (
    <div style={{
      flex: 1,
      position: 'relative',
      overflow: 'hidden',
      backgroundColor: '#111'
    }}>
      {windows.map(win => {
        const agent = agents.find(a => a.id === win.id)
        const statusColor = agent ? STATUS_COLORS[agent.status] ?? '#888' : undefined
        const title = agent
          ? `${agent.name} (${agent.cli}) \u00B7 ${agent.role}`
          : win.title

        return (
          <FloatingWindow
            key={win.id}
            id={win.id}
            title={title}
            statusColor={statusColor}
            initialX={win.x}
            initialY={win.y}
            initialWidth={win.width}
            initialHeight={win.height}
            zIndex={win.zIndex}
            minimized={win.minimized}
            onFocus={() => onFocusWindow(win.id)}
            onMinimize={() => onMinimizeWindow(win.id)}
            onMaximize={() => onFocusWindow(win.id)}
            onClose={() => onCloseWindow(win.id)}
          >
            <TerminalWindow agentId={win.id} />
          </FloatingWindow>
        )
      })}
    </div>
  )
}
