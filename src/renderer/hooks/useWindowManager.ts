import { useState, useCallback, useRef } from 'react'

export interface WindowState {
  id: string
  title: string
  statusColor?: string
  x: number
  y: number
  width: number
  height: number
  zIndex: number
  minimized: boolean
  tabId?: string
}

let nextZ = 1

export function useWindowManager() {
  const [windows, setWindows] = useState<Map<string, WindowState>>(new Map())

  const [zoom, setZoomState] = useState(1.0)
  const [pan, setPanState] = useState({ x: 0, y: 0 })

  // Refs for stable closures (addWindow needs current zoom/pan without recreating)
  const zoomRef = useRef(1.0)
  const panRef = useRef({ x: 0, y: 0 })

  const setZoom = useCallback((level: number) => {
    const clamped = Math.min(2.0, Math.max(0.25, level))
    zoomRef.current = clamped
    setZoomState(clamped)
  }, [])

  const setPan = useCallback((x: number, y: number) => {
    panRef.current = { x, y }
    setPanState({ x, y })
  }, [])

  const updateWindowPosition = useCallback((id: string, x: number, y: number) => {
    setWindows(prev => {
      const win = prev.get(id)
      if (!win) return prev
      const next = new Map(prev)
      next.set(id, { ...win, x, y })
      return next
    })
  }, [])

  const updateWindowSize = useCallback((id: string, width: number, height: number) => {
    setWindows(prev => {
      const win = prev.get(id)
      if (!win) return prev
      const next = new Map(prev)
      next.set(id, { ...win, width, height })
      return next
    })
  }, [])

  const zoomToFit = useCallback((viewportWidth: number, viewportHeight: number, tabId?: string) => {
    setWindows(prev => {
      let wins = Array.from(prev.values())
      if (tabId) wins = wins.filter(w => w.tabId === tabId)
      if (wins.length === 0) return prev

      const padding = 60
      const minX = Math.min(...wins.map(w => w.x))
      const minY = Math.min(...wins.map(w => w.y))
      const maxX = Math.max(...wins.map(w => w.x + w.width))
      const maxY = Math.max(...wins.map(w => w.y + w.height))

      const bboxWidth = maxX - minX
      const bboxHeight = maxY - minY

      const newZoom = Math.min(
        2.0,
        Math.max(0.25, Math.min(
          viewportWidth / (bboxWidth + padding),
          viewportHeight / (bboxHeight + padding)
        ))
      )

      const centerX = (minX + maxX) / 2
      const centerY = (minY + maxY) / 2

      zoomRef.current = newZoom
      panRef.current = {
        x: viewportWidth / 2 - centerX * newZoom,
        y: viewportHeight / 2 - centerY * newZoom
      }
      setZoomState(newZoom)
      setPanState(panRef.current)

      return prev // don't modify windows, just read them
    })
  }, [])

  const addWindow = useCallback((id: string, title: string, statusColor?: string, tabId?: string) => {
    setWindows(prev => {
      const next = new Map(prev)
      // Only count windows in the same tab for offset calculation
      const tabWins = tabId ? Array.from(next.values()).filter(w => w.tabId === tabId) : Array.from(next.values())
      const offset = tabWins.length * 30
      const z = zoomRef.current
      const p = panRef.current
      const canvasX = (window.innerWidth / 2 - p.x) / z - 300 + offset
      const canvasY = (window.innerHeight / 2 - p.y) / z - 200 + offset
      next.set(id, {
        id,
        title,
        statusColor,
        tabId,
        x: canvasX,
        y: canvasY,
        width: 600,
        height: 400,
        zIndex: ++nextZ,
        minimized: false
      })
      return next
    })
  }, []) // stable — uses refs, no zoom/pan in deps

  const addWindowAt = useCallback((id: string, title: string, x: number, y: number, width: number, height: number, statusColor?: string, tabId?: string) => {
    setWindows(prev => {
      const next = new Map(prev)
      next.set(id, {
        id,
        title,
        statusColor,
        tabId,
        x,
        y,
        width,
        height,
        zIndex: ++nextZ,
        minimized: false
      })
      return next
    })
  }, [])

  const removeWindow = useCallback((id: string) => {
    setWindows(prev => {
      const next = new Map(prev)
      next.delete(id)
      return next
    })
  }, [])

  const focusWindow = useCallback((id: string) => {
    setWindows(prev => {
      const win = prev.get(id)
      if (!win) return prev
      const next = new Map(prev)
      next.set(id, { ...win, zIndex: ++nextZ, minimized: false })
      return next
    })
  }, [])

  const minimizeWindow = useCallback((id: string) => {
    setWindows(prev => {
      const win = prev.get(id)
      if (!win) return prev
      const next = new Map(prev)
      next.set(id, { ...win, minimized: true })
      return next
    })
  }, [])

  const updateStatusColor = useCallback((id: string, color: string) => {
    setWindows(prev => {
      const win = prev.get(id)
      if (!win) return prev
      const next = new Map(prev)
      next.set(id, { ...win, statusColor: color })
      return next
    })
  }, [])

  return {
    windows: Array.from(windows.values()),
    zoom,
    pan,
    setZoom,
    setPan,
    addWindow,
    addWindowAt,
    removeWindow,
    focusWindow,
    minimizeWindow,
    updateStatusColor,
    updateWindowPosition,
    updateWindowSize,
    zoomToFit
  }
}
