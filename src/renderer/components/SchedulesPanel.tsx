import React, { useEffect, useMemo, useState } from 'react'
import type { ScheduledPrompt, CreateScheduleInput, EditScheduleInput, AgentState, WorkspaceTab } from '../../shared/types'
import { ScheduleDialog, type AgentOption } from './ScheduleDialog'
import { ScheduleRow } from './ScheduleRow'
import { PastScheduleRow } from './PastScheduleRow'

interface Props {
  agents: AgentState[]
  tabs: WorkspaceTab[]
}

export function SchedulesPanel({ agents, tabs }: Props): React.ReactElement {
  const [schedules, setSchedules] = useState<ScheduledPrompt[]>([])
  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogMode, setDialogMode] = useState<'create' | 'edit'>('create')
  const [editTarget, setEditTarget] = useState<ScheduledPrompt | null>(null)
  const [showPast, setShowPast] = useState(true)
  const [now, setNow] = useState(Date.now())

  // Client-side countdown refresh — pure local, no IPC
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [])

  // Initial fetch + listen for updates from main
  useEffect(() => {
    void refresh()
    const unsub = window.electronAPI.onSchedulesUpdated((list) => {
      setSchedules(list as ScheduledPrompt[])
    })
    return () => { unsub() }
  }, [])

  async function refresh() {
    const list = await window.electronAPI.listSchedules() as ScheduledPrompt[]
    setSchedules(list)
  }

  const agentOptions: AgentOption[] = useMemo(() => {
    return agents.map(a => {
      const tab = tabs.find(t => t.id === a.tabId) ?? tabs[0]
      return { id: a.id, name: a.name, tabId: a.tabId ?? tab?.id ?? 'tab-default', tabName: tab?.name ?? 'Workspace' }
    })
  }, [agents, tabs])

  const agentNameById = (id: string) => agents.find(a => a.id === id)?.name ?? '(deleted)'
  const tabNameById = (id: string) => tabs.find(t => t.id === id)?.name ?? '(deleted tab)'

  const active = schedules.filter(s => s.status === 'active' || s.status === 'paused')
  const past = schedules.filter(s => s.status === 'stopped' || s.status === 'expired')

  async function handleCreate(input: CreateScheduleInput) {
    try {
      await window.electronAPI.createSchedule(input)
      setDialogOpen(false)
      await refresh()
    } catch (err) {
      console.error('Failed to create schedule', err)
      alert(`Failed to create schedule: ${(err as Error).message}`)
    }
  }

  async function handleEdit(id: string, updates: EditScheduleInput) {
    try {
      await window.electronAPI.editSchedule(id, updates)
      setDialogOpen(false)
      setEditTarget(null)
      await refresh()
    } catch (err) {
      console.error('Failed to edit schedule', err)
      alert(`Failed to edit schedule: ${(err as Error).message}`)
    }
  }

  return (
    <div style={{
      background: '#1a1a1a', color: '#e0e0e0', padding: 12, height: '100%',
      overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0, fontSize: 14 }}>Schedules</h3>
        <button
          onClick={() => { setDialogMode('create'); setEditTarget(null); setDialogOpen(true) }}
          disabled={agents.length === 0}
          style={{
            background: '#3b82f6', color: '#fff', border: 'none',
            padding: '4px 10px', borderRadius: 4, cursor: agents.length === 0 ? 'not-allowed' : 'pointer',
            fontSize: 12, opacity: agents.length === 0 ? 0.4 : 1
          }}
        >
          + New
        </button>
      </div>

      {active.length === 0 && past.length === 0 && (
        <div style={{ color: '#666', fontSize: 12, fontStyle: 'italic' }}>
          No schedules yet. Click <strong>+ New</strong> to create one.
        </div>
      )}

      {active.map(s => (
        <ScheduleRow
          key={s.id}
          schedule={s}
          agentName={agentNameById(s.agentId)}
          tabName={tabNameById(s.tabId)}
          now={now}
          onPause={async () => { await window.electronAPI.pauseSchedule(s.id); await refresh() }}
          onResume={async () => { await window.electronAPI.resumeSchedule(s.id); await refresh() }}
          onStop={async () => { await window.electronAPI.stopSchedule(s.id); await refresh() }}
        />
      ))}

      {past.length > 0 && (
        <>
          <button
            onClick={() => setShowPast(v => !v)}
            style={{
              background: 'transparent', color: '#888', border: 'none',
              padding: '4px 0', cursor: 'pointer', fontSize: 11, textAlign: 'left',
              borderTop: '1px solid #2a2a2a', marginTop: 6
            }}
          >
            ─── Past schedules ({past.length}) {showPast ? '▲' : '▼'} ───
          </button>
          {showPast && past.map(s => (
            <PastScheduleRow
              key={s.id}
              schedule={s}
              agentName={agentNameById(s.agentId)}
              tabName={tabNameById(s.tabId)}
              onRestart={async () => { await window.electronAPI.restartSchedule(s.id); await refresh() }}
              onEdit={() => { setDialogMode('edit'); setEditTarget(s); setDialogOpen(true) }}
              onDelete={async () => {
                if (confirm(`Delete "${s.name}"?`)) {
                  await window.electronAPI.deleteSchedule(s.id)
                  await refresh()
                }
              }}
            />
          ))}
        </>
      )}

      <ScheduleDialog
        open={dialogOpen}
        mode={dialogMode}
        agents={agentOptions}
        initialValues={editTarget ?? undefined}
        onSubmit={(result) => {
          if ('id' in result) {
            void handleEdit(result.id, result.updates)
          } else {
            void handleCreate(result)
          }
        }}
        onClose={() => { setDialogOpen(false); setEditTarget(null) }}
      />
    </div>
  )
}
