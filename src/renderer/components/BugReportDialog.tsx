import React, { useState, useEffect } from 'react'

declare const electronAPI: {
  getAgents: () => Promise<any[]>
  getProject: () => Promise<{ path: string; name: string } | null>
  getHubInfo: () => Promise<{ port: number }>
  submitBugReport: (title: string, body: string) => Promise<{ success: boolean; method: string; issueUrl?: string; error?: string }>
}

export function BugReportDialog({ onClose }: { onClose: () => void }): React.ReactElement {
  const [description, setDescription] = useState('')
  const [steps, setSteps] = useState('')
  const [severity, setSeverity] = useState('medium')
  const [systemInfo, setSystemInfo] = useState('')

  useEffect(() => {
    // Auto-collect system info
    const collectInfo = async () => {
      const project = await electronAPI.getProject()
      const agents = await electronAPI.getAgents()
      const hubInfo = await electronAPI.getHubInfo().catch(() => null)

      const info = [
        `**Platform:** ${navigator.platform}`,
        `**User Agent:** ${navigator.userAgent}`,
        `**Project:** ${project?.name || 'None'}`,
        `**Active Agents:** ${agents.length} (${agents.map((a: any) => `${a.name} [${a.cli}/${a.status}]`).join(', ') || 'none'})`,
        `**Hub Port:** ${hubInfo?.port || 'N/A'}`,
        `**Window Size:** ${window.innerWidth}x${window.innerHeight}`,
        `**Timestamp:** ${new Date().toISOString()}`,
      ].join('\n')
      setSystemInfo(info)
    }
    collectInfo()
  }, [])

  const [submitting, setSubmitting] = useState(false)
  const [submitResult, setSubmitResult] = useState<string | null>(null)

  const handleSubmit = async () => {
    const title = description.slice(0, 80)
    const body = [
      `## Bug Description`,
      description,
      ``,
      `## Steps to Reproduce`,
      steps || '_Not provided_',
      ``,
      `## Severity`,
      severity,
      ``,
      `## System Info`,
      systemInfo,
    ].join('\n')

    setSubmitting(true)

    // Try API first (no login needed), fall back to browser
    const result = await electronAPI.submitBugReport(title, body)
    if (result.success) {
      setSubmitResult(`Bug #${result.issueUrl?.split('/').pop()} submitted!`)
      setTimeout(onClose, 2000)
    } else if (result.method === 'browser') {
      // No token — fall back to browser (user needs GitHub login)
      const encodedTitle = encodeURIComponent(title)
      const encodedBody = encodeURIComponent(body)
      window.open(`https://github.com/natebag/AgentOrch/issues/new?title=${encodedTitle}&body=${encodedBody}&labels=bug`, '_blank')
      onClose()
    } else {
      setSubmitResult(`Failed: ${result.error}`)
    }
    setSubmitting(false)
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
        padding: '24px', width: '480px', display: 'flex', flexDirection: 'column', gap: '12px'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: '16px', color: '#e0e0e0' }}>Report a Bug</h2>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: '#666', fontSize: '24px', cursor: 'pointer', lineHeight: 1
          }}>x</button>
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: '#aaa' }}>
          What happened?
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="Describe the bug..."
            rows={3}
            style={{
              backgroundColor: '#2a2a2a', border: '1px solid #444', borderRadius: '4px',
              padding: '8px', color: '#e0e0e0', fontSize: '13px', resize: 'vertical', fontFamily: 'inherit'
            }}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: '#aaa' }}>
          Steps to reproduce (optional)
          <textarea
            value={steps}
            onChange={e => setSteps(e.target.value)}
            placeholder="1. Open the app&#10;2. Click on...&#10;3. See error"
            rows={3}
            style={{
              backgroundColor: '#2a2a2a', border: '1px solid #444', borderRadius: '4px',
              padding: '8px', color: '#e0e0e0', fontSize: '13px', resize: 'vertical', fontFamily: 'inherit'
            }}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: '#aaa' }}>
          Severity
          <select value={severity} onChange={e => setSeverity(e.target.value)} style={{
            backgroundColor: '#2a2a2a', border: '1px solid #444', borderRadius: '4px',
            padding: '8px', color: '#e0e0e0', fontSize: '13px'
          }}>
            <option value="low">Low — cosmetic / minor annoyance</option>
            <option value="medium">Medium — feature broken but workaround exists</option>
            <option value="high">High — can't use a feature at all</option>
            <option value="critical">Critical — app crashes or data loss</option>
          </select>
        </label>

        <div style={{ padding: '8px', backgroundColor: '#252525', borderRadius: '4px', fontSize: '11px', color: '#888' }}>
          <div style={{ marginBottom: '4px', fontWeight: 500, color: '#aaa' }}>Auto-collected info (included in report):</div>
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: '10px', color: '#666' }}>{systemInfo}</pre>
        </div>

        {submitResult && (
          <div style={{
            padding: '8px', borderRadius: '4px', fontSize: '12px', textAlign: 'center',
            backgroundColor: submitResult.startsWith('Bug') ? '#1a3a1a' : '#3a1a1a',
            color: submitResult.startsWith('Bug') ? '#4caf50' : '#f44336',
            border: submitResult.startsWith('Bug') ? '1px solid #4caf50' : '1px solid #f44336'
          }}>
            {submitResult}
          </div>
        )}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{
            padding: '8px 16px', backgroundColor: '#2a2a2a', border: '1px solid #444',
            borderRadius: '4px', color: '#aaa', cursor: 'pointer', fontSize: '13px'
          }}>Cancel</button>
          <button onClick={handleSubmit} disabled={!description.trim() || submitting} style={{
            padding: '8px 16px', backgroundColor: '#5a2d2d', border: '1px solid #f44336',
            borderRadius: '4px', color: '#f44336', cursor: 'pointer', fontSize: '13px'
          }}>{submitting ? 'Submitting...' : 'Submit Bug Report'}</button>
        </div>

        <div style={{ fontSize: '10px', color: '#555', textAlign: 'center' }}>
          No login required — submitted directly to the AgentOrch issue tracker
        </div>
      </div>
    </div>
  )
}
