/**
 * Pure workspace ↔ Telegram forum-topic map. No grammY, no I/O — the routing
 * source of truth, unit-tested in isolation (mirrors ContextRegistry). Persisted
 * by the caller via the onChange callback into settings.telegram.topics.
 */
export interface TopicEntry {
  threadId: number
  name: string
}

export class TopicRegistry {
  private byWorkspace = new Map<string, TopicEntry>()
  private byThread = new Map<number, string>()
  private readonly onChange?: (map: Record<string, TopicEntry>) => void

  constructor(initial: Record<string, TopicEntry> = {}, onChange?: (map: Record<string, TopicEntry>) => void) {
    for (const [ws, entry] of Object.entries(initial)) {
      this.byWorkspace.set(ws, entry)
      this.byThread.set(entry.threadId, ws)
    }
    this.onChange = onChange
  }

  threadFor(workspaceId: string): number | undefined {
    return this.byWorkspace.get(workspaceId)?.threadId
  }

  workspaceFor(threadId: number): string | undefined {
    return this.byThread.get(threadId)
  }

  nameFor(workspaceId: string): string | undefined {
    return this.byWorkspace.get(workspaceId)?.name
  }

  has(workspaceId: string): boolean {
    return this.byWorkspace.has(workspaceId)
  }

  set(workspaceId: string, threadId: number, name: string): void {
    const prev = this.byWorkspace.get(workspaceId)
    if (prev) this.byThread.delete(prev.threadId)
    this.byWorkspace.set(workspaceId, { threadId, name })
    this.byThread.set(threadId, workspaceId)
    this.emit()
  }

  rename(workspaceId: string, name: string): boolean {
    const entry = this.byWorkspace.get(workspaceId)
    if (!entry) return false
    entry.name = name
    this.emit()
    return true
  }

  remove(workspaceId: string): void {
    const entry = this.byWorkspace.get(workspaceId)
    if (!entry) return
    this.byWorkspace.delete(workspaceId)
    this.byThread.delete(entry.threadId)
    this.emit()
  }

  snapshot(): Record<string, TopicEntry> {
    const result: Record<string, TopicEntry> = {}
    for (const [ws, entry] of this.byWorkspace.entries()) {
      result[ws] = { ...entry }
    }
    return result
  }

  private emit(): void {
    this.onChange?.(this.snapshot())
  }
}
