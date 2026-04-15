import React, { useState, useEffect, useMemo } from 'react'
import QRCode from 'qrcode-svg'
import type { AgentState } from '../../shared/types'
import { ROLE_THEME_DEFAULTS, getPresetById, THEME_PRESETS } from '../themes'

declare const electronAPI: {
  getSettings: () => Promise<Record<string, any>>
  setSetting: (key: string, value: unknown) => Promise<{ status: string }>
  enableRemoteView: () => Promise<{ ok: boolean }>
  disableRemoteView: () => Promise<{ ok: boolean }>
  getRemoteViewState: () => Promise<{ enabled: boolean; publicUrl: string | null; connectionCount: number; lastActivity: number | null }>
  killRemoteSessions: () => Promise<{ ok: boolean; newUrl?: string | null }>
  regenerateRemoteToken: () => Promise<{ ok: boolean; newUrl?: string | null }>
  setWorkshopPasscode: (pin: string) => Promise<{ success: boolean; error?: string }>
  getWorkshopPasscodeSet: () => Promise<{ isSet: boolean }>
  clearWorkshopPasscode: () => Promise<{ success: boolean }>
  onRemoteStatusUpdate: (cb: (s: { enabled: boolean; publicUrl: string | null; connectionCount: number; lastActivity: number | null }) => void) => () => void
  onRemoteSetupProgress: (cb: (p: { stage: 'downloading' | 'starting' | 'ready' | 'error'; message?: string }) => void) => () => void
}

interface SettingsDialogProps {
  onClose: () => void
  agents?: AgentState[]
}

export function SettingsDialog({ onClose, agents = [] }: SettingsDialogProps): React.ReactElement {
  const [themeApplyMsg, setThemeApplyMsg] = useState<string | null>(null)

  const applyThemeByRole = async () => {
    let applied = 0
    for (const agent of agents) {
      const presetId = ROLE_THEME_DEFAULTS[agent.role]
      if (!presetId) continue
      const preset = getPresetById(presetId)
      if (!preset) continue
      await window.electronAPI.setAgentTheme(agent.id, preset.theme)
      applied++
    }
    setThemeApplyMsg(`Applied themes to ${applied} agent${applied !== 1 ? 's' : ''}`)
    setTimeout(() => setThemeApplyMsg(null), 2500)
  }

  const clearAllThemes = async () => {
    let cleared = 0
    for (const agent of agents) {
      if (agent.theme) {
        await window.electronAPI.setAgentTheme(agent.id, null)
        cleared++
      }
    }
    setThemeApplyMsg(`Cleared themes from ${cleared} agent${cleared !== 1 ? 's' : ''}`)
    setTimeout(() => setThemeApplyMsg(null), 2500)
  }

  const [settings, setSettings] = useState<Record<string, any>>({})
  const [remoteState, setRemoteState] = useState({ enabled: false, publicUrl: null as string | null, connectionCount: 0, lastActivity: null as number | null })
  const [setupProgress, setSetupProgress] = useState<{ stage: string; message?: string } | null>(null)
  const [showQr, setShowQr] = useState(false)
  const [plainQr, setPlainQr] = useState(false)
  const [showCustomTimeout, setShowCustomTimeout] = useState(false)
  const [customTimeoutHours, setCustomTimeoutHours] = useState(8)
  const [passcodeSet, setPasscodeSet] = useState(false)
  const [passcodeInput, setPasscodeInput] = useState('')
  const [showPasscodeInput, setShowPasscodeInput] = useState(false)

  const qrSvg = useMemo(() => {
    if (!remoteState.publicUrl) return null
    try {
      // Plain mode: lower error correction + no logo overlay for ancient QR
      // readers (Nintendo 3DS, older feature phones). Default: ECL 'H' so the
      // centered cog logo doesn't break scannability on modern scanners.
      return new QRCode({
        content: remoteState.publicUrl,
        padding: 2,
        width: 220,
        height: 220,
        color: '#e0e0e0',
        background: '#1e1e1e',
        ecl: plainQr ? 'M' : 'H'
      }).svg()
    } catch {
      return null
    }
  }, [remoteState.publicUrl, plainQr])

  useEffect(() => {
    electronAPI.getSettings().then(s => {
      setSettings(s)
      const saved = s.remoteSessionTimeout as number | undefined
      const presetValues = [1, 2, 4, 8, 12, 24]
      if (saved && !presetValues.includes(saved)) {
        setShowCustomTimeout(true)
        setCustomTimeoutHours(saved)
      } else if (saved) {
        setCustomTimeoutHours(saved)
      }
    })
    electronAPI.getRemoteViewState().then(setRemoteState)
    electronAPI.getWorkshopPasscodeSet().then(r => setPasscodeSet(r.isSet))

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

  const handleTimeoutChange = async (value: string) => {
    if (value === 'custom') {
      setShowCustomTimeout(true)
      return
    }
    setShowCustomTimeout(false)
    const hours = parseInt(value, 10)
    if (isNaN(hours)) return
    setCustomTimeoutHours(hours)
    await electronAPI.setSetting('remoteSessionTimeout', hours)
    setSettings(prev => ({ ...prev, remoteSessionTimeout: hours }))
  }

  const handleCustomTimeoutChange = async (hours: number) => {
    const clamped = Math.min(168, Math.max(1, hours))
    setCustomTimeoutHours(clamped)
    await electronAPI.setSetting('remoteSessionTimeout', clamped)
    setSettings(prev => ({ ...prev, remoteSessionTimeout: clamped }))
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

        {/* Themes section */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', borderTop: '1px solid #333', paddingTop: '16px' }}>
          <div style={{ fontSize: '12px', color: '#888', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Agent Themes
          </div>
          <div style={{ fontSize: '11px', color: '#666', lineHeight: '1.5' }}>
            Right-click any terminal title bar to customize colors.
            Or apply role-based defaults to all current agents at once:
          </div>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {Object.entries(ROLE_THEME_DEFAULTS).map(([role, presetId]) => {
              const preset = getPresetById(presetId)
              if (!preset) return null
              return (
                <span key={role} style={{
                  fontSize: '10px',
                  padding: '3px 8px',
                  borderRadius: '10px',
                  backgroundColor: preset.theme.chrome,
                  border: `1px solid ${preset.theme.border}`,
                  color: preset.theme.text
                }}>
                  {role} {preset.emoji}
                </span>
              )
            })}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={applyThemeByRole}
              disabled={agents.length === 0}
              style={{
                flex: 1, padding: '8px', backgroundColor: '#3b82f6', color: '#fff',
                border: 'none', borderRadius: '4px', cursor: agents.length === 0 ? 'not-allowed' : 'pointer',
                fontSize: '12px', opacity: agents.length === 0 ? 0.5 : 1
              }}
            >🎨 Apply theme by role</button>
            <button
              onClick={clearAllThemes}
              disabled={agents.length === 0}
              style={{
                padding: '8px 12px', backgroundColor: '#444', color: '#e0e0e0',
                border: 'none', borderRadius: '4px', cursor: agents.length === 0 ? 'not-allowed' : 'pointer',
                fontSize: '12px', opacity: agents.length === 0 ? 0.5 : 1
              }}
            >Clear all</button>
          </div>
          {themeApplyMsg && (
            <div style={{ fontSize: '11px', color: '#6ee7b7', padding: '4px 8px', backgroundColor: '#1a2e1a', borderRadius: '4px' }}>
              {themeApplyMsg}
            </div>
          )}
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

          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '8px', backgroundColor: '#252525', borderRadius: '4px'
          }}>
            <div>
              <div style={{ fontSize: '13px', color: '#e0e0e0' }}>Session timeout</div>
              <div style={{ fontSize: '11px', color: '#666' }}>How long before the remote session expires</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0, marginLeft: 12 }}>
              <select
                value={showCustomTimeout ? 'custom' : String(settings.remoteSessionTimeout ?? 8)}
                onChange={e => handleTimeoutChange(e.target.value)}
                style={{
                  backgroundColor: '#333', color: '#e0e0e0', border: '1px solid #555',
                  borderRadius: '4px', padding: '4px 8px', fontSize: '12px', cursor: 'pointer'
                }}
              >
                <option value="1">1h</option>
                <option value="2">2h</option>
                <option value="4">4h</option>
                <option value="8">8h</option>
                <option value="12">12h</option>
                <option value="24">24h</option>
                <option value="custom">Custom</option>
              </select>
              {showCustomTimeout && (
                <input
                  type="number"
                  min={1}
                  max={168}
                  value={customTimeoutHours}
                  onChange={e => handleCustomTimeoutChange(parseInt(e.target.value, 10) || 1)}
                  style={{
                    width: '52px', backgroundColor: '#333', color: '#e0e0e0', border: '1px solid #555',
                    borderRadius: '4px', padding: '4px 6px', fontSize: '12px', textAlign: 'center'
                  }}
                />
              )}
            </div>
          </div>

          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '8px', backgroundColor: '#252525', borderRadius: '4px'
          }}>
            <div>
              <div style={{ fontSize: '13px', color: '#e0e0e0' }}>Workshop passcode</div>
              <div style={{ fontSize: '11px', color: '#666' }}>4-digit PIN to gate Workshop mode on mobile</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0, marginLeft: 12 }}>
              {showPasscodeInput ? (
                <input
                  type="tel"
                  maxLength={4}
                  autoFocus
                  placeholder="0000"
                  value={passcodeInput}
                  onChange={e => {
                    const val = e.target.value.replace(/\D/g, '').slice(0, 4)
                    setPasscodeInput(val)
                    if (val.length === 4) {
                      electronAPI.setWorkshopPasscode(val).then(r => {
                        if (r.success) {
                          setPasscodeSet(true)
                          setShowPasscodeInput(false)
                          setPasscodeInput('')
                        }
                      })
                    }
                  }}
                  onBlur={() => {
                    if (passcodeInput.length < 4) {
                      setShowPasscodeInput(false)
                      setPasscodeInput('')
                    }
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Escape') {
                      setShowPasscodeInput(false)
                      setPasscodeInput('')
                    }
                  }}
                  style={{
                    width: '56px', backgroundColor: '#333', color: '#e0e0e0', border: '1px solid #555',
                    borderRadius: '4px', padding: '4px 6px', fontSize: '14px', textAlign: 'center',
                    letterSpacing: '4px', fontFamily: 'monospace'
                  }}
                />
              ) : passcodeSet ? (
                <>
                  <button
                    onClick={() => setShowPasscodeInput(true)}
                    style={{
                      padding: '4px 10px', backgroundColor: '#333', color: '#e0e0e0',
                      border: '1px solid #555', borderRadius: '4px', cursor: 'pointer', fontSize: '11px'
                    }}
                  >Change</button>
                  <button
                    onClick={() => {
                      electronAPI.clearWorkshopPasscode().then(r => {
                        if (r.success) setPasscodeSet(false)
                      })
                    }}
                    style={{
                      padding: '4px 10px', backgroundColor: '#333', color: '#ef4444',
                      border: '1px solid #555', borderRadius: '4px', cursor: 'pointer', fontSize: '11px'
                    }}
                  >Clear</button>
                </>
              ) : (
                <button
                  onClick={() => setShowPasscodeInput(true)}
                  style={{
                    padding: '4px 10px', backgroundColor: '#333', color: '#e0e0e0',
                    border: '1px solid #555', borderRadius: '4px', cursor: 'pointer', fontSize: '11px'
                  }}
                >Set passcode</button>
              )}
            </div>
          </div>

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
                <div style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', padding: '12px',
                  backgroundColor: '#1e1e1e', borderRadius: '4px', border: '1px solid #333'
                }}>
                  <div style={{ position: 'relative', display: 'inline-block', lineHeight: 0 }}>
                    <div dangerouslySetInnerHTML={{ __html: qrSvg }} />
                    {!plainQr && (
                      <svg
                        viewBox="0 0 24 24"
                        width="46"
                        height="46"
                        style={{
                          position: 'absolute',
                          top: '50%',
                          left: '50%',
                          transform: 'translate(-50%, -50%)',
                          backgroundColor: '#1e1e1e',
                          borderRadius: '50%',
                          padding: '5px',
                          border: '2px solid #1e1e1e',
                          pointerEvents: 'none'
                        }}
                      >
                        <path
                          fill="#f5d76e"
                          d="M12,15.5A3.5,3.5 0 0,1 8.5,12A3.5,3.5 0 0,1 12,8.5A3.5,3.5 0 0,1 15.5,12A3.5,3.5 0 0,1 12,15.5M19.43,12.97C19.47,12.65 19.5,12.33 19.5,12C19.5,11.67 19.47,11.34 19.43,11L21.54,9.37C21.73,9.22 21.78,8.95 21.66,8.73L19.66,5.27C19.54,5.05 19.27,4.96 19.05,5.05L16.56,6.05C16.04,5.66 15.5,5.32 14.87,5.07L14.5,2.42C14.46,2.18 14.25,2 14,2H10C9.75,2 9.54,2.18 9.5,2.42L9.13,5.07C8.5,5.32 7.96,5.66 7.44,6.05L4.95,5.05C4.73,4.96 4.46,5.05 4.34,5.27L2.34,8.73C2.21,8.95 2.27,9.22 2.46,9.37L4.57,11C4.53,11.34 4.5,11.67 4.5,12C4.5,12.33 4.53,12.65 4.57,12.97L2.46,14.63C2.27,14.78 2.21,15.05 2.34,15.27L4.34,18.73C4.46,18.95 4.73,19.03 4.95,18.95L7.44,17.94C7.96,18.34 8.5,18.68 9.13,18.93L9.5,21.58C9.54,21.82 9.75,22 10,22H14C14.25,22 14.46,21.82 14.5,21.58L14.87,18.93C15.5,18.67 16.04,18.34 16.56,17.94L19.05,18.95C19.27,19.03 19.54,18.95 19.66,18.73L21.66,15.27C21.78,15.05 21.73,14.78 21.54,14.63L19.43,12.97Z"
                        />
                      </svg>
                    )}
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: '#888', cursor: 'pointer' }}>
                    <input type="checkbox" checked={plainQr} onChange={e => setPlainQr(e.target.checked)} />
                    <span>Plain QR (for old scanners — 3DS, feature phones)</span>
                  </label>
                </div>
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
