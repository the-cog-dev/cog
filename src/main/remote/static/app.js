(function() {
  'use strict'
  const TOKEN = window.__TOKEN__
  const BASE = `/r/${TOKEN}`

  // Register the service worker so the app shell is installable as a PWA.
  // Scope follows the SW URL — `${BASE}/sw.js` gives scope `${BASE}/` which
  // matches the manifest. Registration is best-effort: if the browser has no
  // SW support (3DS, PSP, older feature phones) the rest of the app still
  // works via plain network requests.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(`${BASE}/sw.js`, { scope: `${BASE}/` }).catch(() => {
        // Swallow: some embedded browsers refuse SWs, no user-facing impact.
      })
    })
  }

  // WebSocket — best-effort augmentation. Polling continues to run in
  // parallel, so a dead WS just means we're back to 5s refresh latency.
  // On state.delta the next polling tick will reflect server truth; on
  // agent.output we append the chunk live into the detail view's textarea.
  let ws = null
  let wsBackoffMs = 1000
  const wsListeners = { output: new Map() }  // agentId → handler

  function connectWs() {
    if (!('WebSocket' in window)) return
    try {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
      ws = new WebSocket(`${proto}//${location.host}${BASE}/ws`)
    } catch { return }
    ws.addEventListener('open', () => {
      wsBackoffMs = 1000
      // Re-subscribe any agents the user is currently watching after reconnect.
      for (const agentId of wsListeners.output.keys()) {
        try { ws.send(JSON.stringify({ type: 'subscribe.output', agentId })) } catch { /* ignore */ }
      }
    })
    ws.addEventListener('message', (event) => {
      let msg
      try { msg = JSON.parse(event.data) } catch { return }
      if (!msg || typeof msg !== 'object') return
      if (msg.type === 'agent.output') {
        const handler = wsListeners.output.get(msg.agentId)
        if (handler) handler(msg.chunk)
      } else if (msg.type === 'state.delta') {
        // Tell the dashboard to refresh sooner than the polling cadence.
        if (Array.isArray(msg.changed) && msg.changed.length > 0) fetchState()
      }
    })
    ws.addEventListener('close', () => {
      ws = null
      // Cap backoff at 30s. We rely on polling for liveness in the meantime.
      const delay = Math.min(wsBackoffMs, 30_000)
      setTimeout(connectWs, delay)
      wsBackoffMs = Math.min(wsBackoffMs * 2, 30_000)
    })
    ws.addEventListener('error', () => {
      // `close` will fire after this — handle reconnect there.
    })
  }
  connectWs()

  function subscribeAgentOutput(agentId, handler) {
    wsListeners.output.set(agentId, handler)
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'subscribe.output', agentId })) } catch { /* ignore */ }
    }
  }
  function unsubscribeAgentOutput(agentId) {
    wsListeners.output.delete(agentId)
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'unsubscribe.output', agentId })) } catch { /* ignore */ }
    }
  }
  // Expose so detail view can hook in below
  window.__cogWs = { subscribeAgentOutput, unsubscribeAgentOutput }
  const POLL_INTERVAL_MS = 5000
  const OUTPUT_CACHE_MS = 5000

  const $ = (id) => document.getElementById(id)
  const outputCache = new Map()  // agentId → { lines, fetchedAt }
  let pollHandle = null
  let agents = []
  let lastState = null  // cache full state for panel detail views
  // Per-panel poll for inbox/trollbox detail views. Only one is alive at a
  // time — opening or switching panels clears the prior interval.
  let panelPollHandle = null

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
    if (panelPollHandle) { clearInterval(panelPollHandle); panelPollHandle = null }
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

    syncInboxBadges(state.inboxUnread || 0)
  }

  // Mirror state.inboxUnread onto the two pill surfaces and the panels-menu
  // inline count. Server is the source of truth; we never mutate the count
  // optimistically — marking a message read POSTs and the next poll updates.
  function syncInboxBadges(count) {
    const display = count > 9 ? '9+' : String(count)
    for (const id of ['workshop-btn-unread-pill', 'workshop-panels-btn-unread-pill', 'panels-menu-inbox-pill']) {
      const el = document.getElementById(id)
      if (!el) continue
      if (count > 0) {
        el.textContent = display
        el.classList.add('visible')
      } else {
        el.textContent = ''
        el.classList.remove('visible')
      }
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

  // Schedule creation modal. Workshop-gated server-side; if the user hasn't
  // entered the PIN yet, the create endpoint returns 403 and we route them
  // through the existing passcode flow with the submission queued as a
  // continuation. This avoids forcing a passcode entry just to open the modal.
  let pendingScheduleSubmission = null

  function openScheduleModal() {
    // Populate the agent picker from the current state. The schedule needs
    // an agentId, not a name — names can clash and agentId is what the
    // server's createSchedule resolves.
    const select = $('schedule-agent')
    const realAgents = (agents || []).filter(a => a.status !== 'panel')
    if (realAgents.length === 0) {
      statusMessage('Spawn an agent before scheduling prompts', 'error')
      return
    }
    select.innerHTML = realAgents
      .map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}</option>`)
      .join('')
    $('schedule-name').value = ''
    $('schedule-prompt').value = ''
    $('schedule-interval').value = '60'
    $('schedule-duration').value = '8'
    $('schedule-error').textContent = ''
    $('schedule-modal').classList.remove('hidden')
    setTimeout(() => $('schedule-prompt').focus(), 50)
  }

  $('add-schedule-btn').addEventListener('click', (e) => {
    e.stopPropagation()
    openScheduleModal()
  })

  $('schedule-cancel').addEventListener('click', () => {
    $('schedule-modal').classList.add('hidden')
    pendingScheduleSubmission = null
  })

  async function submitScheduleCreate(payload) {
    const res = await fetch(`${BASE}/workshop/schedule/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    if (res.status === 403) {
      // Not workshop-verified. Park the submission and prompt for PIN —
      // verifyPasscode's success path will replay it before entering workshop.
      pendingScheduleSubmission = payload
      $('schedule-modal').classList.add('hidden')
      $('workshop-passcode').classList.remove('hidden')
      const boxes = document.querySelectorAll('.pin-box')
      boxes.forEach(b => { b.value = '' })
      boxes[0].focus()
      $('passcode-error').textContent = ''
      return { deferred: true }
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      return { error: err.error || `HTTP ${res.status}` }
    }
    return { ok: true }
  }

  $('schedule-submit').addEventListener('click', async () => {
    const agentId = $('schedule-agent').value
    const name = $('schedule-name').value.trim()
    const promptText = $('schedule-prompt').value.trim()
    const intervalMinutes = parseInt($('schedule-interval').value, 10)
    const durationRaw = parseInt($('schedule-duration').value, 10)
    const durationHours = !Number.isFinite(durationRaw) || durationRaw <= 0 ? null : durationRaw

    if (!agentId) { $('schedule-error').textContent = 'Pick an agent'; return }
    if (!promptText) { $('schedule-error').textContent = 'Prompt text required'; return }
    if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
      $('schedule-error').textContent = 'Interval must be > 0 minutes'
      return
    }

    const payload = { agentId, name: name || undefined, promptText, intervalMinutes, durationHours }
    try {
      const result = await submitScheduleCreate(payload)
      if (result.deferred) {
        statusMessage('Enter Workshop passcode to confirm', 'info')
        return
      }
      if (result.error) {
        $('schedule-error').textContent = result.error
        return
      }
      $('schedule-modal').classList.add('hidden')
      statusMessage('Schedule created', 'success')
      fetchState()
    } catch {
      $('schedule-error').textContent = 'Network error'
    }
  })

  // --- Workshop ---
  let workshopActive = false
  let workshopPollHandle = null
  let currentDetailAgent = null
  let detailPollHandle = null
  let workshopTouchState = { zoom: 0.4, panX: 0, panY: 0 }

  // Fire-and-forget window position/size push to server during drag/resize
  function pushWindowUpdate(windowId, update) {
    fetch(`${BASE}/workshop/window/${encodeURIComponent(windowId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(update)
    }).catch(() => { /* retry on next action */ })
  }

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
        // If the user came here trying to create a schedule, replay the
        // submission and stay on the dashboard. Otherwise enter workshop view
        // as before.
        if (pendingScheduleSubmission) {
          const payload = pendingScheduleSubmission
          pendingScheduleSubmission = null
          const result = await submitScheduleCreate(payload)
          if (result.ok) {
            statusMessage('Schedule created', 'success')
            fetchState()
          } else if (result.error) {
            statusMessage(result.error, 'error')
          }
        } else {
          enterWorkshop()
        }
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
    if (panelPollHandle) { clearInterval(panelPollHandle); panelPollHandle = null }
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
        card.addEventListener('click', () => {
          if (card.dataset.skipNextClick) { delete card.dataset.skipNextClick; return }
          openAgentDetail(a)
        })
      } else {
        card.innerHTML = `
          <div class="ws-card-chrome"><span class="ws-card-title">${escapeHtml(win.title)}</span></div>
          <div class="ws-card-body" style="color:#666">${escapeHtml(win.panelType || 'panel')}</div>
        `
        card.addEventListener('click', () => {
          if (card.dataset.skipNextClick) { delete card.dataset.skipNextClick; return }
          openPanelDetail(win)
        })
      }

      canvas.appendChild(card)
      attachCardDragAndResize(card, win)
    }

    applyCanvasTransform()
  }

  // Attach drag-to-move (on chrome) and resize (bottom-right corner) to a workshop card.
  // Changes apply locally first for instant feedback; server push only fires on release,
  // so the desktop round-trip confirms via the next workshop state poll.
  function attachCardDragAndResize(card, win) {
    const chrome = card.querySelector('.ws-card-chrome')
    if (chrome) {
      let dragState = null

      const startDrag = (clientX, clientY) => {
        dragState = {
          startX: clientX, startY: clientY,
          origX: win.x, origY: win.y,
          latestX: win.x, latestY: win.y
        }
      }
      const moveDrag = (clientX, clientY) => {
        if (!dragState) return
        const dx = (clientX - dragState.startX) / workshopTouchState.zoom
        const dy = (clientY - dragState.startY) / workshopTouchState.zoom
        dragState.latestX = dragState.origX + dx
        dragState.latestY = dragState.origY + dy
        card.style.left = dragState.latestX + 'px'
        card.style.top = dragState.latestY + 'px'
      }
      const endDrag = () => {
        if (!dragState) return
        const moved = Math.abs(dragState.latestX - dragState.origX) > 3 ||
                      Math.abs(dragState.latestY - dragState.origY) > 3
        if (moved) {
          pushWindowUpdate(win.id, { x: Math.round(dragState.latestX), y: Math.round(dragState.latestY) })
          card.dataset.skipNextClick = '1'
        }
        dragState = null
      }

      chrome.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return
        e.stopPropagation()
        startDrag(e.touches[0].clientX, e.touches[0].clientY)
      }, { passive: true })
      chrome.addEventListener('touchmove', (e) => {
        if (!dragState || e.touches.length !== 1) return
        e.preventDefault()
        moveDrag(e.touches[0].clientX, e.touches[0].clientY)
      }, { passive: false })
      chrome.addEventListener('touchend', endDrag)

      chrome.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return
        e.stopPropagation()
        startDrag(e.clientX, e.clientY)
        const onMove = (ev) => moveDrag(ev.clientX, ev.clientY)
        const onUp = () => { endDrag(); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
      })
    }

    const resizeHandle = document.createElement('div')
    resizeHandle.className = 'ws-card-resize'
    card.appendChild(resizeHandle)

    let resizeState = null
    const startResize = (clientX, clientY) => {
      resizeState = {
        startX: clientX, startY: clientY,
        origW: win.width, origH: win.height,
        latestW: win.width, latestH: win.height
      }
    }
    const moveResize = (clientX, clientY) => {
      if (!resizeState) return
      const dw = (clientX - resizeState.startX) / workshopTouchState.zoom
      const dh = (clientY - resizeState.startY) / workshopTouchState.zoom
      resizeState.latestW = Math.max(200, resizeState.origW + dw)
      resizeState.latestH = Math.max(120, resizeState.origH + dh)
      card.style.width = resizeState.latestW + 'px'
      card.style.height = resizeState.latestH + 'px'
    }
    const endResize = () => {
      if (!resizeState) return
      const changed = Math.abs(resizeState.latestW - resizeState.origW) > 3 ||
                      Math.abs(resizeState.latestH - resizeState.origH) > 3
      if (changed) {
        pushWindowUpdate(win.id, { width: Math.round(resizeState.latestW), height: Math.round(resizeState.latestH) })
        card.dataset.skipNextClick = '1'
      }
      resizeState = null
    }

    resizeHandle.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return
      e.stopPropagation()
      startResize(e.touches[0].clientX, e.touches[0].clientY)
    }, { passive: true })
    resizeHandle.addEventListener('touchmove', (e) => {
      if (!resizeState || e.touches.length !== 1) return
      e.preventDefault()
      moveResize(e.touches[0].clientX, e.touches[0].clientY)
    }, { passive: false })
    resizeHandle.addEventListener('touchend', endResize)

    resizeHandle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return
      e.stopPropagation()
      startResize(e.clientX, e.clientY)
      const onMove = (ev) => moveResize(ev.clientX, ev.clientY)
      const onUp = () => { endResize(); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    })
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

    // Mouse wheel zoom — anchored on cursor position so zooming feels natural
    vp.addEventListener('wheel', (e) => {
      e.preventDefault()
      const rect = vp.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      // Translate cursor position into canvas coordinate space BEFORE zoom change
      const canvasX = (cx - workshopTouchState.panX) / workshopTouchState.zoom
      const canvasY = (cy - workshopTouchState.panY) / workshopTouchState.zoom
      const factor = e.deltaY > 0 ? 0.9 : 1.1
      const newZoom = Math.max(0.15, Math.min(2.0, workshopTouchState.zoom * factor))
      workshopTouchState.zoom = newZoom
      // Keep the cursor anchored on the same canvas point after zoom
      workshopTouchState.panX = cx - canvasX * newZoom
      workshopTouchState.panY = cy - canvasY * newZoom
      applyCanvasTransform()
    }, { passive: false })

    // Mouse drag pan — click anywhere on the canvas background (not on a card)
    let isMouseDragging = false
    let mouseStartX = 0, mouseStartY = 0, mouseStartPanX = 0, mouseStartPanY = 0

    vp.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return  // primary button only
      if (e.target.closest('.ws-card')) return  // let cards handle their own clicks
      isMouseDragging = true
      mouseStartX = e.clientX
      mouseStartY = e.clientY
      mouseStartPanX = workshopTouchState.panX
      mouseStartPanY = workshopTouchState.panY
      vp.style.cursor = 'grabbing'
      e.preventDefault()
    })

    // mousemove + mouseup on window (not viewport) so drag continues off-viewport
    const onMouseMove = (e) => {
      if (!isMouseDragging) return
      workshopTouchState.panX = mouseStartPanX + (e.clientX - mouseStartX)
      workshopTouchState.panY = mouseStartPanY + (e.clientY - mouseStartY)
      applyCanvasTransform()
    }
    const onMouseUp = () => {
      if (!isMouseDragging) return
      isMouseDragging = false
      vp.style.cursor = ''
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
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

    // Live stream new PTY chunks via WS. Polling stays as a backstop so a
    // dropped WS still gets the next 5s tick. New chunks land at the bottom
    // of the existing buffer; we keep the polling renderer authoritative on
    // line breaks and scrollback — WS adds latency reduction, not extra UI.
    if (window.__cogWs) {
      window.__cogWs.subscribeAgentOutput(agent.id, (chunk) => {
        const el = $('detail-output')
        // Strip ANSI so we don't paint escape sequences onto the screen.
        const text = stripAnsi(chunk)
        if (!text) return
        const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        el.textContent += text
        if (wasAtBottom) el.scrollTop = el.scrollHeight
      })
    }
  }

  function closeAgentDetail() {
    if (currentDetailAgent && window.__cogWs) {
      window.__cogWs.unsubscribeAgentOutput(currentDetailAgent.id)
    }
    currentDetailAgent = null
    $('workshop-detail').classList.add('hidden')
    $('workshop-view').classList.remove('hidden')
    if (detailPollHandle) { clearInterval(detailPollHandle); detailPollHandle = null }
  }

  // Panel detail views (pinboard, info, inbox, trollbox)
  function openPanelDetail(win) {
    const panelType = (win.panelType || win.title || '').toLowerCase()
    $('workshop-view').classList.add('hidden')
    $('workshop-panel').classList.remove('hidden')
    $('panel-title').textContent = win.title || panelType

    if (panelPollHandle) { clearInterval(panelPollHandle); panelPollHandle = null }

    const content = $('panel-content')
    if (panelType.includes('pinboard')) {
      renderPanelPinboard(content)
    } else if (panelType.includes('info')) {
      renderPanelInfo(content)
    } else if (panelType.includes('schedule')) {
      renderPanelSchedules(content)
    } else if (panelType.includes('inbox')) {
      renderPanelInbox(content)
      panelPollHandle = setInterval(() => renderPanelInbox(content), 5000)
    } else if (panelType.includes('trollbox')) {
      renderPanelTrollbox(content)
      panelPollHandle = setInterval(() => renderPanelTrollbox(content), 3000)
    } else {
      content.innerHTML = '<div style="color:#666;padding:20px;text-align:center">Panel view not available</div>'
    }
  }

  function closePanelDetail() {
    $('workshop-panel').classList.add('hidden')
    $('workshop-view').classList.remove('hidden')
    if (panelPollHandle) { clearInterval(panelPollHandle); panelPollHandle = null }
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

  // Message ids whose card is in a live user interaction (reject input
  // revealed, or an approve/reject in flight). While this set is non-empty,
  // the inbox poll skips its repaint so we don't wipe a user's typed feedback.
  const inboxInteractionLocks = new Set()

  function relativeTime(iso) {
    if (!iso) return ''
    const ms = Date.now() - new Date(iso).getTime()
    if (!isFinite(ms) || ms < 0) return 'just now'
    const sec = Math.floor(ms / 1000)
    if (sec < 30) return 'just now'
    if (sec < 60) return `${sec}s ago`
    const min = Math.floor(sec / 60)
    if (min < 60) return `${min}m ago`
    const hr = Math.floor(min / 60)
    if (hr < 24) return `${hr}h ago`
    return `${Math.floor(hr / 24)}d ago`
  }

  function priorityClass(p) {
    if (p === 'urgent' || p === 'high') return 'high'
    if (p === 'low') return 'low'
    return 'medium'
  }

  function priorityLabel(p) {
    if (p === 'urgent') return 'URGENT'
    if (p === 'high') return 'HIGH'
    if (p === 'low') return 'LOW'
    return 'NORM'
  }

  async function renderPanelInbox(container) {
    // Skip repaint mid-interaction to preserve typed reject feedback / button state.
    if (inboxInteractionLocks.size > 0) return

    let data
    try {
      const res = await fetch(`${BASE}/inbox`)
      if (!res.ok) {
        container.innerHTML = '<div style="color:#666;padding:20px;text-align:center">Inbox unavailable</div>'
        return
      }
      data = await res.json()
    } catch {
      // Silent — next poll retries.
      return
    }

    const messages = data.messages || []
    const unread = data.unread || 0
    syncInboxBadges(unread)
    $('panel-title').textContent = `📬 Inbox · ${unread} unread`

    if (messages.length === 0) {
      container.innerHTML = '<div style="color:#666;padding:30px 20px;text-align:center;font-style:italic">No messages.</div>'
      return
    }

    const renderProposalAgents = (list) =>
      (list || []).map(a => `<li>${escapeHtml(a.name)} <span style="color:#888">(${escapeHtml(a.cli)} · ${escapeHtml(a.role)})</span></li>`).join('')

    container.innerHTML = `
      <div style="padding:8px;">
        ${unread > 0 ? '<div class="inbox-header"><span class="inbox-unread-count">' + unread + ' unread</span><button class="inbox-read-all" id="inbox-read-all">Read all</button></div>' : ''}
        ${messages.map(m => {
          const isUnread = !m.readAt
          const pCls = priorityClass(m.priority)
          const isProposal = !!m.proposalId
          const status = (m.proposalStatus || '').toLowerCase()
          const proposalResolved = isProposal && status && status !== 'pending'
          return `
            <div class="inbox-card ${isUnread ? 'unread' : ''}" data-msg-id="${escapeHtml(m.id)}" data-proposal-id="${escapeHtml(m.proposalId || '')}" data-agent-name="${escapeHtml(m.agentName)}">
              <div class="inbox-card-top">
                <span class="inbox-priority ${pCls}">${priorityLabel(m.priority)}</span>
                <span class="inbox-sender">${escapeHtml(m.agentName)}</span>
                <span class="inbox-time">${escapeHtml(relativeTime(m.createdAt))}</span>
              </div>
              <div class="inbox-body">${escapeHtml(m.message)}</div>
              ${isProposal ? `
                <div class="inbox-proposal">
                  ${m.proposalSummary ? `<div class="inbox-proposal-summary">${escapeHtml(m.proposalSummary)}</div>` : ''}
                  <div class="inbox-proposal-label">Proposed team</div>
                  <ul class="inbox-proposal-agents">${renderProposalAgents(m.proposalAgents)}</ul>
                  <div class="inbox-actions" data-state="${proposalResolved ? 'resolved' : 'pending'}">
                    ${proposalResolved
                      ? `<span class="inbox-action-resolved">Already ${escapeHtml(status)}</span>`
                      : `<button class="inbox-action-btn approve" data-action="approve">Approve</button>
                         <button class="inbox-action-btn reject" data-action="reject">Reject</button>`}
                  </div>
                </div>
              ` : ''}
              <div class="inbox-reply-slot"></div>
              <div class="inbox-card-actions">
                <button class="inbox-action-btn reply" data-action="reply">Reply</button>
              </div>
              <div class="inbox-footer"></div>
            </div>
          `
        }).join('')}
      </div>
    `

    // Wire up tap-to-read for unread non-proposal cards (proposals stay
    // visually unread until resolved; tapping the body marks them read too).
    container.querySelectorAll('.inbox-card').forEach(card => {
      const msgId = card.dataset.msgId
      const proposalId = card.dataset.proposalId || undefined

      card.addEventListener('click', async (e) => {
        // Don't fire on button clicks or reject-input clicks.
        if (e.target.closest('button') || e.target.closest('input')) return
        if (!card.classList.contains('unread')) return
        card.classList.remove('unread')
        try {
          await fetch(`${BASE}/inbox/${encodeURIComponent(msgId)}/read`, { method: 'POST' })
        } catch { /* will retry on next poll via re-render */ }
      })

      const approveBtn = card.querySelector('.inbox-action-btn.approve')
      const rejectBtn = card.querySelector('.inbox-action-btn.reject')
      const actionsRow = card.querySelector('.inbox-actions')
      const footer = card.querySelector('.inbox-footer')

      if (approveBtn) {
        approveBtn.addEventListener('click', async () => {
          inboxInteractionLocks.add(msgId)
          approveBtn.disabled = true
          if (rejectBtn) rejectBtn.disabled = true
          actionsRow.innerHTML = '<span class="inbox-action-resolved">Approved · spawning…</span>'
          try {
            const res = await fetch(`${BASE}/inbox/${encodeURIComponent(msgId)}/respond`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'approve', proposalId })
            })
            const result = await res.json().catch(() => ({}))
            if (res.ok && result.success !== false) {
              const n = result.spawned ?? (result.spawned === 0 ? 0 : '')
              footer.textContent = `Spawned ${n} agent${n === 1 ? '' : 's'}`
              card.classList.add('inbox-card-dim')
              card.classList.remove('unread')
            } else {
              actionsRow.innerHTML = `<button class="inbox-action-btn approve" data-action="approve">Approve</button><button class="inbox-action-btn reject" data-action="reject">Reject</button>`
              footer.innerHTML = `<span class="inbox-error">${escapeHtml(result.error || 'Approve failed')}</span>`
            }
          } catch {
            actionsRow.innerHTML = `<button class="inbox-action-btn approve" data-action="approve">Approve</button><button class="inbox-action-btn reject" data-action="reject">Reject</button>`
            footer.innerHTML = `<span class="inbox-error">Network error</span>`
          } finally {
            inboxInteractionLocks.delete(msgId)
          }
        })
      }

      if (rejectBtn) {
        rejectBtn.addEventListener('click', () => {
          inboxInteractionLocks.add(msgId)
          actionsRow.innerHTML = `
            <input type="text" class="inbox-reject-input" placeholder="Why? (optional)" />
            <button class="inbox-action-btn reject-send">Send</button>
            <button class="inbox-action-btn reject-cancel">×</button>
          `
          const input = actionsRow.querySelector('.inbox-reject-input')
          const sendBtn = actionsRow.querySelector('.reject-send')
          const cancelBtn = actionsRow.querySelector('.reject-cancel')
          setTimeout(() => input.focus(), 50)

          cancelBtn.addEventListener('click', () => {
            actionsRow.innerHTML = `<button class="inbox-action-btn approve" data-action="approve">Approve</button><button class="inbox-action-btn reject" data-action="reject">Reject</button>`
            inboxInteractionLocks.delete(msgId)
            // Re-wire by re-rendering next poll; for snappier response trigger now:
            renderPanelInbox(container)
          })

          const doSend = async () => {
            const feedback = input.value
            sendBtn.disabled = true
            cancelBtn.disabled = true
            input.disabled = true
            try {
              const res = await fetch(`${BASE}/inbox/${encodeURIComponent(msgId)}/respond`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'reject', feedback, proposalId })
              })
              const result = await res.json().catch(() => ({}))
              if (res.ok && result.success !== false) {
                actionsRow.innerHTML = '<span class="inbox-action-resolved">Rejected</span>'
                footer.textContent = ''
                card.classList.add('inbox-card-dim')
                card.classList.remove('unread')
              } else {
                actionsRow.innerHTML = `<button class="inbox-action-btn approve" data-action="approve">Approve</button><button class="inbox-action-btn reject" data-action="reject">Reject</button>`
                footer.innerHTML = `<span class="inbox-error">${escapeHtml(result.error || 'Reject failed')}</span>`
              }
            } catch {
              actionsRow.innerHTML = `<button class="inbox-action-btn approve" data-action="approve">Approve</button><button class="inbox-action-btn reject" data-action="reject">Reject</button>`
              footer.innerHTML = `<span class="inbox-error">Network error</span>`
            } finally {
              inboxInteractionLocks.delete(msgId)
            }
          }

          sendBtn.addEventListener('click', doSend)
          input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSend() })
        })
      }

      // Free-form reply — mirrors the desktop InboxPanel's Reply button.
      // Lives in its own slot below the proposal block (if any) so the
      // approve/reject row stays untouched.
      const replyBtn = card.querySelector('.inbox-action-btn.reply')
      const replySlot = card.querySelector('.inbox-reply-slot')
      const replyActions = card.querySelector('.inbox-card-actions')
      const agentName = card.dataset.agentName || ''
      if (replyBtn && replySlot && replyActions && agentName) {
        replyBtn.addEventListener('click', () => {
          inboxInteractionLocks.add(msgId)
          replyActions.style.display = 'none'
          replySlot.innerHTML = `
            <textarea class="inbox-reply-input" placeholder="Reply to ${escapeHtml(agentName)}…" rows="3"></textarea>
            <div class="inbox-reply-buttons">
              <button class="inbox-action-btn reply-cancel">Cancel</button>
              <button class="inbox-action-btn reply-send" disabled>Send</button>
            </div>
          `
          const input = replySlot.querySelector('.inbox-reply-input')
          const sendBtn = replySlot.querySelector('.reply-send')
          const cancelBtn = replySlot.querySelector('.reply-cancel')
          setTimeout(() => input.focus(), 50)

          const restoreClosed = () => {
            replySlot.innerHTML = ''
            replyActions.style.display = ''
            inboxInteractionLocks.delete(msgId)
          }

          input.addEventListener('input', () => {
            sendBtn.disabled = !input.value.trim()
          })

          cancelBtn.addEventListener('click', restoreClosed)

          const doSend = async () => {
            const text = input.value.trim()
            if (!text) return
            sendBtn.disabled = true
            cancelBtn.disabled = true
            input.disabled = true
            try {
              const res = await fetch(`${BASE}/inbox/${encodeURIComponent(msgId)}/reply`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: text })
              })
              const result = await res.json().catch(() => ({}))
              if (res.ok && result.success !== false) {
                replySlot.innerHTML = '<span class="inbox-action-resolved">Reply sent</span>'
                footer.textContent = ''
                card.classList.remove('unread')
                inboxInteractionLocks.delete(msgId)
              } else {
                input.disabled = false
                cancelBtn.disabled = false
                sendBtn.disabled = false
                footer.innerHTML = `<span class="inbox-error">${escapeHtml(result.error || 'Reply failed')}</span>`
              }
            } catch {
              input.disabled = false
              cancelBtn.disabled = false
              sendBtn.disabled = false
              footer.innerHTML = '<span class="inbox-error">Network error</span>'
            }
          }

          sendBtn.addEventListener('click', doSend)
          input.addEventListener('keydown', (e) => {
            // Ctrl/Cmd+Enter to send; plain Enter inserts a newline as normal.
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              doSend()
            }
          })
        })
      }
    })

    const readAllBtn = document.getElementById('inbox-read-all')
    if (readAllBtn) {
      readAllBtn.addEventListener('click', async () => {
        const unreadCards = container.querySelectorAll('.inbox-card.unread')
        readAllBtn.disabled = true
        const ids = []
        unreadCards.forEach(c => { ids.push(c.dataset.msgId); c.classList.remove('unread') })
        // No bulk endpoint on the remote server today — loop one-by-one
        // (capped at ~20 cards by the policy of the inbox API).
        await Promise.all(ids.map(id =>
          fetch(`${BASE}/inbox/${encodeURIComponent(id)}/read`, { method: 'POST' }).catch(() => null)
        ))
      })
    }
  }

  async function renderPanelTrollbox(container) {
    let data
    try {
      const res = await fetch(`${BASE}/trollbox`)
      if (res.status === 403) {
        $('panel-title').textContent = '💬 Trollbox'
        container.innerHTML = '<div class="trollbox-empty">Workshop session expired — re-enter the passcode.</div>'
        return
      }
      if (!res.ok) {
        $('panel-title').textContent = '💬 Trollbox'
        container.innerHTML = '<div class="trollbox-empty">Trollbox unavailable</div>'
        return
      }
      data = await res.json()
    } catch {
      return
    }

    if (!data || data.status === 'offline') {
      $('panel-title').textContent = '💬 Trollbox (offline)'
      container.innerHTML = `<div class="trollbox-empty">${escapeHtml(data && data.hint || 'Trollbox not available — desktop hasn\'t opened it yet.')}</div>`
      return
    }

    const messages = data.messages || []
    const onlineCount = data.onlineCount || 0
    const pauseActive = data.pauseUntil && data.pauseUntil > Date.now()
    const pauseReason = data.pauseReason || ''

    // Pin-to-bottom: only auto-scroll if user is already near the bottom, so
    // a user scrolled up to read history doesn't get yanked away.
    const pinned = container.scrollHeight - container.scrollTop - container.clientHeight < 30
    const wasEmpty = container.querySelectorAll('.trollbox-line').length === 0

    const fmtTime = (ts) => {
      const d = new Date(ts)
      const hh = String(d.getHours()).padStart(2, '0')
      const mm = String(d.getMinutes()).padStart(2, '0')
      return `${hh}:${mm}`
    }

    $('panel-title').textContent = `💬 Trollbox · ${onlineCount} online · 🔴 read-only`

    container.innerHTML = `
      <div class="trollbox-list">
        ${messages.length === 0
          ? '<div class="trollbox-empty">No messages yet.</div>'
          : messages.map(m => `
              <div class="trollbox-line">
                <span class="trollbox-nick">${escapeHtml(m.nick)}</span>
                <span class="trollbox-ts">${escapeHtml(fmtTime(m.ts))}</span>
                <span class="trollbox-text">${escapeHtml(m.text)}</span>
              </div>
            `).join('')}
        ${pauseActive ? `<div class="trollbox-pause">─── paused — ${escapeHtml(pauseReason || 'no reason given')} ────</div>` : ''}
      </div>
    `

    if (pinned || wasEmpty) {
      container.scrollTop = container.scrollHeight
    }
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

  // CLI → valid models mapping (mirrors src/renderer/components/SpawnDialog.tsx).
  // Values MUST match exactly what each CLI expects — typos silently fail.
  const SPAWN_CLI_MODELS = {
    claude: [
      { label: 'Sonnet', value: 'sonnet' },
      { label: 'Opus', value: 'opus' },
      { label: 'Haiku', value: 'haiku' },
      { label: 'Opus [1M context]', value: 'opus[1m]' },
      { label: 'Sonnet [1M context]', value: 'sonnet[1m]' },
      { label: 'Default (no --model flag)', value: '' }
    ],
    codex: [
      { label: 'o4-mini (default)', value: '' },
      { label: 'GPT-5.4', value: 'gpt-5.4' },
      { label: 'GPT-5', value: 'gpt-5' },
      { label: 'o3', value: 'o3' },
      { label: 'o3-pro', value: 'o3-pro' },
      { label: 'GPT-4.1', value: 'gpt-4.1' },
      { label: 'GPT-4.1 mini', value: 'gpt-4.1-mini' }
    ],
    kimi: [
      { label: 'Default', value: '' },
      { label: 'Kimi K2.5', value: 'kimi-k2.5' },
      { label: 'Kimi K2 Thinking Turbo', value: 'kimi-k2-thinking-turbo' },
      { label: 'Moonshot v1 8K', value: 'moonshot-v1-8k' }
    ],
    gemini: [
      { label: 'Default', value: '' },
      { label: 'Gemini 2.5 Pro', value: 'gemini-2.5-pro' },
      { label: 'Gemini 2.5 Flash', value: 'gemini-2.5-flash' },
      { label: 'Gemini 2.0 Flash', value: 'gemini-2.0-flash' },
      { label: 'Gemini 2.0 Flash Thinking', value: 'gemini-2.0-flash-thinking' }
    ],
    openclaude: [
      { label: 'GPT-5.4', value: 'gpt-5.4' },
      { label: 'GPT-5', value: 'gpt-5' },
      { label: 'GPT-4o', value: 'gpt-4o' },
      { label: 'GPT-4.1', value: 'gpt-4.1' },
      { label: 'GPT-4.1 mini', value: 'gpt-4.1-mini' },
      { label: 'o3', value: 'o3' },
      { label: 'o3-pro', value: 'o3-pro' },
      { label: 'o4-mini', value: 'o4-mini' },
      { label: 'Gemini 2.5 Pro', value: 'gemini-2.5-pro' },
      { label: 'Gemini 2.5 Flash', value: 'gemini-2.5-flash' },
      { label: 'DeepSeek V3', value: 'deepseek-chat' },
      { label: 'DeepSeek R1', value: 'deepseek-reasoner' },
      { label: 'Llama 4 Scout (Ollama)', value: 'llama4-scout' },
      { label: 'Llama 4 Maverick (Ollama)', value: 'llama4-maverick' },
      { label: 'Llama 3.3 70B (Ollama)', value: 'llama3.3' },
      { label: 'Llama 3.1 8B (Ollama)', value: 'llama3.1:8b' },
      { label: 'Mistral Large', value: 'mistral-large-latest' },
      { label: 'Codestral', value: 'codestral-latest' },
      { label: 'Qwen 3 (Ollama)', value: 'qwen3' },
      { label: 'Qwen 2.5 Coder (Ollama)', value: 'qwen2.5-coder' }
    ],
    copilot: [
      { label: 'Default (Copilot model)', value: '' },
      { label: 'GPT-5.4', value: 'gpt-5.4' },
      { label: 'GPT-5', value: 'gpt-5' },
      { label: 'GPT-4o', value: 'gpt-4o' },
      { label: 'o3', value: 'o3' },
      { label: 'o4-mini', value: 'o4-mini' }
    ],
    grok: [
      { label: 'Default', value: '' },
      { label: 'Grok 3', value: 'grok-3' },
      { label: 'Grok 3 Mini', value: 'grok-3-mini' },
      { label: 'Grok 2', value: 'grok-2' }
    ],
    terminal: [
      { label: 'N/A (plain shell)', value: '' }
    ]
  }

  function updateSpawnModelOptions() {
    const cli = $('spawn-cli').value
    const models = SPAWN_CLI_MODELS[cli] || [{ label: 'Default', value: '' }]
    const select = $('spawn-model')
    select.innerHTML = models.map(m =>
      `<option value="${escapeHtml(m.value)}">${escapeHtml(m.label)}</option>`
    ).join('')
    // If CLI is terminal, disable the model select (no model concept)
    select.disabled = cli === 'terminal'
  }

  $('spawn-cli').addEventListener('change', updateSpawnModelOptions)

  // Workshop spawn agent dialog
  $('workshop-spawn-btn').addEventListener('click', () => {
    $('workshop-view').classList.add('hidden')
    $('workshop-spawn').classList.remove('hidden')
    $('spawn-name').value = ''
    $('spawn-ceo-notes').value = ''
    $('spawn-error').textContent = ''
    $('spawn-auto').checked = true
    $('spawn-role').value = 'worker'
    $('spawn-cli').value = 'claude'
    updateSpawnModelOptions()
    setTimeout(() => $('spawn-name').focus(), 100)
  })

  $('spawn-cancel').addEventListener('click', () => {
    $('workshop-spawn').classList.add('hidden')
    $('workshop-view').classList.remove('hidden')
  })

  $('spawn-submit').addEventListener('click', async () => {
    const name = $('spawn-name').value.trim()
    const cli = $('spawn-cli').value
    const model = $('spawn-model').value
    const role = $('spawn-role').value
    const ceoNotes = $('spawn-ceo-notes').value.trim()
    const autoMode = $('spawn-auto').checked

    if (!name) { $('spawn-error').textContent = 'Name is required'; return }
    if (!cli) { $('spawn-error').textContent = 'CLI is required'; return }

    $('spawn-error').textContent = ''
    const btn = $('spawn-submit')
    btn.disabled = true
    btn.textContent = '...'

    try {
      const res = await fetch(`${BASE}/workshop/spawn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, cli, model: model || undefined, role, ceoNotes, autoMode })
      })
      const data = await res.json()
      if (res.ok && data.ok) {
        statusMessage(`Spawned ${name}`, 'success')
        $('workshop-spawn').classList.add('hidden')
        $('workshop-view').classList.remove('hidden')
        fetchWorkshopState()
      } else {
        $('spawn-error').textContent = data.error || 'Spawn failed'
      }
    } catch {
      $('spawn-error').textContent = 'Network error'
    } finally {
      btn.disabled = false
      btn.textContent = 'Spawn'
    }
  })

  // Workshop panels menu
  $('workshop-panels-btn').addEventListener('click', () => {
    $('workshop-view').classList.add('hidden')
    $('workshop-panels').classList.remove('hidden')
  })

  $('panels-cancel').addEventListener('click', () => {
    $('workshop-panels').classList.add('hidden')
    $('workshop-view').classList.remove('hidden')
  })

  document.querySelectorAll('.panel-item').forEach(btn => {
    btn.addEventListener('click', async () => {
      const panel = btn.dataset.panel
      // Inbox + Trollbox render directly on the phone — no desktop toggle.
      if (btn.dataset.mobileView === '1') {
        $('workshop-panels').classList.add('hidden')
        openPanelDetail({
          panelType: panel,
          title: panel === 'inbox' ? '📬 Inbox' : '💬 Trollbox'
        })
        return
      }
      try {
        const res = await fetch(`${BASE}/workshop/panel/${encodeURIComponent(panel)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'toggle' })
        })
        if (res.ok) {
          statusMessage(`Toggled ${panel}`, 'success')
          $('workshop-panels').classList.add('hidden')
          $('workshop-view').classList.remove('hidden')
          fetchWorkshopState()
        } else {
          statusMessage('Panel toggle failed', 'error')
        }
      } catch {
        statusMessage('Network error', 'error')
      }
    })
  })

  // Initial start
  startPolling()
})()
