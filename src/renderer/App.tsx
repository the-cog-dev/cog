import React, { useState, useCallback, useEffect } from 'react'
import { TopBar } from './components/TopBar'
import { Workspace } from './components/Workspace'
import { SpawnDialog } from './components/SpawnDialog'
import { useWindowManager } from './hooks/useWindowManager'
import { useAgents } from './hooks/useAgents'
import type { AgentConfig } from '../shared/types'

export function App(): React.ReactElement {
  const [showSpawnDialog, setShowSpawnDialog] = useState(false)
  const { windows, addWindow, removeWindow, focusWindow, minimizeWindow } = useWindowManager()
  const { agents, spawnAgent, killAgent, getStatusColor } = useAgents()

  const handleSpawn = useCallback(async (config: Omit<AgentConfig, 'id'>) => {
    setShowSpawnDialog(false)
    const agentId = await spawnAgent(config)
    addWindow(agentId, `${config.name} (${config.cli})`, getStatusColor('idle'))
  }, [spawnAgent, addWindow, getStatusColor])

  const handleClose = useCallback(async (agentId: string) => {
    await killAgent(agentId)
    removeWindow(agentId)
  }, [killAgent, removeWindow])

  const handleAgentPillClick = useCallback((agentId: string) => {
    focusWindow(agentId)
  }, [focusWindow])

  // Keyboard shortcuts: Ctrl+1..9 to focus windows, Ctrl+Tab to cycle
  useEffect(() => {
    let currentFocusIdx = 0
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key) - 1
        if (windows[idx]) {
          focusWindow(windows[idx].id)
          currentFocusIdx = idx
        }
        e.preventDefault()
      }
      if (e.ctrlKey && e.key === 'Tab') {
        if (windows.length > 0) {
          currentFocusIdx = (currentFocusIdx + 1) % windows.length
          focusWindow(windows[currentFocusIdx].id)
        }
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [windows, focusWindow])

  return (
    <div style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <TopBar
        agents={agents}
        onSpawnClick={() => setShowSpawnDialog(true)}
        onAgentClick={handleAgentPillClick}
      />
      <Workspace
        windows={windows}
        agents={agents}
        onFocusWindow={focusWindow}
        onMinimizeWindow={minimizeWindow}
        onCloseWindow={handleClose}
      />
      {showSpawnDialog && (
        <SpawnDialog
          onSpawn={handleSpawn}
          onCancel={() => setShowSpawnDialog(false)}
        />
      )}
    </div>
  )
}
