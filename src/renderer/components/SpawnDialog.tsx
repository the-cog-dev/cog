import React, { useState, useEffect } from 'react'
import type { AgentConfig } from '../../shared/types'
import { AgentConfigForm, emptyFormValue, buildSubmitConfig, type AgentConfigFormValue } from './AgentConfigForm'

interface SpawnDialogProps {
  onSpawn: (config: Omit<AgentConfig, 'id'>) => void
  onCancel: () => void
}

export function SpawnDialog({ onSpawn, onCancel }: SpawnDialogProps): React.ReactElement {
  const [form, setForm] = useState<AgentConfigFormValue>(() => emptyFormValue())

  useEffect(() => {
    window.electronAPI.getCwd().then(cwd => setForm(prev => ({ ...prev, cwd })))
  }, [])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSpawn(buildSubmitConfig(form))
  }

  return (
    <div style={overlayStyle}>
      <form onSubmit={handleSubmit} style={formStyle}>
        <h2 style={{ margin: 0, fontSize: '16px', color: '#e0e0e0' }}>New Agent</h2>
        <AgentConfigForm value={form} onChange={setForm} />
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '8px' }}>
          <button type="button" onClick={onCancel} style={cancelBtnStyle}>Cancel</button>
          <button type="submit" disabled={!form.name.trim()} style={spawnBtnStyle}>Spawn</button>
        </div>
      </form>
    </div>
  )
}

// Re-export CLI_MODELS for backward compat with PresetDialog.tsx (which imports it from here)
export { CLI_MODELS } from './AgentConfigForm'

const overlayStyle: React.CSSProperties = {
  position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
  backgroundColor: 'rgba(0,0,0,0.7)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 99999
}

const formStyle: React.CSSProperties = {
  backgroundColor: '#1e1e1e', border: '1px solid #333', borderRadius: '8px',
  padding: '24px', width: '450px', display: 'flex', flexDirection: 'column', gap: '12px'
}

const cancelBtnStyle: React.CSSProperties = {
  padding: '8px 16px', backgroundColor: '#2a2a2a', border: '1px solid #444',
  borderRadius: '4px', color: '#aaa', cursor: 'pointer', fontSize: '13px'
}

const spawnBtnStyle: React.CSSProperties = {
  padding: '8px 16px', backgroundColor: '#2d5a2d', border: '1px solid #4caf50',
  borderRadius: '4px', color: '#4caf50', cursor: 'pointer', fontSize: '13px'
}
