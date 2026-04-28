// Rasterizes marketing/cogsworth/cogsworth-happy.svg into build/icon.png + build/icon.ico
// for use as the Electron app icon (taskbar, packaged builds).
//
// Run with: node scripts/build-icons.mjs

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import pngToIco from 'png-to-ico'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

const SOURCE_SVG = path.join(root, 'marketing/cogsworth/cogsworth-happy.svg')
const OUT_DIR = path.join(root, 'build')
const PNG_PATH = path.join(OUT_DIR, 'icon.png')
const ICO_PATH = path.join(OUT_DIR, 'icon.ico')

// Multi-resolution PNGs to bake into the .ico — Windows scales the right one for the context
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
// Single high-res PNG used by Electron BrowserWindow at runtime + Linux/Mac builds
const PNG_SIZE = 512

function renderPng(svg, size) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    background: 'transparent',
  })
  return resvg.render().asPng()
}

async function main() {
  if (!fs.existsSync(SOURCE_SVG)) {
    console.error(`Source SVG not found: ${SOURCE_SVG}`)
    process.exit(1)
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const svg = fs.readFileSync(SOURCE_SVG)

  fs.writeFileSync(PNG_PATH, renderPng(svg, PNG_SIZE))
  console.log(`Wrote ${PNG_PATH} (${PNG_SIZE}x${PNG_SIZE})`)

  const buffers = ICO_SIZES.map(size => renderPng(svg, size))
  const ico = await pngToIco(buffers)
  fs.writeFileSync(ICO_PATH, ico)
  console.log(`Wrote ${ICO_PATH} (sizes: ${ICO_SIZES.join(', ')})`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
