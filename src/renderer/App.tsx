import React, { useState, useCallback, useEffect } from 'react'
import { TopBar } from './components/TopBar'
import { Workspace } from './components/Workspace'
import { SpawnDialog } from './components/SpawnDialog'
import { PresetDialog } from './components/PresetDialog'
import { ProjectPickerDialog } from './components/ProjectPickerDialog'
import { useWindowManager } from './hooks/useWindowManager'
import { useAgents } from './hooks/useAgents'
import type { AgentConfig, RecentProject } from '../shared/types'

declare const electronAPI: {
  getProject: () => Promise<RecentProject | null>
  onProjectChanged: (callback: (project: unknown) => void) => () => void
  [key: string]: any
}

const PINBOARD_ID = '__pinboard__'
const INFO_ID = '__info__'

export function App(): React.ReactElement {
  const [showSpawnDialog, setShowSpawnDialog] = useState(false)
  const [showPresetDialog, setShowPresetDialog] = useState(false)
  const [project, setProject] = useState<RecentProject | null>(null)
  const [projectLoading, setProjectLoading] = useState(true)
  const [showProjectPicker, setShowProjectPicker] = useState(false)
  const {
    windows, zoom, pan,
    addWindow, removeWindow, focusWindow, minimizeWindow,
    setZoom, setPan, updateWindowPosition, updateWindowSize, zoomToFit
  } = useWindowManager()
  const { agents, spawnAgent, killAgent, getStatusColor } = useAgents()

  const pinboardOpen = windows.some(w => w.id === PINBOARD_ID)
  const infoOpen = windows.some(w => w.id === INFO_ID)

  const handleSpawn = useCallback(async (config: Omit<AgentConfig, 'id'>) => {
    setShowSpawnDialog(false)
    const agentId = await spawnAgent(config)
    addWindow(agentId, `${config.name} (${config.cli})`, getStatusColor('idle'))
  }, [spawnAgent, addWindow, getStatusColor])

  const handleClose = useCallback(async (windowId: string) => {
    // Panel windows just get removed, no agent to kill
    if (windowId === PINBOARD_ID || windowId === INFO_ID) {
      removeWindow(windowId)
      return
    }
    await killAgent(windowId)
    removeWindow(windowId)
  }, [killAgent, removeWindow])

  const handleAgentPillClick = useCallback((agentId: string) => {
    focusWindow(agentId)
  }, [focusWindow])

  const togglePinboard = useCallback(() => {
    if (pinboardOpen) {
      removeWindow(PINBOARD_ID)
    } else {
      addWindow(PINBOARD_ID, 'Pinboard')
    }
  }, [pinboardOpen, addWindow, removeWindow])

  const toggleInfo = useCallback(() => {
    if (infoOpen) {
      removeWindow(INFO_ID)
    } else {
      addWindow(INFO_ID, 'Info Channel')
    }
  }, [infoOpen, addWindow, removeWindow])

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
      // Ctrl+0 = reset zoom
      if (e.ctrlKey && e.key === '0' && !e.shiftKey) {
        setZoom(1.0)
        setPan(0, 0)
        e.preventDefault()
      }
      // Ctrl+Shift+0 = fit all
      if (e.ctrlKey && e.key === ')') {
        zoomToFit(window.innerWidth, window.innerHeight - 44)
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [windows, focusWindow, setZoom, setPan, zoomToFit])

  useEffect(() => {
    electronAPI.getProject().then((p: RecentProject | null) => {
      setProject(p)
      setProjectLoading(false)
    })
    const unsub = electronAPI.onProjectChanged((p: unknown) => {
      setProject(p as RecentProject | null)
      setProjectLoading(false)
    })
    return unsub
  }, [])

  const handleProjectOpened = useCallback((p: RecentProject) => {
    setProject(p)
    setShowProjectPicker(false)
  }, [])

  return (
    <div style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column' }}>
      {projectLoading ? null : !project ? (
        <ProjectPickerDialog isFullScreen onProjectOpened={handleProjectOpened} />
      ) : (
        <>
          <TopBar
            projectName={project.name}
            onSwitchProject={() => setShowProjectPicker(true)}
            agents={agents}
            onSpawnClick={() => setShowSpawnDialog(true)}
            onAgentClick={handleAgentPillClick}
            pinboardOpen={pinboardOpen}
            onTogglePinboard={togglePinboard}
            infoOpen={infoOpen}
            onToggleInfo={toggleInfo}
            onPresetsClick={() => setShowPresetDialog(true)}
          />
          <Workspace
            windows={windows}
            agents={agents}
            zoom={zoom}
            pan={pan}
            onSetZoom={setZoom}
            onSetPan={setPan}
            onZoomToFit={zoomToFit}
            onFocusWindow={focusWindow}
            onMinimizeWindow={minimizeWindow}
            onCloseWindow={handleClose}
            onDragStop={updateWindowPosition}
            onResizeStop={(id, x, y, w, h) => {
              updateWindowPosition(id, x, y)
              updateWindowSize(id, w, h)
            }}
          />
          {showSpawnDialog && (
            <SpawnDialog
              onSpawn={handleSpawn}
              onCancel={() => setShowSpawnDialog(false)}
            />
          )}
          {showPresetDialog && (
            <PresetDialog
              agents={agents}
              windows={windows}
              zoom={zoom}
              pan={pan}
              onLoadAgents={(configs) => {
                setShowPresetDialog(false)
                configs.forEach(config => handleSpawn(config))
              }}
              onClose={() => setShowPresetDialog(false)}
            />
          )}
          {showProjectPicker && (
            <ProjectPickerDialog
              isFullScreen={false}
              onProjectOpened={handleProjectOpened}
              onCancel={() => setShowProjectPicker(false)}
            />
          )}
        </>
      )}
    </div>
  )
}
