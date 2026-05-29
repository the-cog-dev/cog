import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { boardDir, imagesDir, rendersDir, renderPathForPage, saveImageBytes } from '../../src/main/board/board-files'
import type { BoardPage } from '../../src/shared/types'

let root: string
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogboard-')) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

const page = (id: string, orderIndex: number): BoardPage => ({ id, orderIndex, elements: [], strokes: [] })

describe('board-files', () => {
  it('builds .cog/board subdirs under the project root', () => {
    expect(boardDir(root)).toBe(path.join(root, '.cog', 'board'))
    expect(imagesDir(root)).toBe(path.join(root, '.cog', 'board', 'images'))
    expect(rendersDir(root)).toBe(path.join(root, '.cog', 'board', 'renders'))
  })
  it('resolves a render path by 1-based page number', () => {
    const pages = [page('aaa', 1), page('bbb', 2)]
    expect(renderPathForPage(root, pages, 2)).toBe(path.join(rendersDir(root), 'page-bbb.png'))
    expect(renderPathForPage(root, pages, 3)).toBeNull()
    expect(renderPathForPage(root, pages, 0)).toBeNull()
  })
  it('saves image bytes and returns the filename', () => {
    const name = saveImageBytes(root, 'iVBORw0KGgo=', 'png')
    expect(name).toMatch(/\.png$/)
    expect(fs.existsSync(path.join(imagesDir(root), name))).toBe(true)
  })
})
