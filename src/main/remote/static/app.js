(function() {
  'use strict'
  const TOKEN = window.__TOKEN__
  const BASE = `/r/${TOKEN}`
  const POLL_INTERVAL_MS = 5000
  const OUTPUT_CACHE_MS = 5000

  const $ = (id) => document.getElementById(id)
  const outputCache = new Map()  // agentId → { lines, fetchedAt }
  let pollHandle = null
  let agents = []
  let lastState = null  // cache full state for panel detail views

  function statusMessage(text, kind) {
    const el = $('status-message')
    el.textContent = text
    el.className = `status-message ${kind || ''}`
    if (text) {
      setTimeout(() => { if (el.textContent === text) { el.textContent = ''; el.className = 'status-message' } }, 3000)
    }
  }

  async function fetchState() {
    try {
      const res = await fetch(`${BASE}/state`)
      if (res.status === 404) {
        showDisconnected()
        return
      }
      if (!res.ok) {
        statusMessage(`Server error ${res.status}`, 'error')
        return
      }
      const data = await res.json()
      render(data)
    } catch (err) {
      statusMessage('Network error', 'error')
    }
  }

  function showDisconnected() {
    $('disconnected-overlay').classList.remove('hidden')
    if (pollHandle) { clearInterval(pollHandle); pollHandle = null }
  }

  function render(state) {
    $('project-name').textContent = state.projectName
    $('agent-summary').textContent = `${state.agents.length} agents · ${state.connectionCount} conn`
    const badge = $('connection-badge')
    badge.textContent = `${state.connectionCount === 1 ? '🟢' : '🔴'} ${state.connectionCount}`
    badge.className = `badge ${state.connectionCount > 1 ? 'warn' : 'ok'}`

    const sessionTimeEl = $('session-time')
    if (state.sessionExpiresAt && state.serverTime) {
      const remaining = state.sessionExpiresAt - state.serverTime
      if (remaining > 0) {
        sessionTimeEl.textContent = `⏱ ${formatTimeLeft(remaining)}`
      } else {
        sessionTimeEl.textContent = '⏱ expired'
      }
    } else {
      sessionTimeEl.textContent = ''
    }

    lastState = state
    agents = state.agents
    renderAgents(state.agents)
    renderSchedules(state.schedules)
    renderPinboard(state.pinboardTasks)
    renderSendTargets(state.agents)

    // Workshop button visibility
    const workshopBtn = $('workshop-btn')
    if (state.workshopPasscodeSet) {
      workshopBtn.classList.remove('hidden')
    } else {
      workshopBtn.classList.add('hidden')
    }
  }

  function renderAgents(list) {
    const container = $('agents-list')
    if (list.length === 0) {
      container.innerHTML = '<div style="color:#666;font-size:12px;font-style:italic">No agents</div>'
      return
    }
    container.innerHTML = list.map(a => `
      <div class="agent-card" data-agent-id="${escapeHtml(a.id)}">
        <div class="agent-card-header" data-action="toggle-output">
          <div>
            <div class="agent-name">${escapeHtml(a.name)}</div>
            <div class="agent-meta">${escapeHtml(a.cli)} · ${escapeHtml(a.model || 'default')}</div>
          </div>
          <span class="agent-status ${escapeHtml(a.status)}">${escapeHtml(a.status)}</span>
        </div>
        <div class="agent-output hidden" data-output-for="${escapeHtml(a.id)}" style="display:none"></div>
      </div>
    `).join('')

    container.querySelectorAll('.agent-card-header').forEach(header => {
      header.addEventListener('click', async () => {
        const card = header.closest('.agent-card')
        const id = card.dataset.agentId
        const outputDiv = card.querySelector('[data-output-for]')
        if (outputDiv.style.display === 'none') {
          outputDiv.style.display = 'block'
          outputDiv.textContent = 'Loading...'
          const lines = await fetchOutput(id)
          outputDiv.textContent = stripAnsi(lines.join('\n')) || '(no output)'
        } else {
          outputDiv.style.display = 'none'
        }
      })
    })
  }

  async function fetchOutput(agentId) {
    const cached = outputCache.get(agentId)
    if (cached && Date.now() - cached.fetchedAt < OUTPUT_CACHE_MS) {
      return cached.lines
    }
    try {
      const res = await fetch(`${BASE}/agent/${encodeURIComponent(agentId)}/output`)
      if (!res.ok) return []
      const data = await res.json()
      outputCache.set(agentId, { lines: data.lines, fetchedAt: Date.now() })
      return data.lines
    } catch {
      return []
    }
  }

  function renderSchedules(list) {
    const container = $('schedules-list')
    if (list.length === 0) {
      container.innerHTML = '<div style="color:#666;font-size:12px;font-style:italic">No schedules</div>'
      return
    }
    container.innerHTML = list.map(s => {
      const isPaused = s.status === 'paused'
      const intervalDisplay = s.intervalMinutes >= 60 && s.intervalMinutes % 60 === 0
        ? `${s.intervalMinutes / 60}h`
        : `${s.intervalMinutes}min`
      const nextFireMs = Math.max(0, s.nextFireAt - Date.now())
      const nextFireMin = Math.floor(nextFireMs / 60000)
      return `
        <div class="schedule-card" data-schedule-id="${escapeHtml(s.id)}" data-status="${escapeHtml(s.status)}">
          <div class="schedule-name">
            📅 ${escapeHtml(s.name)}
            <span class="agent-status ${escapeHtml(s.status)}">${escapeHtml(s.status)}</span>
          </div>
          <div class="schedule-meta">
            → ${escapeHtml(s.agentName)}<br>
            Every ${intervalDisplay} · ${s.expiresAt === null ? '∞ running' : `${formatTimeLeft(s.expiresAt - Date.now())} left`}
            ${isPaused ? '' : `<br>Next: in ${nextFireMin}m`}
          </div>
          <div class="schedule-actions">
            ${isPaused
              ? '<button data-action="resume">▶ Resume</button>'
              : '<button data-action="pause">⏸ Pause</button>'}
            ${s.status === 'expired' || s.status === 'stopped' ? '<button data-action="restart">↻ Restart</button>' : ''}
          </div>
        </div>
      `
    }).join('')

    container.querySelectorAll('.schedule-card').forEach(card => {
      const id = card.dataset.scheduleId
      card.querySelectorAll('button[data-action]').forEach(btn => {
        btn.addEventListener('click', () => scheduleAction(id, btn.dataset.action))
      })
    })
  }

  function formatTimeLeft(ms) {
    if (ms <= 0) return '0m'
    const mins = Math.floor(ms / 60000)
    if (mins < 60) return `${mins}m`
    const hours = Math.floor(mins / 60)
    const remMin = mins % 60
    return remMin === 0 ? `${hours}h` : `${hours}h ${remMin}m`
  }

  function renderPinboard(list) {
    const container = $('pinboard-list')
    // Dashboard shows only active (non-completed) tasks — the workshop panel
    // shows the full Kanban breakdown.
    const active = list.filter(t => t.status !== 'completed')
    if (active.length === 0) {
      container.innerHTML = '<div style="color:#666;font-size:12px;font-style:italic">No tasks</div>'
      return
    }
    container.innerHTML = active.map(t => `
      <div class="task-card">
        <div class="task-priority-dot ${escapeHtml(t.priority)}"></div>
        <div>
          <div>${escapeHtml(t.title)}</div>
          ${t.claimedBy ? `<div style="color:#888;font-size:11px">claimed by ${escapeHtml(t.claimedBy)}</div>` : ''}
        </div>
      </div>
    `).join('')
  }

  function renderSendTargets(list) {
    const select = $('send-target')
    const currentValue = select.value
    select.innerHTML = list.map(a => `<option value="${escapeHtml(a.name)}">${escapeHtml(a.name)}</option>`).join('')
    if (currentValue && list.some(a => a.name === currentValue)) {
      select.value = currentValue
    }
  }

  function escapeHtml(s) {
    if (s === undefined || s === null) return ''
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')
  }

  // Clean raw PTY output for phone display.
  // The PTY buffer contains raw terminal screen redraws (cursor movement, TUI
  // repaints, spinners, status bars). xterm.js interprets these as a virtual
  // screen on desktop. For the phone we need to extract just the meaningful text.
  function stripAnsi(text) {
    if (!text) return ''

    let s = text
      // CSI sequences: ESC[ ... letter (colors, cursor movement, erase, etc.)
      .replace(/\x1b\[[0-9;?]*[a-zA-Z@]/g, '')
      // OSC sequences: ESC] ... BEL or ESC\ (window titles, etc.)
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      // Other ESC sequences
      .replace(/\x1b[()][A-Z0-9]/g, '')
      .replace(/\x1b[a-zA-Z]/g, '')
      // Remaining control characters except newline/tab
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')

    // Filter TUI noise line by line
    const lines = s.split('\n')
    const filtered = []
    let prevLine = ''

    for (const raw of lines) {
      const line = raw.replace(/\r/g, '').trim()

      // Skip empty/whitespace-only lines in sequences
      if (!line) {
        if (filtered.length > 0 && filtered[filtered.length - 1] !== '') filtered.push('')
        continue
      }

      // Skip duplicate consecutive lines (TUI redraws)
      if (line === prevLine) continue
      prevLine = line

      // Skip Claude Code TUI chrome / spinner noise
      if (/^[─━═]{4,}$/.test(line)) continue                          // horizontal rules
      if (/^>\s*$/.test(line)) continue                                // empty prompt
      if (/^[✢✶✻✽●·⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⏵▐▛▜▝▘]+/.test(line) && line.length < 80) continue  // spinner-only lines
      if (/thinking with high effort/i.test(line) && !/^[●*]/.test(line)) continue   // status bar redraws
      if (/Quantumizing/i.test(line) && line.length < 60) continue     // thinking status fragments
      if (/esc to interrupt/i.test(line)) continue                     // prompt bar
      if (/bypass permissions on/i.test(line)) continue                // mode indicator
      if (/shift\+tab to cycle/i.test(line)) continue                  // mode hint
      if (/^\s*⎿\s*Tip:/i.test(line)) continue                        // tips
      if (/^\s*⎿\s*Running…/.test(line)) continue                     // tool running indicator
      if (/^\s*⏵⏵/.test(line)) continue                               // mode indicator
      if (/^[a-z]+\d+[a-z]*$/i.test(line) && line.length < 20) continue  // spinner fragment garbage

      // Lines with very few printable chars relative to length are likely garbage
      const printable = line.replace(/\s/g, '')
      if (printable.length < 3 && line.length > 0) continue

      filtered.push(raw.replace(/\r/g, ''))
    }

    // Collapse runs of blank lines
    return filtered.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  }

  // Polling lifecycle
  function startPolling() {
    if (pollHandle) return
    fetchState()
    pollHandle = setInterval(fetchState, POLL_INTERVAL_MS)
  }

  function stopPolling() {
    if (pollHandle) {
      clearInterval(pollHandle)
      pollHandle = null
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (workshopActive) {
        fetchWorkshopState()
        if (!workshopPollHandle) workshopPollHandle = setInterval(fetchWorkshopState, POLL_INTERVAL_MS)
        if (currentDetailAgent && !detailPollHandle) detailPollHandle = setInterval(fetchDetailOutput, POLL_INTERVAL_MS)
      } else {
        startPolling()
      }
    } else {
      stopPolling()
      if (workshopPollHandle) { clearInterval(workshopPollHandle); workshopPollHandle = null }
      if (detailPollHandle) { clearInterval(detailPollHandle); detailPollHandle = null }
    }
  })

  // Section collapse
  document.querySelectorAll('.section-header[data-toggle]').forEach(header => {
    header.addEventListener('click', (e) => {
      // ignore clicks on the inline + button
      if (e.target.classList.contains('inline-btn')) return
      const targetId = header.dataset.toggle
      const body = document.getElementById(targetId)
      if (body) body.classList.toggle('collapsed')
    })
  })

  // Manual refresh
  $('refresh-btn').addEventListener('click', fetchState)

  // Send message
  async function sendMessage() {
    const to = $('send-target').value
    const text = $('send-text').value.trim()
    if (!to || !text) return
    try {
      const res = await fetch(`${BASE}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, text })
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        statusMessage(err.error || `Send failed (${res.status})`, 'error')
        return
      }
      $('send-text').value = ''
      statusMessage(`Sent to ${to}`, 'success')
    } catch {
      statusMessage('Network error', 'error')
    }
  }

  $('send-btn').addEventListener('click', sendMessage)
  $('send-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendMessage()
  })

  // Schedule actions
  async function scheduleAction(id, action) {
    if (action === 'restart' && !confirm('Restart this schedule with a fresh clock?')) return
    try {
      const res = await fetch(`${BASE}/schedule/${encodeURIComponent(id)}/${action}`, { method: 'POST' })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        statusMessage(err.error || `${action} failed`, 'error')
        return
      }
      statusMessage(`Schedule ${action}d`, 'success')
      fetchState()
    } catch {
      statusMessage('Network error', 'error')
    }
  }

  // Task modal
  $('add-task-btn').addEventListener('click', (e) => {
    e.stopPropagation()
    $('task-modal').classList.remove('hidden')
    $('task-title').value = ''
    $('task-description').value = ''
    document.querySelector('input[name="priority"][value="medium"]').checked = true
  })

  $('task-cancel').addEventListener('click', () => {
    $('task-modal').classList.add('hidden')
  })

  $('task-submit').addEventListener('click', async () => {
    const title = $('task-title').value.trim()
    const description = $('task-description').value.trim()
    const priority = document.querySelector('input[name="priority"]:checked').value
    if (!title || !description) {
      statusMessage('Title and description required', 'error')
      return
    }
    try {
      const res = await fetch(`${BASE}/task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description, priority })
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        statusMessage(err.error || 'Failed', 'error')
        return
      }
      $('task-modal').classList.add('hidden')
      statusMessage('Task posted', 'success')
      fetchState()
    } catch {
      statusMessage('Network error', 'error')
    }
  })

  // --- Workshop ---
  let workshopActive = false
  let workshopPollHandle = null
  let currentDetailAgent = null
  let detailPollHandle = null
  let workshopTouchState = { zoom: 0.4, panX: 0, panY: 0 }

  // Passcode entry
  $('workshop-btn').addEventListener('click', () => {
    $('workshop-passcode').classList.remove('hidden')
    const boxes = document.querySelectorAll('.pin-box')
    boxes.forEach(b => { b.value = '' })
    boxes[0].focus()
    $('passcode-error').textContent = ''
  })

  $('passcode-cancel').addEventListener('click', () => {
    $('workshop-passcode').classList.add('hidden')
  })

  document.querySelectorAll('.pin-box').forEach((box, idx) => {
    box.addEventListener('input', (e) => {
      const val = e.target.value.replace(/\D/g, '')
      e.target.value = val.slice(0, 1)
      if (val && idx < 3) {
        document.querySelectorAll('.pin-box')[idx + 1].focus()
      }
      if (idx === 3 && val) {
        const pin = Array.from(document.querySelectorAll('.pin-box')).map(b => b.value).join('')
        if (pin.length === 4) verifyPasscode(pin)
      }
    })
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !e.target.value && idx > 0) {
        document.querySelectorAll('.pin-box')[idx - 1].focus()
      }
    })
  })

  async function verifyPasscode(pin) {
    try {
      const res = await fetch(`${BASE}/workshop/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin })
      })
      const data = await res.json()
      if (data.verified) {
        $('workshop-passcode').classList.add('hidden')
        enterWorkshop()
      } else {
        $('passcode-error').textContent = data.error || `Wrong passcode (${data.attemptsLeft} left)`
        document.querySelectorAll('.pin-box').forEach(b => { b.value = '' })
        document.querySelectorAll('.pin-box')[0].focus()
        $('passcode-boxes').classList.add('shake')
        setTimeout(() => $('passcode-boxes').classList.remove('shake'), 500)
      }
    } catch {
      $('passcode-error').textContent = 'Network error'
    }
  }

  // Workshop canvas enter/exit + polling
  function enterWorkshop() {
    workshopActive = true
    $('content').classList.add('hidden')
    $('send-bar').classList.add('hidden')
    $('header').classList.add('hidden')
    $('workshop-view').classList.remove('hidden')
    workshopTouchState = { zoom: 0.4, panX: 0, panY: 0 }
    fetchWorkshopState()
    workshopPollHandle = setInterval(fetchWorkshopState, POLL_INTERVAL_MS)
    setupTouchHandlers()
  }

  function exitWorkshop() {
    workshopActive = false
    $('workshop-view').classList.add('hidden')
    $('workshop-detail').classList.add('hidden')
    $('content').classList.remove('hidden')
    $('send-bar').classList.remove('hidden')
    $('header').classList.remove('hidden')
    if (workshopPollHandle) { clearInterval(workshopPollHandle); workshopPollHandle = null }
    if (detailPollHandle) { clearInterval(detailPollHandle); detailPollHandle = null }
    currentDetailAgent = null
  }

  $('workshop-back').addEventListener('click', exitWorkshop)

  async function fetchWorkshopState() {
    try {
      const res = await fetch(`${BASE}/workshop/state`)
      if (res.status === 403) { exitWorkshop(); statusMessage('Workshop session expired', 'error'); return }
      if (!res.ok) return
      const data = await res.json()
      renderWorkshopCanvas(data)
    } catch { /* retry on next poll */ }
  }

  // Canvas rendering
  function renderWorkshopCanvas(data) {
    const canvas = $('workshop-canvas')
    canvas.innerHTML = ''

    for (const win of data.windows) {
      const card = document.createElement('div')
      card.className = 'ws-card'
      card.style.left = win.x + 'px'
      card.style.top = win.y + 'px'
      card.style.width = win.width + 'px'
      card.style.height = win.height + 'px'

      if (win.type === 'agent' && win.agent) {
        const a = win.agent
        const theme = a.theme || {}
        card.style.borderColor = theme.border || '#333'
        card.innerHTML = `
          <div class="ws-card-chrome" style="background:${escapeHtml(theme.chrome || '#1e1e1e')}">
            <span class="ws-status-dot ${escapeHtml(a.status)}"></span>
            <span class="ws-card-title" style="color:${escapeHtml(theme.text || '#ccc')}">${escapeHtml(a.name)}</span>
            <span class="ws-card-role" style="color:${escapeHtml(theme.text || '#888')}">${escapeHtml(a.role)}</span>
          </div>
          <div class="ws-card-body" style="background:${escapeHtml(theme.bg || '#0d0d0d')};color:${escapeHtml(theme.text || '#888')}">
            ${escapeHtml(a.cli)}${a.model ? ' · ' + escapeHtml(a.model) : ''}
          </div>
        `
        card.addEventListener('click', () => openAgentDetail(a))
      } else {
        card.innerHTML = `
          <div class="ws-card-chrome"><span class="ws-card-title">${escapeHtml(win.title)}</span></div>
          <div class="ws-card-body" style="color:#666">${escapeHtml(win.panelType || 'panel')}</div>
        `
        card.addEventListener('click', () => openPanelDetail(win))
      }

      canvas.appendChild(card)
    }

    applyCanvasTransform()
  }

  function applyCanvasTransform() {
    const canvas = $('workshop-canvas')
    const { zoom, panX, panY } = workshopTouchState
    canvas.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`
  }

  // Touch handlers for pinch/zoom/pan
  function setupTouchHandlers() {
    const viewport = $('workshop-canvas-viewport')
    let startDist = 0
    let startZoom = 1
    let lastTouchX = 0, lastTouchY = 0
    let isPinching = false

    // Remove old listeners by replacing the element
    const clone = viewport.cloneNode(true)
    viewport.parentNode.replaceChild(clone, viewport)
    clone.id = 'workshop-canvas-viewport'

    const vp = $('workshop-canvas-viewport')

    vp.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        isPinching = true
        startDist = Math.hypot(e.touches[1].clientX - e.touches[0].clientX, e.touches[1].clientY - e.touches[0].clientY)
        startZoom = workshopTouchState.zoom
      } else if (e.touches.length === 1) {
        isPinching = false
        lastTouchX = e.touches[0].clientX
        lastTouchY = e.touches[0].clientY
      }
    }, { passive: true })

    vp.addEventListener('touchmove', (e) => {
      if (isPinching && e.touches.length === 2) {
        e.preventDefault()
        const dist = Math.hypot(e.touches[1].clientX - e.touches[0].clientX, e.touches[1].clientY - e.touches[0].clientY)
        workshopTouchState.zoom = Math.max(0.15, Math.min(2.0, startZoom * (dist / startDist)))
        applyCanvasTransform()
      } else if (!isPinching && e.touches.length === 1) {
        const dx = e.touches[0].clientX - lastTouchX
        const dy = e.touches[0].clientY - lastTouchY
        lastTouchX = e.touches[0].clientX
        lastTouchY = e.touches[0].clientY
        workshopTouchState.panX += dx
        workshopTouchState.panY += dy
        applyCanvasTransform()
      }
    }, { passive: false })

    vp.addEventListener('touchend', () => { isPinching = false })
  }

  // Agent detail view
  async function openAgentDetail(agent) {
    currentDetailAgent = agent
    $('workshop-view').classList.add('hidden')
    $('workshop-detail').classList.remove('hidden')

    const theme = agent.theme || {}
    $('detail-header').style.backgroundColor = theme.chrome || '#1e1e1e'
    $('detail-header').style.borderBottom = `1px solid ${theme.border || '#333'}`
    $('detail-name').textContent = agent.name
    $('detail-name').style.color = theme.text || '#ccc'
    $('detail-meta').textContent = `${agent.cli}${agent.model ? ' · ' + agent.model : ''}`
    $('detail-status-dot').className = `detail-status-dot ${agent.status}`
    $('detail-output').style.backgroundColor = theme.bg || '#0d0d0d'
    $('detail-output').style.color = theme.text || '#ccc'
    $('detail-output').textContent = 'Loading...'
    $('detail-send-text').placeholder = `Type a message to ${agent.name}...`
    $('detail-stop').style.display = agent.status === 'disconnected' ? 'none' : 'block'

    await fetchDetailOutput()
    detailPollHandle = setInterval(fetchDetailOutput, POLL_INTERVAL_MS)
  }

  function closeAgentDetail() {
    currentDetailAgent = null
    $('workshop-detail').classList.add('hidden')
    $('workshop-view').classList.remove('hidden')
    if (detailPollHandle) { clearInterval(detailPollHandle); detailPollHandle = null }
  }

  // Panel detail views (pinboard, info)
  function openPanelDetail(win) {
    const panelType = (win.panelType || win.title || '').toLowerCase()
    $('workshop-view').classList.add('hidden')
    $('workshop-panel').classList.remove('hidden')
    $('panel-title').textContent = win.title || panelType

    const content = $('panel-content')
    if (panelType.includes('pinboard')) {
      renderPanelPinboard(content)
    } else if (panelType.includes('info')) {
      renderPanelInfo(content)
    } else if (panelType.includes('schedule')) {
      renderPanelSchedules(content)
    } else {
      content.innerHTML = '<div style="color:#666;padding:20px;text-align:center">Panel view not available</div>'
    }
  }

  function closePanelDetail() {
    $('workshop-panel').classList.add('hidden')
    $('workshop-view').classList.remove('hidden')
  }

  $('panel-back').addEventListener('click', closePanelDetail)

  function renderPanelPinboard(container) {
    if (!lastState || !lastState.pinboardTasks) {
      container.innerHTML = '<div style="color:#666;padding:20px;text-align:center">No data</div>'
      return
    }
    const tasks = lastState.pinboardTasks
    if (tasks.length === 0) {
      container.innerHTML = '<div style="color:#666;padding:20px;text-align:center;font-style:italic">No tasks</div>'
      return
    }
    const priorityColors = { high: '#ef4444', medium: '#eab308', low: '#22c55e' }
    const groups = [
      { key: 'open', label: 'Open', accent: '#3b82f6', tasks: tasks.filter(t => t.status === 'open') },
      { key: 'in_progress', label: 'In Progress', accent: '#eab308', tasks: tasks.filter(t => t.status === 'in_progress') },
      { key: 'completed', label: 'Completed', accent: '#22c55e', tasks: tasks.filter(t => t.status === 'completed') }
    ]

    const renderTask = (t) => `
      <div style="display:flex;align-items:flex-start;gap:8px;padding:8px 10px;background:#1a1a1a;border-radius:4px;margin-bottom:4px;border:1px solid #2a2a2a;">
        <div style="width:8px;height:8px;border-radius:50%;background:${priorityColors[t.priority] || '#888'};margin-top:4px;flex-shrink:0;"></div>
        <div style="flex:1;min-width:0;">
          <div style="color:#e0e0e0;font-size:12px;line-height:1.4;word-break:break-word;">${escapeHtml(t.title)}</div>
          ${t.claimedBy ? `<div style="color:#888;font-size:10px;margin-top:2px;">claimed by ${escapeHtml(t.claimedBy)}</div>` : ''}
        </div>
      </div>
    `

    // Completed section defaults to collapsed to reduce noise
    container.innerHTML = `
      <div style="padding:8px;">
        ${groups.map(g => `
          <div class="ws-group" data-group="${g.key}" style="margin-bottom:10px;">
            <div class="ws-group-header" style="display:flex;align-items:center;gap:8px;padding:10px 12px;background:#1a1a1a;border:1px solid #333;border-left:3px solid ${g.accent};border-radius:4px;cursor:pointer;user-select:none;">
              <span class="ws-group-toggle" style="color:#888;font-size:10px;width:10px;">${g.key === 'completed' ? '▶' : '▼'}</span>
              <span style="flex:1;color:#e0e0e0;font-size:13px;font-weight:600;">${g.label}</span>
              <span style="color:${g.accent};font-size:11px;font-weight:700;background:#0d0d0d;padding:2px 8px;border-radius:10px;min-width:24px;text-align:center;">${g.tasks.length}</span>
            </div>
            <div class="ws-group-body" style="padding:8px 0 0 0;${g.key === 'completed' ? 'display:none;' : ''}">
              ${g.tasks.length === 0
                ? `<div style="color:#555;font-size:11px;font-style:italic;padding:6px 10px;">No ${g.label.toLowerCase()} tasks</div>`
                : g.tasks.map(renderTask).join('')}
            </div>
          </div>
        `).join('')}
      </div>
    `

    // Wire up collapse/expand
    container.querySelectorAll('.ws-group-header').forEach(header => {
      header.addEventListener('click', () => {
        const body = header.nextElementSibling
        const toggle = header.querySelector('.ws-group-toggle')
        if (body.style.display === 'none') {
          body.style.display = ''
          toggle.textContent = '▼'
        } else {
          body.style.display = 'none'
          toggle.textContent = '▶'
        }
      })
    })
  }

  function renderPanelInfo(container) {
    if (!lastState || !lastState.infoEntries) {
      container.innerHTML = '<div style="color:#666;padding:20px;text-align:center">No data</div>'
      return
    }
    const entries = lastState.infoEntries
    if (entries.length === 0) {
      container.innerHTML = '<div style="color:#666;padding:20px;text-align:center;font-style:italic">No info entries</div>'
      return
    }
    container.innerHTML = `
      <div style="padding:8px;">
        ${entries.map(e => `
          <div style="padding:10px;background:#1a1a1a;border-radius:4px;margin-bottom:6px;border:1px solid #333;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
              <span style="color:#8cc4ff;font-size:11px;font-weight:600;">${escapeHtml(e.from)}</span>
              <span style="color:#555;font-size:10px;">${new Date(e.createdAt).toLocaleTimeString()}</span>
            </div>
            <div style="color:#ccc;font-size:12px;line-height:1.5;white-space:pre-wrap;">${escapeHtml(e.note)}</div>
            ${e.tags && e.tags.length > 0 ? `
              <div style="margin-top:6px;display:flex;gap:4px;flex-wrap:wrap;">
                ${e.tags.map(tag => `<span style="font-size:9px;padding:1px 6px;background:#2a2a3a;border-radius:3px;color:#8888cc;">${escapeHtml(tag)}</span>`).join('')}
              </div>
            ` : ''}
          </div>
        `).join('')}
      </div>
    `
  }

  function renderPanelSchedules(container) {
    if (!lastState || !lastState.schedules) {
      container.innerHTML = '<div style="color:#666;padding:20px;text-align:center">No data</div>'
      return
    }
    const list = lastState.schedules
    if (list.length === 0) {
      container.innerHTML = '<div style="color:#666;padding:20px;text-align:center;font-style:italic">No schedules</div>'
      return
    }
    container.innerHTML = `
      <div style="padding:8px;">
        ${list.map(s => {
          const isPaused = s.status === 'paused'
          const intervalDisplay = s.intervalMinutes >= 60 && s.intervalMinutes % 60 === 0 ? `${s.intervalMinutes / 60}h` : `${s.intervalMinutes}min`
          return `
            <div style="padding:10px;background:#1a1a1a;border-radius:4px;margin-bottom:6px;border:1px solid #333;">
              <div style="color:#e0e0e0;font-size:13px;margin-bottom:4px;">📅 ${escapeHtml(s.name)}</div>
              <div style="color:#888;font-size:11px;">→ ${escapeHtml(s.agentName)} · Every ${intervalDisplay}</div>
              <div style="color:#555;font-size:10px;margin-top:2px;">${escapeHtml(s.status)}</div>
            </div>
          `
        }).join('')}
      </div>
    `
  }

  async function fetchDetailOutput() {
    if (!currentDetailAgent) return
    try {
      const res = await fetch(`${BASE}/workshop/output/${encodeURIComponent(currentDetailAgent.id)}?lines=200`)
      if (!res.ok) return
      const data = await res.json()
      const el = $('detail-output')
      const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30
      el.textContent = stripAnsi(data.lines.join('\n')) || '(no output)'
      if (wasAtBottom) el.scrollTop = el.scrollHeight
    } catch { /* retry */ }
  }

  $('detail-back').addEventListener('click', closeAgentDetail)

  // Send message from detail view
  async function sendDetailMessage() {
    if (!currentDetailAgent) return
    const text = $('detail-send-text').value.trim()
    if (!text) return
    try {
      const res = await fetch(`${BASE}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: currentDetailAgent.name, text })
      })
      if (res.ok) {
        $('detail-send-text').value = ''
        statusMessage(`Sent to ${currentDetailAgent.name}`, 'success')
      }
    } catch { statusMessage('Network error', 'error') }
  }

  $('detail-send-btn').addEventListener('click', sendDetailMessage)
  $('detail-send-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendDetailMessage()
  })

  // Kill agent
  $('detail-stop').addEventListener('click', async () => {
    if (!currentDetailAgent) return
    if (!confirm(`Kill ${currentDetailAgent.name}? This will terminate the agent.`)) return
    try {
      const res = await fetch(`${BASE}/workshop/kill/${encodeURIComponent(currentDetailAgent.id)}`, { method: 'POST' })
      if (res.ok) {
        statusMessage(`${currentDetailAgent.name} killed`, 'success')
        closeAgentDetail()
      } else {
        const err = await res.json().catch(() => ({}))
        statusMessage(err.error || 'Kill failed', 'error')
      }
    } catch { statusMessage('Network error', 'error') }
  })

  // Initial start
  startPolling()
})()
