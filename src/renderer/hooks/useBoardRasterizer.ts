import { toPng } from 'html-to-image'

/** Render a DOM node to a base64 PNG (no data: prefix), or null on failure. */
export async function rasterizeNode(node: HTMLElement): Promise<string | null> {
  try {
    const dataUrl = await toPng(node, { backgroundColor: '#1e1e1e', cacheBust: true, pixelRatio: 1 })
    const comma = dataUrl.indexOf(',')
    return comma >= 0 ? dataUrl.slice(comma + 1) : null
  } catch {
    return null
  }
}
