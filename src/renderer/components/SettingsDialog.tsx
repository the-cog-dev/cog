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
  const [showCustomTimeout, setShowCustomTimeout] = useState(false)
  const [customTimeoutHours, setCustomTimeoutHours] = useState(8)
  const [passcodeSet, setPasscodeSet] = useState(false)
  const [passcodeInput, setPasscodeInput] = useState('')
  const [showPasscodeInput, setShowPasscodeInput] = useState(false)

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
