import React, { useRef, useCallback, useState, useEffect } from 'react'
import { FloatingWindow } from './FloatingWindow'
import { LinkOverlay } from './LinkOverlay'
import { SnapPreview } from './SnapPreview'
import { TerminalWindow } from './TerminalWindow'
import { PinboardPanel } from './PinboardPanel'
import { InfoChannelPanel } from './InfoChannelPanel'
import { FilePanel } from './FilePanel'
import { RacPanel } from './RacPanel'
import { UsagePanel } from './UsagePanel'
import { GitPanel } from './GitPanel'
import { SchedulesPanel } from './SchedulesPanel'
import { RacAgentChat } from './RacAgentChat'
import { ZoomControls } from './ZoomControls'
import type { WindowState } from '../hooks/useWindowManager'
import type { AgentState, WorkspaceTab } from '../../shared/types'
import type { SnapBounds, SnapZoneInfo, WindowBounds } from '../hooks/useSnapZones'

const PANEL_IDS: Record<string, string> = {
  '__pinboard__': 'pinboard',
  '__info__': 'info',
  '__files__': 'files',
  '__rac__': 'rac',
  '__usage__': 'usage',
  '__git__': 'git',
  '__schedules__': 'schedules',
}

// Extract panel type from a potentially tab-qualified ID (e.g. '__pinboard__::tab-1')
function getPanelType(id: string): string | undefined {
  for (const [prefix, type] of Object.entries(PANEL_IDS)) {
    if (id === prefix || id.startsWith(prefix + '::')) {
      return type
    }
  }
  return undefined
}

const STATUS_COLORS: Record<string, string> = {
  idle: '#888',
  active: '#4caf50',
  working: '#ffc107',
  disconnected: '#f44336'
}

interface WorkspaceProps {
  windows: WindowState[]
  agents: AgentState[]
  tabs: WorkspaceTab[]
  zoom: number
  pan: { x: number; y: number }
  links: Array<{ from: string; to: string }>
  groups: Array<{ id: string; color: string; members: string[] }>
  onAddLink: (from: string, to: string) => void
  onRemoveLink: (from: string, to: string) => void
  onSetZoom: (level: number) => void
  onSetPan: (x: number, y: number) => void
  onZoomToFit: (viewportWidth: number, viewportHeight: number) => void
  onFocusWindow: (id: string) => void
  onMinimizeWindow: (id: string) => void
  onCloseWindow: (id: string) => void
  onDragStop: (id: string, x: number, y: number) => void
  onResizeStop: (id: string, x: number, y: number, width: number, height: number) => void
  activeTabId?: string
}

export function Workspace({
  windows,
  agents,
  tabs,
  zoom,
  pan,
  links,
  groups,
  onAddLink,
  onRemoveLink,
  onSetZoom,
  onSetPan,
  onZoomToFit,
  onFocusWindow,
  onMinimizeWindow,
  onCloseWindow,
  onDragStop,
  onResizeStop,
  activeTabId
}: WorkspaceProps): React.ReactElement {
  const viewportRef = useRef<HTMLDivElement>(null)
  const [isPanning, setIsPanning] = useState(false)
  const panStartRef = useRef({ x: 0, y: 0 })
  const [transitionEnabled, setTransitionEnabled] = useState(false)
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [maximizedId, setMaximizedId] = useState<string | null>(null)
  const [snapPreview, setSnapPreview] = useState<SnapZoneInfo | null>(null)
  const [workspaceSize, setWorkspaceSize] = useState({ width: 0, height: 0 })
  const [restoreBoundsById, setRestoreBoundsById] = useState<Map<string, SnapBounds>>(new Map())
  const [linkDrawing, setLinkDrawing] = useState(false)
  const [linkFromAgent, setLinkFromAgent] = useState<string | null>(null)
  const [linkFromPos, setLinkFromPos] = useState<{ x: number; y: number } | null>(null)
  const [linkMousePos, setLinkMousePos] = useState<{ x: number; y: number } | null>(null)

  // Push workspace state to main process for Remote View (debounced 500ms)
  useEffect(() => {
    const timer = setTimeout(() => {
      const enriched = windows.map(win => {
        const panelType = getPanelType(win.id)
        const agent = !panelType ? agents.find(a => a.id === win.id) : undefined
        return {
          id: win.id,
          type: (agent ? 'agent' : 'panel') as 'agent' | 'panel',
          title: agent ? `${agent.name} (${agent.cli}) \u00B7 ${agent.role}` : win.title,
          x: win.x,
          y: win.y,
          width: win.width,
          height: win.height,
          minimized: win.minimized,
          ...(agent && {
            agent: {
              id: agent.id,
              name: agent.name,
              cli: agent.cli,
              model: agent.model,
              role: agent.role,
              status: agent.status,
              theme: agent.theme
            }
          }),
          ...(panelType && { panelType })
        }
      })
      window.electronAPI.pushWorkspaceState({
        windows: enriched,
        zoom,
        panX: pan.x,
        panY: pan.y
      })
    }, 500)
    return () => clearTimeout(timer)
  }, [windows, agents, zoom, pan])

  // Mirror workshop layout to main process so /state can serve per-agent
  // positions to remote clients (mobile, 3DS). Debounced to match the
  // adjacent pushWorkspaceState effect and avoid 60fps IPC during drags.
  useEffect(() => {
    const timer = setTimeout(() => {
      const layouts = windows.map(w => {
        const agent = agents.find(a => a.id === w.id)
        const group = agent?.groupId ? groups.find(g => g.id === agent.groupId) : null
        return {
          id: w.id,
          x: w.x,
          y: w.y,
          width: w.width,
          height: w.height,
          color: group?.color ?? '#888888'
        }
      })
      window.electronAPI.syncWorkshopLayout(layouts)
    }, 500)
    return () => clearTimeout(timer)
  }, [windows, agents, groups])

  // Clean up maximizedId if the window is removed
  useEffect(() => {
    if (maximizedId && !windows.find(w => w.id === maximizedId)) {
      setMaximizedId(null)
    }
  }, [windows, maximizedId])

  useEffect(() => {
    const activeIds = new Set(windows.map(window => window.id))
    setRestoreBoundsById(prev => {
      let changed = false
      const next = new Map<string, SnapBounds>()
      for (const [id, bounds] of prev) {
        if (activeIds.has(id)) {
          next.set(id, bounds)
        } else {
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [windows])

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return

    const updateSize = () => {
      setWorkspaceSize({
        width: el.clientWidth,
        height: el.clientHeight
      })
    }

    updateSize()

    const observer = new ResizeObserver(updateSize)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Use refs for zoom/pan so the native wheel handler stays current
  const zoomRef = useRef(zoom)
  const panRef = useRef(pan)
  zoomRef.current = zoom
  panRef.current = pan

  // Native wheel handler (passive: false so preventDefault works)
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return

    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        // Ctrl+Scroll = zoom centered on cursor
        e.preventDefault()

        setTransitionEnabled(false)
        if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current)
        scrollTimeoutRef.current = setTimeout(() => setTransitionEnabled(true), 150)

        const rect = el.getBoundingClientRect()
        const screenX = e.clientX - rect.left
        const screenY = e.clientY - rect.top

        const oldZoom = zoomRef.current
        const delta = e.deltaY > 0 ? -0.1 : 0.1
        const newZoom = Math.min(2.0, Math.max(0.25, oldZoom + delta))

        const p = panRef.current
        const canvasX = (screenX - p.x) / oldZoom
        const canvasY = (screenY - p.y) / oldZoom
        const newPanX = screenX - canvasX * newZoom
        const newPanY = screenY - canvasY * newZoom

        onSetZoom(newZoom)
        onSetPan(newPanX, newPanY)
      } else {
        // Bare scroll on empty canvas = pan vertically
        // Only pan if the event target is the viewport or canvas (not a terminal)
        const target = e.target as HTMLElement
        if (target === el || target.closest('[data-canvas]')) {
          e.preventDefault()
          const p = panRef.current
          onSetPan(p.x - e.deltaX, p.y - e.deltaY)
        }
      }
    }

    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [onSetZoom, onSetPan])

  // Middle-click drag = pan
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 1) {
      e.preventDefault()
      setIsPanning(true)
      panStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y }
    }
  }, [pan])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning) return
    onSetPan(e.clientX - panStartRef.current.x, e.clientY - panStartRef.current.y)
  }, [isPanning, onSetPan])

  const handleMouseUp = useCallback(() => {
    setIsPanning(false)
  }, [])

  const handleMaximize = useCallback((id: string) => {
    setMaximizedId(prev => prev === id ? null : id)
  }, [])

  const clearSnapState = useCallback((id: string) => {
    setRestoreBoundsById(prev => {
      if (!prev.has(id)) return prev
      const next = new Map(prev)
      next.delete(id)
      return next
    })
  }, [])

  const handleSnap = useCallback((id: string, bounds: SnapBounds, restoreBounds: SnapBounds) => {
    setRestoreBoundsById(prev => {
      const next = new Map(prev)
      next.set(id, restoreBounds)
      return next
    })
    onResizeStop(id, bounds.x, bounds.y, bounds.width, bounds.height)
    setSnapPreview(null)
  }, [onResizeStop])

  const handleLinkDragStart = useCallback((agentName: string, e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    setLinkDrawing(true)
    setLinkFromAgent(agentName)
    setLinkFromPos({ x: e.clientX, y: e.clientY })
    setLinkMousePos({ x: e.clientX, y: e.clientY })
  }, [])

  useEffect(() => {
    if (!linkDrawing) return
    const handleMove = (e: MouseEvent) => {
      setLinkMousePos({ x: e.clientX, y: e.clientY })
    }
    const handleUp = (e: MouseEvent) => {
      setLinkDrawing(false)
      setLinkMousePos(null)
      // Check if dropped on an agent window
      const target = document.elementFromPoint(e.clientX, e.clientY)
      const windowEl = target?.closest('[data-agent-name]') as HTMLElement | null
      if (windowEl && linkFromAgent) {
        const targetName = windowEl.getAttribute('data-agent-name')
        if (targetName && targetName !== linkFromAgent) {
          onAddLink(linkFromAgent, targetName)
        }
      }
      setLinkFromAgent(null)
      setLinkFromPos(null)
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [linkDrawing, linkFromAgent, onAddLink])

  const handleFitAll = useCallback(() => {
    if (!viewportRef.current) return
    const rect = viewportRef.current.getBoundingClientRect()
    setTransitionEnabled(true)
    onZoomToFit(rect.width, rect.height)
    setTimeout(() => setTransitionEnabled(false), 300)
  }, [onZoomToFit])

  const handleReset = useCallback(() => {
    setTransitionEnabled(true)
    onSetZoom(1.0)
    onSetPan(0, 0)
    setTimeout(() => setTransitionEnabled(false), 300)
  }, [onSetZoom, onSetPan])

  return (
    <div
      ref={viewportRef}
      style={{
        flex: 1,
        position: 'relative',
        overflow: 'hidden',
        backgroundColor: '#111',
        cursor: isPanning ? 'grabbing' : 'default'
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      {/* Canvas — transformed by zoom/pan */}
      <div
        data-canvas
        style={{
          transformOrigin: '0 0',
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transition: transitionEnabled ? 'transform 0.2s ease' : 'none',
          position: 'absolute',
          top: 0,
          left: 0
        }}
      >
        <LinkOverlay
          links={links}
          groups={groups}
          windows={windows}
          agents={agents}
          zoom={zoom}
          pan={pan}
          drawing={linkDrawing}
          drawFrom={linkFromPos}
          drawTo={linkMousePos}
          onRemoveLink={onRemoveLink}
        />
        {windows.map(win => {
          const panelType = getPanelType(win.id)
          const agent = !panelType ? agents.find(a => a.id === win.id) : undefined
          const statusColor = agent ? STATUS_COLORS[agent.status] ?? '#888' : undefined
          const title = agent
            ? `${agent.name} (${agent.cli}) \u00B7 ${agent.role}`
            : win.title

          let content: React.ReactNode
          if (panelType === 'pinboard') {
            content = <PinboardPanel tabId={activeTabId} />
          } else if (panelType === 'info') {
            content = <InfoChannelPanel tabId={activeTabId} />
          } else if (panelType === 'files') {
            content = <FilePanel />
          } else if (panelType === 'rac') {
            content = <RacPanel />
          } else if (panelType === 'usage') {
            content = <UsagePanel />
          } else if (panelType === 'git') {
            content = <GitPanel />
          } else if (panelType === 'schedules') {
            content = <SchedulesPanel agents={agents} tabs={tabs} />
          } else if (agent && agent.name.startsWith('rac-')) {
            content = <RacAgentChat agentName={agent.name} />
          } else {
            content = <TerminalWindow agentId={win.id} theme={agent?.theme} />
          }

          const otherWindows: WindowBounds[] = windows
            .filter(w => w.id !== win.id && !w.minimized)
            .map(w => ({ id: w.id, x: w.x, y: w.y, width: w.width, height: w.height }))

          return (
            <div key={win.id} data-agent-name={agent?.name}>
              <FloatingWindow
                id={win.id}
                title={title}
                statusColor={statusColor}
                x={win.x}
                y={win.y}
                width={win.width}
                height={win.height}
                zoom={zoom}
                pan={pan}
                zIndex={win.zIndex}
                minimized={win.minimized}
                maximized={maximizedId === win.id}
                workspaceWidth={workspaceSize.width}
                workspaceHeight={workspaceSize.height}
                otherWindows={otherWindows}
                restoreBounds={restoreBoundsById.get(win.id) ?? null}
                viewportRef={viewportRef}
                onFocus={() => onFocusWindow(win.id)}
                onMinimize={() => onMinimizeWindow(win.id)}
                onMaximize={() => handleMaximize(win.id)}
                onClose={() => onCloseWindow(win.id)}
                onDragStop={(nx, ny) => {
                  clearSnapState(win.id)
                  onDragStop(win.id, nx, ny)
                }}
                onResizeStop={(nx, ny, w, h) => {
                  clearSnapState(win.id)
                  onResizeStop(win.id, nx, ny, w, h)
                }}
                onSnapPreviewChange={setSnapPreview}
                onSnap={(bounds, restoreBounds) => handleSnap(win.id, bounds, restoreBounds)}
                isAgent={!!agent}
                groupColor={agent ? groups.find(g => g.members.includes(agent.name))?.color : undefined}
                onLinkDragStart={agent ? (e: React.MouseEvent) => handleLinkDragStart(agent.name, e) : undefined}
                theme={agent?.theme}
                agentId={agent?.id}
              >
                {content}
              </FloatingWindow>
            </div>
          )
        })}
      </div>

      <SnapPreview bounds={snapPreview?.bounds ?? null} />

      {/* Zoom controls — outside canvas transform */}
      <ZoomControls
        zoom={zoom}
        onZoomIn={() => onSetZoom(Math.min(2.0, zoom + 0.1))}
        onZoomOut={() => onSetZoom(Math.max(0.25, zoom - 0.1))}
        onReset={handleReset}
        onFitAll={handleFitAll}
      />
    </div>
  )
}
