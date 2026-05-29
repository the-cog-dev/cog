import { useEffect, useRef, useState } from 'react'
import type { BoardPage } from '../../shared/types'
import { BoardPageCanvas } from './BoardPageCanvas'
import type { ToolState } from './BoardPageCanvas'
import { BoardToolbar } from './BoardToolbar'

export function Workboard() {
  const [pages, setPages] = useState<BoardPage[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [loading, setLoading] = useState(true)
  const [tool, setTool] = useState<ToolState>({ kind: 'select', color: '#ffd400', width: 4 })
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const ps = await window.electronAPI.boardListPages()
      if (cancelled) return
      if (ps.length === 0) {
        const p = await window.electronAPI.boardAddPage()
        if (!cancelled) setPages(p ? [p] : [])
      } else {
        setPages(ps)
      }
      if (!cancelled) {
        setCurrentIndex(0)
        setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  const handlePageChange = (updated: BoardPage) => {
    setPages(prev => prev.map(p => p.id === updated.id ? updated : p))
    if (debounceRef.current !== null) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      window.electronAPI.boardSavePage(updated)
    }, 600)
  }

  const handleAdd = async () => {
    const p = await window.electronAPI.boardAddPage()
    if (p) {
      const ps = await window.electronAPI.boardListPages()
      setPages(ps)
      setCurrentIndex(ps.findIndex(x => x.id === p.id))
    }
  }

  const handleDelete = async () => {
    if (pages.length <= 1) return
    const id = pages[currentIndex].id
    await window.electronAPI.boardDeletePage(id)
    const ps = await window.electronAPI.boardListPages()
    setPages(ps)
    setCurrentIndex(prev => Math.min(prev, ps.length - 1))
  }

  if (loading || pages.length === 0) {
    return (
      <div style={{
        width: '100%', height: '100%', background: '#141414', color: '#555',
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'monospace'
      }}>
        {loading ? 'Loading…' : 'No pages'}
      </div>
    )
  }

  const page = pages[currentIndex]

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden', background: '#141414' }}>
      {/* Navigator bar */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 44,
        background: '#1a1a1a', borderBottom: '1px solid #2a2a2a',
        display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px',
        fontFamily: 'monospace', fontSize: 13, color: '#ccc', zIndex: 10,
        userSelect: 'none'
      }}>
        <button
          onClick={() => setCurrentIndex(i => i - 1)}
          disabled={currentIndex === 0}
          style={navBtnStyle(currentIndex === 0)}
          title="Previous page"
        >◀</button>

        <span style={{ minWidth: 100, textAlign: 'center' }}>
          Page {currentIndex + 1} / {pages.length}
        </span>

        <button
          onClick={() => setCurrentIndex(i => i + 1)}
          disabled={currentIndex === pages.length - 1}
          style={navBtnStyle(currentIndex === pages.length - 1)}
          title="Next page"
        >▶</button>

        <div style={{ flex: 1 }} />

        <button onClick={handleAdd} style={navBtnStyle(false)} title="Add page">
          ＋ Add
        </button>

        <button
          onClick={handleDelete}
          disabled={pages.length <= 1}
          style={navBtnStyle(pages.length <= 1)}
          title="Delete page"
        >🗑 Delete</button>
      </div>

      {/* Tool palette */}
      <BoardToolbar tool={tool} setTool={setTool} />

      {/* Page canvas */}
      <BoardPageCanvas page={page} tool={tool} onChange={handlePageChange} />
    </div>
  )
}

function navBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    background: disabled ? '#222' : '#2c2c2c',
    border: '1px solid #383838',
    borderRadius: 4,
    color: disabled ? '#444' : '#bbb',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontFamily: 'monospace',
    fontSize: 12,
    padding: '3px 8px',
    transition: 'background 0.15s',
  }
}
