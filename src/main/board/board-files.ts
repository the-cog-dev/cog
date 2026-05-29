import * as fs from 'fs'
import * as path from 'path'
import { v4 as uuid } from 'uuid'
import type { BoardPage } from '../../shared/types'

export function boardDir(projectRoot: string): string { return path.join(projectRoot, '.cog', 'board') }
export function imagesDir(projectRoot: string): string { return path.join(boardDir(projectRoot), 'images') }
export function rendersDir(projectRoot: string): string { return path.join(boardDir(projectRoot), 'renders') }

function ensure(dir: string): void { fs.mkdirSync(dir, { recursive: true }) }

/** Absolute path to the render PNG for the 1-based page number, or null if out of range. */
export function renderPathForPage(projectRoot: string, pages: BoardPage[], pageNumber: number): string | null {
  const page = pages.find(p => p.orderIndex === pageNumber)
  if (!page) return null
  return path.join(rendersDir(projectRoot), `page-${page.id}.png`)
}

/** Persist base64 image bytes (no data: prefix) under images/, returns the filename. */
export function saveImageBytes(projectRoot: string, base64: string, ext: string): string {
  ensure(imagesDir(projectRoot))
  const name = `${uuid()}.${ext.replace(/[^a-z0-9]/gi, '') || 'png'}`
  fs.writeFileSync(path.join(imagesDir(projectRoot), name), Buffer.from(base64, 'base64'))
  return name
}

/** Persist a rendered page PNG (base64, no data: prefix), returns the absolute path. */
export function saveRenderBytes(projectRoot: string, pageId: string, base64: string): string {
  ensure(rendersDir(projectRoot))
  const file = path.join(rendersDir(projectRoot), `page-${pageId}.png`)
  fs.writeFileSync(file, Buffer.from(base64, 'base64'))
  return file
}
