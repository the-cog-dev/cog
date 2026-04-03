import React, { useState, useEffect, useCallback } from 'react'

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
}

function formatTimeLeft(ms: number | null): string {
  if (!ms) return 'No limit'
  const hours = Math.floor(ms / 3600000)
  const mins = Math.floor((ms % 3600000) / 60000)
  if (hours > 0) return `${hours}h ${mins}m left`
  return `${mins}m left`
}

// R.A.C. is in-house only — password gate for the crew
const RAC_ACCESS_HASH = '368fa83a780bba3be2be74ed7560b7a5d8dc46639f4646c997d631bc548ecda9' // sha256 of crew password

async function hashPassword(pw: string): Promise<string> {
  const data = new TextEncoder().encode(pw)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

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
  const [renting, setRenting] = useState<string | null>(null) // slot_id being rented

  // Check if already unlocked this session
  useEffect(() => {
    if (sessionStorage.getItem('rac-unlocked') === 'true') {
      setUnlocked(true)
    }
  }, [])

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
        {passwordError && (
          <div style={{ color: '#f44336', fontSize: '11px' }}>Wrong password</div>
        )}
      </div>
    )
  }

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
    electronAPI.racGetServer().then(url => {
      setServerUrl(url)
      setUrlInput(url)
    })
    refresh()
    const interval = setInterval(refresh, 5000)
    return () => clearInterval(interval)
  }, [refresh])

  const handleRent = async (slotId: string) => {
    setRenting(slotId)
    const result = await electronAPI.racRent(slotId, 'AgentOrch')
    if (result.error) {
      setError(result.error)
    }
    setRenting(null)
    refresh()
  }

  const handleRelease = async (sessionId: string) => {
    const result = await electronAPI.racRelease(sessionId)
    if (result.error) {
      setError(result.error)
    }
    refresh()
  }

  const handleSaveUrl = async () => {
    await electronAPI.racSetServer(urlInput)
    setServerUrl(urlInput)
    setEditingUrl(false)
    refresh()
  }

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
                <span style={{ color: '#555', fontSize: '11px', marginLeft: '8px' }}>
                  {formatTimeLeft(slot.time_left_ms)}
                </span>
              </div>
              <button
                onClick={() => handleRent(slot.slot_id)}
                disabled={renting === slot.slot_id}
                style={{
                  padding: '3px 10px', fontSize: '11px', borderRadius: '4px', cursor: 'pointer',
                  border: '1px solid #4caf50', backgroundColor: '#2d5a2d', color: '#4caf50',
                  fontWeight: 'bold'
                }}
              >
                {renting === slot.slot_id ? '...' : 'RENT'}
              </button>
            </div>
            {slot.note && (
              <div style={{ color: '#888', fontSize: '11px', marginTop: '4px', fontStyle: 'italic' }}>
                "{slot.note}"
              </div>
            )}
          </div>
        ))}

        {/* Active sessions */}
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
