import type { ToolState } from './BoardPageCanvas'

const TOOLS: { kind: ToolState['kind']; label: string; title: string }[] = [
  { kind: 'select',  label: '▣',  title: 'Select / move' },
  { kind: 'note',    label: '📝', title: 'Sticky note' },
  { kind: 'text',    label: 'T',  title: 'Text block' },
  { kind: 'pen',     label: '✏', title: 'Pen (freehand)' },
  { kind: 'line',    label: '／', title: 'Line' },
  { kind: 'arrow',   label: '➜', title: 'Arrow' },
  { kind: 'ellipse', label: '◯', title: 'Ellipse' },
  { kind: 'eraser',  label: '⌫', title: 'Eraser' },
]
const WIDTHS = [2, 4, 8, 14]

export function BoardToolbar({
  tool,
  setTool,
}: {
  tool: ToolState
  setTool: (t: ToolState) => void
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 4,
        alignItems: 'center',
        padding: '6px 8px',
        background: '#1a1a1a',
        border: '1px solid #2a2a2a',
        borderRadius: 8,
        position: 'absolute',
        top: 52,
        left: 12,
        zIndex: 20,
      }}
    >
      {TOOLS.map((t) => (
        <button
          key={t.kind}
          title={t.title}
          onClick={() => setTool({ ...tool, kind: t.kind })}
          style={{
            width: 30,
            height: 30,
            borderRadius: 6,
            cursor: 'pointer',
            background: tool.kind === t.kind ? '#2a3a4a' : '#222',
            color: tool.kind === t.kind ? '#8cc4ff' : '#ccc',
            border: tool.kind === t.kind ? '1px solid #3a5a7a' : '1px solid #333',
          }}
        >
          {t.label}
        </button>
      ))}
      <input
        type="color"
        value={tool.color}
        title="Color"
        onChange={(e) => setTool({ ...tool, color: e.target.value })}
        style={{ width: 30, height: 30, border: 'none', background: 'none', cursor: 'pointer' }}
      />
      <select
        value={tool.width}
        title="Stroke width"
        onChange={(e) => setTool({ ...tool, width: Number(e.target.value) })}
        style={{
          height: 30,
          background: '#222',
          color: '#ccc',
          border: '1px solid #333',
          borderRadius: 6,
        }}
      >
        {WIDTHS.map((w) => (
          <option key={w} value={w}>
            {w}px
          </option>
        ))}
      </select>
    </div>
  )
}
