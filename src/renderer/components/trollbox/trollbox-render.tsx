import React from 'react'

export function formatTs(ms: number): string {
  const d = new Date(ms)
  return d.toTimeString().slice(0, 5)
}

const URL_RE = /(https?:\/\/[^\s<>"']+)/g

export function renderMessageText(text: string): React.ReactNode[] {
  // 1) Split on triple-backtick blocks first.
  const parts: React.ReactNode[] = []
  const tripleRe = /```([\s\S]*?)```/g
  let lastIdx = 0
  let match: RegExpExecArray | null
  let key = 0
  while ((match = tripleRe.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parts.push(renderLineSegment(text.slice(lastIdx, match.index), key++))
    }
    parts.push(
      <pre
        key={key++}
        style={{
          background: '#0d0d0d',
          padding: '6px 8px',
          margin: '4px 0',
          borderRadius: 3,
          overflowX: 'auto',
          fontSize: '12px',
        }}
      >
        {match[1]}
      </pre>
    )
    lastIdx = match.index + match[0].length
  }
  if (lastIdx < text.length) {
    parts.push(renderLineSegment(text.slice(lastIdx), key++))
  }
  return parts
}

function renderLineSegment(segment: string, key: number): React.ReactNode {
  // 2) Single-backticks → inline <code>, then linkify URLs inside non-code runs.
  const nodes: React.ReactNode[] = []
  const tickRe = /`([^`]+)`/g
  let lastIdx = 0
  let match: RegExpExecArray | null
  let sub = 0
  while ((match = tickRe.exec(segment)) !== null) {
    if (match.index > lastIdx) {
      nodes.push(...linkify(segment.slice(lastIdx, match.index), `${key}-${sub++}`))
    }
    nodes.push(
      <code
        key={`${key}-${sub++}`}
        style={{ background: '#0d0d0d', padding: '1px 4px', borderRadius: 2 }}
      >
        {match[1]}
      </code>
    )
    lastIdx = match.index + match[0].length
  }
  if (lastIdx < segment.length) {
    nodes.push(...linkify(segment.slice(lastIdx), `${key}-${sub++}`))
  }
  return <span key={key}>{nodes}</span>
}

function linkify(s: string, keyBase: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  let lastIdx = 0
  let match: RegExpExecArray | null
  let i = 0
  URL_RE.lastIndex = 0
  while ((match = URL_RE.exec(s)) !== null) {
    if (match.index > lastIdx) nodes.push(s.slice(lastIdx, match.index))
    nodes.push(
      <a
        key={`${keyBase}-${i++}`}
        href={match[1]}
        target="_blank"
        rel="noopener noreferrer"
        style={{ color: '#8cc4ff' }}
      >
        {match[1]}
      </a>
    )
    lastIdx = match.index + match[0].length
  }
  if (lastIdx < s.length) nodes.push(s.slice(lastIdx))
  return nodes
}

export const BAN_DURATIONS: Array<{ label: string; ms: number }> = [
  { label: '5 min',  ms: 5 * 60_000 },
  { label: '15 min', ms: 15 * 60_000 },
  { label: '30 min', ms: 30 * 60_000 },
  { label: '1 hour', ms: 60 * 60_000 },
  { label: '24 hr',  ms: 24 * 60 * 60_000 },
]
