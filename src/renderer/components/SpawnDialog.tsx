import React, { useState, useEffect } from 'react'
import type { AgentConfig } from '../../shared/types'

interface SpawnDialogProps {
  onSpawn: (config: Omit<AgentConfig, 'id'>) => void
  onCancel: () => void
}

const CLI_PRESETS = [
  { label: 'Claude Code', value: 'claude' },
  { label: 'Codex CLI', value: 'codex' },
  { label: 'Kimi CLI', value: 'kimi' },
  { label: 'Plain Terminal', value: 'terminal' },
  { label: 'Custom', value: '' }
]

export function SpawnDialog({ onSpawn, onCancel }: SpawnDialogProps): React.ReactElement {
  const [name, setName] = useState('')
  const [cli, setCli] = useState('claude')
  const [customCli, setCustomCli] = useState('')
  const [cwd, setCwd] = useState('')
  const [role, setRole] = useState('')
  const [ceoNotes, setCeoNotes] = useState('')
  const [admin, setAdmin] = useState(false)
  const [autoMode, setAutoMode] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [promptRegex, setPromptRegex] = useState('')

  // Fetch cwd from main process (process.cwd is unavailable in renderer with contextIsolation)
  useEffect(() => {
    window.electronAPI.getCwd().then(setCwd)
  }, [])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSpawn({
      name: name.trim(),
      cli: cli || customCli.trim(),
      cwd: cwd.trim(),
      role: role.trim(),
      ceoNotes: ceoNotes.trim(),
      admin,
      autoMode,
      promptRegex: promptRegex.trim() || undefined
    })
  }

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 99999
    }}>
      <form
        onSubmit={handleSubmit}
        style={{
          backgroundColor: '#1e1e1e',
          border: '1px solid #333',
          borderRadius: '8px',
          padding: '24px',
          width: '450px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px'
        }}
      >
        <h2 style={{ margin: 0, fontSize: '16px', color: '#e0e0e0' }}>New Agent</h2>

        <label style={labelStyle}>
          Name
          <input value={name} onChange={e => setName(e.target.value)} required style={inputStyle} placeholder="worker-1" />
        </label>

        <label style={labelStyle}>
          CLI
          <select value={cli} onChange={e => setCli(e.target.value)} style={inputStyle}>
            {CLI_PRESETS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </label>

        {cli === '' && (
          <label style={labelStyle}>
            Custom Command
            <input value={customCli} onChange={e => setCustomCli(e.target.value)} required style={inputStyle} placeholder="my-agent --flag" />
          </label>
        )}

        <label style={labelStyle}>
          Working Directory
          <input value={cwd} onChange={e => setCwd(e.target.value)} style={inputStyle} />
        </label>

        <label style={labelStyle}>
          Role
          <input value={role} onChange={e => setRole(e.target.value)} style={inputStyle} placeholder="Decompiler" />
        </label>

        <label style={labelStyle}>
          CEO Notes
          <textarea
            value={ceoNotes}
            onChange={e => setCeoNotes(e.target.value)}
            style={{ ...inputStyle, height: '80px', resize: 'vertical' }}
            placeholder="Instructions for this agent..."
          />
        </label>

        <label style={{ ...labelStyle, flexDirection: 'row', alignItems: 'center', gap: '8px' }}>
          <input type="checkbox" checked={autoMode} onChange={e => setAutoMode(e.target.checked)} />
          Auto-approve mode
          <span style={{ color: '#666', fontSize: '11px' }}>
            {cli === 'claude' ? '(--dangerously-skip-permissions)' :
             cli === 'codex' ? '(--yolo)' : '(auto-run)'}
          </span>
        </label>

        <label style={{ ...labelStyle, flexDirection: 'row', alignItems: 'center', gap: '8px' }}>
          <input type="checkbox" checked={admin} onChange={e => setAdmin(e.target.checked)} />
          Run as admin
        </label>

        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          style={{ background: 'none', border: 'none', color: '#666', cursor: 'pointer', textAlign: 'left', fontSize: '12px' }}
        >
          {showAdvanced ? '\u25BC' : '\u25B6'} Advanced
        </button>

        {showAdvanced && (
          <label style={labelStyle}>
            Prompt Regex Override
            <input value={promptRegex} onChange={e => setPromptRegex(e.target.value)} style={inputStyle} placeholder="[>❯]\\s*$" />
          </label>
        )}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '8px' }}>
          <button type="button" onClick={onCancel} style={cancelBtnStyle}>Cancel</button>
          <button type="submit" disabled={!name.trim()} style={spawnBtnStyle}>Spawn</button>
        </div>
      </form>
    </div>
  )
}

const labelStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: '4px',
  fontSize: '12px', color: '#aaa'
}

const inputStyle: React.CSSProperties = {
  backgroundColor: '#2a2a2a', border: '1px solid #444', borderRadius: '4px',
  padding: '8px', color: '#e0e0e0', fontSize: '13px', fontFamily: 'inherit'
}

const cancelBtnStyle: React.CSSProperties = {
  padding: '8px 16px', backgroundColor: '#2a2a2a', border: '1px solid #444',
  borderRadius: '4px', color: '#aaa', cursor: 'pointer', fontSize: '13px'
}

const spawnBtnStyle: React.CSSProperties = {
  padding: '8px 16px', backgroundColor: '#2d5a2d', border: '1px solid #4caf50',
  borderRadius: '4px', color: '#4caf50', cursor: 'pointer', fontSize: '13px'
}
