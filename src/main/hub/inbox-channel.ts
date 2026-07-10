import { v4 as uuid } from 'uuid'
import type { InboxMessage, InboxPriority } from '../../shared/types'

const MAX_MESSAGE_SIZE = 10 * 1024
const MAX_MESSAGES = 500
const VALID_PRIORITIES: ReadonlySet<InboxPriority> = new Set(['low', 'normal', 'high', 'urgent'])

export class InboxChannel {
  private messages: InboxMessage[] = []
  onMessageAdded?: (msg: InboxMessage) => void
  onMessageUpdated?: (msg: InboxMessage) => void
  onMessageDeleted?: (id: string) => void

  postMessage(
    agentId: string,
    agentName: string,
    message: string,
    priority: InboxPriority,
    tags: string[] = [],
    tabId?: string,
    choices?: string[]
  ): InboxMessage {
    if (message.length > MAX_MESSAGE_SIZE) {
      throw new Error(`Message exceeds max size of ${MAX_MESSAGE_SIZE} bytes`)
    }
    if (!VALID_PRIORITIES.has(priority)) {
      throw new Error(`Invalid priority '${priority}'. Must be one of: low, normal, high, urgent.`)
    }

    const cleanChoices = Array.isArray(choices)
      ? choices.map(c => String(c).trim()).filter(Boolean).slice(0, 8)
      : undefined

    const msg: InboxMessage = {
      id: uuid(),
      agentId,
      agentName,
      message,
      priority,
      tags,
      createdAt: new Date().toISOString(),
      tabId: tabId ?? undefined,
      choices: cleanChoices && cleanChoices.length ? cleanChoices : undefined
    }

    this.messages.unshift(msg)
    this.onMessageAdded?.(msg)

    // Trim oldest READ messages first when over limit; only drop unread as a
    // last resort so the user never silently loses an unread urgent message.
    while (this.messages.length > MAX_MESSAGES) {
      const oldestReadIdx = this.findLastReadIndex()
      if (oldestReadIdx >= 0) {
        this.messages.splice(oldestReadIdx, 1)
      } else {
        this.messages.pop()
      }
    }

    return msg
  }

  readAll(): InboxMessage[] {
    return [...this.messages]
  }

  markRead(id: string): InboxMessage | null {
    const msg = this.messages.find(m => m.id === id)
    if (!msg) return null
    if (!msg.readAt) {
      msg.readAt = new Date().toISOString()
      this.onMessageUpdated?.(msg)
    }
    return msg
  }

  markAllRead(): number {
    const now = new Date().toISOString()
    let count = 0
    for (const msg of this.messages) {
      if (!msg.readAt) {
        msg.readAt = now
        this.onMessageUpdated?.(msg)
        count++
      }
    }
    return count
  }

  deleteMessage(id: string): boolean {
    const idx = this.messages.findIndex(m => m.id === id)
    if (idx === -1) return false
    this.messages.splice(idx, 1)
    this.onMessageDeleted?.(id)
    return true
  }

  loadMessages(messages: InboxMessage[]): void {
    // Stored newest-first by SQL ORDER BY; in-memory array also newest-first.
    this.messages.push(...messages)
  }

  clear(): void {
    this.messages = []
  }

  unreadCount(minPriority?: InboxPriority): number {
    return this.messages.reduce((acc, m) => {
      if (m.readAt) return acc
      if (minPriority && !meetsThreshold(m.priority, minPriority)) return acc
      return acc + 1
    }, 0)
  }

  private findLastReadIndex(): number {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].readAt) return i
    }
    return -1
  }
}

const PRIORITY_RANK: Record<InboxPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  urgent: 3
}

export function meetsThreshold(actual: InboxPriority, minimum: InboxPriority): boolean {
  return PRIORITY_RANK[actual] >= PRIORITY_RANK[minimum]
}
