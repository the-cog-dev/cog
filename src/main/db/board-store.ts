import type Database from 'better-sqlite3'
import { v4 as uuid } from 'uuid'
import type { BoardPage, BoardElement, BoardStroke } from '../../shared/types'

interface Row { id: string; order_index: number; elements: string; strokes: string }

export class BoardStore {
  private listStmt: Database.Statement
  private upsertStmt: Database.Statement
  private deleteStmt: Database.Statement
  private maxOrderStmt: Database.Statement

  constructor(private db: Database.Database) {
    this.listStmt = db.prepare('SELECT * FROM board_pages ORDER BY order_index ASC')
    this.upsertStmt = db.prepare(
      `INSERT INTO board_pages (id, order_index, elements, strokes) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET order_index = excluded.order_index, elements = excluded.elements, strokes = excluded.strokes`
    )
    this.deleteStmt = db.prepare('DELETE FROM board_pages WHERE id = ?')
    this.maxOrderStmt = db.prepare('SELECT COALESCE(MAX(order_index), 0) AS m FROM board_pages')
  }

  listPages(): BoardPage[] {
    return (this.listStmt.all() as Row[]).map(r => ({
      id: r.id,
      orderIndex: r.order_index,
      elements: JSON.parse(r.elements) as BoardElement[],
      strokes: JSON.parse(r.strokes) as BoardStroke[]
    }))
  }

  addPage(): BoardPage {
    const next = (this.maxOrderStmt.get() as { m: number }).m + 1
    const page: BoardPage = { id: uuid(), orderIndex: next, elements: [], strokes: [] }
    this.savePage(page)
    return page
  }

  savePage(page: BoardPage): void {
    this.upsertStmt.run(page.id, page.orderIndex, JSON.stringify(page.elements), JSON.stringify(page.strokes))
  }

  deletePage(id: string): void {
    this.deleteStmt.run(id)
    const pages = this.listPages()
    pages.forEach((p, i) => {
      const want = i + 1
      if (p.orderIndex !== want) this.savePage({ ...p, orderIndex: want })
    })
  }
}
