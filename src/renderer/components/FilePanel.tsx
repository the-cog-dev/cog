import React, { useState, useEffect, useCallback } from 'react'
import Editor from '@monaco-editor/react'

interface FileEntry {
  name: string
  type: 'file' | 'directory'
  path: string
}

interface OpenFile {
  path: string
  name: string
  content: string
  dirty: boolean
}

declare const electronAPI: {
  listFiles: (dirPath?: string) => Promise<{ path: string; items: FileEntry[] }>
  readFile: (filePath: string) => Promise<{ path: string; content: string } | null>
  writeFile: (filePath: string, content: string) => Promise<boolean>
}

// Detect language from file extension
function getLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase()
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    json: 'json', md: 'markdown', css: 'css', scss: 'scss',
    html: 'html', xml: 'xml', yaml: 'yaml', yml: 'yaml',
    py: 'python', rs: 'rust', go: 'go', java: 'java',
    sh: 'shell', bash: 'shell', zsh: 'shell',
    sql: 'sql', graphql: 'graphql', toml: 'toml',
  }
  return map[ext ?? ''] ?? 'plaintext'
}

// --- Tree Node Component ---
function TreeNode({ entry, depth, onFileClick }: {
  entry: FileEntry
  depth: number
  onFileClick: (path: string) => void
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<FileEntry[]>([])
  const [loaded, setLoaded] = useState(false)

  const handleToggle = async (): Promise<void> => {
    if (entry.type === 'file') {
      onFileClick(entry.path)
      return
    }
    if (!loaded) {
      const result = await electronAPI.listFiles(entry.path)
      setChildren(result.items)
      setLoaded(true)
    }
    setExpanded(!expanded)
  }

  return (
    <div>
      <div
        onClick={handleToggle}
        style={{
          padding: '2px 0',
          paddingLeft: `${depth * 16 + 8}px`,
          cursor: 'pointer',
          fontSize: '12px',
          color: entry.type === 'directory' ? '#c8a86e' : '#ccc',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          lineHeight: '22px',
        }}
        onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#2a2d2e')}
        onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
      >
        {entry.type === 'directory' && (
          <span style={{ display: 'inline-block', width: '12px', fontSize: '10px' }}>
            {expanded ? '\u25BC' : '\u25B6'}
          </span>
        )}
        {entry.type === 'file' && <span style={{ display: 'inline-block', width: '12px' }} />}
        {' '}{entry.name}
      </div>
      {expanded && children.map(child => (
        <TreeNode key={child.path} entry={child} depth={depth + 1} onFileClick={onFileClick} />
      ))}
    </div>
  )
}

// --- Main FilePanel Component ---
export function FilePanel(): React.ReactElement {
  const [rootFiles, setRootFiles] = useState<FileEntry[]>([])
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([])
  const [activeTab, setActiveTab] = useState<string | null>(null)

  useEffect(() => {
    electronAPI.listFiles('.').then(result => setRootFiles(result.items))
  }, [])

  const openFile = useCallback(async (filePath: string) => {
    // Check if already open
    const existing = openFiles.find(f => f.path === filePath)
    if (existing) {
      setActiveTab(filePath)
      return
    }

    const result = await electronAPI.readFile(filePath)
    if (!result) return

    const name = filePath.split('/').pop() || filePath
    setOpenFiles(prev => [...prev, { path: filePath, name, content: result.content, dirty: false }])
    setActiveTab(filePath)
  }, [openFiles])

  const closeTab = useCallback((filePath: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setOpenFiles(prev => prev.filter(f => f.path !== filePath))
    if (activeTab === filePath) {
      setActiveTab(openFiles.length > 1 ? openFiles.find(f => f.path !== filePath)?.path ?? null : null)
    }
  }, [activeTab, openFiles])

  const handleEditorChange = useCallback((value: string | undefined) => {
    if (!activeTab || value === undefined) return
    setOpenFiles(prev => prev.map(f =>
      f.path === activeTab ? { ...f, content: value, dirty: true } : f
    ))
  }, [activeTab])

  const saveFile = useCallback(async () => {
    if (!activeTab) return
    const file = openFiles.find(f => f.path === activeTab)
    if (!file || !file.dirty) return

    const success = await electronAPI.writeFile(file.path, file.content)
    if (success) {
      setOpenFiles(prev => prev.map(f =>
        f.path === activeTab ? { ...f, dirty: false } : f
      ))
    }
  }, [activeTab, openFiles])

  // Ctrl+S to save
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.key === 's') {
        e.preventDefault()
        saveFile()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [saveFile])

  const activeFile = openFiles.find(f => f.path === activeTab)

  return (
    <div style={{ display: 'flex', height: '100%', backgroundColor: '#1e1e1e' }}>
      {/* File tree sidebar */}
      <div style={{
        width: '220px',
        minWidth: '150px',
        borderRight: '1px solid #333',
        overflow: 'auto',
        flexShrink: 0,
      }}>
        <div style={{
          padding: '8px 12px',
          fontSize: '11px',
          color: '#888',
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          borderBottom: '1px solid #333'
        }}>
          Explorer
        </div>
        {rootFiles.map(entry => (
          <TreeNode key={entry.path} entry={entry} depth={0} onFileClick={openFile} />
        ))}
      </div>

      {/* Editor area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* Tabs */}
        {openFiles.length > 0 && (
          <div style={{
            display: 'flex',
            height: '32px',
            backgroundColor: '#252525',
            borderBottom: '1px solid #333',
            overflow: 'auto',
          }}>
            {openFiles.map(file => (
              <div
                key={file.path}
                onClick={() => setActiveTab(file.path)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '0 12px',
                  fontSize: '12px',
                  color: activeTab === file.path ? '#e0e0e0' : '#888',
                  backgroundColor: activeTab === file.path ? '#1e1e1e' : 'transparent',
                  borderRight: '1px solid #333',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  minWidth: 0,
                }}
              >
                <span>{file.dirty ? '\u25CF ' : ''}{file.name}</span>
                <span
                  onClick={e => closeTab(file.path, e)}
                  style={{ fontSize: '14px', color: '#666', marginLeft: '4px' }}
                >
                  x
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Monaco Editor */}
        {activeFile ? (
          <Editor
            height="100%"
            language={getLanguage(activeFile.name)}
            value={activeFile.content}
            onChange={handleEditorChange}
            theme="vs-dark"
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              lineNumbers: 'on',
              renderLineHighlight: 'gutter',
              automaticLayout: true,
            }}
          />
        ) : (
          <div style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#555',
            fontSize: '13px'
          }}>
            Click a file in the explorer to open it
          </div>
        )}
      </div>
    </div>
  )
}
