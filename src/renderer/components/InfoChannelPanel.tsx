import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { InfoEntry } from '../../shared/types'
import { useContainCanvasScroll } from '../hooks/useContainCanvasScroll'

const containerStyle: React.CSSProperties = {
  width: '100%',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  backgroundColor: '#1a1a1a',
  color: '#e0e0e0',
  fontFamily: 'Consolas, "SFMono-Regular", Menlo, Monaco, monospace',
  overflow: 'hidden'
}

const scrollStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  overflowX: 'hidden',
  padding: '8px 0'
}

const emptyStateStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#666',
  fontSize: '12px',
  padding: '16px'
}

const cardStyle: React.CSSProperties = {
  margin: '0 8px',
  padding: '10px 12px',
  backgroundColor: '#2a2a2a',
  borderBottom: '1px solid #3a3a3a',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word'
}

const agentLabelStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '2px 8px',
  borderRadius: '999px',
  backgroundColor: '#19324d',
  border: '1px solid #2d4d73',
  color: '#8cc4ff',
  fontSize: '11px',
  lineHeight: 1.4
}

const metaRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '8px',
  marginBottom: '8px'
}

const tagStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '2px 7px',
  borderRadius: '999px',
  backgroundColor: '#333',
  border: '1px solid #444',
  color: '#b5b5b5',
  fontSize: '10px',
  lineHeight: 1.4
}

function formatTimestamp(value: string): string {
  const time = new Date(value).getTime()
  if (Number.isNaN(time)) return value

  const diffMs = Date.now() - time
  if (diffMs < 0) {
    return new Date(value).toLocaleString()
  }

  const diffSeconds = Math.floor(diffMs / 1000)
  if (diffSeconds < 10) return 'just now'
  if (diffSeconds < 60) return `${diffSeconds}s ago`

  const diffMinutes = Math.floor(diffSeconds / 60)
  if (diffMinutes < 60) return `${diffMinutes}m ago`

  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) return `${diffHours}h ago`

  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 7) return `${diffDays}d ago`

  return new Date(value).toLocaleString()
}

function sortNewestFirst(entries: InfoEntry[]): InfoEntry[] {
  return [...entries].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
}

export function InfoChannelPanel({ tabId }: { tabId?: string }): React.ReactElement {
  const [entries, setEntries] = useState<InfoEntry[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const attachWheelGuard = useContainCanvasScroll<HTMLDivElement>()

  useEffect(() => {
    let isMounted = true

    const loadEntries = async () => {
      const nextEntries = await window.electronAPI.getInfoEntries(tabId)
      if (isMounted) {
        setEntries(sortNewestFirst(nextEntries))
      }
    }

    void loadEntries()

    const cleanup = window.electronAPI.onInfoUpdate((updatedEntries) => {
      // Filter push updates by tab
      const filtered = tabId
        ? updatedEntries.filter(e => !e.tabId || e.tabId === tabId)
        : updatedEntries
      setEntries(sortNewestFirst(filtered))
      if (scrollRef.current) {
        scrollRef.current.scrollTop = 0
      }
    })

    return () => {
      isMounted = false
      cleanup()
    }
  }, [tabId])

  const renderedEntries = useMemo(() => sortNewestFirst(entries), [entries])

  return (
    <div ref={attachWheelGuard} style={containerStyle}>
      {renderedEntries.length === 0 ? (
        <div style={emptyStateStyle}>No info entries yet</div>
      ) : (
        <div ref={scrollRef} style={scrollStyle}>
          {renderedEntries.map(entry => (
            <article key={entry.id} style={cardStyle}>
              <div style={metaRowStyle}>
                <span style={agentLabelStyle}>{entry.from}</span>
                <span style={{ color: '#7a7a7a', fontSize: '11px', flexShrink: 0 }}>
                  {formatTimestamp(entry.createdAt)}
                </span>
              </div>

              <div style={{ fontSize: '12px', lineHeight: 1.5 }}>{entry.note}</div>

              {entry.tags.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' }}>
                  {entry.tags.map(tag => (
                    <span key={`${entry.id}-${tag}`} style={tagStyle}>
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  )
}
