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

function TaskCard({ task }: { task: PinboardTask }) {
  const desc = task.description.length > 120
    ? task.description.slice(0, 120) + '...'
    : task.description

  return (
    <div style={{
      backgroundColor: '#2a2a2a',
      border: '1px solid #333',
      borderRadius: '4px',
      padding: '8px 10px',
      display: 'flex',
      flexDirection: 'column',
      gap: '4px'
    }}>
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

declare const electronAPI: {
  getPinboardTasks: () => Promise<PinboardTask[]>
  clearCompletedTasks: () => Promise<{ status: string; cleared: number }>
  onPinboardUpdate: (cb: (tasks: PinboardTask[]) => void) => () => void
}

export function PinboardPanel() {
  const [tasks, setTasks] = useState<PinboardTask[]>([])

  useEffect(() => {
    window.electronAPI.getPinboardTasks().then(setTasks)
    const cleanup = window.electronAPI.onPinboardUpdate(setTasks)
    return cleanup
  }, [])

  const completedCount = tasks.filter(t => t.status === 'completed').length

  const handleClearCompleted = async () => {
    try {
      await window.electronAPI.clearCompletedTasks()
      const updated = await window.electronAPI.getPinboardTasks()
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
              <TaskCard key={task.id} task={task} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
