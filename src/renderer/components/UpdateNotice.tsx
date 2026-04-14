import React, { useState, useEffect, useRef } from 'react'

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
  restartApp: () => void
}

type Phase = 'notify' | 'confirm' | 'updating' | 'done' | 'failed'

export function UpdateNotice(): React.ReactElement | null {
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [phase, setPhase] = useState<Phase>('notify')
  const [errorMsg, setErrorMsg] = useState('')
  const [dismissed, setDismissed] = useState(false)
  const dismissedShaRef = useRef<string | null>(null)
  const dismissedAtRef = useRef<number>(0)
  const DISMISS_COOLDOWN_MS = 60 * 60 * 1000 // 1 hour

  useEffect(() => {
    const unsub = electronAPI.onUpdateAvailable((info: UpdateInfo) => {
      if (!info.available) return
      const sameSha = info.remoteSha === dismissedShaRef.current
      const withinCooldown = Date.now() - dismissedAtRef.current < DISMISS_COOLDOWN_MS
      if (sameSha && withinCooldown) return
      setUpdate(info)
      setPhase('notify')
      setDismissed(false)
    })
    electronAPI.checkForUpdate().then(info => {
      if (info?.available) {
        setUpdate(info)
      }
    })
    return unsub
  }, [])

  const handleConfirmUpdate = async () => {
    setPhase('updating')
    const res = await electronAPI.performUpdate()
    if (res.success) {
      setPhase('done')
    } else {
      setErrorMsg(res.error || 'Unknown error')
      setPhase('failed')
    }
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
      maxWidth: '360px',
      fontSize: '12px',
      color: '#e0e0e0',
      boxShadow: '0 4px 12px rgba(0,0,0,0.4)'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
        <span style={{ fontWeight: 600, color: '#8cc4ff' }}>Update Available</span>
        <button onClick={() => { setDismissed(true); if (update) { dismissedShaRef.current = update.remoteSha; dismissedAtRef.current = Date.now() } }} style={{
          background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: '14px', padding: '0 2px'
        }}>x</button>
      </div>
      <div style={{ color: '#aaa', fontSize: '11px', marginBottom: '4px' }}>
        {update.currentSha} {'\u2192'} {update.remoteSha}
      </div>
      <div style={{ color: '#ccc', fontSize: '11px', marginBottom: '8px' }}>
        {update.message}
      </div>

      {/* Phase: Initial notification */}
      {phase === 'notify' && (
        <div style={{ display: 'flex', gap: '6px' }}>
          <button onClick={() => setPhase('confirm')} style={{
            padding: '4px 12px', backgroundColor: '#2d5a2d', border: '1px solid #4caf50',
            borderRadius: '4px', color: '#4caf50', cursor: 'pointer', fontSize: '11px'
          }}>Update Now</button>
          <button onClick={() => { setDismissed(true); if (update) { dismissedShaRef.current = update.remoteSha; dismissedAtRef.current = Date.now() } }} style={{
            padding: '4px 12px', backgroundColor: 'transparent', border: '1px solid #444',
            borderRadius: '4px', color: '#888', cursor: 'pointer', fontSize: '11px'
          }}>Later</button>
        </div>
      )}

      {/* Phase: Confirmation warning */}
      {phase === 'confirm' && (
        <div>
          <div style={{
            padding: '6px 8px', backgroundColor: '#3a2a1a', border: '1px solid #d0a85c',
            borderRadius: '4px', marginBottom: '8px', fontSize: '11px', color: '#ffc107'
          }}>
            The Cog will restart after updating. All running agents will be stopped. Save any work before proceeding.
          </div>
          <div style={{ display: 'flex', gap: '6px' }}>
            <button onClick={handleConfirmUpdate} style={{
              padding: '4px 12px', backgroundColor: '#5a2d2d', border: '1px solid #f44336',
              borderRadius: '4px', color: '#f44336', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold'
            }}>Update + Restart</button>
            <button onClick={() => setPhase('notify')} style={{
              padding: '4px 12px', backgroundColor: 'transparent', border: '1px solid #444',
              borderRadius: '4px', color: '#888', cursor: 'pointer', fontSize: '11px'
            }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Phase: Updating */}
      {phase === 'updating' && (
        <div style={{ fontSize: '11px', color: '#ffc107' }}>
          Updating... pulling latest code and installing dependencies.
        </div>
      )}

      {/* Phase: Done — restart button */}
      {phase === 'done' && (
        <div>
          <div style={{ fontSize: '11px', color: '#4caf50', marginBottom: '6px' }}>
            Update complete. Restart to apply.
          </div>
          <button onClick={() => electronAPI.restartApp()} style={{
            padding: '4px 12px', backgroundColor: '#2d5a2d', border: '1px solid #4caf50',
            borderRadius: '4px', color: '#4caf50', cursor: 'pointer', fontSize: '11px'
          }}>Restart Now</button>
        </div>
      )}

      {/* Phase: Failed */}
      {phase === 'failed' && (
        <div>
          <div style={{ fontSize: '11px', color: '#f44336', marginBottom: '6px' }}>
            Update failed: {errorMsg}
          </div>
          <button onClick={() => setPhase('notify')} style={{
            padding: '4px 12px', backgroundColor: 'transparent', border: '1px solid #444',
            borderRadius: '4px', color: '#888', cursor: 'pointer', fontSize: '11px'
          }}>OK</button>
        </div>
      )}
    </div>
  )
}
