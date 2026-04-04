import React, { useState, useEffect } from 'react'

interface UpdateInfo {
  available: boolean
  currentSha: string
  remoteSha: string
  message: string
  date: string
}

declare const electronAPI: {
  onUpdateAvailable: (callback: (info: UpdateInfo) => void) => () => void
  checkForUpdate: () => Promise<UpdateInfo | null>
  performUpdate: () => Promise<{ success: boolean; error?: string }>
}

export function UpdateNotice(): React.ReactElement | null {
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [updating, setUpdating] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    const unsub = electronAPI.onUpdateAvailable((info: UpdateInfo) => {
      if (info.available) {
        setUpdate(info)
        setDismissed(false)
      }
    })
    // Also check on mount
    electronAPI.checkForUpdate().then(info => {
      if (info?.available) {
        setUpdate(info)
      }
    })
    return unsub
  }, [])

  const handleUpdate = async () => {
    setUpdating(true)
    setResult(null)
    const res = await electronAPI.performUpdate()
    if (res.success) {
      setResult('Updated! Restart AgentOrch to apply.')
    } else {
      setResult(`Failed: ${res.error}`)
    }
    setUpdating(false)
  }

  if (!update || !update.available || dismissed) return null

  return (
    <div style={{
      position: 'fixed',
      bottom: '12px',
      left: '12px',
      backgroundColor: '#1e3a5f',
      border: '1px solid #4a9eff',
      borderRadius: '8px',
      padding: '10px 14px',
      zIndex: 99999,
      maxWidth: '340px',
      fontSize: '12px',
      color: '#e0e0e0',
      boxShadow: '0 4px 12px rgba(0,0,0,0.4)'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
        <span style={{ fontWeight: 600, color: '#8cc4ff' }}>Update Available</span>
        <button onClick={() => setDismissed(true)} style={{
          background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: '14px', padding: '0 2px'
        }}>x</button>
      </div>
      <div style={{ color: '#aaa', fontSize: '11px', marginBottom: '4px' }}>
        {update.currentSha} &rarr; {update.remoteSha}
      </div>
      <div style={{ color: '#ccc', fontSize: '11px', marginBottom: '8px' }}>
        {update.message}
      </div>
      {result ? (
        <div style={{ fontSize: '11px', color: result.startsWith('Updated') ? '#4caf50' : '#f44336' }}>
          {result}
        </div>
      ) : (
        <div style={{ display: 'flex', gap: '6px' }}>
          <button onClick={handleUpdate} disabled={updating} style={{
            padding: '4px 12px', backgroundColor: '#2d5a2d', border: '1px solid #4caf50',
            borderRadius: '4px', color: '#4caf50', cursor: 'pointer', fontSize: '11px'
          }}>{updating ? 'Updating...' : 'Update Now'}</button>
          <button onClick={() => setDismissed(true)} style={{
            padding: '4px 12px', backgroundColor: 'transparent', border: '1px solid #444',
            borderRadius: '4px', color: '#888', cursor: 'pointer', fontSize: '11px'
          }}>Later</button>
        </div>
      )}
    </div>
  )
}
