import { toPng } from 'html-to-image'

/**
 * Wait for every <img> inside the node to finish decoding so toPng captures
 * pixels, not half-loaded placeholders. Per-image failures are tolerated —
 * a broken image should degrade that one element, not kill the whole render.
 */
export async function waitForImages(node: HTMLElement): Promise<void> {
  const imgs = Array.from(node.querySelectorAll('img'))
  await Promise.all(imgs.map((img) => img.decode().catch(() => {})))
}

/** Render a DOM node to a base64 PNG (no data: prefix), or null on failure. */
export async function rasterizeNode(node: HTMLElement, bgColor = '#101010'): Promise<string | null> {
  try {
    await waitForImages(node)
    // cacheBust is intentionally OFF: board images are data: URLs (cache-bust
    // queries are useless for them) and busting appends ?<timestamp> to any
    // fetched resource, defeating html-to-image's internal cache.
    const dataUrl = await toPng(node, { backgroundColor: bgColor, cacheBust: false, pixelRatio: 1 })
    const comma = dataUrl.indexOf(',')
    return comma >= 0 ? dataUrl.slice(comma + 1) : null
  } catch (err) {
    // Surface the real cause (this used to be a silent `catch { return null }`,
    // which made photo-page render failures undiagnosable). Callers still get
    // null and degrade gracefully.
    console.error('[rasterizeNode] board page rasterization failed:', err)
    return null
  }
}
