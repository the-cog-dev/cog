import { v4 as uuid } from 'uuid'
import type { InfoEntry } from '../../shared/types'

const MAX_NOTE_SIZE = 10 * 1024
const MAX_ENTRIES = 500

export class InfoChannel {
  private entries: InfoEntry[] = []
  onEntryAdded?: (entry: InfoEntry) => void
  onEntryUpdated?: (entry: InfoEntry) => void
  onEntryDeleted?: (id: string) => void

  postInfo(from: string, note: string, tags: string[] = [], groupId?: string, tabId?: string): InfoEntry {
    if (note.length > MAX_NOTE_SIZE) {
      throw new Error(`Note exceeds max size of ${MAX_NOTE_SIZE} bytes`)
    }

    const entry: InfoEntry = {
      id: uuid(),
      from,
      note,
      tags,
      createdAt: new Date().toISOString(),
      groupId: groupId ?? undefined,
      tabId: tabId ?? undefined
    }

    this.entries.push(entry)
    this.onEntryAdded?.(entry)

    // Enforce max entries limit, dropping oldest
    while (this.entries.length > MAX_ENTRIES) {
      this.entries.shift()
    }

    return entry
  }

  readInfo(tags?: string[]): InfoEntry[] {
    if (!tags || tags.length === 0) {
      return [...this.entries]
    }

    // Filter to entries matching ANY of the provided tags
    return this.entries.filter(entry =>
      entry.tags.some(tag => tags.includes(tag))
    )
  }

  readInfoForGroup(groupId: string | null, tags?: string[]): InfoEntry[] {
    let entries = groupId
      ? this.entries.filter(e => !e.groupId || e.groupId === groupId)
      : [...this.entries]
    if (tags && tags.length > 0) {
      entries = entries.filter(entry => entry.tags.some(tag => tags.includes(tag)))
    }
    return entries
  }

  readInfoForTab(tabId: string | null, tags?: string[]): InfoEntry[] {
    let entries = tabId
      ? this.entries.filter(e => !e.tabId || e.tabId === tabId)
      : [...this.entries]
    if (tags && tags.length > 0) {
      entries = entries.filter(entry => entry.tags.some(tag => tags.includes(tag)))
    }
    return entries
  }

  deleteInfo(id: string): boolean {
    const idx = this.entries.findIndex(e => e.id === id)
    if (idx === -1) return false
    this.entries.splice(idx, 1)
    this.onEntryDeleted?.(id)
    return true
  }

  updateInfo(id: string, note: string): InfoEntry | null {
    const entry = this.entries.find(e => e.id === id)
    if (!entry) return null
    if (note.length > MAX_NOTE_SIZE) {
      throw new Error(`Note exceeds max size of ${MAX_NOTE_SIZE} bytes`)
    }
    entry.note = note
    this.onEntryUpdated?.(entry)
    return entry
  }

  loadEntries(entries: InfoEntry[]): void {
    this.entries.push(...entries)
  }

  clear(): void {
    this.entries = []
  }
}
