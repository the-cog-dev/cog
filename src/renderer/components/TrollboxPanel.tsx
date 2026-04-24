import React, { useEffect, useRef, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import { TrollboxClient, type TrollboxState } from './trollbox/trollbox-client'
import {
  TROLLBOX_SUPABASE_URL,
  TROLLBOX_SUPABASE_ANON,
  TROLLBOX_ADMIN_ED25519_PUBKEY,
  TROLLBOX_ADMIN_X25519_PUBKEY,
} from '../../shared/trollbox-config'
import { hashCrewPassword, CREW_ACCESS_HASH } from '../../shared/crew-auth'
import { ChatroomLayout } from './trollbox/ChatroomLayout'
import { CliLayout } from './trollbox/CliLayout'
import { useTrollboxStyle } from './trollbox/useTrollboxStyle'
import { BAN_DURATIONS } from './trollbox/trollbox-render'

// Crew-password hash (shared with RacPanel via crew-auth). Hides admin UI from
// casual observers; carries no security weight — real admin power comes from
// the Ed25519 private key that's pasted at runtime and never embedded.
const TROLLBOX_CREW_HASH = CREW_ACCESS_HASH

const adminHoverButtonStyle: React.CSSProperties = {
  background: '#2a2a2a',
  color: '#e0e0e0',
  border: '1px solid #444',
  padding: '1px 6px',
  cursor: 'pointer',
  fontSize: 11,
  fontFamily: 'inherit',
}

const modSelectStyle: React.CSSProperties = {
  background: '#0d0d0d',
  color: '#e0e0e0',
  border: '1px solid #333',
  padding: '1px 4px',
  fontFamily: 'inherit',
  fontSize: 11,
  flex: 1,
}

function KillSwitchControls({
  paused,
  onPause,
  onUnpause,
}: {
  paused: boolean
  onPause: (reason: string, durationMs: number) => void
  onUnpause: () => void
}): React.ReactElement {
  const [reason, setReason] = useState('chill out')
  const [durationMin, setDurationMin] = useState(15)
  return (
    <div>
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value.slice(0, 80))}
        placeholder="reason (shown to users)"
        style={{
          width: '100%',
          background: '#0d0d0d',
          color: '#e0e0e0',
          border: '1px solid #333',
          padding: 6,
          marginBottom: 6,
          boxSizing: 'border-box',
          fontFamily: 'inherit',
          fontSize: '13px',
        }}
      />
      <select
        value={durationMin}
        onChange={(e) => setDurationMin(Number(e.target.value))}
        style={{
          marginRight: 8,
          background: '#0d0d0d',
          color: '#e0e0e0',
          border: '1px solid #333',
          padding: '4px 6px',
          fontFamily: 'inherit',
        }}
      >
        <option value={5}>5 min</option>
        <option value={15}>15 min</option>
        <option value={30}>30 min</option>
        <option value={60}>1 hour</option>
      </select>
      <button
        onClick={() => onPause(reason, durationMin * 60_000)}
        disabled={paused}
        style={{
          background: paused ? '#2a1a1a' : '#5a1a1a',
          color: '#fff',
          border: '1px solid #7a2a2a',
          padding: '4px 10px',
          cursor: paused ? 'not-allowed' : 'pointer',
          opacity: paused ? 0.5 : 1,
          fontFamily: 'inherit',
        }}
      >
        ⛔ KILL (pause)
      </button>
      <button
        onClick={onUnpause}
        disabled={!paused}
        style={{
          marginLeft: 6,
          background: paused ? '#1a5a2a' : '#1a2a1a',
          color: '#fff',
          border: '1px solid #2a7a3a',
          padding: '4px 10px',
          cursor: paused ? 'pointer' : 'not-allowed',
          opacity: paused ? 1 : 0.5,
          fontFamily: 'inherit',
        }}
      >
        ▶ unpause
      </button>
    </div>
  )
}

function RateLimitControl({
  currentMs,
  onSet,
}: {
  currentMs: number
  onSet: (ms: number) => void
}): React.ReactElement {
  const currentSec = Math.round(currentMs / 1000)
  const [draft, setDraft] = useState<string>(String(currentSec))
  // If admin issues a new rate limit (e.g. from another session) and the dialog
  // re-renders with a different currentMs, sync the draft once.
  useEffect(() => { setDraft(String(Math.round(currentMs / 1000))) }, [currentMs])
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
      <input
        type="number"
        min={0}
        max={3600}
        step={1}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        style={{
          width: 60,
          background: '#0d0d0d',
          color: '#e0e0e0',
          border: '1px solid #333',
          padding: '2px 6px',
          fontFamily: 'inherit',
          fontSize: 12,
          boxSizing: 'border-box',
        }}
      />
      <span style={{ color: '#888' }}>sec (0 = off)</span>
      <button
        onClick={() => {
          const n = Math.max(0, Math.floor(Number(draft)))
          if (Number.isFinite(n)) onSet(n * 1000)
        }}
        style={adminHoverButtonStyle}
      >
        set
      </button>
      <span style={{ color: '#666', marginLeft: 'auto' }}>
        current: {currentSec === 0 ? 'off' : `${currentSec}s`}
      </span>
    </div>
  )
}

function ActiveBansList({
  bans,
  onUnban,
  onSetDuration,
}: {
  bans: Array<{ kind: 'nick' | 'fp'; target: string; expiresAt: number }>
  onUnban: (kind: 'nick' | 'fp', target: string) => void
  onSetDuration: (kind: 'nick' | 'fp', target: string, durationMs: number) => void
}): React.ReactElement {
  if (bans.length === 0) {
    return <div style={{ color: '#555', fontSize: 12, fontStyle: 'italic' }}>none active</div>
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {bans.map(b => (
        <ActiveBanRow
          key={`${b.kind}:${b.target}`}
          ban={b}
          onUnban={() => onUnban(b.kind, b.target)}
          onSetDuration={(ms) => onSetDuration(b.kind, b.target, ms)}
        />
      ))}
    </div>
  )
}

function ActiveBanRow({
  ban,
  onUnban,
  onSetDuration,
}: {
  ban: { kind: 'nick' | 'fp'; target: string; expiresAt: number }
  onUnban: () => void
  onSetDuration: (durationMs: number) => void
}): React.ReactElement {
  const [newDurMs, setNewDurMs] = useState(15 * 60_000)
  const remainingSec = Math.max(0, Math.round((ban.expiresAt - Date.now()) / 1000))
  const mm = Math.floor(remainingSec / 60)
  const ss = remainingSec % 60
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        padding: '4px 6px',
        background: '#161616',
        border: '1px solid #2a2a2a',
        borderRadius: 3,
        fontSize: 12,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>
          <span style={{ color: '#888' }}>{ban.kind}:</span>{' '}
          <span style={{ color: '#e0e0e0', fontWeight: 600 }}>{ban.target}</span>{' '}
          <span style={{ color: '#666' }}>
            ({mm}:{String(ss).padStart(2, '0')})
          </span>
        </span>
        <button onClick={onUnban} style={adminHoverButtonStyle}>
          unban
        </button>
      </div>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <select
          value={newDurMs}
          onChange={(e) => setNewDurMs(Number(e.target.value))}
          style={modSelectStyle}
        >
          {BAN_DURATIONS.map(d => (
            <option key={d.ms} value={d.ms}>{d.label}</option>
          ))}
        </select>
        <button onClick={() => onSetDuration(newDurMs)} style={adminHoverButtonStyle}>
          set
        </button>
      </div>
    </div>
  )
}

export function TrollboxPanel(): React.ReactElement {
  const { style, theme } = useTrollboxStyle()
  const [state, setState] = useState<TrollboxState>({
    status: 'closed',
    onlineCount: 0,
    messages: [],
    pauseUntil: null,
    pauseReason: null,
  })
  const [nick, setNick] = useState<string>(() => {
    try { return localStorage.getItem('trollbox:nick') ?? 'anon' } catch { return 'anon' }
  })
  const [editingNick, setEditingNick] = useState(false)
  const [nickDraft, setNickDraft] = useState(nick)
  const [text, setText] = useState('')
  const [sendHint, setSendHint] = useState<string | null>(null)
  const [showAdminDialog, setShowAdminDialog] = useState(false)
  const [adminUnlocked, setAdminUnlocked] = useState(false)
  const [adminPasswordInput, setAdminPasswordInput] = useState('')
  const [adminPasswordError, setAdminPasswordError] = useState(false)
  const [adminKeyInput, setAdminKeyInput] = useState('')
  const [adminKeyStatus, setAdminKeyStatus] = useState<'none' | 'loaded' | 'bad'>('none')
  const [activeBans, setActiveBans] = useState<
    Array<{ kind: 'nick' | 'fp'; target: string; expiresAt: number }>
  >([])
  const clientRef = useRef<TrollboxClient | null>(null)
  const logRef = useRef<HTMLDivElement | null>(null)
  const sendHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let disposed = false
    let localClient: TrollboxClient | null = null
    let unsubscribe: (() => void) | null = null

    ;(async () => {
      const machineHash = await window.electronAPI.getMachineHash()
      if (disposed) return
      const supabase = createClient(TROLLBOX_SUPABASE_URL, TROLLBOX_SUPABASE_ANON, {
        realtime: { params: { eventsPerSecond: 10 } },
      })
      const client = new TrollboxClient({
        supabase,
        machineHash,
        adminEd25519Pub: TROLLBOX_ADMIN_ED25519_PUBKEY,
        adminX25519Pub: TROLLBOX_ADMIN_X25519_PUBKEY,
      })
      if (disposed) return
      clientRef.current = client
      localClient = client
      unsubscribe = client.onState(setState)
      await client.connect()
    })()

    return () => {
      disposed = true
      if (sendHintTimerRef.current) {
        clearTimeout(sendHintTimerRef.current)
        sendHintTimerRef.current = null
      }
      if (unsubscribe) unsubscribe()
      if (localClient) {
        localClient.disconnect()
      }
      clientRef.current = null
    }
  }, [])

  // Auto-scroll to bottom on new messages only when user is already near-bottom
  useEffect(() => {
    const el = logRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [state.messages.length])

  // Poll the client's localBans every 5s while admin dialog is open. Cheap,
  // localBans only mutates on broadcast, so polling is sufficient.
  useEffect(() => {
    if (!showAdminDialog) return
    const refresh = () => {
      const bans = clientRef.current?.getActiveBans() ?? []
      setActiveBans(bans)
    }
    refresh()
    const id = setInterval(refresh, 5000)
    return () => clearInterval(id)
  }, [showAdminDialog])

  const onSend = async () => {
    const client = clientRef.current
    const trimmed = text.trim()
    if (!client || !trimmed) return
    const res = await client.sendChat(nick, trimmed)
    if (sendHintTimerRef.current) {
      clearTimeout(sendHintTimerRef.current)
      sendHintTimerRef.current = null
    }
    if (res.ok) {
      setText('')
      setSendHint(null)
    } else {
      const hint =
        res.reason === 'rate-limit'     ? '\u2717 slow down' :
        res.reason === 'paused'         ? '\u26A0 room is paused' :
        res.reason === 'not-connected'  ? '\u26A0 disconnected' :
        res.reason === 'banned'         ? '\u2717 you are banned' :
        `\u2717 ${res.reason}`
      setSendHint(hint)
      sendHintTimerRef.current = setTimeout(() => {
        setSendHint(null)
        sendHintTimerRef.current = null
      }, 2000)
    }
  }

  const commitNick = () => {
    const next = nickDraft.trim().slice(0, 24) || 'anon'
    setNick(next)
    try { localStorage.setItem('trollbox:nick', next) } catch { /* ignore */ }
    setEditingNick(false)
  }

  const tryUnlockAdmin = async () => {
    const h = await hashCrewPassword(adminPasswordInput)
    if (h === TROLLBOX_CREW_HASH) {
      setAdminUnlocked(true)
      setAdminPasswordError(false)
      setAdminPasswordInput('')
    } else {
      setAdminPasswordError(true)
    }
  }

  const tryLoadAdminKey = async () => {
    const client = clientRef.current
    const blob = adminKeyInput.trim()
    // Expected: 64-byte blob as 128 hex chars (32-byte Ed25519 seed || 32-byte X25519 priv).
    if (!client || blob.length !== 128 || !/^[0-9a-fA-F]+$/.test(blob)) {
      setAdminKeyStatus('bad')
      return
    }
    try {
      const { hexToBytes } = await import('@noble/hashes/utils')
      const edPriv = hexToBytes(blob.slice(0, 64))    // 32-byte Ed25519 seed
      const xPriv  = hexToBytes(blob.slice(64, 128))  // 32-byte X25519 seed
      const { x25519 } = await import('@noble/curves/ed25519')
      const { signAdmin, verifyAdmin } = await import('../../shared/trollbox-crypto')
      // 1) Ed25519 sign-and-verify round-trip against embedded pub
      const testPayload = { type: 'validate', ts: Date.now() }
      const signed = signAdmin(testPayload, edPriv)
      const okSig = verifyAdmin(signed, TROLLBOX_ADMIN_ED25519_PUBKEY)
      // 2) X25519 priv → pub must match embedded X25519 pub
      const derivedXPub = x25519.getPublicKey(xPriv)
      const okX =
        derivedXPub.length === TROLLBOX_ADMIN_X25519_PUBKEY.length &&
        derivedXPub.every((b, i) => b === TROLLBOX_ADMIN_X25519_PUBKEY[i])
      if (!okSig || !okX) {
        setAdminKeyStatus('bad')
        return
      }
      client.loadAdminKeys(edPriv, xPriv)
      setAdminKeyStatus('loaded')
      setAdminKeyInput('')
    } catch {
      setAdminKeyStatus('bad')
    }
  }

  const unloadAdmin = () => {
    clientRef.current?.unloadAdminKeys()
    setAdminKeyStatus('none')
  }

  const layoutProps = {
    state,
    theme,
    nick,
    nickDraft,
    editingNick,
    text,
    sendHint,
    adminKeyStatus,
    clientRef,
    logRef,
    onStartEditNick: () => { setNickDraft(nick); setEditingNick(true) },
    onNickDraftChange: setNickDraft,
    onCommitNick: commitNick,
    onTextChange: (v: string) => setText(v.slice(0, 280)),
    onSend,
    onOpenAdminDialog: () => setShowAdminDialog(true),
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {style === 'chatroom' ? <ChatroomLayout {...layoutProps} /> : <CliLayout {...layoutProps} />}
      {showAdminDialog && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(0,0,0,0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
            zIndex: 10,
          }}
          onClick={() => setShowAdminDialog(false)}
        >
          <div
            style={{
              background: '#1a1a1a',
              border: '1px solid #333',
              padding: 16,
              width: 360,
              maxWidth: '100%',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {!adminUnlocked ? (
              <>
                <div style={{ marginBottom: 8 }}>enter crew password:</div>
                <input
                  type="password"
                  value={adminPasswordInput}
                  onChange={(e) => setAdminPasswordInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') tryUnlockAdmin() }}
                  style={{
                    width: '100%',
                    background: '#0d0d0d',
                    color: '#e0e0e0',
                    border: '1px solid #333',
                    padding: 6,
                    boxSizing: 'border-box',
                    fontFamily: 'inherit',
                  }}
                />
                {adminPasswordError && (
                  <div style={{ color: '#ff9a9a', marginTop: 6, fontSize: 12 }}>wrong password</div>
                )}
              </>
            ) : (
              <>
                <div style={{ marginBottom: 8 }}>
                  admin key:{' '}
                  {adminKeyStatus === 'loaded' && <span style={{ color: '#9affb1' }}>loaded ✓</span>}
                  {adminKeyStatus === 'bad' && <span style={{ color: '#ff9a9a' }}>⚠ key does not match embedded pubkeys</span>}
                  {adminKeyStatus === 'none' && <span style={{ color: '#888' }}>paste private key to enable</span>}
                </div>
                <input
                  type="password"
                  placeholder="paste 64-byte hex blob (128 chars)"
                  value={adminKeyInput}
                  onChange={(e) => setAdminKeyInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') tryLoadAdminKey() }}
                  style={{
                    width: '100%',
                    background: '#0d0d0d',
                    color: '#e0e0e0',
                    border: '1px solid #333',
                    padding: 6,
                    boxSizing: 'border-box',
                    fontFamily: 'inherit',
                  }}
                />
                <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                  <button
                    onClick={tryLoadAdminKey}
                    style={{
                      background: '#2a2a2a',
                      color: '#e0e0e0',
                      border: '1px solid #444',
                      padding: '4px 10px',
                      cursor: 'pointer',
                    }}
                  >
                    load key
                  </button>
                  {adminKeyStatus === 'loaded' && (
                    <button
                      onClick={unloadAdmin}
                      style={{
                        background: '#2a2a2a',
                        color: '#e0e0e0',
                        border: '1px solid #444',
                        padding: '4px 10px',
                        cursor: 'pointer',
                      }}
                    >
                      unload
                    </button>
                  )}
                </div>
                {adminKeyStatus === 'loaded' && (
                  <div
                    style={{
                      marginTop: 16,
                      borderTop: '1px solid #333',
                      paddingTop: 12,
                    }}
                  >
                    <div style={{ color: '#888', marginBottom: 6, fontSize: 12 }}>room control:</div>
                    <KillSwitchControls
                      paused={state.status === 'paused'}
                      onPause={(reason, durationMs) => { clientRef.current?.adminPause(reason, durationMs) }}
                      onUnpause={() => { clientRef.current?.adminUnpause() }}
                    />
                  </div>
                )}
                {adminKeyStatus === 'loaded' && (
                  <div style={{ marginTop: 16, borderTop: '1px solid #333', paddingTop: 12 }}>
                    <div style={{ color: '#888', marginBottom: 6, fontSize: 12 }}>active bans:</div>
                    <ActiveBansList
                      bans={activeBans}
                      onUnban={(kind, target) => { clientRef.current?.adminUnban(kind, target) }}
                      onSetDuration={(kind, target, ms) => { clientRef.current?.adminBan(kind, target, ms) }}
                    />
                  </div>
                )}
                {adminKeyStatus === 'loaded' && (
                  <div style={{ marginTop: 16, borderTop: '1px solid #333', paddingTop: 12 }}>
                    <div style={{ color: '#888', marginBottom: 6, fontSize: 12 }}>send rate limit:</div>
                    <RateLimitControl
                      currentMs={clientRef.current?.getRateLimitMs() ?? 1000}
                      onSet={(ms) => { clientRef.current?.adminSetRateLimit(ms) }}
                    />
                  </div>
                )}
              </>
            )}
            <button
              onClick={() => setShowAdminDialog(false)}
              style={{
                marginTop: 12,
                background: 'transparent',
                color: '#888',
                border: 'none',
                float: 'right',
                cursor: 'pointer',
              }}
            >
              close
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
