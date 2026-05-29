import React, { useState } from 'react'
import type { ScheduledPrompt } from '../../shared/types'

interface Props {
  schedule: ScheduledPrompt
  agentName: string
  tabName: string
  now: number
  onPause: () => void
  onResume: () => void
  onStop: () => void
}

function formatHoursMinutes(ms: number): string {
  if (ms <= 0) return '0m'
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  const remMin = mins % 60
  return remMin === 0 ? `${hours}h` : `${hours}h ${remMin}m`
}

function formatClock(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function ScheduleRow({ schedule, agentName, tabName, now, onPause, onResume, onStop }: Props): React.ReactElement {
  const [showHistory, setShowHistory] = useState(false)

  const isPaused = schedule.status === 'paused'
  const timeLeft = schedule.expiresAt === null
    ? null
    : Math.max(0, schedule.expiresAt - now)
  const timeToNext = Math.max(0, schedule.nextFireAt - now)

  const intervalDisplay = schedule.intervalMinutes >= 60 && schedule.intervalMinutes % 60 === 0
    ? `${schedule.intervalMinutes / 60}h`
    : `${schedule.intervalMinutes}min`

  return (
    <div style={{
      background: '#2a2a2a', border: '1px solid #333', borderRadius: 4,
      padding: 10, display: 'flex', flexDirection: 'column', gap: 4,
      opacity: isPaused ? 0.6 : 1
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ color: '#e0e0e0', fontSize: 13, fontWeight: 600 }}>
          📅 {schedule.name}
          {schedule.createdBy && schedule.createdBy !== 'user'
            ? <span title={`Created by ${schedule.createdBy}`} style={{ fontSize: 11, color: '#9aa', marginLeft: 6 }}>
                🤖 {schedule.createdBy}
              </span>
            : <span title="Created by you" style={{ fontSize: 11, color: '#9aa', marginLeft: 6 }}>👤 you</span>}
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          {isPaused ? (
            <button onClick={onResume} title="Resume" style={btnStyle}>▶</button>
          ) : (
            <button onClick={onPause} title="Pause" style={btnStyle}>⏸</button>
          )}
          <button onClick={onStop} title="Stop" style={btnStyle}>■</button>
        </div>
      </div>

      <span style={{ color: '#888', fontSize: 11 }}>
        → {agentName} ({tabName})
      </span>

      <span style={{ color: '#999', fontSize: 11 }}>
        Every {intervalDisplay} · {timeLeft === null ? '∞ running' : `${formatHoursMinutes(timeLeft)} left`}
      </span>

      {!isPaused && (
        <span style={{ color: '#999', fontSize: 11 }}>
          Next: {formatClock(schedule.nextFireAt)} (in {formatHoursMinutes(timeToNext)})
        </span>
      )}

      <button
        onClick={() => setShowHistory(v => !v)}
        style={{
          background: 'transparent', color: '#888', border: 'none',
          padding: 0, cursor: 'pointer', fontSize: 11, textAlign: 'left'
        }}
      >
        {showHistory ? '▲' : '▼'} History ({schedule.fireHistory.length})
      </button>

      {showHistory && schedule.fireHistory.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingLeft: 8 }}>
          {[...schedule.fireHistory].reverse().map((entry, i) => (
            <span key={i} style={{ color: '#777', fontSize: 10 }}>
              {entry.outcome === 'fired' ? '✅' : '⚠'} {formatClock(entry.timestamp)} — {entry.outcome === 'fired' ? 'fired' : 'agent offline'}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

const btnStyle: React.CSSProperties = {
  background: '#333', color: '#e0e0e0', border: '1px solid #444',
  width: 24, height: 24, borderRadius: 3, cursor: 'pointer', fontSize: 11
}
