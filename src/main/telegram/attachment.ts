/**
 * Pure helpers for turning a Telegram attachment into something an agent can
 * actually consume. No fs, no grammY — just decisions about text-vs-binary,
 * safe filenames, and the message body the agent receives. Kept separate from
 * the download/save I/O so the rules are unit-testable.
 */

// How much file text to inline into the agent message before we truncate. Kept
// well under the hub's 10 KB per-message cap so the wrapper always fits; the
// full file is on disk regardless, so the agent can read past this.
export const TEXT_INLINE_LIMIT = 8_000

// Extensions we treat as inline-able text. Everything else (images, pdfs,
// archives, binaries) is saved to disk and handed to the agent as a path.
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'rst', 'log', 'csv', 'tsv',
  'json', 'jsonl', 'yaml', 'yml', 'toml', 'xml', 'ini', 'cfg', 'conf', 'env',
  'html', 'htm', 'css', 'scss', 'svg',
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java',
  'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'php', 'swift', 'kt', 'scala',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'sql', 'diff', 'patch',
  'gitignore', 'dockerfile', 'makefile', 'gradle', 'properties'
])

export function extensionOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename
  const dot = base.lastIndexOf('.')
  // No dot, or leading-dot-only (e.g. ".gitignore") → treat whole name as ext.
  if (dot <= 0) return base.replace(/^\./, '').toLowerCase()
  return base.slice(dot + 1).toLowerCase()
}

/** Is this something we can meaningfully inline as UTF-8 text? */
export function isTextFile(filename: string, mimeType?: string): boolean {
  if (mimeType) {
    if (mimeType.startsWith('text/')) return true
    if (mimeType === 'application/json' || mimeType === 'application/xml') return true
    if (mimeType.startsWith('image/') || mimeType === 'application/pdf') return false
  }
  return TEXT_EXTENSIONS.has(extensionOf(filename))
}

/**
 * Strip a Telegram-supplied filename down to a safe basename: no directory
 * traversal, no separators, bounded length, never empty. The sender is the
 * trusted owner, but a filename like "../../etc/passwd" must never escape the
 * inbox folder.
 */
export function sanitizeFilename(name: string, fallback = 'telegram-file'): string {
  const base = (name.split(/[\\/]/).pop() ?? '').trim()
  const cleaned = base
    .replace(/[\x00-\x1f<>:"|?*]/g, '')  // control + Windows-illegal chars
    .replace(/^\.+/, '')                  // no leading dots ("..", hidden traversal)
    .slice(0, 120)
    .trim()
  return cleaned || fallback
}

export interface AttachmentMessageInput {
  filename: string
  /** Path the agent can open, relative to its cwd (the project root). */
  relPath: string
  caption?: string
  isImage: boolean
  /** Decoded text, already truncated to the inline limit (null for binary). */
  textContent?: string | null
  /** True when textContent was cut off — the full file is still on disk. */
  truncated?: boolean
}

/** Build the hub message an agent receives for an incoming attachment. */
export function buildAttachmentMessage(input: AttachmentMessageInput): string {
  const { filename, relPath, caption, isImage, textContent, truncated } = input
  const head = isImage
    ? `📎 Telegram sent an image: ${filename}`
    : `📎 Telegram sent a file: ${filename}`
  const lines = [head, `Saved to: ${relPath}`]
  if (caption && caption.trim()) lines.push(`Caption: ${caption.trim()}`)

  if (textContent != null) {
    lines.push('', `--- ${filename} ---`, textContent, '--- end ---')
    if (truncated) lines.push(`(Truncated — read ${relPath} for the full contents.)`)
  } else if (isImage) {
    lines.push('', `Open/read ${relPath} to view the image.`)
  } else {
    lines.push('', `Read ${relPath} to inspect the file.`)
  }
  return lines.join('\n')
}
