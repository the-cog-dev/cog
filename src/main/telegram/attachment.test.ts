import { describe, it, expect } from 'vitest'
import { extensionOf, isTextFile, isImageFile, sanitizeFilename, buildAttachmentMessage } from './attachment'

describe('extensionOf', () => {
  it('pulls the extension, lowercased', () => {
    expect(extensionOf('Notes.MD')).toBe('md')
    expect(extensionOf('a/b/c/report.txt')).toBe('txt')
  })
  it('treats a dotfile name as its own extension', () => {
    expect(extensionOf('.gitignore')).toBe('gitignore')
    expect(extensionOf('Makefile')).toBe('makefile')
  })
})

describe('isTextFile', () => {
  it('accepts known text extensions', () => {
    expect(isTextFile('notes.md')).toBe(true)
    expect(isTextFile('data.json')).toBe(true)
    expect(isTextFile('script.py')).toBe(true)
  })
  it('rejects images and binaries by extension', () => {
    expect(isTextFile('photo.jpg')).toBe(false)
    expect(isTextFile('archive.zip')).toBe(false)
  })
  it('trusts mime type over extension when decisive', () => {
    expect(isTextFile('weird.bin', 'text/plain')).toBe(true)
    expect(isTextFile('notes.md', 'image/png')).toBe(false)  // image mime wins
  })
})

describe('isImageFile', () => {
  it('detects images by mime or extension', () => {
    expect(isImageFile('shot.png')).toBe(true)
    expect(isImageFile('pic.JPG')).toBe(true)
    expect(isImageFile('blob', 'image/webp')).toBe(true)
  })
  it('is false for non-images (incl. svg, which we treat as text)', () => {
    expect(isImageFile('notes.md')).toBe(false)
    expect(isImageFile('diagram.svg')).toBe(false)
  })
})

describe('sanitizeFilename', () => {
  it('strips directory traversal to a bare basename', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFilename('C:\\Windows\\evil.txt')).toBe('evil.txt')
  })
  it('drops leading dots and illegal characters', () => {
    expect(sanitizeFilename('...hidden')).toBe('hidden')
    expect(sanitizeFilename('a<b>c:d?.txt')).toBe('abcd.txt')
  })
  it('falls back when nothing usable remains', () => {
    expect(sanitizeFilename('///')).toBe('telegram-file')
    expect(sanitizeFilename('', 'photo.jpg')).toBe('photo.jpg')
  })
})

describe('buildAttachmentMessage', () => {
  it('inlines text content and notes truncation', () => {
    const msg = buildAttachmentMessage({
      filename: 'notes.md', relPath: '.cog/telegram-inbox/notes.md',
      isImage: false, textContent: '# Hello', truncated: true, caption: 'read this'
    })
    expect(msg).toContain('📎 Telegram sent a file: notes.md')
    expect(msg).toContain('Saved to: .cog/telegram-inbox/notes.md')
    expect(msg).toContain('Caption: read this')
    expect(msg).toContain('# Hello')
    expect(msg).toContain('Truncated')
  })
  it('points an image at its path instead of inlining', () => {
    const msg = buildAttachmentMessage({
      filename: 'shot.png', relPath: '.cog/telegram-inbox/shot.png',
      isImage: true, textContent: null
    })
    expect(msg).toContain('📎 Telegram sent an image: shot.png')
    expect(msg).toContain('Open/read .cog/telegram-inbox/shot.png')
    expect(msg).not.toContain('--- end ---')
  })
})
