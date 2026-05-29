import type { BoardPage } from '../../shared/types'

export function BoardPageCanvas({ page }: { page: BoardPage; onChange: (p: BoardPage) => void }) {
  return (
    <div style={{
      position: 'absolute', inset: 0, top: 44, background: '#101010', color: '#555',
      display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'monospace'
    }}>
      Page {page.orderIndex} — canvas coming next ({page.elements.length} elements, {page.strokes.length} strokes)
    </div>
  )
}
