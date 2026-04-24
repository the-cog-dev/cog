import React, { useEffect, useRef, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import { TrollboxClient, type TrollboxState } from './trollbox/trollbox-client'
import {
  TROLLBOX_SUPABASE_URL,
  TROLLBOX_SUPABASE_ANON,
  TROLLBOX_ADMIN_ED25519_PUBKEY,
  TROLLBOX_ADMIN_X25519_PUBKEY,
} from '../../shared/trollbox-config'
import { nickToColor } from '../../shared/trollbox-crypto'
import { hashCrewPassword, CREW_ACCESS_HASH } from '../../shared/crew-auth'

const containerStyle: React.CSSProperties = {
  width: '100%',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  backgroundColor: '#1a1a1a',
  color: '#e0e0e0',
  fontFamily: 'Consolas, "SFMono-Regular", Menlo, Monaco, monospace',
  overflow: 'hidden',
  position: 'relative',
}

const headerStyle: React.CSSProperties = {
  padding: '8px 12px',
  borderBottom: '1px solid #2a2a2a',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  fontSize: '13px',
}

const logStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '8px 12px',
  fontSize: '13px',
  lineHeight: 1.45,
}

const rowStyle: React.CSSProperties = {
  marginBottom: '4px',
  wordBreak: 'break-word',
  whiteSpace: 'pre-wrap',
}

// Crew-password hash (shared with RacPanel via crew-auth). Hides admin UI from
// casual observers; carries no security weight — real admin power comes from
// the Ed25519 private key that's pasted at runtime and never embedded.
const TROLLBOX_CREW_HASH = CREW_ACCESS_HASH

function formatTs(ms: number): string {
  const d = new Date(ms)
  return d.toTimeString().slice(0, 5)
}

const URL_RE = /(https?:\/\/[^\s<>"']+)/g

function renderMessageText(text: string): React.ReactNode[] {
  // 1) Split on triple-backtick blocks first.
  const parts: React.ReactNode[] = []
  const tripleRe = /```([\s\S]*?)```/g
  let lastIdx = 0
  let match: RegExpExecArray | null
  let key = 0
  while ((match = tripleRe.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parts.push(renderLineSegment(text.slice(lastIdx, match.index), key++))
    }
    parts.push(
      <pre
        key={key++}
        style={{
          background: '#0d0d0d',
          padding: '6px 8px',
          margin: '4px 0',
          borderRadius: 3,
          overflowX: 'auto',
          fontSize: '12px',
        }}
      >
        {match[1]}
      </pre>
    )
    lastIdx = match.index + match[0].length
  }
  if (lastIdx < text.length) {
    parts.push(renderLineSegment(text.slice(lastIdx), key++))
  }
  return parts
}

function renderLineSegment(segment: string, key: number): React.ReactNode {
  // 2) Single-backticks → inline <code>, then linkify URLs inside non-code runs.
  const nodes: React.ReactNode[] = []
  const tickRe = /`([^`]+)`/g
  let lastIdx = 0
  let match: RegExpExecArray | null
  let sub = 0
  while ((match = tickRe.exec(segment)) !== null) {
    if (match.index > lastIdx) {
      nodes.push(...linkify(segment.slice(lastIdx, match.index), `${key}-${sub++}`))
    }
    nodes.push(
      <code
        key={`${key}-${sub++}`}
        style={{ background: '#0d0d0d', padding: '1px 4px', borderRadius: 2 }}
      >
        {match[1]}
      </code>
    )
    lastIdx = match.index + match[0].length
  }
  if (lastIdx < segment.length) {
    nodes.push(...linkify(segment.slice(lastIdx), `${key}-${sub++}`))
  }
  return <span key={key}>{nodes}</span>
}

function linkify(s: string, keyBase: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  let lastIdx = 0
  let match: RegExpExecArray | null
  let i = 0
  URL_RE.lastIndex = 0
  while ((match = URL_RE.exec(s)) !== null) {
    if (match.index > lastIdx) nodes.push(s.slice(lastIdx, match.index))
    nodes.push(
      <a
        key={`${keyBase}-${i++}`}
        href={match[1]}
        target="_blank"
        rel="noopener noreferrer"
        style={{ color: '#8cc4ff' }}
      >
        {match[1]}
      </a>
    )
    lastIdx = match.index + match[0].length
  }
  if (lastIdx < s.length) nodes.push(s.slice(lastIdx))
  return nodes
}

const adminHoverButtonStyle: React.CSSProperties = {
  background: '#2a2a2a',
  color: '#e0e0e0',
  border: '1px solid #444',
  padding: '1px 6px',
  cursor: 'pointer',
  fontSize: 11,
  fontFamily: 'inherit',
}

const BAN_DURATIONS: Array<{ label: string; ms: number }> = [
  { label: '5 min',  ms: 5 * 60_000 },
  { label: '15 min', ms: 15 * 60_000 },
  { label: '30 min', ms: 30 * 60_000 },
  { label: '1 hour', ms: 60 * 60_000 },
  { label: '24 hr',  ms: 24 * 60 * 60_000 },
]

function MessageRow({
  msg,
  canAdmin,
  fp,
  onDelete,
  onBanNick,
  onBanFp,
}: {
  msg: import('./trollbox/trollbox-client').ChatMsg
  canAdmin: boolean
  fp: string | undefined
  onDelete: () => void
  onBanNick: (durationMs: number) => void
  onBanFp: (durationMs: number) => void
}): React.ReactElement {
  const [hover, setHover] = useState(false)
  const [modOpen, setModOpen] = useState(false)
  const [nickDurMs, setNickDurMs] = useState(15 * 60_000)
  const [fpDurMs, setFpDurMs]   = useState(15 * 60_000)
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setModOpen(false) }}
      style={{
        ...rowStyle,
        position: 'relative',
        background: hover && canAdmin ? '#222' : 'transparent',
      }}
    >
      <span style={{ color: '#666', marginRight: 6 }}>[{formatTs(msg.ts)}]</span>
      <span style={{ color: nickToColor(msg.nick), fontWeight: 600, marginRight: 8 }}>
        {msg.nick}
      </span>
      <span>{renderMessageText(msg.text)}</span>
      {canAdmin && hover && !modOpen && (
        <button
          onClick={() => setModOpen(true)}
          title="moderate"
          style={{
            ...adminHoverButtonStyle,
            position: 'absolute', right: 8, top: 2, fontSize: 12,
          }}
        >
          🛡 mod
        </button>
      )}
      {canAdmin && modOpen && (
        <div
          style={{
            position: 'absolute',
            right: 8,
            top: 2,
            background: '#1a1a1a',
            border: '1px solid #444',
            padding: 8,
            borderRadius: 4,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            fontSize: 11,
            minWidth: 220,
            zIndex: 5,
            boxShadow: '0 2px 8px rgba(0,0,0,0.6)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ color: '#888', fontSize: 10 }}>
            moderate <span style={{ color: nickToColor(msg.nick) }}>{msg.nick}</span>
          </div>
          <button
            onClick={() => { onDelete(); setModOpen(false) }}
            style={adminHoverButtonStyle}
          >
            🗑 delete this message
          </button>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <select
              value={nickDurMs}
              onChange={(e) => setNickDurMs(Number(e.target.value))}
              style={modSelectStyle}
            >
              {BAN_DURATIONS.map(d => (
                <option key={d.ms} value={d.ms}>{d.label}</option>
              ))}
            </select>
            <button
              onClick={() => { onBanNick(nickDurMs); setModOpen(false) }}
              style={adminHoverButtonStyle}
            >
              🔇 ban nick
            </button>
          </div>
          {fp && (
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <select
                value={fpDurMs}
                onChange={(e) => setFpDurMs(Number(e.target.value))}
                style={modSelectStyle}
              >
                {BAN_DURATIONS.map(d => (
                  <option key={d.ms} value={d.ms}>{d.label}</option>
                ))}
              </select>
              <button
                onClick={() => { onBanFp(fpDurMs); setModOpen(false) }}
                style={adminHoverButtonStyle}
                title={`fp: ${fp}`}
              >
                🔇 ban fp
              </button>
            </div>
          )}
          <button
            onClick={() => setModOpen(false)}
            style={{ ...adminHoverButtonStyle, color: '#888' }}
          >
            close
          </button>
        </div>
      )}
    </div>
  )
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

function PauseBanner({ reason, until }: { reason: string; until: number }): React.ReactElement {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const secs = Math.max(0, Math.round((until - now) / 1000))
  const mm = Math.floor(secs / 60)
  const ss = secs % 60
  return (
    <div
      style={{
        background: '#3a2a1a',
        color: '#ffd59a',
        padding: '6px 12px',
        fontSize: '12px',
      }}
    >
      ⚠ admin paused the room{reason ? `: "${reason}"` : ''} — resumes in {mm}:{String(ss).padStart(2, '0')}
    </div>
  )
}

export function TrollboxPanel(): React.ReactElement {
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

  return (
    <div style={containerStyle}>
      <div style={headerStyle}>
        <span>🍿 trollbox</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ color: state.status === 'connected' ? '#b5b5b5' : '#555' }}>
            {state.status === 'connected' ? `${state.onlineCount} online` : '—'}
          </span>
          <span
            onClick={() => setShowAdminDialog(true)}
            title="admin"
            style={{
              cursor: 'pointer',
              color: adminKeyStatus === 'loaded' ? '#ffd59a' : '#555',
              userSelect: 'none',
            }}
          >
            {adminKeyStatus === 'loaded' ? '🔓' : '🔒'}
          </span>
        </span>
      </div>
      {state.status === 'connecting' && (
        <div
          style={{
            background: '#1a2b44',
            color: '#8cc4ff',
            padding: '4px 12px',
            fontSize: '12px',
          }}
        >
          connecting…
        </div>
      )}
      {state.status === 'disconnected' && (
        <div
          style={{
            background: '#3a1a1a',
            color: '#ff9a9a',
            padding: '4px 12px',
            fontSize: '12px',
            cursor: 'pointer',
          }}
          onClick={() => { clientRef.current?.connect() }}
        >
          disconnected — click to reconnect
        </div>
      )}
      {state.status === 'paused' && state.pauseUntil !== null && (
        <PauseBanner reason={state.pauseReason ?? ''} until={state.pauseUntil} />
      )}
      <div ref={logRef} style={logStyle}>
        {state.messages.length === 0 && (
          <div style={{ color: '#555', fontStyle: 'italic' }}>
            no messages yet. say something dumb.
          </div>
        )}
        {state.messages.map(m => (
          <MessageRow
            key={m.id}
            msg={m}
            canAdmin={adminKeyStatus === 'loaded'}
            fp={clientRef.current?.getDecryptedFp(m.id)}
            onDelete={() => { clientRef.current?.adminDelete(m.id) }}
            onBanNick={(durationMs) => { clientRef.current?.adminBan('nick', m.nick, durationMs) }}
            onBanFp={(durationMs) => {
              const fp = clientRef.current?.getDecryptedFp(m.id)
              if (fp) clientRef.current?.adminBan('fp', fp, durationMs)
            }}
          />
        ))}
      </div>
      <div
        style={{
          borderTop: '1px solid #2a2a2a',
          padding: '8px 12px',
          fontSize: '13px',
        }}
      >
        <div style={{ marginBottom: 6 }}>
          you are:{' '}
          {editingNick ? (
            <input
              autoFocus
              value={nickDraft}
              onChange={(e) => setNickDraft(e.target.value.slice(0, 24))}
              onBlur={commitNick}
              onKeyDown={(e) => { if (e.key === 'Enter') commitNick() }}
              style={{
                background: '#0d0d0d',
                color: nickToColor(nickDraft.trim() || 'anon'),
                border: '1px solid #333',
                padding: '2px 6px',
                fontFamily: 'inherit',
                fontWeight: 600,
                outline: 'none',
              }}
            />
          ) : (
            <span
              onClick={() => { setNickDraft(nick); setEditingNick(true) }}
              style={{
                color: nickToColor(nick),
                fontWeight: 600,
                cursor: 'pointer',
              }}
              title="click to change"
            >
              {nick}
            </span>
          )}
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, 280))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              onSend()
            }
          }}
          placeholder="type something dumb..."
          rows={2}
          disabled={state.status === 'paused'}
          style={{
            width: '100%',
            background: '#0d0d0d',
            color: '#e0e0e0',
            border: '1px solid #333',
            padding: '6px 8px',
            resize: 'none',
            fontFamily: 'inherit',
            fontSize: '13px',
            outline: 'none',
            boxSizing: 'border-box',
            opacity: state.status === 'paused' ? 0.4 : 1,
            cursor: state.status === 'paused' ? 'not-allowed' : 'text',
          }}
        />
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            marginTop: 4,
            color: '#666',
            fontSize: '11px',
          }}
        >
          <span>{sendHint ?? ' '}</span>
          <span>
            {text.length}/280 &middot; enter to send
          </span>
        </div>
      </div>
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
