import React, { useState, useEffect, useCallback, useRef } from 'react'
import { hashCrewPassword as hashPassword, CREW_ACCESS_HASH } from '../../shared/crew-auth'

interface RacSlot {
  slot_id: string
  parker_name: string
  tier: string
  note: string
  expires_at: number | null
  time_left_ms: number | null
}

interface RacSession {
  session_id: string
  slot_id: string
  parker: string
  renter: string
  agentorch_agent: string
  status: string
}

declare const electronAPI: {
  racGetServer: () => Promise<string>
  racSetServer: (url: string) => Promise<{ status: string }>
  racGetAvailable: () => Promise<{ available: RacSlot[]; count: number; error?: string }>
  racRent: (slotId: string, renterName: string) => Promise<RacSession & { error?: string }>
  racRelease: (sessionId: string) => Promise<{ status?: string; error?: string }>
  racGetSessions: () => Promise<RacSession[]>
  getHubInfo: () => Promise<{ port: number; secret: string }>
}

function formatTimeLeft(ms: number | null): string {
  if (!ms || ms <= 0) return 'No limit'
  const hours = Math.floor(ms / 3600000)
  const mins = Math.floor((ms % 3600000) / 60000)
  const secs = Math.floor((ms % 60000) / 1000)
  if (hours > 0) return `${hours}h ${mins}m`
  if (mins > 0) return `${mins}m ${secs}s`
  return `${secs}s`
}

// R.A.C. is in-house only — password gate for the crew
const RAC_ACCESS_HASH = CREW_ACCESS_HASH

type PanelView = 'list' | 'rent-dialog' | 'session-detail'

export function RacPanel(): React.ReactElement {
  const [unlocked, setUnlocked] = useState(false)
  const [passwordInput, setPasswordInput] = useState('')
  const [passwordError, setPasswordError] = useState(false)

  const [serverUrl, setServerUrl] = useState('')
  const [editingUrl, setEditingUrl] = useState(false)
  const [urlInput, setUrlInput] = useState('')
  const [available, setAvailable] = useState<RacSlot[]>([])
  const [sessions, setSessions] = useState<RacSession[]>([])
  const [error, setError] = useState<string | null>(null)
  const [renting, setRenting] = useState(false)

  // View state
  const [view, setView] = useState<PanelView>('list')
  const [selectedSlot, setSelectedSlot] = useState<RacSlot | null>(null)
  const [selectedSession, setSelectedSession] = useState<RacSession | null>(null)

  // Rent dialog form
  const [rentCeoNotes, setRentCeoNotes] = useState('You are a remote worker rented via R.A.C. You communicate through hub messages only. When given a task, work on it and send results back via send_message().')
  const [rentGitRepo, setRentGitRepo] = useState('')
  const [rentName, setRentName] = useState('')

  // Live timer
  const [now, setNow] = useState(Date.now())
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ALL hooks above early return
  const refresh = useCallback(async () => {
    try {
      const [avail, sess] = await Promise.all([
        electronAPI.racGetAvailable(),
        electronAPI.racGetSessions()
      ])
      if (avail.error) {
        setError(avail.error)
        setAvailable([])
      } else {
        setError(null)
        setAvailable(avail.available)
      }
      setSessions(sess)
    } catch (err: any) {
      setError(err.message)
    }
  }, [])

  useEffect(() => {
    if (sessionStorage.getItem('rac-unlocked') === 'true') {
      setUnlocked(true)
    }
  }, [])

  useEffect(() => {
    if (!unlocked) return
    electronAPI.racGetServer().then(url => {
      setServerUrl(url)
      setUrlInput(url)
    })
    refresh()
    const interval = setInterval(refresh, 5000)
    return () => clearInterval(interval)
  }, [unlocked, refresh])

  // Live countdown timer (updates every second when sessions exist)
  useEffect(() => {
    if (sessions.length > 0 || available.length > 0) {
      timerRef.current = setInterval(() => setNow(Date.now()), 1000)
      return () => { if (timerRef.current) clearInterval(timerRef.current) }
    }
  }, [sessions.length, available.length])

  const handleUnlock = async () => {
    const hash = await hashPassword(passwordInput)
    if (hash === RAC_ACCESS_HASH) {
      setUnlocked(true)
      sessionStorage.setItem('rac-unlocked', 'true')
      setPasswordError(false)
    } else {
      setPasswordError(true)
    }
  }

  // --- Lock screen ---
  if (!unlocked) {
    return (
      <div style={{
        height: '100%', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        backgroundColor: '#1e1e1e', color: '#e0e0e0', gap: '12px', padding: '24px'
      }}>
        <div style={{ fontSize: '14px', fontWeight: 500 }}>R.A.C. — Crew Access Only</div>
        <div style={{ color: '#666', fontSize: '12px', textAlign: 'center' }}>
          This feature is in private testing. Enter the crew password to access.
        </div>
        <input
          type="password"
          value={passwordInput}
          onChange={e => { setPasswordInput(e.target.value); setPasswordError(false) }}
          onKeyDown={e => e.key === 'Enter' && handleUnlock()}
          placeholder="Password"
          style={{
            backgroundColor: '#2a2a2a', border: `1px solid ${passwordError ? '#f44336' : '#444'}`,
            borderRadius: '4px', padding: '8px 12px', color: '#e0e0e0', fontSize: '13px',
            width: '200px', textAlign: 'center'
          }}
        />
        <button onClick={handleUnlock} style={{
          padding: '6px 20px', backgroundColor: '#2d5a2d', border: '1px solid #4caf50',
          borderRadius: '4px', color: '#4caf50', cursor: 'pointer', fontSize: '12px'
        }}>Unlock</button>
        {passwordError && <div style={{ color: '#f44336', fontSize: '11px' }}>Wrong password</div>}
      </div>
    )
  }

  // --- Rent dialog ---
  const handleOpenRentDialog = (slot: RacSlot) => {
    setSelectedSlot(slot)
    setRentName(slot.parker_name)
    setView('rent-dialog')
  }

  const handleConfirmRent = async () => {
    if (!selectedSlot) return
    setRenting(true)

    // Build CEO notes with git repo if provided
    let fullNotes = rentCeoNotes
    if (rentGitRepo.trim()) {
      fullNotes += `\n\nGit repository: ${rentGitRepo.trim()}\nClone the repo to get the codebase. Work on a feature branch and push when done.`
    }

    const result = await electronAPI.racRent(selectedSlot.slot_id, rentName || 'The Cog')
    if (result.error) {
      setError(result.error)
    } else {
      // TODO: Send CEO notes to the rented agent via hub message
      setView('list')
    }
    setRenting(false)
    refresh()
  }

  const handleRelease = async (sessionId: string) => {
    const result = await electronAPI.racRelease(sessionId)
    if (result.error) {
      setError(result.error)
    }
    setView('list')
    refresh()
  }

  const handleSaveUrl = async () => {
    await electronAPI.racSetServer(urlInput)
    setServerUrl(urlInput)
    setEditingUrl(false)
    refresh()
  }

  const liveTimeLeft = (slot: RacSlot): string => {
    if (!slot.expires_at) return 'No limit'
    const remaining = slot.expires_at - now
    if (remaining <= 0) return 'Expired'
    return formatTimeLeft(remaining)
  }

  // --- Rent dialog view ---
  if (view === 'rent-dialog' && selectedSlot) {
    return (
      <div style={{
        height: '100%', display: 'flex', flexDirection: 'column',
        backgroundColor: '#1e1e1e', color: '#e0e0e0', fontSize: '13px'
      }}>
        <div style={{
          padding: '8px 12px', borderBottom: '1px solid #333',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center'
        }}>
          <span style={{ fontSize: '12px', color: '#888', fontWeight: 500 }}>
            Rent {selectedSlot.parker_name}'s Claude
          </span>
          <button onClick={() => setView('list')} style={{
            background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: '14px'
          }}>x</button>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {/* Slot info */}
          <div style={{ padding: '8px', backgroundColor: '#252525', borderRadius: '4px', border: '1px solid #333' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span><span style={{ color: '#4caf50' }}>{'\u25CF'}</span> {selectedSlot.parker_name}</span>
              <span style={{ color: '#888', fontSize: '11px' }}>{selectedSlot.tier}</span>
            </div>
            <div style={{ color: '#ffc107', fontSize: '12px', marginTop: '4px' }}>
              Time remaining: {liveTimeLeft(selectedSlot)}
            </div>
            {selectedSlot.note && (
              <div style={{ color: '#888', fontSize: '11px', marginTop: '4px', fontStyle: 'italic' }}>"{selectedSlot.note}"</div>
            )}
          </div>

          {/* Renter name */}
          <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: '#aaa' }}>
            Your Name
            <input value={rentName} onChange={e => setRentName(e.target.value)} style={{
              backgroundColor: '#2a2a2a', border: '1px solid #444', borderRadius: '4px',
              padding: '6px 8px', color: '#e0e0e0', fontSize: '12px'
            }} />
          </label>

          {/* Git repo */}
          <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: '#aaa' }}>
            Git Repository (optional)
            <input value={rentGitRepo} onChange={e => setRentGitRepo(e.target.value)} placeholder="https://github.com/you/repo.git" style={{
              backgroundColor: '#2a2a2a', border: '1px solid #444', borderRadius: '4px',
              padding: '6px 8px', color: '#e0e0e0', fontSize: '12px'
            }} />
            <span style={{ color: '#555', fontSize: '10px' }}>The rented agent will clone this repo to access your codebase</span>
          </label>

          {/* CEO Notes */}
          <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: '#aaa' }}>
            Instructions for Rented Agent
            <textarea value={rentCeoNotes} onChange={e => setRentCeoNotes(e.target.value)} rows={5} style={{
              backgroundColor: '#2a2a2a', border: '1px solid #444', borderRadius: '4px',
              padding: '6px 8px', color: '#e0e0e0', fontSize: '12px', resize: 'vertical', fontFamily: 'inherit'
            }} />
          </label>

          {/* Info box */}
          <div style={{ padding: '8px', backgroundColor: '#1a2a3a', borderRadius: '4px', border: '1px solid #2a4a6a', fontSize: '11px', color: '#8cb4e0' }}>
            This agent runs remotely in a Docker container. It communicates through hub messages — your orchestrator can send_message() to it and receive results back. It cannot access your local files directly.
          </div>
        </div>

        <div style={{ padding: '8px 12px', borderTop: '1px solid #333', display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button onClick={() => setView('list')} style={{
            padding: '6px 16px', backgroundColor: '#2a2a2a', border: '1px solid #444',
            borderRadius: '4px', color: '#aaa', cursor: 'pointer', fontSize: '12px'
          }}>Cancel</button>
          <button onClick={handleConfirmRent} disabled={renting} style={{
            padding: '6px 16px', backgroundColor: '#2d5a2d', border: '1px solid #4caf50',
            borderRadius: '4px', color: '#4caf50', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold'
          }}>{renting ? 'Renting...' : 'RENT'}</button>
        </div>
      </div>
    )
  }

  // --- Main list view ---
  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column',
      backgroundColor: '#1e1e1e', color: '#e0e0e0', fontSize: '13px'
    }}>
      {/* Header */}
      <div style={{
        padding: '8px 12px', borderBottom: '1px solid #333',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center'
      }}>
        <span style={{ fontSize: '12px', color: '#888', fontWeight: 500 }}>
          R.A.C. — Rent-A-Claude
        </span>
        <button onClick={() => setEditingUrl(!editingUrl)} style={{
          background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: '14px'
        }}>
          {editingUrl ? 'x' : '\u2699'}
        </button>
      </div>

      {/* Server URL config */}
      {editingUrl && (
        <div style={{ padding: '8px 12px', borderBottom: '1px solid #333', display: 'flex', gap: '4px' }}>
          <input value={urlInput} onChange={e => setUrlInput(e.target.value)} style={{
            flex: 1, backgroundColor: '#2a2a2a', border: '1px solid #444', borderRadius: '4px',
            padding: '4px 8px', color: '#e0e0e0', fontSize: '11px'
          }} placeholder="http://localhost:7700" />
          <button onClick={handleSaveUrl} style={{
            padding: '4px 8px', backgroundColor: '#2d5a2d', border: '1px solid #4caf50',
            borderRadius: '4px', color: '#4caf50', cursor: 'pointer', fontSize: '11px'
          }}>Save</button>
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{ padding: '6px 12px', backgroundColor: '#3a1a1a', color: '#ff6b6b', fontSize: '11px' }}>
          {error}
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto', padding: '8px' }}>
        {/* Available slots */}
        <div style={{ color: '#888', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
          Available ({available.length})
        </div>

        {available.length === 0 && !error && (
          <div style={{ color: '#555', fontSize: '12px', padding: '12px 0', textAlign: 'center' }}>
            No slots available right now.
          </div>
        )}

        {available.map(slot => (
          <div key={slot.slot_id} style={{
            padding: '8px 10px', marginBottom: '4px', borderRadius: '4px',
            backgroundColor: '#252525', border: '1px solid #333'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <span style={{ color: '#4caf50', marginRight: '6px' }}>{'\u25CF'}</span>
                <span style={{ fontWeight: 500 }}>{slot.parker_name}</span>
                <span style={{ color: '#666', fontSize: '11px', marginLeft: '8px' }}>{slot.tier}</span>
              </div>
              <button
                onClick={() => handleOpenRentDialog(slot)}
                style={{
                  padding: '3px 10px', fontSize: '11px', borderRadius: '4px', cursor: 'pointer',
                  border: '1px solid #4caf50', backgroundColor: '#2d5a2d', color: '#4caf50',
                  fontWeight: 'bold'
                }}
              >
                RENT
              </button>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
              {slot.note && (
                <span style={{ color: '#888', fontSize: '11px', fontStyle: 'italic' }}>"{slot.note}"</span>
              )}
              <span style={{ color: '#ffc107', fontSize: '11px' }}>{liveTimeLeft(slot)}</span>
            </div>
          </div>
        ))}

        {/* Rented sessions */}
        {sessions.length > 0 && (
          <>
            <div style={{
              color: '#888', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px',
              marginTop: '12px', marginBottom: '6px'
            }}>
              Rented ({sessions.length})
            </div>

            {sessions.map(session => (
              <div key={session.session_id} style={{
                padding: '8px 10px', marginBottom: '4px', borderRadius: '4px',
                backgroundColor: '#252525', border: '1px solid #4a6fa5'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <span style={{ color: '#4a9eff', marginRight: '6px' }}>{'\u25CF'}</span>
                    <span style={{ fontWeight: 500 }}>{session.parker}</span>
                    <span style={{ color: '#666', fontSize: '11px', marginLeft: '8px' }}>
                      Agent: {session.agentorch_agent}
                    </span>
                  </div>
                  <button
                    onClick={() => handleRelease(session.session_id)}
                    style={{
                      padding: '3px 10px', fontSize: '11px', borderRadius: '4px', cursor: 'pointer',
                      border: '1px solid #f44336', backgroundColor: '#3a1a1a', color: '#f44336'
                    }}
                  >
                    RELEASE
                  </button>
                </div>
                <div style={{ fontSize: '10px', color: '#555', marginTop: '4px' }}>
                  Session: {session.session_id} | Status: {session.status}
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {/* Footer */}
      <div style={{
        padding: '6px 12px', borderTop: '1px solid #333',
        fontSize: '10px', color: '#555', textAlign: 'center'
      }}>
        Server: {serverUrl}
      </div>
    </div>
  )
}
