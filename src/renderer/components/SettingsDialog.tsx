import React, { useState, useEffect, useMemo } from 'react'
import QRCode from 'qrcode-svg'

declare const electronAPI: {
  getSettings: () => Promise<Record<string, any>>
  setSetting: (key: string, value: unknown) => Promise<{ status: string }>
  enableRemoteView: () => Promise<{ ok: boolean }>
  disableRemoteView: () => Promise<{ ok: boolean }>
  getRemoteViewState: () => Promise<{ enabled: boolean; publicUrl: string | null; connectionCount: number; lastActivity: number | null }>
  killRemoteSessions: () => Promise<{ ok: boolean; newUrl?: string | null }>
  regenerateRemoteToken: () => Promise<{ ok: boolean; newUrl?: string | null }>
  onRemoteStatusUpdate: (cb: (s: { enabled: boolean; publicUrl: string | null; connectionCount: number; lastActivity: number | null }) => void) => () => void
  onRemoteSetupProgress: (cb: (p: { stage: 'downloading' | 'starting' | 'ready' | 'error'; message?: string }) => void) => () => void
}

interface SettingsDialogProps {
  onClose: () => void
}

export function SettingsDialog({ onClose }: SettingsDialogProps): React.ReactElement {
  const [settings, setSettings] = useState<Record<string, any>>({})
  const [remoteState, setRemoteState] = useState({ enabled: false, publicUrl: null as string | null, connectionCount: 0, lastActivity: null as number | null })
  const [setupProgress, setSetupProgress] = useState<{ stage: string; message?: string } | null>(null)
  const [showQr, setShowQr] = useState(false)

  const qrSvg = useMemo(() => {
    if (!remoteState.publicUrl) return null
    try {
      return new QRCode({
        content: remoteState.publicUrl,
        padding: 2,
        width: 220,
        height: 220,
        color: '#e0e0e0',
        background: '#1e1e1e',
        ecl: 'M'
      }).svg()
    } catch {
      return null
    }
  }, [remoteState.publicUrl])

  useEffect(() => {
    electronAPI.getSettings().then(setSettings)
    electronAPI.getRemoteViewState().then(setRemoteState)

    const unsubStatus = electronAPI.onRemoteStatusUpdate((s) => setRemoteState(s))
    const unsubProgress = electronAPI.onRemoteSetupProgress((p) => {
      setSetupProgress(p)
      if (p.stage === 'ready' || p.stage === 'error') {
        setTimeout(() => setSetupProgress(null), 2500)
      }
    })

    return () => {
      unsubStatus()
      unsubProgress()
    }
  }, [])

  const toggle = async (key: string, defaultVal: boolean) => {
    const current = settings[key] ?? defaultVal
    const newVal = !current
    await electronAPI.setSetting(key, newVal)
    setSettings(prev => ({ ...prev, [key]: newVal }))
  }

  const toggleRemote = async () => {
    if (remoteState.enabled) {
      await electronAPI.disableRemoteView()
    } else {
      await electronAPI.enableRemoteView()
    }
  }

  const copyUrl = () => {
    if (remoteState.publicUrl) {
      navigator.clipboard.writeText(remoteState.publicUrl)
    }
  }

  const killSessions = async () => {
    if (confirm('Kill all active remote sessions and rotate the token?')) {
      await electronAPI.killRemoteSessions()
    }
  }

  const regenerate = async () => {
    if (confirm('Generate a new token? Anyone using the old URL will be disconnected.')) {
      await electronAPI.regenerateRemoteToken()
    }
  }

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 100002
    }}>
      <div style={{
        backgroundColor: '#1e1e1e', border: '1px solid #333', borderRadius: '8px',
        padding: '24px', width: '440px', maxHeight: 'calc(100vh - 80px)', overflowY: 'auto',
        display: 'flex', flexDirection: 'column', gap: '16px'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: '16px', color: '#e0e0e0' }}>Settings</h2>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: '#666', fontSize: '24px', cursor: 'pointer', lineHeight: 1
          }}>x</button>
        </div>

        {/* Notifications section */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ fontSize: '12px', color: '#888', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Notifications
          </div>

          <label style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '8px', backgroundColor: '#252525', borderRadius: '4px', cursor: 'pointer'
          }}>
            <div>
              <div style={{ fontSize: '13px', color: '#e0e0e0' }}>Task completion alerts</div>
              <div style={{ fontSize: '11px', color: '#666' }}>Show a system notification when tasks are completed</div>
            </div>
            <div
              onClick={() => toggle('notifications', true)}
              style={{
                width: 40, height: 22, borderRadius: 11,
                backgroundColor: (settings.notifications ?? true) ? '#4caf50' : '#444',
                position: 'relative', cursor: 'pointer', transition: 'background-color 0.2s',
                flexShrink: 0, marginLeft: 12
              }}
            >
              <div style={{
                width: 18, height: 18, borderRadius: '50%',
                backgroundColor: '#fff', position: 'absolute', top: 2,
                left: (settings.notifications ?? true) ? 20 : 2,
                transition: 'left 0.2s'
              }} />
            </div>
          </label>

          <label style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '8px', backgroundColor: '#252525', borderRadius: '4px', cursor: 'pointer'
          }}>
            <div>
              <div style={{ fontSize: '13px', color: '#e0e0e0' }}>All tasks done alert</div>
              <div style={{ fontSize: '11px', color: '#666' }}>Extra notification when entire pinboard is cleared</div>
            </div>
            <div
              onClick={() => toggle('notifyAllDone', true)}
              style={{
                width: 40, height: 22, borderRadius: 11,
                backgroundColor: (settings.notifyAllDone ?? true) ? '#4caf50' : '#444',
                position: 'relative', cursor: 'pointer', transition: 'background-color 0.2s',
                flexShrink: 0, marginLeft: 12
              }}
            >
              <div style={{
                width: 18, height: 18, borderRadius: '50%',
                backgroundColor: '#fff', position: 'absolute', top: 2,
                left: (settings.notifyAllDone ?? true) ? 20 : 2,
                transition: 'left 0.2s'
              }} />
            </div>
          </label>
        </div>

        {/* Remote View section */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', borderTop: '1px solid #333', paddingTop: '16px' }}>
          <div style={{ fontSize: '12px', color: '#888', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Remote View <span style={{ color: '#eab308', textTransform: 'none', fontWeight: 600 }}>(experimental)</span>
          </div>

          <label style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '8px', backgroundColor: '#252525', borderRadius: '4px', cursor: 'pointer'
          }}>
            <div>
              <div style={{ fontSize: '13px', color: '#e0e0e0' }}>Enable Remote View</div>
              <div style={{ fontSize: '11px', color: '#666' }}>Tunnel your workshop to a public URL via Cloudflare</div>
            </div>
            <div
              onClick={toggleRemote}
              style={{
                width: 40, height: 22, borderRadius: 11,
                backgroundColor: remoteState.enabled ? '#4caf50' : '#444',
                position: 'relative', cursor: 'pointer', transition: 'background-color 0.2s',
                flexShrink: 0, marginLeft: 12
              }}
            >
              <div style={{
                width: 18, height: 18, borderRadius: '50%',
                backgroundColor: '#fff', position: 'absolute', top: 2,
                left: remoteState.enabled ? 20 : 2,
                transition: 'left 0.2s'
              }} />
            </div>
          </label>

          {setupProgress && (
            <div style={{ fontSize: '12px', color: setupProgress.stage === 'error' ? '#ef4444' : '#888', padding: '8px' }}>
              {setupProgress.stage === 'downloading' && `Downloading cloudflared... ${setupProgress.message ?? ''}`}
              {setupProgress.stage === 'starting' && (setupProgress.message ?? 'Starting tunnel...')}
              {setupProgress.stage === 'ready' && '✅ Tunnel ready'}
              {setupProgress.stage === 'error' && `❌ ${setupProgress.message}`}
            </div>
          )}

          {remoteState.enabled && remoteState.publicUrl && (
            <>
              <div style={{
                padding: '8px', backgroundColor: '#252525', borderRadius: '4px',
                fontSize: '11px', color: '#aaa', wordBreak: 'break-all'
              }}>
                {remoteState.publicUrl}
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button onClick={copyUrl} style={{
                  flex: 1, padding: '8px', backgroundColor: '#3b82f6', color: '#fff',
                  border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px'
                }}>📋 Copy URL</button>
                <button onClick={() => setShowQr(v => !v)} style={{
                  flex: 1, padding: '8px', backgroundColor: '#444', color: '#e0e0e0',
                  border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px'
                }}>{showQr ? '✕ Hide QR' : '📱 Show QR'}</button>
              </div>

              {showQr && qrSvg && (
                <div
                  style={{
                    display: 'flex', justifyContent: 'center', padding: '12px',
                    backgroundColor: '#1e1e1e', borderRadius: '4px', border: '1px solid #333'
                  }}
                  dangerouslySetInnerHTML={{ __html: qrSvg }}
                />
              )}

              <div style={{ fontSize: '12px', color: '#aaa' }}>
                {remoteState.connectionCount === 0 && '⚪ No connections'}
                {remoteState.connectionCount === 1 && '🟢 1 connection active'}
                {remoteState.connectionCount > 1 && (
                  <span style={{ color: '#ef4444' }}>🔴 {remoteState.connectionCount} connections active</span>
                )}
                {remoteState.lastActivity && (
                  <div style={{ fontSize: '11px', color: '#666' }}>
                    Last activity: {new Date(remoteState.lastActivity).toLocaleTimeString()}
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: '8px' }}>
                <button onClick={killSessions} style={{
                  flex: 1, padding: '8px', backgroundColor: '#ef4444', color: '#fff',
                  border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px'
                }}>🛑 Kill all sessions</button>
                <button onClick={regenerate} style={{
                  flex: 1, padding: '8px', backgroundColor: '#444', color: '#e0e0e0',
                  border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px'
                }}>🔄 Regenerate token</button>
              </div>
            </>
          )}
        </div>

        <button onClick={onClose} style={{
          padding: '8px 16px', backgroundColor: '#2a2a2a', border: '1px solid #444',
          borderRadius: '4px', color: '#aaa', cursor: 'pointer', fontSize: '13px', alignSelf: 'flex-end'
        }}>Done</button>
      </div>
    </div>
  )
}
