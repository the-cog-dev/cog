import React from 'react'
import { AgentPill } from './AgentPill'
import type { AgentState } from '../../shared/types'

interface TopBarProps {
  projectName: string | null
  onSwitchProject: () => void
  agents: AgentState[]
  onSpawnClick: () => void
  onAgentClick: (agentId: string) => void
  pinboardOpen: boolean
  onTogglePinboard: () => void
  infoOpen: boolean
  onToggleInfo: () => void
  buddyOpen: boolean
  onToggleBuddy: () => void
  filesOpen: boolean
  onToggleFiles: () => void
  racOpen: boolean
  onToggleRac: () => void
  onPresetsClick: () => void
}

const toggleBtnStyle = (active: boolean): React.CSSProperties => ({
  height: '28px',
  padding: '0 10px',
  borderRadius: '5px',
  border: active ? '1px solid #4a9eff' : '1px solid #444',
  backgroundColor: active ? '#1e3a5f' : '#2a2a2a',
  color: active ? '#8cc4ff' : '#999',
  fontSize: '12px',
  cursor: 'pointer',
  whiteSpace: 'nowrap'
})

export function TopBar({ projectName, onSwitchProject, agents, onSpawnClick, onAgentClick, pinboardOpen, onTogglePinboard, infoOpen, onToggleInfo, buddyOpen, onToggleBuddy, filesOpen, onToggleFiles, racOpen, onToggleRac, onPresetsClick }: TopBarProps): React.ReactElement {
  return (
    <div style={{
      height: '44px',
      backgroundColor: '#1a1a1a',
      borderBottom: '1px solid #2a2a2a',
      display: 'flex',
      alignItems: 'center',
      padding: '0 12px',
      gap: '8px',
      flexShrink: 0
    }}>
      {projectName && (
        <button
          onClick={onSwitchProject}
          title="Switch Project"
          style={{
            height: '28px',
            padding: '0 10px',
            borderRadius: '5px',
            border: '1px solid #333',
            backgroundColor: 'transparent',
            color: '#aaa',
            fontSize: '12px',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            maxWidth: '200px',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
        >
          {projectName}
        </button>
      )}
      {projectName && (
        <div style={{ width: '1px', height: '24px', backgroundColor: '#333', margin: '0 4px' }} />
      )}
      <button
        onClick={onSpawnClick}
        style={{
          width: '32px',
          height: '32px',
          borderRadius: '6px',
          border: '1px solid #444',
          backgroundColor: '#2a2a2a',
          color: '#4caf50',
          fontSize: '18px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        +
      </button>
      <div style={{ width: '1px', height: '24px', backgroundColor: '#333', margin: '0 4px' }} />
      {agents.map(agent => (
        <AgentPill
          key={agent.id}
          agent={agent}
          onClick={() => onAgentClick(agent.id)}
        />
      ))}
      {agents.length === 0 && (
        <span style={{ color: '#555', fontSize: '13px' }}>Click + to spawn an agent</span>
      )}
      <div style={{ marginLeft: 'auto', display: 'flex', gap: '6px', alignItems: 'center' }}>
        <button onClick={onToggleRac} style={toggleBtnStyle(racOpen)}>R.A.C.</button>
        <button onClick={onToggleFiles} style={toggleBtnStyle(filesOpen)}>Files</button>
        <button onClick={onTogglePinboard} style={toggleBtnStyle(pinboardOpen)}>Pinboard</button>
        <button onClick={onToggleInfo} style={toggleBtnStyle(infoOpen)}>Info</button>
        <button onClick={onToggleBuddy} style={toggleBtnStyle(buddyOpen)}>Buddy</button>
        <div style={{ width: '1px', height: '24px', backgroundColor: '#333' }} />
        <button onClick={onPresetsClick} style={toggleBtnStyle(false)}>Presets</button>
      </div>
    </div>
  )
}
