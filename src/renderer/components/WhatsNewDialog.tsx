import React, { useState, useEffect } from 'react'

declare const electronAPI: {
  getUpdateChangelog: () => Promise<{ commits: string[]; fromSha: string; toSha: string } | null>
}

export function WhatsNewDialog(): React.ReactElement | null {
  const [changelog, setChangelog] = useState<{ commits: string[]; fromSha: string; toSha: string } | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    electronAPI.getUpdateChangelog().then(cl => {
      if (cl && cl.commits.length > 0) setChangelog(cl)
    })
  }, [])

  if (!changelog || dismissed) return null

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 100003
    }}>
      <div style={{
        backgroundColor: '#1e1e1e', border: '1px solid #333', borderRadius: '8px',
        padding: '24px', width: '450px', maxHeight: '500px',
        display: 'flex', flexDirection: 'column', gap: '12px'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: '16px', color: '#8cc4ff' }}>What's New</h2>
          <span style={{ fontSize: '11px', color: '#666' }}>{changelog.fromSha} → {changelog.toSha}</span>
        </div>

        <div style={{ overflow: 'auto', maxHeight: '350px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {changelog.commits.map((commit, i) => {
            // Color-code by commit type
            let color = '#ccc'
            if (commit.startsWith('feat:') || commit.startsWith('feat(')) color = '#4caf50'
            if (commit.startsWith('fix:') || commit.startsWith('fix(')) color = '#ffc107'
            if (commit.startsWith('refactor:')) color = '#4a9eff'
            if (commit.startsWith('chore:') || commit.startsWith('docs:') || commit.startsWith('test:')) color = '#888'

            return (
              <div key={i} style={{
                padding: '4px 8px', fontSize: '12px', color,
                borderLeft: `3px solid ${color}`, backgroundColor: '#252525',
                borderRadius: '2px'
              }}>
                {commit}
              </div>
            )
          })}
        </div>

        <button onClick={() => setDismissed(true)} style={{
          padding: '8px 16px', backgroundColor: '#2a4a5a', border: '1px solid #4a9eff',
          borderRadius: '4px', color: '#4a9eff', cursor: 'pointer', fontSize: '13px',
          alignSelf: 'flex-end'
        }}>Got it</button>
      </div>
    </div>
  )
}
