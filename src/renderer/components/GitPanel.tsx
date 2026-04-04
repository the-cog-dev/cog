import React, { useState, useEffect, useCallback, useRef } from 'react'
import type { GitStatus, GitFileStatus, GitLogEntry } from '../../shared/types'

declare const electronAPI: {
  gitStatus: () => Promise<GitStatus>
  gitLog: (count?: number) => Promise<GitLogEntry[]>
  gitDiff: (file: string, staged: boolean) => Promise<string>
  gitStage: (file: string) => Promise<{ status?: string; error?: string }>
  gitUnstage: (file: string) => Promise<{ status?: string; error?: string }>
  gitCommit: (message: string) => Promise<{ status?: string; output?: string; error?: string }>
  gitPush: () => Promise<{ status?: string; output?: string; error?: string }>
  gitPull: () => Promise<{ status?: string; output?: string; error?: string }>
  gitBranches: () => Promise<{ current: string; branches: string[] }>
  gitCheckout: (branch: string) => Promise<{ status?: string; error?: string }>
  gitNewBranch: (name: string) => Promise<{ status?: string; error?: string }>
}

const STATUS_COLORS: Record<GitFileStatus['status'], string> = {
  added: '#4caf50',
  modified: '#ffc107',
  deleted: '#f44336',
  renamed: '#42a5f5',
}

const STATUS_LABELS: Record<GitFileStatus['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
}

// ── Diff viewer ─────────────────────────────────────────────
function DiffViewer({ diff }: { diff: string }): React.ReactElement {
  return (
    <pre style={{
      margin: 0,
      padding: '8px 12px',
      fontSize: '12px',
      fontFamily: 'Consolas, "Courier New", monospace',
      lineHeight: '1.5',
      overflow: 'auto',
      backgroundColor: '#1a1a1a',
      color: '#ccc',
      whiteSpace: 'pre',
      tabSize: 4,
    }}>
      {diff.split('\n').map((line, i) => {
        let color = '#ccc'
        let bg = 'transparent'
        if (line.startsWith('+') && !line.startsWith('+++')) {
          color = '#4caf50'
          bg = 'rgba(76,175,80,0.08)'
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          color = '#f44336'
          bg = 'rgba(244,67,54,0.08)'
        } else if (line.startsWith('@@')) {
          color = '#42a5f5'
        } else if (line.startsWith('diff ') || line.startsWith('index ')) {
          color = '#888'
        }
        return (
          <div key={i} style={{ color, backgroundColor: bg, minHeight: '18px' }}>
            {line}
          </div>
        )
      })}
    </pre>
  )
}

// ── File list item ──────────────────────────────────────────
function FileItem({ file, action, actionLabel, onAction, onClick, selected }: {
  file: GitFileStatus
  action: () => void
  actionLabel: string
  onAction: () => void
  onClick: () => void
  selected: boolean
}): React.ReactElement {
  const shortPath = file.path.split('/').pop() || file.path
  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: '2px 8px',
        fontSize: '12px',
        cursor: 'pointer',
        backgroundColor: selected ? '#2a2d2e' : 'transparent',
        gap: '6px',
      }}
      title={file.path}
      onMouseEnter={e => { if (!selected) e.currentTarget.style.backgroundColor = '#252525' }}
      onMouseLeave={e => { if (!selected) e.currentTarget.style.backgroundColor = 'transparent' }}
    >
      <span style={{
        color: STATUS_COLORS[file.status],
        fontWeight: 600,
        fontSize: '11px',
        width: '14px',
        textAlign: 'center',
        flexShrink: 0,
      }}>
        {STATUS_LABELS[file.status]}
      </span>
      <span style={{
        flex: 1,
        color: '#ccc',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        {shortPath}
        <span style={{ color: '#666', marginLeft: '4px', fontSize: '11px' }}>
          {file.path !== shortPath ? file.path.replace(/\/[^/]+$/, '') : ''}
        </span>
      </span>
      <span
        onClick={e => { e.stopPropagation(); onAction() }}
        style={{
          width: '20px',
          height: '20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: '3px',
          fontSize: '14px',
          color: '#888',
          cursor: 'pointer',
          flexShrink: 0,
        }}
        title={actionLabel}
        onMouseEnter={e => (e.currentTarget.style.color = '#e0e0e0')}
        onMouseLeave={e => (e.currentTarget.style.color = '#888')}
      >
        {action === onAction ? actionLabel : actionLabel}
      </span>
    </div>
  )
}

// ── Small button ────────────────────────────────────────────
function Btn({ label, onClick, disabled, loading, small, style: extraStyle }: {
  label: string
  onClick: () => void
  disabled?: boolean
  loading?: boolean
  small?: boolean
  style?: React.CSSProperties
}): React.ReactElement {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      style={{
        padding: small ? '2px 8px' : '4px 10px',
        fontSize: small ? '11px' : '12px',
        backgroundColor: disabled || loading ? '#333' : '#3c3c3c',
        color: disabled || loading ? '#666' : '#ccc',
        border: '1px solid #555',
        borderRadius: '3px',
        cursor: disabled || loading ? 'default' : 'pointer',
        whiteSpace: 'nowrap',
        ...extraStyle,
      }}
    >
      {loading ? '...' : label}
    </button>
  )
}

// ── Main GitPanel ───────────────────────────────────────────
export function GitPanel(): React.ReactElement {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [log, setLog] = useState<GitLogEntry[]>([])
  const [viewMode, setViewMode] = useState<'status' | 'log'>('status')
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [selectedFileStaged, setSelectedFileStaged] = useState(false)
  const [diffContent, setDiffContent] = useState<string>('')
  const [commitMsg, setCommitMsg] = useState('')
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showBranches, setShowBranches] = useState(false)
  const [branches, setBranches] = useState<string[]>([])
  const [newBranchName, setNewBranchName] = useState('')
  const [showNewBranch, setShowNewBranch] = useState(false)

  const branchDropdownRef = useRef<HTMLDivElement>(null)

  // ── Fetch status ──────────────────────────────────────────
  const refreshStatus = useCallback(async () => {
    try {
      const s = await electronAPI.gitStatus()
      setStatus(s)
    } catch (err) {
      setError(`Failed to get git status: ${err}`)
    }
  }, [])

  const refreshLog = useCallback(async () => {
    try {
      const entries = await electronAPI.gitLog(20)
      setLog(entries)
    } catch (err) {
      setError(`Failed to get git log: ${err}`)
    }
  }, [])

  // Initial load + auto-refresh
  useEffect(() => {
    refreshStatus()
    refreshLog()
    const interval = setInterval(refreshStatus, 15000)
    return () => clearInterval(interval)
  }, [refreshStatus, refreshLog])

  // Close branch dropdown on outside click
  useEffect(() => {
    if (!showBranches) return
    const handler = (e: MouseEvent): void => {
      if (branchDropdownRef.current && !branchDropdownRef.current.contains(e.target as Node)) {
        setShowBranches(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showBranches])

  // ── Actions ───────────────────────────────────────────────
  const fetchDiff = useCallback(async (file: string, staged: boolean) => {
    setSelectedFile(file)
    setSelectedFileStaged(staged)
    try {
      const d = await electronAPI.gitDiff(file, staged)
      setDiffContent(d)
    } catch (err) {
      setDiffContent(`Error fetching diff: ${err}`)
    }
  }, [])

  const stageFile = useCallback(async (file: string) => {
    setError(null)
    const result = await electronAPI.gitStage(file)
    if (result.error) setError(result.error)
    await refreshStatus()
    // If we were viewing this file's diff, refresh it
    if (selectedFile === file) fetchDiff(file, true)
  }, [refreshStatus, selectedFile, fetchDiff])

  const unstageFile = useCallback(async (file: string) => {
    setError(null)
    const result = await electronAPI.gitUnstage(file)
    if (result.error) setError(result.error)
    await refreshStatus()
    if (selectedFile === file) fetchDiff(file, false)
  }, [refreshStatus, selectedFile, fetchDiff])

  const stageAll = useCallback(async () => {
    if (!status) return
    setError(null)
    for (const f of status.unstaged) {
      await electronAPI.gitStage(f.path)
    }
    await refreshStatus()
  }, [status, refreshStatus])

  const unstageAll = useCallback(async () => {
    if (!status) return
    setError(null)
    for (const f of status.staged) {
      await electronAPI.gitUnstage(f.path)
    }
    await refreshStatus()
  }, [status, refreshStatus])

  const commit = useCallback(async () => {
    if (!commitMsg.trim() || !status?.staged.length) return
    setError(null)
    setLoading('commit')
    try {
      const result = await electronAPI.gitCommit(commitMsg.trim())
      if (result.error) {
        setError(result.error)
      } else {
        setCommitMsg('')
        setSelectedFile(null)
        setDiffContent('')
      }
      await refreshStatus()
      await refreshLog()
    } catch (err) {
      setError(`Commit failed: ${err}`)
    } finally {
      setLoading(null)
    }
  }, [commitMsg, status, refreshStatus, refreshLog])

  const push = useCallback(async () => {
    setError(null)
    setLoading('push')
    try {
      const result = await electronAPI.gitPush()
      if (result.error) setError(result.error)
      await refreshStatus()
    } catch (err) {
      setError(`Push failed: ${err}`)
    } finally {
      setLoading(null)
    }
  }, [refreshStatus])

  const pull = useCallback(async () => {
    setError(null)
    setLoading('pull')
    try {
      const result = await electronAPI.gitPull()
      if (result.error) setError(result.error)
      await refreshStatus()
      await refreshLog()
    } catch (err) {
      setError(`Pull failed: ${err}`)
    } finally {
      setLoading(null)
    }
  }, [refreshStatus, refreshLog])

  const fetchBranches = useCallback(async () => {
    try {
      const info = await electronAPI.gitBranches()
      setBranches(info.branches)
    } catch (err) {
      setError(`Failed to fetch branches: ${err}`)
    }
  }, [])

  const switchBranch = useCallback(async (branch: string) => {
    setError(null)
    setLoading('checkout')
    setShowBranches(false)
    try {
      const result = await electronAPI.gitCheckout(branch)
      if (result.error) setError(result.error)
      await refreshStatus()
      await refreshLog()
    } catch (err) {
      setError(`Checkout failed: ${err}`)
    } finally {
      setLoading(null)
    }
  }, [refreshStatus, refreshLog])

  const createBranch = useCallback(async () => {
    if (!newBranchName.trim()) return
    setError(null)
    setLoading('new-branch')
    try {
      const result = await electronAPI.gitNewBranch(newBranchName.trim())
      if (result.error) {
        setError(result.error)
      } else {
        setNewBranchName('')
        setShowNewBranch(false)
      }
      await refreshStatus()
      await refreshLog()
    } catch (err) {
      setError(`Create branch failed: ${err}`)
    } finally {
      setLoading(null)
    }
  }, [newBranchName, refreshStatus, refreshLog])

  // ── Not a repo ────────────────────────────────────────────
  if (status && !status.isRepo) {
    return (
      <div style={{
        height: '100%',
        backgroundColor: '#1e1e1e',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#666',
        fontSize: '13px',
      }}>
        Not a git repository
      </div>
    )
  }

  // ── Loading initial status ────────────────────────────────
  if (!status) {
    return (
      <div style={{
        height: '100%',
        backgroundColor: '#1e1e1e',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#666',
        fontSize: '13px',
      }}>
        Loading git status...
      </div>
    )
  }

  const canCommit = commitMsg.trim().length > 0 && status.staged.length > 0

  return (
    <div style={{
      height: '100%',
      backgroundColor: '#1e1e1e',
      display: 'flex',
      flexDirection: 'column',
      color: '#ccc',
      fontSize: '12px',
      overflow: 'hidden',
    }}>
      {/* ── Error banner ─────────────────────────────────── */}
      {error && (
        <div style={{
          padding: '6px 10px',
          backgroundColor: 'rgba(244,67,54,0.15)',
          borderBottom: '1px solid #f44336',
          color: '#f44336',
          fontSize: '11px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
        }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {error}
          </span>
          <span
            onClick={() => setError(null)}
            style={{ cursor: 'pointer', marginLeft: '8px', fontSize: '14px', flexShrink: 0 }}
          >
            x
          </span>
        </div>
      )}

      {/* ── Branch bar ───────────────────────────────────── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '6px 10px',
        backgroundColor: '#252525',
        borderBottom: '1px solid #333',
        flexShrink: 0,
        flexWrap: 'wrap',
      }}>
        {/* Branch name + dropdown */}
        <div style={{ position: 'relative' }} ref={branchDropdownRef}>
          <div
            onClick={() => { setShowBranches(!showBranches); if (!showBranches) fetchBranches() }}
            style={{
              padding: '2px 8px',
              backgroundColor: '#333',
              borderRadius: '3px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              fontSize: '12px',
              color: '#e0e0e0',
            }}
          >
            <span style={{ fontSize: '11px' }}>{'\u2387'}</span>
            {status.branch || 'HEAD'}
            <span style={{ fontSize: '9px', color: '#888' }}>{'\u25BC'}</span>
          </div>

          {showBranches && (
            <div style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              marginTop: '2px',
              backgroundColor: '#2a2a2a',
              border: '1px solid #555',
              borderRadius: '4px',
              maxHeight: '200px',
              overflow: 'auto',
              zIndex: 100,
              minWidth: '160px',
              boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
            }}>
              {branches.map(b => (
                <div
                  key={b}
                  onClick={() => switchBranch(b)}
                  style={{
                    padding: '4px 10px',
                    fontSize: '12px',
                    cursor: 'pointer',
                    color: b === status.branch ? '#4caf50' : '#ccc',
                    fontWeight: b === status.branch ? 600 : 400,
                  }}
                  onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#333')}
                  onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                >
                  {b === status.branch ? '* ' : '  '}{b}
                </div>
              ))}
              {branches.length === 0 && (
                <div style={{ padding: '6px 10px', color: '#666', fontSize: '11px' }}>
                  No branches found
                </div>
              )}
            </div>
          )}
        </div>

        {/* Ahead/behind */}
        <span style={{ color: '#888', fontSize: '11px' }}>
          {status.ahead > 0 && <span style={{ color: '#4caf50' }}>{'\u2191'}{status.ahead}</span>}
          {(status.ahead > 0 && status.behind > 0) && ' '}
          {status.behind > 0 && <span style={{ color: '#f44336' }}>{'\u2193'}{status.behind}</span>}
          {status.ahead === 0 && status.behind === 0 && (
            <span style={{ color: '#555' }}>{'\u2191'}0 {'\u2193'}0</span>
          )}
        </span>

        <div style={{ flex: 1 }} />

        {/* New branch */}
        {showNewBranch ? (
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
            <input
              autoFocus
              value={newBranchName}
              onChange={e => setNewBranchName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') createBranch()
                if (e.key === 'Escape') { setShowNewBranch(false); setNewBranchName('') }
              }}
              placeholder="branch-name"
              style={{
                padding: '2px 6px',
                fontSize: '11px',
                backgroundColor: '#1e1e1e',
                color: '#ccc',
                border: '1px solid #555',
                borderRadius: '3px',
                outline: 'none',
                width: '120px',
              }}
            />
            <Btn label="OK" onClick={createBranch} small loading={loading === 'new-branch'} />
            <Btn label="X" onClick={() => { setShowNewBranch(false); setNewBranchName('') }} small />
          </div>
        ) : (
          <Btn label="+ Branch" onClick={() => setShowNewBranch(true)} small />
        )}

        <Btn label="Pull" onClick={pull} small loading={loading === 'pull'} />
        <Btn label="Push" onClick={push} small loading={loading === 'push'} disabled={status.ahead === 0} />
      </div>

      {/* ── View mode toggle ─────────────────────────────── */}
      <div style={{
        display: 'flex',
        borderBottom: '1px solid #333',
        flexShrink: 0,
      }}>
        {(['status', 'log'] as const).map(mode => (
          <div
            key={mode}
            onClick={() => { setViewMode(mode); if (mode === 'log') refreshLog() }}
            style={{
              flex: 1,
              padding: '5px 0',
              textAlign: 'center',
              fontSize: '11px',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              cursor: 'pointer',
              color: viewMode === mode ? '#e0e0e0' : '#666',
              backgroundColor: viewMode === mode ? '#1e1e1e' : '#252525',
              borderBottom: viewMode === mode ? '2px solid #4caf50' : '2px solid transparent',
            }}
          >
            {mode}
          </div>
        ))}
      </div>

      {/* ── Content area ─────────────────────────────────── */}
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {viewMode === 'status' ? (
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            {/* Staged files */}
            <div>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '4px 10px',
                backgroundColor: '#252525',
                borderBottom: '1px solid #333',
              }}>
                <span style={{ fontSize: '11px', color: '#888', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  Staged ({status.staged.length})
                </span>
                {status.staged.length > 0 && (
                  <Btn label="Unstage All" onClick={unstageAll} small />
                )}
              </div>
              {status.staged.length === 0 ? (
                <div style={{ padding: '8px 10px', color: '#555', fontSize: '11px' }}>
                  No staged changes
                </div>
              ) : (
                status.staged.map(f => (
                  <FileItem
                    key={`staged-${f.path}`}
                    file={f}
                    action={() => unstageFile(f.path)}
                    actionLabel="-"
                    onAction={() => unstageFile(f.path)}
                    onClick={() => fetchDiff(f.path, true)}
                    selected={selectedFile === f.path && selectedFileStaged}
                  />
                ))
              )}
            </div>

            {/* Unstaged / changes */}
            <div>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '4px 10px',
                backgroundColor: '#252525',
                borderBottom: '1px solid #333',
                borderTop: '1px solid #333',
              }}>
                <span style={{ fontSize: '11px', color: '#888', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  Changes ({status.unstaged.length})
                </span>
                {status.unstaged.length > 0 && (
                  <Btn label="Stage All" onClick={stageAll} small />
                )}
              </div>
              {status.unstaged.length === 0 ? (
                <div style={{ padding: '8px 10px', color: '#555', fontSize: '11px' }}>
                  No unstaged changes
                </div>
              ) : (
                status.unstaged.map(f => (
                  <FileItem
                    key={`unstaged-${f.path}`}
                    file={f}
                    action={() => stageFile(f.path)}
                    actionLabel="+"
                    onAction={() => stageFile(f.path)}
                    onClick={() => fetchDiff(f.path, false)}
                    selected={selectedFile === f.path && !selectedFileStaged}
                  />
                ))
              )}
            </div>

            {/* Diff viewer */}
            {diffContent && (
              <div style={{ borderTop: '1px solid #333', flex: 1, overflow: 'auto', minHeight: '80px' }}>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '4px 10px',
                  backgroundColor: '#252525',
                  borderBottom: '1px solid #333',
                }}>
                  <span style={{ fontSize: '11px', color: '#888' }}>
                    {selectedFile} {selectedFileStaged ? '(staged)' : '(unstaged)'}
                  </span>
                  <span
                    onClick={() => { setSelectedFile(null); setDiffContent('') }}
                    style={{ cursor: 'pointer', color: '#666', fontSize: '14px' }}
                  >
                    x
                  </span>
                </div>
                <DiffViewer diff={diffContent} />
              </div>
            )}
          </div>
        ) : (
          /* ── Log view ────────────────────────────────────── */
          <div>
            {log.length === 0 ? (
              <div style={{ padding: '12px', color: '#555', fontSize: '12px', textAlign: 'center' }}>
                No commits found
              </div>
            ) : (
              log.map(entry => (
                <div
                  key={entry.sha}
                  style={{
                    padding: '6px 10px',
                    borderBottom: '1px solid #2a2a2a',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '2px',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#252525')}
                  onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{
                      fontFamily: 'Consolas, "Courier New", monospace',
                      fontSize: '11px',
                      color: '#ffc107',
                      flexShrink: 0,
                    }}>
                      {entry.sha.slice(0, 7)}
                    </span>
                    <span style={{
                      color: '#e0e0e0',
                      fontSize: '12px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      flex: 1,
                    }}>
                      {entry.message}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', fontSize: '10px', color: '#666' }}>
                    <span>{entry.author}</span>
                    <span>{entry.relativeDate}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* ── Commit section ───────────────────────────────── */}
      <div style={{
        borderTop: '1px solid #333',
        padding: '8px 10px',
        backgroundColor: '#252525',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
      }}>
        <textarea
          value={commitMsg}
          onChange={e => setCommitMsg(e.target.value)}
          placeholder="Commit message..."
          rows={2}
          onKeyDown={e => {
            if (e.ctrlKey && e.key === 'Enter' && canCommit) commit()
          }}
          style={{
            width: '100%',
            padding: '6px 8px',
            fontSize: '12px',
            backgroundColor: '#1e1e1e',
            color: '#ccc',
            border: '1px solid #333',
            borderRadius: '3px',
            outline: 'none',
            resize: 'vertical',
            fontFamily: 'inherit',
            boxSizing: 'border-box',
          }}
        />
        <Btn
          label={loading === 'commit' ? 'Committing...' : `Commit (${status.staged.length} file${status.staged.length !== 1 ? 's' : ''})`}
          onClick={commit}
          disabled={!canCommit}
          loading={loading === 'commit'}
          style={{ width: '100%' }}
        />
      </div>
    </div>
  )
}
