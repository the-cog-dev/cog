import React, { useState } from 'react'
import type { TrollboxState, ChatMsg, TrollboxClient } from './trollbox-client'
import { nickToColor } from '../../../shared/trollbox-crypto'
import { formatTs, renderMessageText, BAN_DURATIONS } from './trollbox-render'
import { usePauseCountdown } from './usePauseCountdown'
import type { TrollboxTheme } from './useTrollboxStyle'

export interface CliLayoutProps {
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

const cliTextLinkStyle: React.CSSProperties = {
  color: '#7ecfff',
  cursor: 'pointer',
  textDecoration: 'underline',
  textDecorationStyle: 'dotted',
  fontSize: 12,
  userSelect: 'none',
}

function cliSelectStyle(theme: Required<TrollboxTheme>): React.CSSProperties {
  return {
    background: theme.bg,
    color: theme.text,
    border: `1px solid ${theme.border}`,
    fontSize: 11,
    padding: '0 2px',
    fontFamily: 'inherit',
  }
}

function CliPauseBanner({
  reason,
  until,
  theme: _theme,
}: {
  reason: string
  until: number
  theme: Required<TrollboxTheme>
}): React.ReactElement {
  const { mm, ss } = usePauseCountdown(until)
  return (
    <div
      style={{
        fontStyle: 'italic',
        color: 'rgba(224, 224, 224, 0.6)',
        textAlign: 'center',
        padding: '2px 0',
      }}
    >
      *** room paused{reason ? `: "${reason}"` : ''} · {mm}:{ss} ***
    </div>
  )
}

function CliMessageRow({
  msg,
  theme,
  canAdmin,
  fp,
  onDelete,
  onBanNick,
  onBanFp,
}: {
  msg: ChatMsg
  theme: Required<TrollboxTheme>
  canAdmin: boolean
  fp: string | undefined
  onDelete: () => void
  onBanNick: (ms: number) => void
  onBanFp: (ms: number) => void
}): React.ReactElement {
  const [hover, setHover] = useState(false)
  const [modOpen, setModOpen] = useState(false)
  const [nickDurMs, setNickDurMs] = useState(15 * 60_000)
  const [fpDurMs, setFpDurMs] = useState(15 * 60_000)
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setModOpen(false) }}
      style={{
        position: 'relative',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      <span style={{ color: 'rgba(224, 224, 224, 0.5)' }}>{formatTs(msg.ts)}</span>
      {'  '}
      <span style={{ color: nickToColor(msg.nick), fontWeight: 600 }}>{msg.nick}</span>
      {'  > '}
      <span>{renderMessageText(msg.text)}</span>
      {canAdmin && hover && !modOpen && (
        <span
          onClick={() => setModOpen(true)}
          title="moderate"
          style={{
            marginLeft: 8,
            color: '#7ecfff',
            cursor: 'pointer',
            textDecoration: 'underline',
            textDecorationStyle: 'dotted',
            fontSize: 12,
          }}
        >
          [mod]
        </span>
      )}
      {canAdmin && modOpen && (
        <span
          style={{
            marginLeft: 8,
            padding: '2px 4px',
            background: theme.bg,
            border: `1px dashed ${theme.border}`,
            fontSize: 12,
            display: 'inline-flex',
            gap: 6,
            alignItems: 'center',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <span
            onClick={() => { onDelete(); setModOpen(false) }}
            style={cliTextLinkStyle}
          >
            [delete]
          </span>
          <select
            value={nickDurMs}
            onChange={(e) => setNickDurMs(Number(e.target.value))}
            style={cliSelectStyle(theme)}
          >
            {BAN_DURATIONS.map(d => <option key={d.ms} value={d.ms}>{d.label}</option>)}
          </select>
          <span
            onClick={() => { onBanNick(nickDurMs); setModOpen(false) }}
            style={cliTextLinkStyle}
          >
            [ban nick]
          </span>
          {fp && (
            <>
              <select
                value={fpDurMs}
                onChange={(e) => setFpDurMs(Number(e.target.value))}
                style={cliSelectStyle(theme)}
              >
                {BAN_DURATIONS.map(d => <option key={d.ms} value={d.ms}>{d.label}</option>)}
              </select>
              <span
                onClick={() => { onBanFp(fpDurMs); setModOpen(false) }}
                style={cliTextLinkStyle}
                title={`fp: ${fp}`}
              >
                [ban fp]
              </span>
            </>
          )}
          <span
            onClick={() => setModOpen(false)}
            style={{ ...cliTextLinkStyle, color: 'rgba(224, 224, 224, 0.4)' }}
          >
            [close]
          </span>
        </span>
      )}
    </div>
  )
}

export function CliLayout({
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
}: CliLayoutProps): React.ReactElement {
  const containerStyle: React.CSSProperties = {
    width: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: theme.bg,
    color: theme.text,
    fontFamily: '"Cascadia Code", "Fira Code", Consolas, "SFMono-Regular", Menlo, Monaco, monospace',
    fontSize: '13px',
    lineHeight: 1.45,
    overflow: 'hidden',
    padding: '8px 12px',
    boxSizing: 'border-box',
  }

  return (
    <div style={containerStyle}>
      <div style={{ marginBottom: 4 }}>
        <span>🍿 trollbox v1</span>
        {' · '}
        <span style={{ color: state.status === 'connected' ? theme.text : 'rgba(224, 224, 224, 0.4)' }}>
          {state.status === 'connected' ? `${state.onlineCount} online` : state.status}
        </span>
        {' · '}
        <span
          onClick={onOpenAdminDialog}
          title="admin"
          style={{
            cursor: 'pointer',
            color: adminKeyStatus === 'loaded' ? '#ffd59a' : '#7ecfff',
            textDecoration: 'underline',
            textDecorationStyle: 'dotted',
          }}
        >
          {adminKeyStatus === 'loaded' ? '/admin (unlocked)' : '/admin'}
        </span>
      </div>
      <div style={{ borderTop: `1px solid ${theme.border}`, marginBottom: 6 }} />
      {state.status === 'connecting' && (
        <div style={{ fontStyle: 'italic', color: 'rgba(224, 224, 224, 0.5)', marginBottom: 2 }}>
          *** connecting... ***
        </div>
      )}
      {state.status === 'disconnected' && (
        <div
          onClick={() => clientRef.current?.connect()}
          style={{
            fontStyle: 'italic',
            color: '#ff9a9a',
            marginBottom: 2,
            cursor: 'pointer',
          }}
        >
          *** disconnected · click to reconnect ***
        </div>
      )}
      <div ref={logRef} style={{ flex: 1, overflowY: 'auto', marginBottom: 6 }}>
        {state.messages.length === 0 && (
          <div style={{ fontStyle: 'italic', color: 'rgba(224, 224, 224, 0.5)' }}>
            *** no messages yet. say something dumb. ***
          </div>
        )}
        {state.status === 'paused' && state.pauseUntil !== null && (
          <CliPauseBanner reason={state.pauseReason ?? ''} until={state.pauseUntil} theme={theme} />
        )}
        {state.messages.map(m => (
          <CliMessageRow
            key={m.id}
            msg={m}
            theme={theme}
            canAdmin={adminKeyStatus === 'loaded'}
            fp={clientRef.current?.getDecryptedFp(m.id)}
            onDelete={() => { clientRef.current?.adminDelete(m.id) }}
            onBanNick={(ms) => { clientRef.current?.adminBan('nick', m.nick, ms) }}
            onBanFp={(ms) => {
              const fp = clientRef.current?.getDecryptedFp(m.id)
              if (fp) clientRef.current?.adminBan('fp', fp, ms)
            }}
          />
        ))}
      </div>
      <div style={{ borderTop: `1px solid ${theme.border}`, marginBottom: 4 }} />
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ whiteSpace: 'nowrap' }}>
          {editingNick ? (
            <input
              autoFocus
              value={nickDraft}
              onChange={(e) => onNickDraftChange(e.target.value.slice(0, 24))}
              onBlur={onCommitNick}
              onKeyDown={(e) => { if (e.key === 'Enter') onCommitNick() }}
              style={{
                background: 'transparent',
                color: nickToColor(nickDraft.trim() || 'anon'),
                border: `1px solid ${theme.border}`,
                padding: '0 4px',
                fontFamily: 'inherit',
                fontSize: 13,
                fontWeight: 600,
                outline: 'none',
                width: `${Math.max(8, nickDraft.length + 2)}ch`,
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
          <span style={{ color: 'rgba(224, 224, 224, 0.5)' }}>@trollbox $</span>
        </span>
        <textarea
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              onSend()
            }
          }}
          disabled={state.status === 'paused'}
          placeholder="_"
          rows={1}
          style={{
            flex: 1,
            background: 'transparent',
            color: theme.text,
            border: 'none',
            outline: 'none',
            padding: 0,
            resize: 'none',
            fontFamily: 'inherit',
            fontSize: 13,
            lineHeight: 1.45,
            opacity: state.status === 'paused' ? 0.4 : 1,
          }}
        />
      </div>
      <div
        style={{
          marginTop: 2,
          color: 'rgba(224, 224, 224, 0.4)',
          fontSize: 11,
          display: 'flex',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <span>{sendHint ?? ' '}</span>
        <span>{text.length}/280 · enter to send</span>
      </div>
    </div>
  )
}
