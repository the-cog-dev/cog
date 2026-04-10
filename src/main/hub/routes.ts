import { Router, type Request, type Response } from 'express'
import * as fs from 'fs'
import * as path from 'path'
import type { AgentRegistry } from './agent-registry'
import type { MessageRouter } from './message-router'
import type { Pinboard } from './pinboard'
import type { InfoChannel } from './info-channel'
import type { BuddyRoom } from './buddy-room'
import type { GroupManager } from './group-manager'
import type { AgentConfig } from '../../shared/types'
import type { MessageStore } from '../db/message-store'

export type OutputAccessor = (agentName: string, lines: number) => string[] | null

export function createRoutes(
  registry: AgentRegistry,
  messages: MessageRouter,
  outputRef: { accessor: OutputAccessor | null },
  pinboard: Pinboard,
  infoChannel: InfoChannel,
  messageStoreRef: { store: MessageStore | null } = { store: null },
  buddyRoom?: BuddyRoom,
  projectPathRef: { path: string | null } = { path: null },
  groupManager?: GroupManager
): Router {
  const router = Router()

  router.get('/agents', (_req: Request, res: Response) => {
    // Filter out the virtual "user" agent — it's internal for R.A.C. message routing
    const agents = registry.list().filter(a => a.name !== 'user').map(({ ceoNotes, ...rest }) => ({
      ...rest,
      healthy: registry.isHealthy(rest.name)
    }))
    res.json(agents)
  })

  router.post('/agents/register', (req: Request, res: Response) => {
    try {
      const config: AgentConfig = req.body
      if (!config.name || typeof config.name !== 'string' || config.name.length > 100) {
        res.status(400).json({ error: 'Invalid agent name' })
        return
      }
      if (config.promptRegex && config.promptRegex.length > 200) {
        res.status(400).json({ error: 'promptRegex too long' })
        return
      }
      const state = registry.register(config)
      res.json(state)
    } catch (err: any) {
      res.status(400).json({ error: 'Registration failed' })
    }
  })

  router.get('/agents/:name/ceo-notes', (req: Request, res: Response) => {
    const agent = registry.get(req.params.name)
    if (!agent) {
      res.status(404).json({ error: `Agent '${req.params.name}' not found` })
      return
    }
    res.json({ name: agent.name, ceoNotes: agent.ceoNotes, role: agent.role })
  })

  router.post('/agents/:name/heartbeat', (req: Request, res: Response) => {
    const agent = registry.get(req.params.name)
    if (!agent) {
      res.status(404).json({ error: `Agent '${req.params.name}' not found` })
      return
    }
    registry.recordHeartbeat(req.params.name)
    res.json({ status: 'ok' })
  })

  router.post('/agents/:name/status', (req: Request, res: Response) => {
    const { status } = req.body
    const validStatuses = ['idle', 'active', 'working']
    if (!status || !validStatuses.includes(status)) {
      res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` })
      return
    }
    const agent = registry.get(req.params.name)
    if (!agent) {
      res.status(404).json({ error: `Agent '${req.params.name}' not found` })
      return
    }
    registry.updateStatus(req.params.name, status)
    res.json({ status: 'ok', agentStatus: status })
  })

  router.post('/messages/send', (req: Request, res: Response) => {
    const { from, to, message } = req.body
    const result = messages.send(from, to, message)
    res.json(result)
  })

  router.post('/messages/broadcast', (req: Request, res: Response) => {
    const { from, message } = req.body
    const result = messages.broadcast(from, message)
    res.json(result)
  })

  router.get('/messages/:name', (req: Request, res: Response) => {
    const peek = req.query.peek === 'true'
    const msgs = messages.getMessages(req.params.name, peek)
    res.json(msgs)
  })

  router.post('/messages/:name/ack', (req: Request, res: Response) => {
    const { messageIds } = req.body
    if (!Array.isArray(messageIds)) {
      res.status(400).json({ error: 'messageIds array is required' })
      return
    }
    const acked = messages.ackMessages(req.params.name, messageIds)
    res.json({ acknowledged: acked })
  })

  // --- Pinboard routes ---

  router.post('/pinboard/tasks', (req: Request, res: Response) => {
    const { title, description, priority, from, targetRole, tabId, targetAgent } = req.body
    if (!title || !description) {
      res.status(400).json({ error: 'title and description are required' })
      return
    }
    const task = pinboard.postTask(title, description, priority, from, undefined, targetRole, tabId, targetAgent)
    res.json({ id: task.id, title: task.title, createdBy: task.createdBy, targetRole: task.targetRole, targetAgent: task.targetAgent })
  })

  router.get('/pinboard/tasks', (req: Request, res: Response) => {
    const tabId = (req.query.tabId as string) || null
    res.json(pinboard.readTasksForTab(tabId))
  })

  router.post('/pinboard/tasks/:id/claim', (req: Request, res: Response) => {
    const { from } = req.body
    // Look up the claiming agent's tabId for tab isolation enforcement
    const agent = registry.get(from)
    const agentTabId = agent?.tabId
    const result = pinboard.claimTask(req.params.id, from, agentTabId)
    if (result.status === 'error') {
      res.status(409).json(result)
      return
    }
    res.json(result)
  })

  router.post('/pinboard/tasks/:id/complete', (req: Request, res: Response) => {
    const { from, result } = req.body
    const outcome = pinboard.completeTask(req.params.id, from, result)
    if (outcome.status === 'error') {
      res.status(409).json(outcome)
      return
    }
    res.json(outcome)
  })

  router.post('/pinboard/tasks/:id/abandon', (req: Request, res: Response) => {
    const result = pinboard.abandonTask(req.params.id)
    if (result.status === 'error') {
      res.status(409).json(result)
      return
    }
    res.json(result)
  })

  router.post('/pinboard/clear-completed', (req: Request, res: Response) => {
    const tabId = (req.body.tabId as string) || null
    const cleared = pinboard.clearCompleted(tabId)
    res.json({ status: 'ok', cleared })
  })

  router.get('/pinboard/tasks/:id', (req: Request, res: Response) => {
    const task = pinboard.getTask(req.params.id)
    if (!task) {
      res.status(404).json({ error: `Task '${req.params.id}' not found` })
      return
    }
    res.json(task)
  })

  // --- Message History route ---

  router.get('/messages/history', (req: Request, res: Response) => {
    if (!messageStoreRef.store) {
      res.status(503).json({ error: 'Message history not available' })
      return
    }
    const agent = req.query.agent as string | undefined
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500)
    const history = messageStoreRef.store.getMessageHistory(agent, limit)
    res.json(history)
  })

  // --- Info Channel routes ---

  router.post('/info', (req: Request, res: Response) => {
    try {
      const { from, note, tags, tabId } = req.body
      if (!from || !note) {
        res.status(400).json({ error: 'from and note are required' })
        return
      }
      const entry = infoChannel.postInfo(from, note, tags || [], undefined, tabId)
      res.json(entry)
    } catch (err: any) {
      res.status(400).json({ error: 'Invalid info entry' })
    }
  })

  router.get('/info', (req: Request, res: Response) => {
    const tagsParam = req.query.tags as string | undefined
    const tags = tagsParam ? tagsParam.split(',').filter(Boolean) : undefined
    const entries = infoChannel.readInfo(tags)
    res.json(entries)
  })

  router.delete('/info/:id', (req: Request, res: Response) => {
    const deleted = infoChannel.deleteInfo(req.params.id)
    if (!deleted) {
      res.status(404).json({ error: `Info entry '${req.params.id}' not found` })
      return
    }
    res.json({ status: 'ok' })
  })

  router.patch('/info/:id', (req: Request, res: Response) => {
    try {
      const { note } = req.body
      if (!note) {
        res.status(400).json({ error: 'note is required' })
        return
      }
      const entry = infoChannel.updateInfo(req.params.id, note)
      if (!entry) {
        res.status(404).json({ error: `Info entry '${req.params.id}' not found` })
        return
      }
      res.json(entry)
    } catch (err: any) {
      res.status(400).json({ error: 'Update failed' })
    }
  })

  // --- File operation routes ---

  function resolveProjectPath(requestedPath: string): string | null {
    if (!projectPathRef.path) return null
    const projectRoot = path.resolve(projectPathRef.path)
    const resolved = path.resolve(projectRoot, requestedPath)
    // Security: normalize both paths for case-insensitive Windows comparison
    const normalizedRoot = projectRoot.toLowerCase().replace(/\\/g, '/')
    const normalizedResolved = resolved.toLowerCase().replace(/\\/g, '/')
    if (!normalizedResolved.startsWith(normalizedRoot)) return null
    return resolved
  }

  router.get('/files/read', (req: Request, res: Response) => {
    const filePath = req.query.path as string
    if (!filePath) {
      res.status(400).json({ error: 'path query parameter is required' })
      return
    }
    const resolved = resolveProjectPath(filePath)
    if (!resolved) {
      res.status(403).json({ error: 'Path outside project directory' })
      return
    }
    try {
      if (!fs.existsSync(resolved)) {
        res.status(404).json({ error: `File not found: ${filePath}` })
        return
      }
      const stat = fs.statSync(resolved)
      if (stat.isDirectory()) {
        res.status(400).json({ error: 'Path is a directory, use /files/list instead' })
        return
      }
      // Limit read size to 1MB to prevent huge files from crashing
      if (stat.size > 1024 * 1024) {
        res.status(413).json({ error: `File too large (${stat.size} bytes). Max 1MB.` })
        return
      }
      const content = fs.readFileSync(resolved, 'utf-8')
      res.json({ path: filePath, content, size: stat.size })
    } catch (err: any) {
      res.status(500).json({ error: 'File operation failed' })
    }
  })

  router.post('/files/write', (req: Request, res: Response) => {
    const { path: filePath, content } = req.body
    if (!filePath || content === undefined) {
      res.status(400).json({ error: 'path and content are required' })
      return
    }
    const resolved = resolveProjectPath(filePath)
    if (!resolved) {
      res.status(403).json({ error: 'Path outside project directory' })
      return
    }
    try {
      // Ensure parent directory exists
      const dir = path.dirname(resolved)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      fs.writeFileSync(resolved, content, 'utf-8')
      const stat = fs.statSync(resolved)
      res.json({ path: filePath, size: stat.size, status: 'ok' })
    } catch (err: any) {
      res.status(500).json({ error: 'File operation failed' })
    }
  })

  router.get('/files/list', (req: Request, res: Response) => {
    const dirPath = (req.query.path as string) || '.'
    const resolved = resolveProjectPath(dirPath)
    if (!resolved) {
      res.status(403).json({ error: 'Path outside project directory' })
      return
    }
    try {
      if (!fs.existsSync(resolved)) {
        res.status(404).json({ error: `Directory not found: ${dirPath}` })
        return
      }
      const stat = fs.statSync(resolved)
      if (!stat.isDirectory()) {
        res.status(400).json({ error: 'Path is a file, use /files/read instead' })
        return
      }
      const entries = fs.readdirSync(resolved, { withFileTypes: true })
      const items = entries.map(entry => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
        path: path.join(dirPath, entry.name).replace(/\\/g, '/')
      }))
      // Sort: directories first, then files, both alphabetical
      items.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      res.json({ path: dirPath, items })
    } catch (err: any) {
      res.status(500).json({ error: 'File operation failed' })
    }
  })

  // --- Buddy Room route ---

  router.get('/buddy-room', (req: Request, res: Response) => {
    if (!buddyRoom) {
      res.json([])
      return
    }
    const count = Math.min(Math.max(Number(req.query.count) || 50, 1), 200)
    res.json(buddyRoom.getMessages(count))
  })

  // --- Group routes ---

  router.get('/groups', (_req: Request, res: Response) => {
    if (!groupManager) { res.json([]); return }
    res.json(groupManager.getGroups())
  })

  router.get('/groups/links', (_req: Request, res: Response) => {
    if (!groupManager) { res.json([]); return }
    res.json(groupManager.getLinks())
  })

  router.post('/groups/link', (req: Request, res: Response) => {
    if (!groupManager) { res.status(503).json({ error: 'Groups not available' }); return }
    const { from, to } = req.body
    if (!from || !to) { res.status(400).json({ error: 'from and to required' }); return }
    groupManager.addLink(from, to)
    res.json({ status: 'ok', groups: groupManager.getGroups() })
  })

  router.delete('/groups/link', (req: Request, res: Response) => {
    if (!groupManager) { res.status(503).json({ error: 'Groups not available' }); return }
    const { from, to } = req.body
    if (!from || !to) { res.status(400).json({ error: 'from and to required' }); return }
    groupManager.removeLink(from, to)
    res.json({ status: 'ok', groups: groupManager.getGroups() })
  })

  // --- Output route ---

  router.get('/agents/:name/output', (req: Request, res: Response) => {
    const agent = registry.get(req.params.name)
    if (!agent) {
      res.status(404).json({ error: `Agent '${req.params.name}' not found` })
      return
    }
    if (!outputRef.accessor) {
      res.status(503).json({ error: 'Output not available' })
      return
    }
    const lines = Math.min(Math.max(Number(req.query.lines) || 50, 1), 1000)
    const output = outputRef.accessor(req.params.name, lines)
    if (!output) {
      res.status(404).json({ error: `No output buffer for agent '${req.params.name}'` })
      return
    }
    res.json({ lines: output, count: output.length })
  })

  return router
}
