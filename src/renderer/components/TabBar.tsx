import React, { useState } from 'react'

interface Tab {
  id: string
  name: string
  projectPath?: string
}

interface TabBarProps {
  tabs: Tab[]
  activeTabId: string
  onSwitchTab: (tabId: string) => void
  onCreateTab: () => void
  onCloseTab: (tabId: string) => void
  onRenameTab: (tabId: string, name: string) => void
}

export function TabBar({ tabs, activeTabId, onSwitchTab, onCreateTab, onCloseTab, onRenameTab }: TabBarProps): React.ReactElement {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')

  const startRename = (tab: Tab) => {
    setEditingId(tab.id)
    setEditName(tab.name)
  }

  const confirmRename = () => {
    if (editingId && editName.trim()) {
      onRenameTab(editingId, editName.trim())
    }
    setEditingId(null)
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
      {tabs.map(tab => (
        <div
          key={tab.id}
          onClick={() => onSwitchTab(tab.id)}
          title={tab.projectPath ? `📁 ${tab.projectPath}` : `${tab.name} — double-click to rename; use + to add a folder-bound workspace`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            padding: '4px 10px',
            backgroundColor: tab.id === activeTabId ? '#333' : 'transparent',
            border: tab.id === activeTabId ? '1px solid #555' : '1px solid transparent',
            borderRadius: '4px 4px 0 0',
            cursor: 'pointer',
            fontSize: '11px',
            color: tab.id === activeTabId ? '#e0e0e0' : '#888',
            whiteSpace: 'nowrap',
            maxWidth: '140px',
          }}
        >
          {editingId === tab.id ? (
            <input
              value={editName}
              onChange={e => setEditName(e.target.value)}
              onBlur={confirmRename}
              onKeyDown={e => { if (e.key === 'Enter') confirmRename(); if (e.key === 'Escape') setEditingId(null) }}
              onClick={e => e.stopPropagation()}
              autoFocus
              style={{
                width: '80px', backgroundColor: '#2a2a2a', border: '1px solid #4a9eff',
                borderRadius: '2px', padding: '1px 4px', color: '#e0e0e0', fontSize: '11px',
                outline: 'none'
              }}
            />
          ) : (
            <span
              onDoubleClick={(e) => { e.stopPropagation(); startRename(tab) }}
              style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}
            >
              {tab.projectPath ? '📁 ' : ''}{tab.name}
            </span>
          )}
          {tabs.length > 1 && (
            <span
              onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id) }}
              style={{ color: '#666', fontSize: '12px', cursor: 'pointer', marginLeft: '2px' }}
            >x</span>
          )}
        </div>
      ))}
      <button
        onClick={onCreateTab}
        title="New workspace — pick a project folder for its team"
        style={{
          width: '22px', height: '22px', borderRadius: '4px',
          border: '1px solid #444', backgroundColor: 'transparent',
          color: '#888', fontSize: '14px', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}
      >+</button>
    </div>
  )
}
