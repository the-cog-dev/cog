import { Router, type Request, type Response } from 'express'
import type { AgentRegistry } from './agent-registry'
import type { MessageRouter } from './message-router'
import type { Pinboard } from './pinboard'
import type { InfoChannel } from './info-channel'
import type { BuddyRoom } from './buddy-room'
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
  buddyRoom?: BuddyRoom
): Router {
  const router = Router()

  router.get('/agents', (_req: Request, res: Response) => {
    const agents = registry.list().map(({ ceoNotes, ...rest }) => ({
      ...rest,
      healthy: registry.isHealthy(rest.name)
    }))
    res.json(agents)
  })

  router.post('/agents/register', (req: Request, res: Response) => {
    try {
      const config: AgentConfig = req.body
      const state = registry.register(config)
      res.json(state)
    } catch (err: any) {
      res.status(400).json({ error: err.message })
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
    const { title, description, priority, from } = req.body
    if (!title || !description) {
      res.status(400).json({ error: 'title and description are required' })
      return
    }
    const task = pinboard.postTask(title, description, priority, from)
    res.json({ id: task.id, title: task.title, createdBy: task.createdBy })
  })

  router.get('/pinboard/tasks', (_req: Request, res: Response) => {
    res.json(pinboard.readTasks())
  })

  router.post('/pinboard/tasks/:id/claim', (req: Request, res: Response) => {
    const { from } = req.body
    const result = pinboard.claimTask(req.params.id, from)
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
      const { from, note, tags } = req.body
      if (!from || !note) {
        res.status(400).json({ error: 'from and note are required' })
        return
      }
      const entry = infoChannel.postInfo(from, note, tags || [])
      res.json(entry)
    } catch (err: any) {
      res.status(400).json({ error: err.message })
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
      res.status(400).json({ error: err.message })
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
