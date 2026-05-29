import { useCallback, useRef } from 'react'

// Stop wheel events from bubbling to the workspace canvas, which has a native
// wheel listener that pans/zooms whenever it sees a wheel inside `[data-canvas]`.
// React's synthetic onWheel fires after that listener during DOM bubble, so a
// native listener attached directly to the scroll container is required.
//
// Returns a callback ref so the listener auto-attaches when the element mounts
// and detaches when it unmounts — works even for elements that conditionally
// render (e.g. empty-state branches that swap in a scroll container later).
export function useContainCanvasScroll<T extends HTMLElement>(): (node: T | null) => void {
  const attachedRef = useRef<T | null>(null)
  return useCallback((node: T | null) => {
    const prev = attachedRef.current
    if (prev) {
      prev.removeEventListener('wheel', stopWheel)
    }
    if (node) {
      node.addEventListener('wheel', stopWheel, { passive: true })
    }
    attachedRef.current = node
  }, [])
}

function stopWheel(e: WheelEvent): void {
  e.stopPropagation()
}
