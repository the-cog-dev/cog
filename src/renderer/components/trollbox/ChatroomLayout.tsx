import React, { useState } from 'react'
import type { TrollboxState, ChatMsg, TrollboxClient } from './trollbox-client'
import { nickToColor } from '../../../shared/trollbox-crypto'
import { formatTs, renderMessageText, BAN_DURATIONS } from './trollbox-render'
import { usePauseCountdown } from './usePauseCountdown'
import type { TrollboxTheme } from './useTrollboxStyle'

export interface ChatroomLayoutProps {
  state: TrollboxState
  theme: Required<TrollboxTheme>
  nick: string
  nickDraft: string
  editingNick: boolean
  text: string
  sendHint: string | null
  adminKeyStatus: 'none' | 'loaded' | 'bad'
  clientRef: React.MutableRefObject<TrollboxClient | null>
  logRef: React.MutableRefObject<HTMLDivElement | null>
  onStartEditNick: () => void
  onNickDraftChange: (v: string) => void
  onCommitNick: () => void
  onTextChange: (v: string) => void
  onSend: () => void
  onOpenAdminDialog: () => void
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

const modSelectStyle: React.CSSProperties = {
  background: '#0d0d0d',
  color: '#e0e0e0',
  border: '1px solid #333',
  padding: '1px 4px',
  fontFamily: 'inherit',
  fontSize: 11,
  flex: 1,
}

function MessageRow({
  msg,
  canAdmin,
  fp,
  rowStyle,
  onDelete,
  onBanNick,
  onBanFp,
}: {
  msg: ChatMsg
  canAdmin: boolean
  fp: string | undefined
  rowStyle: React.CSSProperties
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

function PauseBanner({ reason, until }: { reason: string; until: number }): React.ReactElement {
  const { mm, ss } = usePauseCountdown(until)
  return (
    <div
      style={{
        background: '#3a2a1a',
        color: '#ffd59a',
        padding: '6px 12px',
        fontSize: '12px',
      }}
    >
      ⚠ admin paused the room{reason ? `: "${reason}"` : ''} — resumes in {mm}:{ss}
    </div>
  )
}

export function ChatroomLayout({
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
  onStartEditNick,
  onNickDraftChange,
  onCommitNick,
  onTextChange,
  onSend,
  onOpenAdminDialog,
}: ChatroomLayoutProps): React.ReactElement {
  const containerStyle: React.CSSProperties = {
    width: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: theme.bg,
    color: theme.text,
    fontFamily: 'Consolas, "SFMono-Regular", Menlo, Monaco, monospace',
    overflow: 'hidden',
    position: 'relative',
  }

  const headerStyle: React.CSSProperties = {
    padding: '8px 12px',
    borderBottom: `1px solid ${theme.border}`,
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

  return (
    <div style={containerStyle}>
      <div style={headerStyle}>
        <span>🍿 trollbox</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ color: state.status === 'connected' ? '#b5b5b5' : '#555' }}>
            {state.status === 'connected' ? `${state.onlineCount} online` : '—'}
          </span>
          <span
            onClick={onOpenAdminDialog}
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
            rowStyle={rowStyle}
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
          borderTop: `1px solid ${theme.border}`,
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
              onChange={(e) => onNickDraftChange(e.target.value.slice(0, 24))}
              onBlur={onCommitNick}
              onKeyDown={(e) => { if (e.key === 'Enter') onCommitNick() }}
              style={{
                background: theme.chrome,
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
              onClick={onStartEditNick}
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
          onChange={(e) => onTextChange(e.target.value)}
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
            background: theme.chrome,
            color: theme.text,
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
    </div>
  )
}
