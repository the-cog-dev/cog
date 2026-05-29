import { useCallback, useEffect, useRef } from 'react'
import type { BoardPage } from '../../shared/types'

const MAX_HISTORY = 50

interface UseBoardHistoryOpts {
  page: BoardPage
  onChange: (p: BoardPage) => void
}

interface UseBoardHistoryResult {
  /** Call instead of onChange for user-initiated edits that should be undoable. */
  commit: (nextPage: BoardPage) => void
}

/**
 * Per-page snapshot-based undo/redo.
 *
 * - `past` and `future` stacks are scoped to the current page id and reset
 *   whenever the page id changes (i.e. user navigates to a different board page).
 * - `commit(nextPage)` pushes the CURRENT page onto `past`, clears `future`,
 *   then calls `onChange(nextPage)`.
 * - Ctrl+Z / Cmd+Z → undo; Ctrl+Y / Ctrl+Shift+Z → redo.
 * - Keyboard shortcuts are ignored when focus is in a text input/textarea/
 *   contentEditable so native text undo still works inside notes.
 */
export function useBoardHistory({ page, onChange }: UseBoardHistoryOpts): UseBoardHistoryResult {
  const pastRef = useRef<BoardPage[]>([])
  const futureRef = useRef<BoardPage[]>([])

  // Track the page id so we can reset history on navigation.
  const pageIdRef = useRef<string>(page.id)

  // Keep a stable ref to the current page so undo/redo handlers always see it.
  const pageRef = useRef<BoardPage>(page)
  pageRef.current = page

  // Keep a stable ref to onChange.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  // Reset stacks when page id changes (board page navigation).
  if (page.id !== pageIdRef.current) {
    pageIdRef.current = page.id
    pastRef.current = []
    futureRef.current = []
  }

  const commit = useCallback((nextPage: BoardPage) => {
    // Push current snapshot onto past (capped at MAX_HISTORY)
    const newPast = [...pastRef.current, pageRef.current]
    if (newPast.length > MAX_HISTORY) newPast.splice(0, newPast.length - MAX_HISTORY)
    pastRef.current = newPast
    futureRef.current = []
    onChangeRef.current(nextPage)
  }, [])

  const undo = useCallback(() => {
    const past = pastRef.current
    if (past.length === 0) return
    const prev = past[past.length - 1]
    pastRef.current = past.slice(0, past.length - 1)
    futureRef.current = [pageRef.current, ...futureRef.current]
    onChangeRef.current(prev)
  }, [])

  const redo = useCallback(() => {
    const future = futureRef.current
    if (future.length === 0) return
    const next = future[0]
    futureRef.current = future.slice(1)
    pastRef.current = [...pastRef.current, pageRef.current]
    onChangeRef.current(next)
  }, [])

  // Keyboard listener — attached to window while this hook is mounted.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore when focus is in a text field so native undo still works there.
      const active = document.activeElement
      if (
        active &&
        (active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          (active as HTMLElement).isContentEditable)
      ) {
        return
      }

      const ctrlOrCmd = e.ctrlKey || e.metaKey

      if (ctrlOrCmd && !e.shiftKey && e.key === 'z') {
        e.preventDefault()
        undo()
        return
      }

      if (ctrlOrCmd && (e.key === 'y' || (e.shiftKey && e.key === 'z') || (e.shiftKey && e.key === 'Z'))) {
        e.preventDefault()
        redo()
        return
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [undo, redo])

  return { commit }
}
