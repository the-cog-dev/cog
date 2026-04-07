import React, { useState, useRef, useEffect } from 'react'
import { AgentPill } from './AgentPill'
import { TabBar } from './TabBar'
import type { AgentState } from '../../shared/types'

const STATUS_COLORS: Record<string, string> = {
  idle: '#888',
  active: '#4caf50',
  working: '#ffc107',
  disconnected: '#f44336'
}

interface TopBarProps {
  projectName: string | null
  onSwitchProject: () => void
  agents: AgentState[]
  onSpawnClick: () => void
  onAgentClick: (agentId: string) => void
  onClearContext: (agentId: string) => void
  onDisconnectAgent: (agentName: string) => void
  onKillAgent: (agentId: string) => void
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
  usageOpen: boolean
  onToggleUsage: () => void
  gitOpen: boolean
  onToggleGit: () => void
  schedulesOpen: boolean
  onToggleSchedules: () => void
  onPresetsClick: () => void
  onBugReport: () => void
  onSettingsClick: () => void
  onHelpMcpToolsClick: () => void
  groups: Array<{ id: string; color: string; members: string[] }>
  onLinkDragStart: (agentName: string, e: React.MouseEvent) => void
  linkDraggingFrom: string | null
  tabs: Array<{ id: string; name: string }>
  activeTabId: string
  onSwitchTab: (tabId: string) => void
  onCreateTab: () => void
  onCloseTab: (tabId: string) => void
  onRenameTab: (tabId: string, name: string) => void
}

function DropdownMenu({ items, onClose, style }: {
  items: Array<{ label: string; onClick: () => void; color?: string; divider?: boolean }>
  onClose: () => void
  style?: React.CSSProperties
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  return (
    <div ref={ref} style={{
      position: 'absolute',
      top: '100%',
      left: 0,
      marginTop: '4px',
      backgroundColor: '#252525',
      border: '1px solid #444',
      borderRadius: '6px',
      padding: '4px 0',
      minWidth: '160px',
      zIndex: 100000,
      boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
      ...style
    }}>
      {items.map((item, i) => (
        <React.Fragment key={i}>
          {item.divider && <div style={{ height: '1px', backgroundColor: '#333', margin: '4px 0' }} />}
          <button
            onClick={() => { item.onClick(); onClose() }}
            style={{
              display: 'block',
              width: '100%',
              padding: '6px 14px',
              background: 'none',
              border: 'none',
              color: item.color || '#ccc',
              fontSize: '12px',
              cursor: 'pointer',
              textAlign: 'left',
            }}
            onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#333')}
            onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
          >
            {item.label}
          </button>
        </React.Fragment>
      ))}
    </div>
  )
}

export function TopBar({
  projectName, onSwitchProject, agents, onSpawnClick, onAgentClick,
  onClearContext, onDisconnectAgent, onKillAgent,
  pinboardOpen, onTogglePinboard, infoOpen, onToggleInfo,
  buddyOpen, onToggleBuddy, filesOpen, onToggleFiles,
  racOpen, onToggleRac, usageOpen, onToggleUsage,
  gitOpen, onToggleGit, schedulesOpen, onToggleSchedules,
  onPresetsClick, onBugReport, onSettingsClick, onHelpMcpToolsClick,
  groups, onLinkDragStart, linkDraggingFrom,
  tabs, activeTabId, onSwitchTab, onCreateTab, onCloseTab, onRenameTab
}: TopBarProps): React.ReactElement {
  const [agentMenuOpen, setAgentMenuOpen] = useState(false)
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null)
  const [panelMenu, setPanelMenu] = useState(false)
  const [helpMenu, setHelpMenu] = useState(false)

  const closeAgentMenu = () => { setAgentMenuOpen(false); setExpandedAgent(null) }

  const btnStyle: React.CSSProperties = {
    height: '28px',
    padding: '0 10px',
    borderRadius: '5px',
    border: '1px solid #444',
    backgroundColor: '#2a2a2a',
    color: '#999',
    fontSize: '12px',
    cursor: 'pointer',
    whiteSpace: 'nowrap'
  }

  const menuItemStyle: React.CSSProperties = {
    display: 'block', width: '100%', padding: '5px 14px', background: 'none',
    border: 'none', color: '#ccc', fontSize: '11px', cursor: 'pointer', textAlign: 'left',
  }
  const hoverIn = (e: React.MouseEvent) => (e.currentTarget.style.backgroundColor = '#333')
  const hoverOut = (e: React.MouseEvent) => (e.currentTarget.style.backgroundColor = 'transparent')

  const activePanelCount = [pinboardOpen, infoOpen, buddyOpen, filesOpen, racOpen, usageOpen, gitOpen, schedulesOpen].filter(Boolean).length

  return (
    <div style={{
      height: '44px',
      backgroundColor: '#1a1a1a',
      borderBottom: '1px solid #2a2a2a',
      display: 'flex',
      alignItems: 'center',
      padding: '0 12px',
      gap: '6px',
      flexShrink: 0
    }}>
      {/* Project name */}
      {projectName && (
        <button onClick={onSwitchProject} title="Switch Project" style={{
          ...btnStyle, border: '1px solid #333', backgroundColor: 'transparent', color: '#aaa',
          maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis'
        }}>
          {projectName}
        </button>
      )}
      {projectName && <div style={{ width: '1px', height: '24px', backgroundColor: '#333' }} />}

      {/* Workspace tabs */}
      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onSwitchTab={onSwitchTab}
        onCreateTab={onCreateTab}
        onCloseTab={onCloseTab}
        onRenameTab={onRenameTab}
      />

      <div style={{ width: '1px', height: '24px', backgroundColor: '#333' }} />

      {/* Spawn button */}
      <button onClick={onSpawnClick} style={{
        width: '30px', height: '30px', borderRadius: '6px', border: '1px solid #444',
        backgroundColor: '#2a2a2a', color: '#4caf50', fontSize: '18px', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center'
      }}>+</button>

      {/* Agents dropdown */}
      <div style={{ position: 'relative' }}>
        <button onClick={() => { setAgentMenuOpen(!agentMenuOpen); setExpandedAgent(null) }} style={{
          ...btnStyle,
          border: agents.length > 0 ? '1px solid #4caf50' : '1px solid #444',
          color: agents.length > 0 ? '#4caf50' : '#999',
        }}>
          Agents {agents.length > 0 && `(${agents.length})`}
        </button>
        {agentMenuOpen && (
          <div style={{
            position: 'absolute', top: '100%', left: 0, marginTop: '4px',
            backgroundColor: '#252525', border: '1px solid #444', borderRadius: '6px',
            padding: '4px 0', minWidth: '220px', zIndex: 100000,
            boxShadow: '0 4px 12px rgba(0,0,0,0.4)', maxHeight: '400px', overflow: 'auto'
          }}>
            {agents.length === 0 && (
              <div style={{ padding: '8px 14px', color: '#555', fontSize: '12px' }}>No agents running</div>
            )}
            {agents.map(agent => {
              const groupColor = groups.find(g => g.members.includes(agent.name))?.color
              const expanded = expandedAgent === agent.id
              return (
                <div key={agent.id} data-agent-name={agent.name}>
                  <button
                    onClick={() => setExpandedAgent(expanded ? null : agent.id)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '8px', width: '100%',
                      padding: '6px 14px', background: 'none', border: 'none',
                      color: '#ccc', fontSize: '12px', cursor: 'pointer', textAlign: 'left',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#333')}
                    onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                  >
                    <span style={{
                      width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                      backgroundColor: STATUS_COLORS[agent.status] ?? '#888',
                      border: groupColor ? `2px solid ${groupColor}` : 'none'
                    }} />
                    <span style={{ flex: 1 }}>{agent.name}</span>
                    <span style={{ color: '#666', fontSize: '10px' }}>{agent.role}</span>
                    <span style={{ color: '#555', fontSize: '10px' }}>{expanded ? '\u25B2' : '\u25BC'}</span>
                  </button>
                  {expanded && (
                    <div style={{ borderTop: '1px solid #333', borderBottom: '1px solid #333', backgroundColor: '#1e1e1e' }}>
                      <button onClick={() => { onAgentClick(agent.id); closeAgentMenu() }}
                        style={menuItemStyle} onMouseEnter={hoverIn} onMouseLeave={hoverOut}>
                        Focus Window
                      </button>
                      <button onClick={() => { onClearContext(agent.id); closeAgentMenu() }}
                        style={menuItemStyle} onMouseEnter={hoverIn} onMouseLeave={hoverOut}>
                        Clear Context
                      </button>
                      <button onClick={() => { onDisconnectAgent(agent.name); closeAgentMenu() }}
                        style={menuItemStyle} onMouseEnter={hoverIn} onMouseLeave={hoverOut}>
                        Disconnect Links
                      </button>
                      <button onClick={() => { onKillAgent(agent.id); closeAgentMenu() }}
                        style={{ ...menuItemStyle, color: '#f44336' }} onMouseEnter={hoverIn} onMouseLeave={hoverOut}>
                        Kill Agent
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div style={{ flex: 1 }} /> {/* spacer */}

      {/* Right side controls */}
      <div style={{ display: 'flex', gap: '4px', alignItems: 'center', flexShrink: 0 }}>
        {/* Panels dropdown */}
        <div style={{ position: 'relative' }}>
          <button onClick={() => setPanelMenu(!panelMenu)} style={{
            ...btnStyle,
            border: activePanelCount > 0 ? '1px solid #4a9eff' : '1px solid #444',
            color: activePanelCount > 0 ? '#8cc4ff' : '#999',
            backgroundColor: activePanelCount > 0 ? '#1e3a5f' : '#2a2a2a',
          }}>
            Panels {activePanelCount > 0 && `(${activePanelCount})`}
          </button>
          {panelMenu && (
            <DropdownMenu
              onClose={() => setPanelMenu(false)}
              style={{ right: 0, left: 'auto' }}
              items={[
                { label: `${gitOpen ? '\u25CF ' : '  '}Git`, onClick: onToggleGit, color: gitOpen ? '#8cc4ff' : '#888' },
                { label: `${filesOpen ? '\u25CF ' : '  '}Files`, onClick: onToggleFiles, color: filesOpen ? '#8cc4ff' : '#888' },
                { label: `${pinboardOpen ? '\u25CF ' : '  '}Pinboard`, onClick: onTogglePinboard, color: pinboardOpen ? '#8cc4ff' : '#888' },
                { label: `${infoOpen ? '\u25CF ' : '  '}Info Channel`, onClick: onToggleInfo, color: infoOpen ? '#8cc4ff' : '#888' },
                { label: `${buddyOpen ? '\u25CF ' : '  '}Buddy Room`, onClick: onToggleBuddy, color: buddyOpen ? '#8cc4ff' : '#888' },
                { label: `${usageOpen ? '\u25CF ' : '  '}Usage`, onClick: onToggleUsage, color: usageOpen ? '#8cc4ff' : '#888' },
                { label: `${racOpen ? '\u25CF ' : '  '}R.A.C.`, onClick: onToggleRac, color: racOpen ? '#8cc4ff' : '#888', divider: true },
                { label: `${schedulesOpen ? '\u25CF ' : '  '}Schedules`, onClick: onToggleSchedules, color: schedulesOpen ? '#8cc4ff' : '#888' },
              ]}
            />
          )}
        </div>

        <button onClick={onPresetsClick} style={btnStyle}>Presets</button>

        {/* Help dropdown */}
        <div style={{ position: 'relative' }}>
          <button onClick={() => setHelpMenu(!helpMenu)} style={btnStyle}>Help</button>
          {helpMenu && (
            <DropdownMenu
              onClose={() => setHelpMenu(false)}
              style={{ right: 0, left: 'auto' }}
              items={[
                { label: 'MCP Tools Reference', onClick: onHelpMcpToolsClick },
              ]}
            />
          )}
        </div>

        <div style={{ width: '1px', height: '24px', backgroundColor: '#333' }} />

        <button onClick={onBugReport} style={{ ...btnStyle, color: '#f44336', fontSize: '11px' }}>Bug?</button>
        <button onClick={onSettingsClick} style={{ ...btnStyle, color: '#888', fontSize: '14px' }}>{'\u2699'}</button>
      </div>
    </div>
  )
}
