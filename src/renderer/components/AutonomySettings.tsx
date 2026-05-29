import { useEffect, useState } from 'react'

interface Props { projectName: string | null }

export function AutonomySettings({ projectName }: Props) {
  const [scheduling, setScheduling] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!projectName) return
    window.electronAPI.getAutonomy().then(a => { setScheduling(!!a.scheduling); setLoaded(true) })
  }, [projectName])

  const toggle = async () => {
    const next = !scheduling
    setScheduling(next)
    await window.electronAPI.setAutonomy({ scheduling: next })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', borderTop: '1px solid #333', paddingTop: '16px' }}>
      <div style={{ fontSize: '12px', color: '#888', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        Agent Autonomy{projectName ? ` — ${projectName}` : ''}
      </div>
      {!projectName ? (
        <p style={{ fontSize: '12px', color: '#888', margin: 0 }}>Open a project to configure autonomy.</p>
      ) : (
        <label style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px', backgroundColor: '#252525', borderRadius: '4px', cursor: loaded ? 'pointer' : 'default'
        }}>
          <div>
            <div style={{ fontSize: '13px', color: '#e0e0e0' }}>Scheduling</div>
            <div style={{ fontSize: '11px', color: '#666' }}>Let agents create scheduled prompts directly (off = they propose to your inbox)</div>
          </div>
          <div
            onClick={loaded ? toggle : undefined}
            style={{
              width: 40, height: 22, borderRadius: 11,
              backgroundColor: scheduling ? '#4caf50' : '#444',
              position: 'relative', cursor: loaded ? 'pointer' : 'not-allowed',
              transition: 'background-color 0.2s',
              flexShrink: 0, marginLeft: 12,
              opacity: loaded ? 1 : 0.5
            }}
          >
            <div style={{
              width: 18, height: 18, borderRadius: '50%',
              backgroundColor: '#fff', position: 'absolute', top: 2,
              left: scheduling ? 20 : 2,
              transition: 'left 0.2s'
            }} />
          </div>
        </label>
      )}
    </div>
  )
}
