import { v4 as uuid } from 'uuid'
import type { Message, SendMessageResult, BroadcastResult } from '../../shared/types'
import type { AgentRegistry } from './agent-registry'
import type { GroupManager } from './group-manager'
import type { AgentMetrics } from './agent-metrics'

const MAX_MESSAGE_SIZE = 10 * 1024
const MAX_QUEUE_DEPTH = 100
const RATE_LIMIT_WINDOW_MS = 60_000
const MAX_MESSAGES_PER_WINDOW = 30

export class MessageRouter {
  private queues = new Map<string, Message[]>()
  private sendTimestamps = new Map<string, number[]>()
  onMessageQueued?: (msg: Message) => void
  onMessageSaved?: (msg: Message) => void

  constructor(private registry: AgentRegistry, private groupManager?: GroupManager, private metrics?: AgentMetrics) {}

  send(from: string, to: string, message: string, skipRateLimit = false, tabId?: string): SendMessageResult {
    if (message.length > MAX_MESSAGE_SIZE) {
      return { status: 'error', detail: `Message exceeds max size of ${MAX_MESSAGE_SIZE} bytes` }
    }

    if (!skipRateLimit) {
      const now = Date.now()
      const recentTimestamps = this.pruneRecentTimestamps(from, now)
      if (recentTimestamps.length >= MAX_MESSAGES_PER_WINDOW) {
        return { status: 'error', detail: 'Rate limit exceeded. Max 30 messages per minute.' }
      }
      recentTimestamps.push(now)
      this.sendTimestamps.set(from, recentTimestamps)
    }

    const target = this.registry.get(to)
    if (!target) {
      return { status: 'error', detail: `Agent '${to}' not found` }
    }

    // Group scoping: check if sender can communicate with target
    if (this.groupManager && !this.groupManager.canCommunicate(from, to)) {
      return { status: 'error', detail: `Agent '${to}' is not in your group` }
    }

    const msg: Message = {
      id: uuid(),
      from,
      to,
      message,
      timestamp: new Date().toISOString(),
      groupId: this.groupManager?.getGroupIdForAgent(from) ?? undefined,
      tabId: tabId ?? undefined
    }

    if (!this.queues.has(to)) {
      this.queues.set(to, [])
    }

    const queue = this.queues.get(to)!
    queue.push(msg)

    while (queue.length > MAX_QUEUE_DEPTH) {
      queue.shift()
    }

    // Notify listeners (main process uses these for nudging and persistence)
    this.onMessageQueued?.(msg)
    this.onMessageSaved?.(msg)

    this.metrics?.increment(from, 'messagesSent')
    this.metrics?.increment(to, 'messagesReceived')

    if (target.status === 'disconnected') {
      return { status: 'queued', detail: `${to} is offline, message queued` }
    }

    return { status: 'delivered' }
  }

  getMessages(agentName: string, peek = false): Message[] {
    const queue = this.queues.get(agentName)
    if (!queue || queue.length === 0) return []

    const messages = [...queue]
    if (!peek) queue.length = 0
    return messages
  }

  ackMessages(agentName: string, messageIds: string[]): number {
    const queue = this.queues.get(agentName)
    if (!queue) return 0

    const idSet = new Set(messageIds)
    const before = queue.length
    const remaining = queue.filter(m => !idSet.has(m.id))
    queue.length = 0
    queue.push(...remaining)
    return before - queue.length
  }

  clearAgent(agentName: string): void {
    this.queues.delete(agentName)
    this.sendTimestamps.delete(agentName)
  }

  private pruneRecentTimestamps(sender: string, now: number): number[] {
    const timestamps = this.sendTimestamps.get(sender) ?? []
    const recent = timestamps.filter((timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS)

    if (recent.length === 0) {
      this.sendTimestamps.delete(sender)
      return []
    }

    this.sendTimestamps.set(sender, recent)
    return recent
  }

  broadcast(from: string, message: string): BroadcastResult {
    // Rate limit: count the entire broadcast as one action
    const now = Date.now()
    const recentTimestamps = this.pruneRecentTimestamps(from, now)
    if (recentTimestamps.length >= MAX_MESSAGES_PER_WINDOW) {
      return { delivered: 0, failed: [], error: 'Rate limit exceeded. Max 30 messages per minute.' }
    }
    recentTimestamps.push(now)
    this.sendTimestamps.set(from, recentTimestamps)

    const agents = this.registry.list()
    const failed: string[] = []
    let delivered = 0

    for (const agent of agents) {
      if (agent.name === from) continue

      const result = this.send(from, agent.name, message, true)
      if (result.status === 'error') {
        failed.push(agent.name)
      } else {
        delivered++
      }
    }

    return { delivered, failed }
  }
}
