import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Rnd } from 'react-rnd'
import type { BoardElement } from '../../shared/types'

interface BoardElementViewProps {
  element: BoardElement
  zoom: number
  selected: boolean
  onSelect: () => void
  onChange: (el: BoardElement) => void
  onDelete: () => void
}

// Separate component so hooks are always called unconditionally
function ImageContent({ file }: { file: string }): React.ReactElement {
  const [imgSrc, setImgSrc] = useState<string | null>(null)

  useEffect(() => {
    if (!file) return
    // data: URIs render as-is. Everything else (bare filename) is read back as a
    // data URL via IPC — file:// URLs are blocked in the http-served renderer.
    if (file.startsWith('data:')) { setImgSrc(file); return }
    let cancelled = false
    window.electronAPI.boardReadImage(file).then((dataUrl) => {
      if (!cancelled && dataUrl) setImgSrc(dataUrl)
    })
    return () => { cancelled = true }
  }, [file])

  if (!imgSrc) {
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          background: 'rgba(255,255,255,0.05)',
          borderRadius: 2,
        }}
      />
    )
  }

  return (
    <img
      src={imgSrc}
      alt=""
      draggable={false}
      style={{
        width: '100%',
        height: '100%',
        objectFit: 'contain',
        display: 'block',
        pointerEvents: 'none',
      }}
    />
  )
}

export function BoardElementView({
  element,
  zoom,
  selected,
  onSelect,
  onChange,
  onDelete,
}: BoardElementViewProps): React.ReactElement {
  // Track whether we are actively editing text to suppress delete key
  const [editing, setEditing] = useState(false)
  const textRef = useRef<HTMLTextAreaElement | HTMLDivElement | null>(null)

  // Delete / Backspace while selected and NOT editing text
  useEffect(() => {
    if (!selected) return
    const handleKey = (e: KeyboardEvent) => {
      if (editing) return
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // Only fire if no focussed input/textarea inside the element
        const active = document.activeElement
        if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || (active as HTMLElement).isContentEditable)) {
          return
        }
        e.preventDefault()
        onDelete()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [selected, editing, onDelete])

  // Focus the text field when we enter edit mode (double-click).
  useEffect(() => {
    if (editing) textRef.current?.focus()
  }, [editing])

  const handleDragStop = useCallback(
    (_e: unknown, d: { x: number; y: number }) => {
      onChange({ ...element, x: d.x, y: d.y })
    },
    [element, onChange]
  )

  const handleResizeStop = useCallback(
    (
      _e: unknown,
      _dir: unknown,
      ref: HTMLElement,
      _delta: unknown,
      pos: { x: number; y: number }
    ) => {
      onChange({
        ...element,
        w: parseInt(ref.style.width),
        h: parseInt(ref.style.height),
        x: pos.x,
        y: pos.y,
      })
    },
    [element, onChange]
  )

  const borderStyle = selected
    ? '2px solid #4a9eff'
    : '2px solid transparent'

  let content: React.ReactNode

  if (element.type === 'note') {
    content = (
      <div
        style={{
          width: '100%',
          height: '100%',
          background: element.color,
          borderRadius: 6,
          boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
          padding: 8,
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <textarea
          ref={textRef as React.RefObject<HTMLTextAreaElement>}
          defaultValue={element.text}
          readOnly={!editing}
          tabIndex={editing ? 0 : -1}
          onFocus={() => setEditing(true)}
          onBlur={(e) => {
            setEditing(false)
            const newText = e.currentTarget.value
            if (newText !== element.text) {
              onChange({ ...element, text: newText })
            }
          }}
          onMouseDown={(e) => { if (editing) e.stopPropagation() }}
          onKeyDown={(e) => { if (e.key === 'Escape') e.currentTarget.blur() }}
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            resize: 'none',
            fontSize: 13,
            fontFamily: 'sans-serif',
            color: '#111',
            lineHeight: 1.5,
            // Inert until editing so clicking the note SELECTS it (Del works)
            // instead of focusing the textarea and swallowing the key.
            pointerEvents: editing ? 'auto' : 'none',
          }}
        />
      </div>
    )
  } else if (element.type === 'text') {
    content = (
      <div
        contentEditable={editing}
        suppressContentEditableWarning
        ref={textRef as React.RefObject<HTMLDivElement>}
        onFocus={() => setEditing(true)}
        onBlur={(e) => {
          setEditing(false)
          const newText = e.currentTarget.textContent ?? ''
          if (newText !== element.text) {
            onChange({ ...element, text: newText })
          }
        }}
        onMouseDown={(e) => { if (editing) e.stopPropagation() }}
        onKeyDown={(e) => { if (e.key === 'Escape') e.currentTarget.blur() }}
        style={{
          width: '100%',
          height: '100%',
          fontSize: element.fontSize,
          fontFamily: 'sans-serif',
          color: '#ddd',
          outline: 'none',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          padding: 4,
          boxSizing: 'border-box',
          // Inert until editing so a single click selects (Del works).
          pointerEvents: editing ? 'auto' : 'none',
        }}
      >
        {element.text}
      </div>
    )
  } else {
    // type === 'image'
    content = <ImageContent file={element.file} />
  }

  return (
    <Rnd
      position={{ x: element.x, y: element.y }}
      size={{ width: element.w, height: element.h }}
      scale={zoom}
      style={{
        zIndex: element.z,
        border: borderStyle,
        borderRadius: element.type === 'note' ? 6 : 2,
        boxSizing: 'border-box',
        cursor: 'default',
      }}
      onMouseDown={onSelect}
      onDragStop={handleDragStop}
      onResizeStop={handleResizeStop}
    >
      <div
        style={{ width: '100%', height: '100%' }}
        onDoubleClick={() => { if (element.type !== 'image') setEditing(true) }}
      >
        {content}
      </div>
    </Rnd>
  )
}
