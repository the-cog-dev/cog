import React, { useEffect, useMemo, useState } from 'react'
import type { InboxMessage, InboxPriority, NotificationThreshold } from '../../shared/types'

const containerStyle: React.CSSProperties = {
  width: '100%',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  backgroundColor: '#1a1a1a',
  color: '#e0e0e0',
  fontFamily: 'Consolas, "SFMono-Regular", Menlo, Monaco, monospace',
  overflow: 'hidden'
}

const toolbarStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '8px 10px',
  borderBottom: '1px solid #2c2c2c',
  backgroundColor: '#202020',
  flexShrink: 0
}

const selectStyle: React.CSSProperties = {
  backgroundColor: '#1a1a1a',
  color: '#e0e0e0',
  border: '1px solid #3a3a3a',
  borderRadius: '4px',
  padding: '3px 6px',
  fontSize: '11px',
  fontFamily: 'inherit'
}

const buttonStyle: React.CSSProperties = {
  backgroundColor: '#2a2a2a',
  color: '#aaa',
  border: '1px solid #3a3a3a',
  borderRadius: '4px',
  padding: '3px 8px',
  fontSize: '11px',
  cursor: 'pointer'
}

const scrollStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  overflowX: 'hidden',
  padding: '4px 0'
}

const cardStyle: React.CSSProperties = {
  margin: '6px 8px',
  padding: '10px 12px',
  backgroundColor: '#222',
  border: '1px solid #2e2e2e',
  borderRadius: '6px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word'
}

const cardUnreadStyle: React.CSSProperties = {
  ...cardStyle,
  backgroundColor: '#1f2a36',
  borderColor: '#2d4566'
}

const metaRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '8px',
  marginBottom: '6px'
}

const metaLeft: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '8px'
}

const dateStyle: React.CSSProperties = {
  color: '#666',
  fontSize: '11px'
}

const replyAreaStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  marginTop: '8px',
  paddingTop: '8px',
  borderTop: '1px solid #2c2c2c'
}

const textareaStyle: React.CSSProperties = {
  backgroundColor: '#1a1a1a',
  color: '#e0e0e0',
  border: '1px solid #3a3a3a',
  borderRadius: '4px',
  padding: '6px 8px',
  fontSize: '12px',
  fontFamily: 'inherit',
  resize: 'vertical',
  minHeight: '60px'
}

const PRIORITY_COLORS: Record<InboxPriority, { bg: string; fg: string; border: string; label: string }> = {
  low:    { bg: '#2a2f3a', fg: '#9ab', border: '#3c4452', label: 'LOW' },
  normal: { bg: '#1f3147', fg: '#8cc4ff', border: '#2d4d73', label: 'NORMAL' },
  high:   { bg: '#3a2c14', fg: '#f5a25a', border: '#5a4520', label: 'HIGH' },
  urgent: { bg: '#3d1717', fg: '#ff7777', border: '#6e2a2a', label: 'URGENT' }
}

const PRIORITY_RANK: Record<InboxPriority, number> = {
  low: 0, normal: 1, high: 2, urgent: 3
}

type Filter = 'all' | 'unread' | 'high+' | 'urgent'

export function InboxPanel(): React.ReactElement {
  const [messages, setMessages] = useState<InboxMessage[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [threshold, setThreshold] = useState<NotificationThreshold>('high')
  const [replying, setReplying] = useState<string | null>(null)
  const [replyText, setReplyText] = useState('')
  // Proposal IDs still pending (seeded on mount) and ones settled since.
  // The Review button shows only for a still-pending proposal.
  const [pendingProposals, setPendingProposals] = useState<Set<string>>(new Set())
  const [resolvedProposals, setResolvedProposals] = useState<Set<string>>(new Set())

  useEffect(() => {
    let mounted = true
    window.electronAPI.inboxList().then(msgs => { if (mounted) setMessages(msgs) })
    window.electronAPI.inboxGetNotifyThreshold().then(t => { if (mounted) setThreshold(t) })
    // Seed pending proposals so historical, already-resolved proposal messages
    // don't render a stale "Review" button after a restart/remount.
    window.electronAPI.proposalsListPending().then(list => {
      if (mounted) setPendingProposals(new Set(list.map(p => p.id)))
    })
    const offAdd = window.electronAPI.onInboxMessageAdded((msgs) => setMessages(msgs))
    const offUpd = window.electronAPI.onInboxMessageUpdated((msgs) => setMessages(msgs))
    // Track proposals that arrive while mounted so their Review button shows too.
    const offProposal = window.electronAPI.onProposalAdded((p) => {
      setPendingProposals(prev => new Set(prev).add(p.id))
    })
    const offResolved = window.electronAPI.onProposalResolved((p) => {
      setResolvedProposals(prev => new Set(prev).add(p.id))
    })
    return () => { mounted = false; offAdd(); offUpd(); offProposal(); offResolved() }
  }, [])

  // A message wraps a team proposal when it carries a `proposal:<id>` tag.
  const proposalIdOf = (m: InboxMessage): string | null => {
    const tag = m.tags.find(t => t.startsWith('proposal:'))
    return tag ? tag.slice('proposal:'.length) : null
  }
  const handleReviewProposal = async (id: string) => {
    const res = await window.electronAPI.proposalsReopen(id)
    if (!res.ok) {
      // Already approved/rejected/expired/gone — mark it settled so the button hides.
      setResolvedProposals(prev => new Set(prev).add(id))
    }
  }

  const filtered = useMemo(() => {
    return messages.filter(m => {
      if (filter === 'unread') return !m.readAt
      if (filter === 'high+') return PRIORITY_RANK[m.priority] >= PRIORITY_RANK['high']
      if (filter === 'urgent') return m.priority === 'urgent'
      return true
    })
  }, [messages, filter])

  const handleMarkRead = async (id: string) => {
    await window.electronAPI.inboxMarkRead(id)
  }
  const handleDelete = async (id: string) => {
    await window.electronAPI.inboxDelete(id)
    setMessages(prev => prev.filter(m => m.id !== id))
  }
  const handleMarkAllRead = async () => {
    await window.electronAPI.inboxMarkAllRead()
  }
  const handleThresholdChange = async (t: NotificationThreshold) => {
    setThreshold(t)
    await window.electronAPI.inboxSetNotifyThreshold(t)
  }
  const handleStartReply = (id: string) => {
    setReplying(id)
    setReplyText('')
  }
  const handleSendReply = async (agentName: string) => {
    if (!replyText.trim()) return
    const result = await window.electronAPI.inboxReply(agentName, replyText.trim())
    if (result.success) {
      setReplying(null)
      setReplyText('')
    }
  }

  return (
    <div style={containerStyle}>
      <div style={toolbarStyle}>
        <span style={{ color: '#888', fontSize: '11px' }}>Filter:</span>
        <select value={filter} onChange={e => setFilter(e.target.value as Filter)} style={selectStyle}>
          <option value="all">All</option>
          <option value="unread">Unread</option>
          <option value="high+">High+ only</option>
          <option value="urgent">Urgent only</option>
        </select>
        <span style={{ color: '#888', fontSize: '11px', marginLeft: '8px' }}>Notify:</span>
        <select value={threshold} onChange={e => handleThresholdChange(e.target.value as NotificationThreshold)} style={selectStyle}>
          <option value="none">None</option>
          <option value="low">Low+</option>
          <option value="normal">Normal+</option>
          <option value="high">High+</option>
          <option value="urgent">Urgent only</option>
        </select>
        <div style={{ flex: 1 }} />
        <button onClick={handleMarkAllRead} style={buttonStyle}>Mark all read</button>
      </div>

      <div style={scrollStyle}>
        {filtered.length === 0 && (
          <div style={{ padding: '24px 16px', textAlign: 'center', color: '#666', fontSize: '12px' }}>
            No messages{filter !== 'all' ? ` matching "${filter}"` : ''}.
          </div>
        )}
        {filtered.map(m => {
          const colors = PRIORITY_COLORS[m.priority]
          const isUnread = !m.readAt
          const isReplying = replying === m.id
          return (
            <div key={m.id} style={isUnread ? cardUnreadStyle : cardStyle}>
              <div style={metaRowStyle}>
                <div style={metaLeft}>
                  <span style={{
                    display: 'inline-flex',
                    padding: '2px 8px',
                    borderRadius: '999px',
                    backgroundColor: colors.bg,
                    border: `1px solid ${colors.border}`,
                    color: colors.fg,
                    fontSize: '10px',
                    fontWeight: 600,
                    letterSpacing: '0.5px'
                  }}>{colors.label}</span>
                  <span style={{ color: '#aaa', fontSize: '12px' }}>from {m.agentName}</span>
                  {m.tags.length > 0 && (
                    <span style={{ color: '#666', fontSize: '11px' }}>
                      {m.tags.map(t => `#${t}`).join(' ')}
                    </span>
                  )}
                </div>
                <span style={dateStyle}>{formatDate(m.createdAt)}</span>
              </div>
              <div style={{ color: '#ddd', fontSize: '13px', lineHeight: 1.45 }}>{m.message}</div>
              {(() => {
                const proposalId = proposalIdOf(m)
                if (!proposalId || !pendingProposals.has(proposalId) || resolvedProposals.has(proposalId)) return null
                return (
                  <button
                    onClick={() => handleReviewProposal(proposalId)}
                    style={{ ...buttonStyle, marginTop: '8px', color: '#8cffa0', borderColor: '#2d663a', backgroundColor: '#16281c' }}
                  >Open / Review team proposal ▸</button>
                )
              })()}
              <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
                {isUnread && (
                  <button onClick={() => handleMarkRead(m.id)} style={buttonStyle}>Mark read</button>
                )}
                {!isReplying && (
                  <button onClick={() => handleStartReply(m.id)} style={buttonStyle}>Reply</button>
                )}
                <div style={{ flex: 1 }} />
                <button onClick={() => handleDelete(m.id)} style={{ ...buttonStyle, color: '#a55' }}>
                  Delete
                </button>
              </div>
              {isReplying && (
                <div style={replyAreaStyle}>
                  <textarea
                    value={replyText}
                    onChange={e => setReplyText(e.target.value)}
                    placeholder={`Reply to ${m.agentName}...`}
                    style={textareaStyle}
                    autoFocus
                  />
                  <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                    <button onClick={() => { setReplying(null); setReplyText('') }} style={buttonStyle}>
                      Cancel
                    </button>
                    <button
                      onClick={() => handleSendReply(m.agentName)}
                      disabled={!replyText.trim()}
                      style={{
                        ...buttonStyle,
                        backgroundColor: replyText.trim() ? '#2d4d73' : '#2a2a2a',
                        color: replyText.trim() ? '#8cc4ff' : '#555',
                        cursor: replyText.trim() ? 'pointer' : 'not-allowed'
                      }}
                    >Send</button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    const now = new Date()
    const sameDay = d.toDateString() === now.toDateString()
    if (sameDay) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
      + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch { return iso }
}
