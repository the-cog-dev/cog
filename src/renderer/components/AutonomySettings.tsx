import { useEffect, useRef, useState } from 'react'

interface Props { projectName: string | null }

const DURATIONS = [
  { label: '2h', hours: 2 },
  { label: '6h', hours: 6 },
  { label: '12h', hours: 12 },
  { label: '24h', hours: 24 },
]

function formatRemaining(ms: number): string {
  if (ms <= 0) return '0m'
  const totalMin = Math.ceil(ms / 60000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

export function AutonomySettings({ projectName }: Props) {
  const [expiresAt, setExpiresAt] = useState<number | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [durationHours, setDurationHours] = useState(6)
  const [now, setNow] = useState(() => Date.now())
  const tick = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!projectName) return
    window.electronAPI.getAutonomy().then(a => { setExpiresAt(a.sessionExpiresAt); setLoaded(true) })
    const off = window.electronAPI.onAutonomyChanged(a => setExpiresAt(a.sessionExpiresAt))
    return () => off()
  }, [projectName])

  const active = expiresAt !== null && now < expiresAt

  useEffect(() => {
    if (!active) {
      if (tick.current) { clearInterval(tick.current); tick.current = null }
      return
    }
    tick.current = setInterval(() => setNow(Date.now()), 1000)
    return () => { if (tick.current) clearInterval(tick.current) }
  }, [active])

  const start = async () => {
    const a = await window.electronAPI.startAutonomySession(durationHours)
    setExpiresAt(a.sessionExpiresAt); setNow(Date.now())
  }
  const end = async () => {
    const a = await window.electronAPI.endAutonomySession()
    setExpiresAt(a.sessionExpiresAt)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', borderTop: '1px solid #333', paddingTop: '16px' }}>
      <div style={{ fontSize: '12px', color: '#888', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        Agent Autonomy{projectName ? ` — ${projectName}` : ''}
      </div>
      {!projectName ? (
        <p style={{ fontSize: '12px', color: '#888', margin: 0 }}>Open a project to configure autonomy.</p>
      ) : (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: '10px', padding: '10px',
          backgroundColor: active ? '#2a1f1f' : '#252525',
          border: active ? '1px solid #b04a4a' : '1px solid #333',
          borderRadius: '4px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: '13px', color: '#e0e0e0', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: active ? '#e8a33d' : '#888' }}>⚠</span> Autonomous session
            </div>
            <div
              onClick={loaded ? (active ? end : start) : undefined}
              style={{
                width: 40, height: 22, borderRadius: 11,
                backgroundColor: active ? '#4caf50' : '#444',
                position: 'relative', cursor: loaded ? 'pointer' : 'not-allowed',
                transition: 'background-color 0.2s', flexShrink: 0, opacity: loaded ? 1 : 0.5
              }}
            >
              <div style={{
                width: 18, height: 18, borderRadius: '50%', backgroundColor: '#fff',
                position: 'absolute', top: 2, left: active ? 20 : 2, transition: 'left 0.2s'
              }} />
            </div>
          </div>

          {active ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontSize: '12px', color: '#e8a33d' }}>{formatRemaining(expiresAt! - now)} left</div>
              <button
                onClick={end}
                style={{ fontSize: '11px', color: '#e0e0e0', background: '#3a2a2a', border: '1px solid #b04a4a', borderRadius: 4, padding: '3px 8px', cursor: 'pointer' }}
              >End now</button>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: '12px', color: '#888' }}>Duration</span>
              <select
                value={durationHours}
                onChange={e => setDurationHours(Number(e.target.value))}
                style={{ fontSize: '12px', background: '#1c1c1c', color: '#e0e0e0', border: '1px solid #444', borderRadius: 4, padding: '3px 6px' }}
              >
                {DURATIONS.map(d => <option key={d.hours} value={d.hours}>{d.label}</option>)}
              </select>
            </div>
          )}

          <div style={{ fontSize: '11px', color: '#888', lineHeight: 1.4 }}>
            While active, agents self-schedule prompts, spawn agents/teams, and close idle agents <strong>without approval</strong>. Every spawn/close posts to your inbox as urgent.
          </div>
        </div>
      )}
    </div>
  )
}
