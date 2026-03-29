import { v4 as uuid } from 'uuid'
import type { Message, SendMessageResult } from '../../shared/types'
import type { AgentRegistry } from './agent-registry'

const MAX_MESSAGE_SIZE = 10 * 1024
const MAX_QUEUE_DEPTH = 100

export class MessageRouter {
  private queues = new Map<string, Message[]>()
  onMessageQueued?: (msg: Message) => void

  constructor(private registry: AgentRegistry) {}

  send(from: string, to: string, message: string): SendMessageResult {
    if (message.length > MAX_MESSAGE_SIZE) {
      return { status: 'error', detail: `Message exceeds max size of ${MAX_MESSAGE_SIZE} bytes` }
    }

    const target = this.registry.get(to)
    if (!target) {
      return { status: 'error', detail: `Agent '${to}' not found` }
    }

    const msg: Message = {
      id: uuid(),
      from,
      to,
      message,
      timestamp: new Date().toISOString()
    }

    if (!this.queues.has(to)) {
      this.queues.set(to, [])
    }

    const queue = this.queues.get(to)!
    queue.push(msg)

    while (queue.length > MAX_QUEUE_DEPTH) {
      queue.shift()
    }

    // Notify listener (main process uses this to nudge agents)
    this.onMessageQueued?.(msg)

    if (target.status === 'disconnected') {
      return { status: 'queued', detail: `${to} is offline, message queued` }
    }

    return { status: 'delivered' }
  }

  getMessages(agentName: string): Message[] {
    const queue = this.queues.get(agentName)
    if (!queue || queue.length === 0) return []

    const messages = [...queue]
    queue.length = 0
    return messages
  }

  clearAgent(agentName: string): void {
    this.queues.delete(agentName)
  }
}
