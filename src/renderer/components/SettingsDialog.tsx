import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { AutonomySettings } from './AutonomySettings'
import QRCode from 'qrcode-svg'
import type { AgentState, WorkspaceTheme, CommunityThemeListItem, CommunityTheme, AgentTheme, TelegramStatus, NotificationThreshold } from '../../shared/types'
import { ROLE_THEME_DEFAULTS, getPresetById, THEME_PRESETS, WORKSPACE_THEMES, getWorkspaceThemeById } from '../themes'

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
  const [activeWsThemeId, setActiveWsThemeId] = useState<string | null>(null)
  const [customThemes, setCustomThemes] = useState<WorkspaceTheme[]>([])
  const [customThemeName, setCustomThemeName] = useState('')
  const [showSaveCustom, setShowSaveCustom] = useState(false)

  useEffect(() => {
    window.electronAPI.getActiveWorkspaceTheme().then(setActiveWsThemeId)
    window.electronAPI.listCustomWorkspaceThemes().then(setCustomThemes)
  }, [])

  const allThemes = useMemo(() => [...WORKSPACE_THEMES, ...customThemes], [customThemes])

  const applyWorkspaceTheme = useCallback(async (theme: WorkspaceTheme) => {
    let applied = 0
    for (const agent of agents) {
      const colors = theme.roleColors[agent.role] ?? theme.fallback
      await window.electronAPI.setAgentTheme(agent.id, colors)
      applied++
    }
    await window.electronAPI.setActiveWorkspaceTheme(theme.id)
    setActiveWsThemeId(theme.id)
    setThemeApplyMsg(`Applied "${theme.label}" to ${applied} agent${applied !== 1 ? 's' : ''}`)
    setTimeout(() => setThemeApplyMsg(null), 2500)
  }, [agents])

  const clearAllThemes = async () => {
    let cleared = 0
    for (const agent of agents) {
      if (agent.theme) {
        await window.electronAPI.setAgentTheme(agent.id, null)
        cleared++
      }
    }
    await window.electronAPI.setActiveWorkspaceTheme(null)
    setActiveWsThemeId(null)
    setThemeApplyMsg(`Cleared themes from ${cleared} agent${cleared !== 1 ? 's' : ''}`)
    setTimeout(() => setThemeApplyMsg(null), 2500)
  }

  const saveCurrentAsTheme = async () => {
    const name = customThemeName.trim()
    if (!name || agents.length === 0) return
    const roleColors: Record<string, Required<import('../../shared/types').AgentTheme>> = {}
    let fallbackTheme = { chrome: '#1e1e1e', border: '#333333', bg: '#0d0d0d', text: '#e0e0e0' }
    for (const agent of agents) {
      if (agent.theme) {
        const full = {
          chrome: agent.theme.chrome ?? '#1e1e1e',
          border: agent.theme.border ?? '#333333',
          bg: agent.theme.bg ?? '#0d0d0d',
          text: agent.theme.text ?? '#e0e0e0'
        }
        if (agent.role) roleColors[agent.role] = full
        fallbackTheme = full
      }
    }
    const id = `custom-${Date.now()}`
    const theme: WorkspaceTheme = {
      id,
      label: name,
      description: 'Custom theme',
      roleColors,
      fallback: fallbackTheme,
      meta: { version: 1 }
    }
    await window.electronAPI.saveCustomWorkspaceTheme(theme)
    setCustomThemes(prev => [...prev, theme])
    setCustomThemeName('')
    setShowSaveCustom(false)
    setThemeApplyMsg(`Saved "${name}"`)
    setTimeout(() => setThemeApplyMsg(null), 2500)
  }

  const deleteCustomTheme = async (id: string) => {
    await window.electronAPI.deleteCustomWorkspaceTheme(id)
    setCustomThemes(prev => prev.filter(t => t.id !== id))
    if (activeWsThemeId === id) {
      setActiveWsThemeId(null)
      await window.electronAPI.setActiveWorkspaceTheme(null)
    }
  }

  // Community themes
  const [showCommunityThemes, setShowCommunityThemes] = useState(false)
  const [communityThemes, setCommunityThemes] = useState<CommunityThemeListItem[]>([])
  const [communityLoading, setCommunityLoading] = useState(false)
  const [communityError, setCommunityError] = useState<string | null>(null)
  const [showShareForm, setShowShareForm] = useState(false)
  const [shareAuthor, setShareAuthor] = useState('')
  const [shareDescription, setShareDescription] = useState('')

  const browseCommunityThemes = async (force = false) => {
    setCommunityLoading(true)
    setCommunityError(null)
    const res = await window.electronAPI.communityThemeList({ force })
    if (res.success) {
      setCommunityThemes(res.items)
    } else {
      setCommunityError(res.error)
    }
    setCommunityLoading(false)
  }

  const downloadCommunityTheme = async (item: CommunityThemeListItem) => {
    const res = await window.electronAPI.communityThemeGet(item.issueNumber)
    if (!res.success) {
      setThemeApplyMsg(`Error: ${res.error}`)
      setTimeout(() => setThemeApplyMsg(null), 3000)
      return
    }
    const ct = res.theme
    const wsTheme: WorkspaceTheme = {
      id: `community-${ct.issueNumber}`,
      label: ct.name,
      description: ct.description,
      roleColors: ct.roleColors,
      fallback: ct.fallback,
      meta: { author: ct.author, version: 1 }
    }
    await window.electronAPI.saveCustomWorkspaceTheme(wsTheme)
    setCustomThemes(prev => {
      if (prev.find(t => t.id === wsTheme.id)) return prev
      return [...prev, wsTheme]
    })
    setThemeApplyMsg(`Downloaded "${ct.name}"`)
    setTimeout(() => setThemeApplyMsg(null), 2500)
  }

  const shareCommunityTheme = async (theme: WorkspaceTheme) => {
    if (!shareAuthor.trim()) return
    const res = await window.electronAPI.communityThemeShare({
      name: theme.label,
      description: shareDescription.trim() || theme.description,
      author: shareAuthor.trim(),
      roleColors: theme.roleColors,
      fallback: theme.fallback
    })
    if (res.success) {
      setThemeApplyMsg(`Shared "${theme.label}" to community!`)
      setShowShareForm(false)
      setShareAuthor('')
      setShareDescription('')
      browseCommunityThemes(true)
    } else {
      setThemeApplyMsg(`Error: ${res.error}`)
    }
    setTimeout(() => setThemeApplyMsg(null), 3000)
  }

  const toggleThemeStar = async (issueNumber: number) => {
    const res = await window.electronAPI.communityThemeToggleStar(issueNumber)
    if (res.success) {
      setCommunityThemes(prev => prev.map(t =>
        t.issueNumber === issueNumber ? { ...t, stars: res.stars, isStarredByMe: res.isStarredByMe } : t
      ))
    }
  }

  const [projectName, setProjectName] = useState<string | null>(null)
  const [settings, setSettings] = useState<Record<string, any>>({})
  const [remoteState, setRemoteState] = useState({ enabled: false, publicUrl: null as string | null, lanUrl: null as string | null, lanEnabled: false, connectionCount: 0, lastActivity: null as number | null })
  const [whichQr, setWhichQr] = useState<'tunnel' | 'lan'>('tunnel')
  const [setupProgress, setSetupProgress] = useState<{ stage: string; message?: string } | null>(null)
  const [showQr, setShowQr] = useState(false)
  const [plainQr, setPlainQr] = useState(false)
  const [shortQrUrl, setShortQrUrl] = useState<string | null>(null)
  const [show3dsPanel, setShow3dsPanel] = useState(false)
  const [dsIp, setDsIp] = useState('')
  const [dsPort, setDsPort] = useState('8336')
  const [dsSendResult, setDsSendResult] = useState('')
  const [showCustomTimeout, setShowCustomTimeout] = useState(false)
  const [customTimeoutHours, setCustomTimeoutHours] = useState(8)
  const [passcodeSet, setPasscodeSet] = useState(false)
  const [passcodeInput, setPasscodeInput] = useState('')
  const [showPasscodeInput, setShowPasscodeInput] = useState(false)

  const qrSourceUrl = whichQr === 'lan' ? remoteState.lanUrl : remoteState.publicUrl
  const qrSvg = useMemo(() => {
    if (!qrSourceUrl) return null
    try {
      // Plain mode: lower error correction + no logo overlay for ancient QR
      // readers (Nintendo 3DS, older feature phones). Default: ECL 'H' so the
      // centered cog logo doesn't break scannability on modern scanners.
      const content = (plainQr && shortQrUrl) ? shortQrUrl : qrSourceUrl
      return new QRCode({
        content,
        padding: 2,
        width: 220,
        height: 220,
        color: '#e0e0e0',
        background: '#1e1e1e',
        ecl: plainQr ? 'L' : 'H'
      }).svg()
    } catch {
      return null
    }
  }, [qrSourceUrl, plainQr, shortQrUrl])

  useEffect(() => {
    const hasAnyUrl = remoteState.lanUrl || remoteState.publicUrl
    if (!plainQr || !hasAnyUrl) { setShortQrUrl(null); return }
    let cancelled = false
    window.electronAPI.registerShortLink(
      remoteState.lanUrl || null,
      remoteState.publicUrl || null
    ).then(url => { if (!cancelled) setShortQrUrl(url) })
    return () => { cancelled = true }
  }, [plainQr, remoteState.lanUrl, remoteState.publicUrl])

  useEffect(() => {
    window.electronAPI.getProject().then(p => setProjectName(p?.name ?? null))
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

        {/* Workspace Themes section */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', borderTop: '1px solid #333', paddingTop: '16px' }}>
          <div style={{ fontSize: '12px', color: '#888', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Themes
          </div>
          <div style={{ fontSize: '11px', color: '#666', lineHeight: '1.5' }}>
            Click a theme to color all agents by role. Right-click any terminal title bar to override individual agents.
          </div>

          {/* Theme gallery */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px' }}>
            {allThemes.map(theme => {
              const isActive = activeWsThemeId === theme.id
              const isCustom = !WORKSPACE_THEMES.find(t => t.id === theme.id)
              const swatchColors = ['orchestrator', 'worker', 'researcher', 'reviewer'].map(
                role => (theme.roleColors[role] ?? theme.fallback).border
              )
              return (
                <div
                  key={theme.id}
                  onClick={() => agents.length > 0 && applyWorkspaceTheme(theme)}
                  style={{
                    padding: '8px',
                    backgroundColor: isActive ? '#2a2a2a' : '#1a1a1a',
                    border: isActive ? '2px solid #3b82f6' : '1px solid #333',
                    borderRadius: '6px',
                    cursor: agents.length === 0 ? 'not-allowed' : 'pointer',
                    opacity: agents.length === 0 ? 0.5 : 1,
                    position: 'relative'
                  }}
                >
                  <div style={{ fontSize: '11px', color: '#e0e0e0', marginBottom: '4px', fontWeight: isActive ? 600 : 400 }}>
                    {theme.label}
                  </div>
                  <div style={{ display: 'flex', gap: '3px' }}>
                    {swatchColors.map((color, i) => (
                      <div key={i} style={{
                        width: '16px', height: '16px', borderRadius: '50%',
                        backgroundColor: color, border: '1px solid rgba(255,255,255,0.15)'
                      }} />
                    ))}
                  </div>
                  <div style={{ fontSize: '9px', color: '#555', marginTop: '3px' }}>
                    {theme.description}
                  </div>
                  {isCustom && (
                    <div
                      onClick={e => { e.stopPropagation(); deleteCustomTheme(theme.id) }}
                      style={{
                        position: 'absolute', top: '4px', right: '6px',
                        fontSize: '12px', color: '#555', cursor: 'pointer', lineHeight: 1
                      }}
                      title="Delete custom theme"
                    >x</div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Save current + clear */}
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={() => setShowSaveCustom(!showSaveCustom)}
              disabled={agents.length === 0}
              style={{
                flex: 1, padding: '8px', backgroundColor: '#333', color: '#e0e0e0',
                border: '1px solid #444', borderRadius: '4px',
                cursor: agents.length === 0 ? 'not-allowed' : 'pointer',
                fontSize: '12px', opacity: agents.length === 0 ? 0.5 : 1
              }}
            >Save current as theme</button>
            <button
              onClick={clearAllThemes}
              disabled={agents.length === 0}
              style={{
                padding: '8px 12px', backgroundColor: '#444', color: '#e0e0e0',
                border: 'none', borderRadius: '4px',
                cursor: agents.length === 0 ? 'not-allowed' : 'pointer',
                fontSize: '12px', opacity: agents.length === 0 ? 0.5 : 1
              }}
            >Clear all</button>
          </div>

          {showSaveCustom && (
            <div style={{ display: 'flex', gap: '6px' }}>
              <input
                type="text"
                placeholder="Theme name..."
                value={customThemeName}
                onChange={e => setCustomThemeName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && saveCurrentAsTheme()}
                autoFocus
                style={{
                  flex: 1, padding: '6px 8px', backgroundColor: '#252525', color: '#e0e0e0',
                  border: '1px solid #444', borderRadius: '4px', fontSize: '12px'
                }}
              />
              <button
                onClick={saveCurrentAsTheme}
                disabled={!customThemeName.trim()}
                style={{
                  padding: '6px 12px', backgroundColor: '#3b82f6', color: '#fff',
                  border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px',
                  opacity: customThemeName.trim() ? 1 : 0.5
                }}
              >Save</button>
            </div>
          )}

          {themeApplyMsg && (
            <div style={{ fontSize: '11px', color: '#6ee7b7', padding: '4px 8px', backgroundColor: '#1a2e1a', borderRadius: '4px' }}>
              {themeApplyMsg}
            </div>
          )}

          {/* Community themes */}
          <div style={{ borderTop: '1px solid #2a2a2a', paddingTop: '10px', marginTop: '4px' }}>
            <div
              onClick={() => { setShowCommunityThemes(!showCommunityThemes); if (!showCommunityThemes && communityThemes.length === 0) browseCommunityThemes() }}
              style={{ fontSize: '11px', color: '#888', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              <span>{showCommunityThemes ? '▾' : '▸'}</span>
              <span style={{ textTransform: 'uppercase', letterSpacing: '0.5px' }}>Community Themes</span>
            </div>

            {showCommunityThemes && (
              <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <button
                    onClick={() => browseCommunityThemes(true)}
                    disabled={communityLoading}
                    style={{
                      flex: 1, padding: '6px', backgroundColor: '#333', color: '#e0e0e0',
                      border: '1px solid #444', borderRadius: '4px', cursor: 'pointer', fontSize: '11px',
                      opacity: communityLoading ? 0.5 : 1
                    }}
                  >{communityLoading ? 'Loading...' : 'Refresh'}</button>
                  {customThemes.length > 0 && (
                    <button
                      onClick={() => setShowShareForm(!showShareForm)}
                      style={{
                        flex: 1, padding: '6px', backgroundColor: '#1a2e3a', color: '#7ec4f5',
                        border: '1px solid #2a4a5a', borderRadius: '4px', cursor: 'pointer', fontSize: '11px'
                      }}
                    >Share a theme</button>
                  )}
                </div>

                {showShareForm && customThemes.length > 0 && (
                  <div style={{ padding: '8px', backgroundColor: '#1a1a1a', borderRadius: '6px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <div style={{ fontSize: '10px', color: '#888' }}>Share a custom theme to the community:</div>
                    <input
                      type="text" placeholder="Your name" value={shareAuthor}
                      onChange={e => setShareAuthor(e.target.value)}
                      style={{ padding: '4px 8px', backgroundColor: '#252525', color: '#e0e0e0', border: '1px solid #444', borderRadius: '4px', fontSize: '11px' }}
                    />
                    <input
                      type="text" placeholder="Description (optional)" value={shareDescription}
                      onChange={e => setShareDescription(e.target.value)}
                      style={{ padding: '4px 8px', backgroundColor: '#252525', color: '#e0e0e0', border: '1px solid #444', borderRadius: '4px', fontSize: '11px' }}
                    />
                    <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                      {customThemes.map(t => (
                        <button
                          key={t.id}
                          onClick={() => shareCommunityTheme(t)}
                          disabled={!shareAuthor.trim()}
                          style={{
                            padding: '4px 10px', backgroundColor: '#2a3a2a', color: '#7ef598',
                            border: '1px solid #3a5a3a', borderRadius: '4px', cursor: shareAuthor.trim() ? 'pointer' : 'not-allowed',
                            fontSize: '10px', opacity: shareAuthor.trim() ? 1 : 0.5
                          }}
                        >Share "{t.label}"</button>
                      ))}
                    </div>
                  </div>
                )}

                {communityError && (
                  <div style={{ fontSize: '11px', color: '#ef4444', padding: '4px 8px' }}>{communityError}</div>
                )}

                {communityThemes.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '200px', overflowY: 'auto' }}>
                    {communityThemes.map(item => (
                      <div key={item.issueNumber} style={{
                        padding: '8px', backgroundColor: '#1a1a1a', borderRadius: '6px',
                        border: '1px solid #2a2a2a', display: 'flex', alignItems: 'center', gap: '8px'
                      }}>
                        <div style={{ display: 'flex', gap: '2px', flexShrink: 0 }}>
                          {item.previewColors.map((color, i) => (
                            <div key={i} style={{
                              width: '12px', height: '12px', borderRadius: '50%',
                              backgroundColor: color, border: '1px solid rgba(255,255,255,0.1)'
                            }} />
                          ))}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: '11px', color: '#e0e0e0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {item.name}
                          </div>
                          <div style={{ fontSize: '9px', color: '#666' }}>
                            by {item.author}
                          </div>
                        </div>
                        <div
                          onClick={() => toggleThemeStar(item.issueNumber)}
                          style={{ fontSize: '11px', color: item.isStarredByMe ? '#eab308' : '#555', cursor: 'pointer', flexShrink: 0 }}
                          title={item.isStarredByMe ? 'Unstar' : 'Star'}
                        >
                          {item.isStarredByMe ? '\u2605' : '\u2606'} {item.stars}
                        </div>
                        <button
                          onClick={() => downloadCommunityTheme(item)}
                          style={{
                            padding: '3px 8px', backgroundColor: '#333', color: '#e0e0e0',
                            border: '1px solid #444', borderRadius: '4px', cursor: 'pointer',
                            fontSize: '10px', flexShrink: 0
                          }}
                        >Get</button>
                      </div>
                    ))}
                  </div>
                )}

                {!communityLoading && communityThemes.length === 0 && !communityError && (
                  <div style={{ fontSize: '11px', color: '#666', textAlign: 'center', padding: '12px' }}>
                    No community themes shared yet. Be the first!
                  </div>
                )}
              </div>
            )}
          </div>
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
              <div style={{ fontSize: '10px', color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: '4px' }}>Tunnel URL (internet)</div>
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
                }}>📋 Copy Tunnel URL</button>
                <button onClick={() => setShowQr(v => !v)} style={{
                  flex: 1, padding: '8px', backgroundColor: '#444', color: '#e0e0e0',
                  border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px'
                }}>{showQr ? '✕ Hide QR' : '📱 Show QR'}</button>
              </div>

              {/* LAN access toggle + URL */}
              <label style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '8px', backgroundColor: '#252525', borderRadius: '4px', cursor: 'pointer', marginTop: '6px'
              }}>
                <div>
                  <div style={{ fontSize: '13px', color: '#e0e0e0' }}>Enable LAN access</div>
                  <div style={{ fontSize: '11px', color: '#666' }}>Same-WiFi devices can connect over plain HTTP — no internet needed</div>
                </div>
                <div
                  onClick={async () => {
                    if (remoteState.lanEnabled) await electronAPI.disableRemoteLan()
                    else await electronAPI.enableRemoteLan()
                  }}
                  style={{
                    width: 40, height: 22, borderRadius: 11,
                    backgroundColor: remoteState.lanEnabled ? '#4caf50' : '#444',
                    position: 'relative', cursor: 'pointer', transition: 'background-color 0.2s',
                    flexShrink: 0, marginLeft: 12
                  }}
                >
                  <div style={{
                    width: 18, height: 18, borderRadius: '50%',
                    backgroundColor: '#fff', position: 'absolute', top: 2,
                    left: remoteState.lanEnabled ? 20 : 2,
                    transition: 'left 0.2s'
                  }} />
                </div>
              </label>

              {remoteState.lanEnabled && remoteState.lanUrl && (
                <>
                  <div style={{ fontSize: '10px', color: '#6ee7b7', textTransform: 'uppercase', letterSpacing: '0.05em' }}>LAN URL (same WiFi only)</div>
                  <div style={{
                    padding: '8px', backgroundColor: '#1a2e1a', borderRadius: '4px',
                    fontSize: '11px', color: '#6ee7b7', wordBreak: 'break-all', border: '1px solid #2a4a2a'
                  }}>
                    {remoteState.lanUrl}
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      onClick={() => { if (remoteState.lanUrl) navigator.clipboard.writeText(remoteState.lanUrl) }}
                      style={{
                        flex: 1, padding: '8px', backgroundColor: '#1a2e1a', color: '#6ee7b7',
                        border: '1px solid #2a4a2a', borderRadius: '4px', cursor: 'pointer', fontSize: '12px'
                      }}
                    >📋 Copy LAN URL</button>
                  </div>
                </>
              )}

              {/* QR source selector — only show if both URLs are available */}
              {showQr && remoteState.lanEnabled && remoteState.lanUrl && (
                <div style={{ display: 'flex', gap: '4px', fontSize: '11px' }}>
                  <button
                    onClick={() => setWhichQr('tunnel')}
                    style={{
                      flex: 1, padding: '6px', borderRadius: '4px', cursor: 'pointer',
                      background: whichQr === 'tunnel' ? '#3b82f6' : '#2a2a2a',
                      color: whichQr === 'tunnel' ? '#fff' : '#888',
                      border: whichQr === 'tunnel' ? 'none' : '1px solid #444'
                    }}
                  >Tunnel QR</button>
                  <button
                    onClick={() => setWhichQr('lan')}
                    style={{
                      flex: 1, padding: '6px', borderRadius: '4px', cursor: 'pointer',
                      background: whichQr === 'lan' ? '#4caf50' : '#2a2a2a',
                      color: whichQr === 'lan' ? '#fff' : '#888',
                      border: whichQr === 'lan' ? 'none' : '1px solid #444'
                    }}
                  >LAN QR</button>
                </div>
              )}

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
                  <div
                    onClick={() => setShow3dsPanel(!show3dsPanel)}
                    style={{ fontSize: '11px', color: '#666', cursor: 'pointer', marginTop: '4px' }}
                  >
                    {show3dsPanel ? '▾' : '▸'} Send to 3DS
                  </div>
                  {show3dsPanel && (
                    <div style={{ padding: '8px', background: '#1a1a1a', borderRadius: '6px', marginTop: '4px', fontSize: '12px' }}>
                      <div style={{ display: 'flex', gap: '6px', marginBottom: '6px', alignItems: 'center' }}>
                        <input
                          type="text" placeholder="3DS IP (e.g. 192.168.2.227)"
                          value={dsIp} onChange={e => setDsIp(e.target.value)}
                          style={{ flex: 1, padding: '4px 8px', background: '#111', border: '1px solid #333', borderRadius: '4px', color: '#eee', fontSize: '12px' }}
                        />
                        <input
                          type="text" placeholder="Port"
                          value={dsPort} onChange={e => setDsPort(e.target.value)}
                          style={{ width: '60px', padding: '4px 8px', background: '#111', border: '1px solid #333', borderRadius: '4px', color: '#eee', fontSize: '12px' }}
                        />
                      </div>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        {remoteState.lanUrl && (
                          <button
                            onClick={async () => {
                              setDsSendResult('Sending...')
                              const r = await window.electronAPI.sendTo3DS(dsIp, parseInt(dsPort) || 8336, remoteState.lanUrl!)
                              setDsSendResult(r)
                            }}
                            style={{ padding: '4px 10px', background: '#2a5a2a', color: '#eee', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '11px' }}
                          >
                            Send LAN URL
                          </button>
                        )}
                        {remoteState.publicUrl && (
                          <button
                            onClick={async () => {
                              setDsSendResult('Sending...')
                              const r = await window.electronAPI.sendTo3DS(dsIp, parseInt(dsPort) || 8336, remoteState.publicUrl!)
                              setDsSendResult(r)
                            }}
                            style={{ padding: '4px 10px', background: '#2a3a5a', color: '#eee', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '11px' }}
                          >
                            Send Tunnel URL
                          </button>
                        )}
                      </div>
                      {dsSendResult && (
                        <div style={{ fontSize: '11px', color: dsSendResult.includes('Error') || dsSendResult.includes('Timeout') ? '#ef4444' : '#6ed76e', marginTop: '4px' }}>
                          {dsSendResult}
                        </div>
                      )}
                      <div style={{ fontSize: '10px', color: '#555', marginTop: '4px' }}>
                        On 3DS: press L on setup screen to start listening
                      </div>
                    </div>
                  )}
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

        {/* Telegram Bot section */}
        <TelegramSection />

        {/* Agent Autonomy section */}
        <AutonomySettings projectName={projectName} />

        {/* Stream Deck section */}
        <StreamDeckSection />

        <button onClick={onClose} style={{
          padding: '8px 16px', backgroundColor: '#2a2a2a', border: '1px solid #444',
          borderRadius: '4px', color: '#aaa', cursor: 'pointer', fontSize: '13px', alignSelf: 'flex-end'
        }}>Done</button>
      </div>
    </div>
  )
}

function TelegramSection(): React.ReactElement {
  const [status, setStatus] = React.useState<TelegramStatus | null>(null)
  const [showTokenInput, setShowTokenInput] = React.useState(false)
  const [tokenInput, setTokenInput] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [threshold, setThreshold] = React.useState<NotificationThreshold>('low')

  React.useEffect(() => {
    void window.electronAPI.getTelegramStatus().then(setStatus)
    void window.electronAPI.getSettings().then(s => {
      const t = s.telegramNotifyThreshold
      if (typeof t === 'string') setThreshold(t as NotificationThreshold)
    })
    const off = window.electronAPI.onTelegramStatusUpdate(setStatus)
    return () => off()
  }, [])

  const changeThreshold = async (t: NotificationThreshold) => {
    setThreshold(t)
    await window.electronAPI.setSetting('telegramNotifyThreshold', t)
  }

  const flash = (msg: string) => {
    setNotice(msg)
    setTimeout(() => setNotice(null), 2500)
  }

  // IPC rejections arrive as "Error invoking remote method 'x': Error: <real message>"
  const ipcError = (err: unknown): string =>
    (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')

  const saveToken = async () => {
    const token = tokenInput.trim()
    if (!token || busy) return
    setBusy(true)
    setError(null)
    try {
      // Validated against Telegram before it's persisted — a typo can't
      // clobber a working token.
      await window.electronAPI.setTelegramToken(token)
      setTokenInput('')
      setShowTokenInput(false)
      flash('Token verified and saved')
    } catch (err) {
      setError(`Token rejected: ${ipcError(err)}`)
    }
    setBusy(false)
  }

  const toggleBot = async () => {
    if (!status?.hasToken || busy) return
    setBusy(true)
    setError(null)
    try {
      if (status.enabled) await window.electronAPI.disableTelegram()
      else await window.electronAPI.enableTelegram()
    } catch (err) {
      setError(ipcError(err))
    }
    setBusy(false)
  }

  const generateCode = async () => {
    setError(null)
    await window.electronAPI.getTelegramPairingCode()
    // The status-update event delivers the new code; no local state needed.
  }

  const unpair = async (id: number) => {
    if (!confirm(`Unpair Telegram account ${id}? It will lose access to your agents.`)) return
    await window.electronAPI.unpairTelegram(id)
  }

  const rowStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '8px', backgroundColor: '#252525', borderRadius: '4px', gap: '8px'
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', borderTop: '1px solid #333', paddingTop: '16px' }}>
      <div style={{ fontSize: '12px', color: '#888', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        Telegram Bot <span style={{ color: '#eab308', textTransform: 'none', fontWeight: 600 }}>(experimental)</span>
      </div>
      <div style={{ fontSize: '11px', color: '#666', lineHeight: '1.5' }}>
        Drive your agents from your phone: /status, /use, /msg, /output, /task — and agent replies
        land in your chat. Create a bot with @BotFather in Telegram, paste its token, then pair.
        Works in direct messages only.
      </div>

      {/* Bot token */}
      <div style={rowStyle}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '13px', color: '#e0e0e0' }}>Bot token</div>
          <div style={{ fontSize: '11px', color: '#666' }}>
            {status?.hasToken ? 'Saved (stored encrypted)' : 'Paste the token from @BotFather'}
          </div>
        </div>
        {showTokenInput ? (
          <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
            <input
              type="password"
              autoFocus
              placeholder="123456:ABC-DEF…"
              value={tokenInput}
              onChange={e => setTokenInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') saveToken()
                if (e.key === 'Escape') { setShowTokenInput(false); setTokenInput('') }
              }}
              style={{
                width: '150px', padding: '4px 8px', backgroundColor: '#333', color: '#e0e0e0',
                border: '1px solid #555', borderRadius: '4px', fontSize: '12px'
              }}
            />
            <button
              onClick={saveToken}
              disabled={!tokenInput.trim() || busy}
              style={{
                padding: '4px 10px', backgroundColor: '#3b82f6', color: '#fff',
                border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px',
                opacity: tokenInput.trim() && !busy ? 1 : 0.5
              }}
            >{busy ? '…' : 'Save'}</button>
          </div>
        ) : (
          <button
            onClick={() => setShowTokenInput(true)}
            style={{
              padding: '4px 10px', backgroundColor: '#333', color: '#e0e0e0',
              border: '1px solid #555', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', flexShrink: 0
            }}
          >{status?.hasToken ? 'Change' : 'Set token'}</button>
        )}
      </div>

      {/* Enable toggle */}
      <label style={{ ...rowStyle, cursor: status?.hasToken ? 'pointer' : 'not-allowed', opacity: status?.hasToken ? 1 : 0.5 }}>
        <div>
          <div style={{ fontSize: '13px', color: '#e0e0e0' }}>Enable Telegram bot</div>
          <div style={{ fontSize: '11px', color: '#666' }}>
            {status?.enabled ? 'Running — long-polling Telegram (no tunnel needed)' : 'Bot is off'}
          </div>
        </div>
        <div
          onClick={toggleBot}
          style={{
            width: 40, height: 22, borderRadius: 11,
            backgroundColor: status?.enabled ? '#4caf50' : '#444',
            position: 'relative', cursor: status?.hasToken ? 'pointer' : 'not-allowed',
            transition: 'background-color 0.2s', flexShrink: 0, marginLeft: 12
          }}
        >
          <div style={{
            width: 18, height: 18, borderRadius: '50%',
            backgroundColor: '#fff', position: 'absolute', top: 2,
            left: status?.enabled ? 20 : 2,
            transition: 'left 0.2s'
          }} />
        </div>
      </label>

      {/* Which inbox priorities get pushed to Telegram */}
      <label style={{ ...rowStyle }}>
        <div>
          <div style={{ fontSize: '13px', color: '#e0e0e0' }}>Send to Telegram when</div>
          <div style={{ fontSize: '11px', color: '#666' }}>
            Mirror inbox messages at or above this urgency to your phone.
          </div>
        </div>
        <select
          value={threshold}
          onChange={e => changeThreshold(e.target.value as NotificationThreshold)}
          style={{
            backgroundColor: '#1a1a1a', color: '#e0e0e0', border: '1px solid #3a3a3a',
            borderRadius: 4, padding: '4px 8px', fontSize: 12, marginLeft: 12, flexShrink: 0
          }}
        >
          <option value="low">Everything</option>
          <option value="normal">Normal &amp; up</option>
          <option value="high">High &amp; up</option>
          <option value="urgent">Urgent only</option>
          <option value="none">Nothing (off)</option>
        </select>
      </label>

      {/* Pairing — only meaningful while the bot is running */}
      {status?.enabled && (
        <>
          <div style={rowStyle}>
            <div>
              <div style={{ fontSize: '13px', color: '#e0e0e0' }}>Pair a phone</div>
              <div style={{ fontSize: '11px', color: '#666' }}>Code is single-use and expires in 10 minutes</div>
            </div>
            {status.activePairingCode ? (
              <div style={{
                fontSize: '18px', fontFamily: 'monospace', letterSpacing: '3px',
                color: '#6ee7b7', padding: '2px 10px', backgroundColor: '#1a2e1a',
                borderRadius: '4px', flexShrink: 0
              }}>{status.activePairingCode}</div>
            ) : (
              <button
                onClick={generateCode}
                style={{
                  padding: '4px 10px', backgroundColor: '#333', color: '#e0e0e0',
                  border: '1px solid #555', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', flexShrink: 0
                }}
              >Generate code</button>
            )}
          </div>
          {status.activePairingCode && (
            <div style={{ fontSize: '11px', color: '#888', padding: '0 4px' }}>
              Message your bot in Telegram: <span style={{ fontFamily: 'monospace', color: '#e0e0e0' }}>/pair {status.activePairingCode}</span>
            </div>
          )}
        </>
      )}

      {/* Paired accounts — shown even while the bot is off so unpair always works */}
      {status && status.pairedIds.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <div style={{ fontSize: '11px', color: '#666' }}>Linked Telegram accounts</div>
          {status.pairedIds.map(id => (
            <div key={id} style={rowStyle}>
              <div style={{ fontSize: '12px', color: '#e0e0e0', fontFamily: 'monospace' }}>{id}</div>
              <button
                onClick={() => unpair(id)}
                style={{
                  padding: '3px 10px', backgroundColor: '#3a2222', color: '#ef8888',
                  border: '1px solid #5a3333', borderRadius: '4px', cursor: 'pointer', fontSize: '11px', flexShrink: 0
                }}
              >Unpair</button>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div style={{ fontSize: '11px', color: '#ef4444', padding: '4px 8px', backgroundColor: '#2e1a1a', borderRadius: '4px' }}>
          {error}
        </div>
      )}
      {notice && (
        <div style={{ fontSize: '11px', color: '#6ee7b7', padding: '4px 8px', backgroundColor: '#1a2e1a', borderRadius: '4px' }}>
          {notice}
        </div>
      )}
    </div>
  )
}

function StreamDeckSection(): React.ReactElement {
  const [sdSettings, setSdSettings] = React.useState<{ enabled: boolean; whisperBackend: 'cloud' | 'local' | 'disabled'; openaiApiKey?: string }>({ enabled: true, whisperBackend: 'cloud' })
  const [showKey, setShowKey] = React.useState(false)
  const [connection, setConnection] = React.useState<'connected' | 'disconnected' | 'unknown'>('unknown')
  const [localProgress, setLocalProgress] = React.useState<{ stage: string; percent: number; detail?: string } | null>(null)

  React.useEffect(() => {
    void electronAPI.getSettings().then((all: Record<string, unknown>) => {
      const s = all.streamdeck as typeof sdSettings | undefined
      if (s) setSdSettings(prev => ({ ...prev, ...s }))
    })
    void window.electronAPI.getStreamDeckStatus?.().then((s: 'connected' | 'disconnected') => setConnection(s))

    // Subscribe to local Whisper setup progress events.
    const off = window.electronAPI.onLocalWhisperProgress?.((evt) => setLocalProgress(evt))
    return () => off?.()
  }, [])

  const update = async (patch: Partial<typeof sdSettings>) => {
    const next = { ...sdSettings, ...patch }
    setSdSettings(next)
    await electronAPI.setSetting('streamdeck', next)
    // When user switches TO local, kick off setup. The handler is idempotent —
    // if everything is already in place, fires a single ready event and returns.
    if (patch.whisperBackend === 'local') {
      setLocalProgress({ stage: 'model', percent: 0, detail: 'Checking local Whisper setup…' })
      void window.electronAPI.prepareLocalWhisper?.()
    } else if (patch.whisperBackend !== undefined) {
      // Switched away from local — clear the bar
      setLocalProgress(null)
    }
  }

  const rowStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '8px', backgroundColor: '#252525', borderRadius: '4px', gap: '8px'
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', borderTop: '1px solid #333', paddingTop: '16px' }}>
      <div style={{ fontSize: '12px', color: '#888', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        Stream Deck
      </div>

      <div style={rowStyle}>
        <div>
          <div style={{ fontSize: '13px', color: '#e0e0e0' }}>Enable Stream Deck integration</div>
          <div style={{ fontSize: '11px', color: '#666' }}>Connect a Stream Deck MK.2 for hardware controls</div>
        </div>
        <div
          onClick={() => void update({ enabled: !sdSettings.enabled })}
          style={{
            width: 40, height: 22, borderRadius: 11,
            backgroundColor: sdSettings.enabled ? '#4caf50' : '#444',
            position: 'relative', cursor: 'pointer', transition: 'background-color 0.2s',
            flexShrink: 0, marginLeft: 12
          }}
        >
          <div style={{
            width: 18, height: 18, borderRadius: '50%',
            backgroundColor: '#fff', position: 'absolute', top: 2,
            left: sdSettings.enabled ? 20 : 2,
            transition: 'left 0.2s'
          }} />
        </div>
      </div>

      <div style={{ ...rowStyle, flexDirection: 'column', alignItems: 'flex-start' }}>
        <div style={{ fontSize: '13px', color: '#e0e0e0' }}>Voice transcription</div>
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          {(['cloud', 'local', 'disabled'] as const).map(opt => (
            <label key={opt} style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: '#ccc', cursor: 'pointer' }}>
              <input type="radio" name="sd-whisper" value={opt}
                     checked={sdSettings.whisperBackend === opt}
                     onChange={() => void update({ whisperBackend: opt })} />
              {opt === 'cloud' ? 'Cloud (OpenAI Whisper)'
                : opt === 'local' ? 'Local (Whisper.cpp)'
                : 'Disabled'}
            </label>
          ))}
        </div>
      </div>

      {sdSettings.whisperBackend === 'local' && localProgress && (
        <div style={{ ...rowStyle, flexDirection: 'column', alignItems: 'stretch', gap: '6px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: '13px', color: '#e0e0e0' }}>
              {localProgress.stage === 'ready'
                ? 'Local Whisper ready'
                : localProgress.stage === 'error'
                  ? 'Setup failed'
                  : localProgress.stage === 'model'
                    ? 'Downloading model'
                    : localProgress.stage === 'configure'
                      ? 'Configuring CMake'
                      : 'Building whisper.cpp'}
            </div>
            <div style={{ fontSize: '11px', color: '#888' }}>{localProgress.percent}%</div>
          </div>
          <div style={{ height: 6, backgroundColor: '#1a1a1a', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{
              width: `${localProgress.percent}%`,
              height: '100%',
              backgroundColor: localProgress.stage === 'error' ? '#ef4444' : localProgress.stage === 'ready' ? '#4caf50' : '#3b82f6',
              transition: 'width 0.3s ease',
            }} />
          </div>
          {localProgress.detail && (
            <div style={{ fontSize: '10px', color: '#666', fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {localProgress.detail}
            </div>
          )}
          {localProgress.stage === 'error' && (
            <button
              type="button"
              onClick={() => {
                setLocalProgress({ stage: 'model', percent: 0, detail: 'Retrying…' })
                void window.electronAPI.prepareLocalWhisper?.()
              }}
              style={{
                padding: '4px 12px', backgroundColor: '#333', color: '#e0e0e0',
                border: '1px solid #444', borderRadius: '4px', cursor: 'pointer', fontSize: '11px', alignSelf: 'flex-start'
              }}
            >Retry</button>
          )}
        </div>
      )}

      {sdSettings.whisperBackend === 'cloud' && (
        <div style={rowStyle}>
          <div style={{ fontSize: '13px', color: '#e0e0e0', flexShrink: 0 }}>OpenAI API key</div>
          <div style={{ display: 'flex', gap: '6px', flex: 1, minWidth: 0 }}>
            <input
              type={showKey ? 'text' : 'password'}
              value={sdSettings.openaiApiKey ?? ''}
              onChange={e => void update({ openaiApiKey: e.target.value })}
              placeholder="sk-…"
              style={{
                flex: 1, minWidth: 0, padding: '4px 8px', backgroundColor: '#1a1a1a',
                color: '#e0e0e0', border: '1px solid #444', borderRadius: '4px', fontSize: '12px'
              }}
            />
            <button
              type="button"
              onClick={() => setShowKey(v => !v)}
              style={{
                padding: '4px 10px', backgroundColor: '#333', color: '#e0e0e0',
                border: '1px solid #444', borderRadius: '4px', cursor: 'pointer', fontSize: '11px', flexShrink: 0
              }}
            >{showKey ? 'Hide' : 'Show'}</button>
          </div>
        </div>
      )}

      <div style={rowStyle}>
        <div>
          <div style={{ fontSize: '13px', color: '#e0e0e0' }}>Connection</div>
          <div style={{ fontSize: '11px', color: connection === 'connected' ? '#4caf50' : connection === 'disconnected' ? '#ef4444' : '#888' }}>
            {connection}
          </div>
        </div>
        <button
          type="button"
          onClick={() => window.electronAPI.reconnectStreamDeck?.()}
          style={{
            padding: '4px 12px', backgroundColor: '#333', color: '#e0e0e0',
            border: '1px solid #444', borderRadius: '4px', cursor: 'pointer', fontSize: '12px'
          }}
        >Reconnect</button>
      </div>
    </div>
  )
}
