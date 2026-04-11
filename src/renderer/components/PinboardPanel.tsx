import React, { useState, useEffect } from 'react'
import type { PinboardTask } from '../../shared/types'

const PRIORITY_COLORS: Record<PinboardTask['priority'], string> = {
  high: '#ef4444',
  medium: '#eab308',
  low: '#22c55e'
}

const COLUMN_CONFIG: { key: PinboardTask['status']; label: string; accent: string }[] = [
  { key: 'open', label: 'Open', accent: '#3b82f6' },
  { key: 'in_progress', label: 'In Progress', accent: '#eab308' },
  { key: 'completed', label: 'Completed', accent: '#22c55e' }
]

const STATUS_LABELS: Record<PinboardTask['status'], string> = {
  open: 'Open',
  in_progress: 'In Progress',
  completed: 'Completed'
}

function TaskCard({ task, onClick }: { task: PinboardTask; onClick: () => void }) {
  const desc = task.description.length > 120
    ? task.description.slice(0, 120) + '...'
    : task.description

  return (
    <div
      onClick={onClick}
      style={{
        backgroundColor: '#2a2a2a',
        border: '1px solid #333',
        borderRadius: '4px',
        padding: '8px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        cursor: 'pointer'
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.borderColor = '#555' }}
      onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.borderColor = '#333' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span style={{
          width: '8px', height: '8px', borderRadius: '50%',
          backgroundColor: PRIORITY_COLORS[task.priority],
          flexShrink: 0
        }} />
        <span style={{ color: '#e0e0e0', fontSize: '12px', fontWeight: 600, lineHeight: '1.3' }}>
          {task.title}
        </span>
      </div>

      {task.claimedBy && (
        <span style={{
          color: '#888', fontSize: '10px',
          padding: '1px 6px', backgroundColor: '#333', borderRadius: '3px',
          alignSelf: 'flex-start'
        }}>
          {task.claimedBy}
        </span>
      )}

      <span style={{ color: '#999', fontSize: '11px', lineHeight: '1.4' }}>
        {desc}
      </span>

      {task.result && (
        <span style={{
          color: '#6ee7b7', fontSize: '10px', lineHeight: '1.3',
          borderTop: '1px solid #333', paddingTop: '4px', marginTop: '2px'
        }}>
          {task.result.length > 80 ? task.result.slice(0, 80) + '...' : task.result}
        </span>
      )}
    </div>
  )
}

function TaskDetail({ task, onBack }: { task: PinboardTask; onBack: () => void }) {
  const statusColor = COLUMN_CONFIG.find(c => c.key === task.status)?.accent ?? '#888'

  return (
    <div style={{
      width: '100%', height: '100%',
      backgroundColor: '#1a1a1a',
      fontFamily: 'monospace',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden'
    }}>
      {/* Header */}
      <div style={{
        padding: '10px 12px',
        borderBottom: '1px solid #333',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        flexShrink: 0
      }}>
        <button
          onClick={onBack}
          style={{
            background: 'none', border: '1px solid #444', borderRadius: '4px',
            color: '#aaa', fontSize: '11px', cursor: 'pointer', padding: '2px 8px',
            fontFamily: 'monospace'
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = '#666' }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = '#444' }}
        >
          ← Back
        </button>
        <span style={{
          width: '8px', height: '8px', borderRadius: '50%',
          backgroundColor: PRIORITY_COLORS[task.priority],
          flexShrink: 0
        }} />
        <span style={{ color: '#e0e0e0', fontSize: '13px', fontWeight: 600, flex: 1 }}>
          {task.title}
        </span>
        <span style={{
          color: statusColor, fontSize: '10px', fontWeight: 600,
          padding: '2px 8px', border: `1px solid ${statusColor}`,
          borderRadius: '3px', textTransform: 'uppercase'
        }}>
          {STATUS_LABELS[task.status]}
        </span>
      </div>

      {/* Body */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: '12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px'
      }}>
        {/* Meta row */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', fontSize: '11px' }}>
          <div>
            <span style={{ color: '#666' }}>Priority: </span>
            <span style={{ color: PRIORITY_COLORS[task.priority] }}>{task.priority}</span>
          </div>
          {task.createdBy && (
            <div>
              <span style={{ color: '#666' }}>Created by: </span>
              <span style={{ color: '#aaa' }}>{task.createdBy}</span>
            </div>
          )}
          {task.claimedBy && (
            <div>
              <span style={{ color: '#666' }}>Claimed by: </span>
              <span style={{ color: '#aaa' }}>{task.claimedBy}</span>
            </div>
          )}
          <div>
            <span style={{ color: '#666' }}>Created: </span>
            <span style={{ color: '#aaa' }}>
              {new Date(task.createdAt).toLocaleString()}
            </span>
          </div>
          {task.targetRole && (
            <div>
              <span style={{ color: '#666' }}>Target role: </span>
              <span style={{ color: '#aaa' }}>{task.targetRole}</span>
            </div>
          )}
        </div>

        {/* Description */}
        <div>
          <div style={{ color: '#666', fontSize: '10px', textTransform: 'uppercase', marginBottom: '4px' }}>
            Description
          </div>
          <div style={{
            color: '#ccc', fontSize: '12px', lineHeight: '1.5',
            backgroundColor: '#222', borderRadius: '4px', padding: '10px',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word'
          }}>
            {task.description || '(none)'}
          </div>
        </div>

        {/* Result */}
        {task.result && (
          <div>
            <div style={{ color: '#666', fontSize: '10px', textTransform: 'uppercase', marginBottom: '4px' }}>
              Result
            </div>
            <div style={{
              color: '#6ee7b7', fontSize: '12px', lineHeight: '1.5',
              backgroundColor: '#1a2e1a', border: '1px solid #2a3e2a',
              borderRadius: '4px', padding: '10px',
              whiteSpace: 'pre-wrap', wordBreak: 'break-word'
            }}>
              {task.result}
            </div>
          </div>
        )}

        {/* Task ID */}
        <div style={{ fontSize: '10px', color: '#444', marginTop: 'auto' }}>
          ID: {task.id}
        </div>
      </div>
    </div>
  )
}

declare const electronAPI: {
  getPinboardTasks: (tabId?: string) => Promise<PinboardTask[]>
  clearCompletedTasks: () => Promise<{ status: string; cleared: number }>
  onPinboardUpdate: (cb: (tasks: PinboardTask[]) => void) => () => void
  getStaleAlertSnooze: () => Promise<{ muteUntil: number | null }>
  setStaleAlertSnooze: (durationMs: number | null) => Promise<{ muteUntil: number | null }>
  onStaleAlertUpdate: (cb: (state: { muteUntil: number | null }) => void) => () => void
}

const SNOOZE_OPTIONS: { label: string; ms: number }[] = [
  { label: '15 minutes', ms: 15 * 60 * 1000 },
  { label: '1 hour', ms: 60 * 60 * 1000 },
  { label: '4 hours', ms: 4 * 60 * 60 * 1000 },
  { label: '8 hours', ms: 8 * 60 * 60 * 1000 }
]

function SnoozeControl() {
  const [muteUntil, setMuteUntil] = useState<number | null>(null)
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    window.electronAPI.getStaleAlertSnooze().then(s => setMuteUntil(s.muteUntil))
    const cleanup = window.electronAPI.onStaleAlertUpdate(s => setMuteUntil(s.muteUntil))
    return cleanup
  }, [])

  // Local tick so the countdown display updates and we flip back to "Snooze" on expiry
  useEffect(() => {
    if (muteUntil === null) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [muteUntil])

  const isMuted = muteUntil !== null && now < muteUntil

  // Auto-clear local state when the snooze expires client-side
  useEffect(() => {
    if (muteUntil !== null && now >= muteUntil) setMuteUntil(null)
  }, [now, muteUntil])

  const handleSet = async (ms: number) => {
    setOpen(false)
    const s = await window.electronAPI.setStaleAlertSnooze(ms)
    setMuteUntil(s.muteUntil)
  }

  const handleUnmute = async () => {
    const s = await window.electronAPI.setStaleAlertSnooze(null)
    setMuteUntil(s.muteUntil)
  }

  const countdown = (() => {
    if (!isMuted || muteUntil === null) return ''
    const remaining = Math.max(0, muteUntil - now)
    const totalSec = Math.floor(remaining / 1000)
    const h = Math.floor(totalSec / 3600)
    const m = Math.floor((totalSec % 3600) / 60)
    const s = totalSec % 60
    if (h > 0) return `${h}h ${m}m`
    if (m > 0) return `${m}m ${s}s`
    return `${s}s`
  })()

  if (isMuted) {
    return (
      <button
        onClick={handleUnmute}
        title="Click to unmute stale task alerts"
        style={{
          background: '#3a2a1a', border: '1px solid #8a5a2a', borderRadius: '4px',
          color: '#f0a040', fontSize: '10px', cursor: 'pointer', padding: '1px 6px',
          fontFamily: 'monospace'
        }}
      >⏸ Muted {countdown}</button>
    )
  }

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(v => !v)}
        title="Snooze stale task alerts"
        style={{
          background: 'none', border: '1px solid #444', borderRadius: '4px',
          color: '#888', fontSize: '10px', cursor: 'pointer', padding: '1px 6px',
          fontFamily: 'monospace'
        }}
      >🔔 Snooze</button>
      {open && (
        <>
          <div
            onClick={() => setOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 10 }}
          />
          <div style={{
            position: 'absolute', top: '100%', right: 0, marginTop: '4px',
            backgroundColor: '#222', border: '1px solid #444', borderRadius: '4px',
            padding: '4px', zIndex: 11, minWidth: '110px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.5)'
          }}>
            {SNOOZE_OPTIONS.map(opt => (
              <button
                key={opt.ms}
                onClick={() => handleSet(opt.ms)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  background: 'none', border: 'none', color: '#ccc',
                  fontSize: '11px', padding: '4px 8px', cursor: 'pointer',
                  fontFamily: 'monospace', borderRadius: '3px'
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#333' }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent' }}
              >{opt.label}</button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

export function PinboardPanel({ tabId }: { tabId?: string }) {
  const [tasks, setTasks] = useState<PinboardTask[]>([])
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)

  useEffect(() => {
    window.electronAPI.getPinboardTasks(tabId).then(setTasks)
    const cleanup = window.electronAPI.onPinboardUpdate((allTasks) => {
      // Filter push updates by tab
      if (tabId) {
        setTasks(allTasks.filter(t => !t.tabId || t.tabId === tabId))
      } else {
        setTasks(allTasks)
      }
    })
    return cleanup
  }, [tabId])

  const completedCount = tasks.filter(t => t.status === 'completed').length

  const handleClearCompleted = async () => {
    try {
      await window.electronAPI.clearCompletedTasks()
      const updated = await window.electronAPI.getPinboardTasks(tabId)
      setTasks(updated)
    } catch { /* failed */ }
  }

  if (tasks.length === 0) {
    return (
      <div style={{
        width: '100%', height: '100%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        backgroundColor: '#1a1a1a', color: '#666',
        fontFamily: 'monospace', fontSize: '13px'
      }}>
        No tasks yet
      </div>
    )
  }

  // Show detail view if a task is selected
  const selectedTask = selectedTaskId ? tasks.find(t => t.id === selectedTaskId) : null
  if (selectedTask) {
    return <TaskDetail task={selectedTask} onBack={() => setSelectedTaskId(null)} />
  }

  const grouped = Object.fromEntries(
    COLUMN_CONFIG.map(c => [c.key, tasks.filter(t => t.status === c.key)])
  ) as Record<PinboardTask['status'], PinboardTask[]>

  return (
    <div style={{
      width: '100%', height: '100%',
      display: 'flex',
      backgroundColor: '#1a1a1a',
      fontFamily: 'monospace',
      overflow: 'hidden'
    }}>
      {COLUMN_CONFIG.map((col, i) => (
        <div key={col.key} style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          borderRight: i < COLUMN_CONFIG.length - 1 ? '1px solid #333' : 'none',
          overflow: 'hidden'
        }}>
          <div style={{
            padding: '8px 10px',
            borderBottom: '1px solid #333',
            display: 'flex', alignItems: 'center', gap: '6px',
            flexShrink: 0
          }}>
            <span style={{
              width: '6px', height: '6px', borderRadius: '50%',
              backgroundColor: col.accent
            }} />
            <span style={{ color: '#e0e0e0', fontSize: '12px', fontWeight: 600 }}>
              {col.label}
            </span>
            <span style={{
              color: '#888', fontSize: '11px',
              marginLeft: 'auto',
              backgroundColor: '#333', borderRadius: '8px',
              padding: '0 6px', lineHeight: '18px'
            }}>
              {grouped[col.key].length}
            </span>
            {col.key === 'completed' && completedCount > 0 && (
              <button
                onClick={handleClearCompleted}
                title="Clear all completed tasks"
                style={{
                  background: 'none', border: '1px solid #444', borderRadius: '4px',
                  color: '#888', fontSize: '10px', cursor: 'pointer', padding: '1px 6px'
                }}
              >Clear</button>
            )}
            {col.key === 'in_progress' && <SnoozeControl />}
          </div>

          <div style={{
            flex: 1,
            overflowY: 'auto',
            padding: '6px',
            display: 'flex',
            flexDirection: 'column',
            gap: '6px'
          }}>
            {grouped[col.key].map(task => (
              <TaskCard key={task.id} task={task} onClick={() => setSelectedTaskId(task.id)} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
