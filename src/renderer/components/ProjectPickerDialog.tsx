import React, { useState, useEffect } from 'react'
import type { RecentProject } from '../../shared/types'

declare const electronAPI: {
  listRecentProjects: () => Promise<RecentProject[]>
  openFolderDialog: () => Promise<string | null>
  switchProject: (path: string) => Promise<RecentProject>
}

interface ProjectPickerDialogProps {
  isFullScreen: boolean
  onProjectOpened: (project: RecentProject) => void
  onCancel?: () => void
}

export function ProjectPickerDialog({ isFullScreen, onProjectOpened, onCancel }: ProjectPickerDialogProps): React.ReactElement {
  const [recent, setRecent] = useState<RecentProject[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    electronAPI.listRecentProjects().then(setRecent)
  }, [])

  const handleOpenFolder = async () => {
    const folderPath = await electronAPI.openFolderDialog()
    if (!folderPath) return
    setLoading(true)
    const project = await electronAPI.switchProject(folderPath)
    onProjectOpened(project)
  }

  const handleSelectRecent = async (projectPath: string) => {
    setLoading(true)
    const project = await electronAPI.switchProject(projectPath)
    onProjectOpened(project)
  }

  const overlayStyle: React.CSSProperties = isFullScreen ? {
    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: '#1a1a1a',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 9999
  } : {
    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.7)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 9999
  }

  return (
    <div style={overlayStyle}>
      <div style={{
        backgroundColor: '#252525',
        borderRadius: '12px',
        border: '1px solid #333',
        padding: '32px',
        width: '480px',
        maxHeight: '600px',
        display: 'flex',
        flexDirection: 'column',
        gap: '20px'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0, color: '#e0e0e0', fontSize: '18px' }}>
            {isFullScreen ? 'Open a Project' : 'Switch Project'}
          </h2>
          {onCancel && (
            <button onClick={onCancel} style={{
              background: 'none', border: 'none', color: '#666',
              fontSize: '18px', cursor: 'pointer', padding: '4px'
            }}>x</button>
          )}
        </div>

        <button
          onClick={handleOpenFolder}
          disabled={loading}
          style={{
            padding: '12px 16px',
            borderRadius: '8px',
            border: '1px solid #4a9eff',
            backgroundColor: '#1e3a5f',
            color: '#8cc4ff',
            fontSize: '14px',
            cursor: loading ? 'wait' : 'pointer',
            textAlign: 'left'
          }}
        >
          Open Folder...
        </button>

        {recent.length > 0 && (
          <>
            <div style={{ color: '#888', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Recent Projects
            </div>
            <div style={{ overflow: 'auto', maxHeight: '360px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {recent.map(project => (
                <button
                  key={project.path}
                  onClick={() => handleSelectRecent(project.path)}
                  disabled={loading}
                  style={{
                    padding: '10px 12px',
                    borderRadius: '6px',
                    border: '1px solid #333',
                    backgroundColor: '#2a2a2a',
                    color: '#e0e0e0',
                    fontSize: '13px',
                    cursor: loading ? 'wait' : 'pointer',
                    textAlign: 'left',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '2px'
                  }}
                >
                  <span style={{ fontWeight: 500 }}>{project.name}</span>
                  <span style={{ color: '#666', fontSize: '11px' }}>{project.path}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {recent.length === 0 && (
          <div style={{ color: '#555', fontSize: '13px', textAlign: 'center', padding: '20px 0' }}>
            No recent projects. Open a folder to get started.
          </div>
        )}
      </div>
    </div>
  )
}
