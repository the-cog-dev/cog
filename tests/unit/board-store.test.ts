import { describe, it, expect } from 'vitest'
import { createDatabase } from '../../src/main/db/database'
import { BoardStore } from '../../src/main/db/board-store'

const store = () => new BoardStore(createDatabase(':memory:'))

describe('BoardStore', () => {
  it('starts empty', () => {
    expect(store().listPages()).toEqual([])
  })
  it('adds pages with incrementing orderIndex and round-trips content', () => {
    const s = store()
    const p1 = s.addPage()
    expect(p1.orderIndex).toBe(1)
    s.savePage({ ...p1, elements: [{ type: 'note', id: 'n1', x: 0, y: 0, w: 100, h: 80, text: 'hi', color: '#ff0', z: 0 }], strokes: [] })
    const reloaded = s.listPages()
    expect(reloaded).toHaveLength(1)
    expect(reloaded[0].elements[0].type).toBe('note')
  })
  it('numbers the second page 2 and deletes + renumbers', () => {
    const s = store()
    const a = s.addPage(); const b = s.addPage()
    expect(b.orderIndex).toBe(2)
    s.deletePage(a.id)
    const pages = s.listPages()
    expect(pages).toHaveLength(1)
    expect(pages[0].orderIndex).toBe(1)
    expect(pages[0].id).toBe(b.id)
  })
})
