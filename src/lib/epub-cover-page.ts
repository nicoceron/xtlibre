import AdmZip from "adm-zip"
import { XMLParser } from "fast-xml-parser"

const parser = new XMLParser({ ignoreAttributes: false })

const COVER_CENTER_CSS =
  `@page{margin:0;padding:0;}` +
  `html,body{margin:0;padding:0;width:100%;height:100%;}` +
  `body{text-align:center;}` +
  `._xtc_cover_center{display:table;width:100%;height:100%;margin:0;padding:0;}` +
  `._xtc_cover_cell{display:table-cell;width:100%;height:100%;vertical-align:middle;text-align:center;}` +
  `._xtc_cover_cell>svg{width:100%;height:100%;display:block;margin:0 auto;}` +
  `._xtc_cover_cell>img{max-width:100%;max-height:100%;width:auto;height:auto;display:block;margin:0 auto;}`

interface OpfPackageForCss {
  manifest?: {
    item?: Record<string, string> | Record<string, string>[]
  }
}

/**
 * Inject a global CSS file into every XHTML page of an EPUB to preserve
 * image aspect ratios. Also adds it to the manifest.
 */
export function injectImageCss(zip: AdmZip, opfPath: string, pkg: OpfPackageForCss): boolean {
  const opfDir = opfPath.includes("/") ? opfPath.substring(0, opfPath.lastIndexOf("/") + 1) : ""
  const xtcCssPath = opfDir + "_xtc_styles.css"

  const xtcCss = `img{max-width:100%;height:auto;display:block;margin:0 auto;}svg{max-width:100%;display:block;margin:0 auto;}`
  const existingCssEntry = zip.getEntry(xtcCssPath)
  let changed = false
  if (existingCssEntry) {
    const currentCss = existingCssEntry.getData().toString("utf-8")
    if (currentCss !== xtcCss) {
      zip.deleteFile(xtcCssPath)
      zip.addFile(xtcCssPath, Buffer.from(xtcCss, "utf-8"))
      changed = true
    }
  } else {
    zip.addFile(xtcCssPath, Buffer.from(xtcCss, "utf-8"))
    changed = true
  }

  const xtcLinkTag = `<link rel="stylesheet" href="_xtc_styles.css" type="text/css"/>`

  // Inject <link> into every XHTML page
  const manifest = pkg.manifest?.item
  const manifestList: Record<string, string>[] = Array.isArray(manifest) ? manifest : manifest ? [manifest] : []
  for (const item of manifestList) {
    const href = item["@_href"] || ""
    const mediaType = (item["@_media-type"] || "").toLowerCase()
    if (!mediaType.includes("html") && !mediaType.includes("xhtml")) continue
    if (href.endsWith(".css")) continue

    const xhtmlPath = href.startsWith("/") ? href.slice(1) : (opfDir ? opfDir + href : href)
    const entry = zip.getEntry(xhtmlPath)
    if (!entry) continue

    let xhtml = entry.getData().toString("utf-8")
    const originalXhtml = xhtml
    const hasXtcLink = xhtml.includes("_xtc_styles.css")
    // Remove explicit width/height and inline styles from ALL <img> tags
    xhtml = xhtml.replace(/<img[^>]*>/gi, (match) => {
      let m = match
      // Strip width="..." and width='...'
      m = m.replace(/\s+width\s*=\s*["'][^"']*["']/gi, '')
      // Strip height="..." and height='...'
      m = m.replace(/\s+height\s*=\s*["'][^"']*["']/gi, '')
      // Strip style="..." and style='...'
      m = m.replace(/\s+style\s*=\s*"[^"]*"/gi, '')
      m = m.replace(/\s+style\s*=\s*'[^']*'/gi, '')
      return m.replace(/<img(?=\s|>)/i, '<img style="max-width:100%;height:auto;display:block;margin:0 auto;"')
    })
    // Fix Calibre cover SVGs with preserveAspectRatio="none"
    xhtml = fixCoverPageSvg(xhtml)
    if (!hasXtcLink) xhtml = xhtml.replace(/<\/head>/i, `${xtcLinkTag}</head>`)
    if (xhtml !== originalXhtml) {
      zip.deleteFile(xhtmlPath)
      zip.addFile(xhtmlPath, Buffer.from(xhtml, "utf-8"))
      changed = true
    }
  }

  // Re-read OPF (may have been modified by cover injection)
  const currentOpfEntry = zip.getEntry(opfPath)
  if (!currentOpfEntry) return false
  let opfContent = currentOpfEntry.getData().toString("utf-8")
  if (!/href\s*=\s*["']_xtc_styles\.css["']/i.test(opfContent)) {
    const manifestClose = opfContent.indexOf("</manifest>")
    if (manifestClose === -1) return changed
    opfContent = opfContent.slice(0, manifestClose) + `  <item id="_xtc_styles" href="_xtc_styles.css" media-type="text/css"/>\n  ` + opfContent.slice(manifestClose)
    zip.deleteFile(opfPath)
    zip.addFile(opfPath, Buffer.from(opfContent, "utf-8"))
    changed = true
  }
  return changed
}

/**
 * Fix cover SVGs that force stretching. Calibre commonly writes
 * preserveAspectRatio="none" on the generated titlepage SVG.
 */
function fixCoverPageSvg(xhtml: string): string {
  xhtml = xhtml.replace(
    /preserveAspectRatio\s*=\s*(?:"none"|'none'|none)/gi,
    'preserveAspectRatio="xMidYMid meet"'
  )

  xhtml = xhtml.replace(/<svg\b([^>]*\bviewBox\s*=\s*["'][^"']+["'][^>]*)>/gi, (match, attrs: string) => {
    if (/preserveAspectRatio\s*=/i.test(attrs)) return match
    return `<svg${attrs} preserveAspectRatio="xMidYMid meet">`
  })

  xhtml = xhtml.replace(/<image\b([^>]*?)(\/?)>/gi, (match, attrs: string, slash: string) => {
    if (/preserveAspectRatio\s*=/i.test(attrs)) return match
    return `<image${attrs} preserveAspectRatio="xMidYMid meet"${slash}>`
  })

  if (isCoverLikeXhtml(xhtml)) {
    if (!xhtml.includes("_xtc_cover_fix")) {
      const coverFixStyle = `<style type="text/css" title="_xtc_cover_fix">${COVER_CENTER_CSS}</style>`
      xhtml = xhtml.replace(/<\/head>/i, `${coverFixStyle}</head>`)
    }
    xhtml = centerCoverBody(xhtml)
  }

  return xhtml
}

function isCoverLikeXhtml(xhtml: string): boolean {
  return /<meta\b[^>]+name\s*=\s*["']calibre:cover["'][^>]*>/i.test(xhtml) ||
    /<meta\b[^>]+content\s*=\s*["']cover["'][^>]*>/i.test(xhtml) ||
    /<title>\s*cover\s*<\/title>/i.test(xhtml)
}

function centerCoverBody(xhtml: string): string {
  if (/class\s*=\s*["'][^"']*\b_xtc_cover_center\b/i.test(xhtml)) return xhtml

  const bodyMatch = xhtml.match(/<body\b([^>]*)>([\s\S]*?)<\/body>/i)
  if (!bodyMatch || bodyMatch.index === undefined) return xhtml

  const bodyAttrs = bodyMatch[1] || ""
  const bodyContent = bodyMatch[2]
  const mediaMatch = bodyContent.match(/<svg\b[\s\S]*?<\/svg>/i) || bodyContent.match(/<img\b[^>]*\/?>/i)
  if (!mediaMatch) return xhtml

  const centeredBody =
    `<body${bodyAttrs}>` +
    `<div class="_xtc_cover_center"><div class="_xtc_cover_cell">${mediaMatch[0]}</div></div>` +
    `</body>`

  return xhtml.slice(0, bodyMatch.index) + centeredBody + xhtml.slice(bodyMatch.index + bodyMatch[0].length)
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

function getImageDimensions(data: Buffer): { width: number; height: number } | null {
  if (
    data.length >= 24 &&
    data[0] === 0x89 &&
    data.toString("ascii", 1, 4) === "PNG"
  ) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
  }

  if (data.length >= 10 && data.toString("ascii", 0, 3) === "GIF") {
    return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) }
  }

  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < data.length) {
      while (data[offset] === 0xff) offset++
      const marker = data[offset++]
      if (marker === 0xd9 || marker === 0xda) break
      if (offset + 2 > data.length) break
      const length = data.readUInt16BE(offset)
      if (length < 2 || offset + length > data.length) break

      const isStartOfFrame =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      if (isStartOfFrame && length >= 7) {
        return { width: data.readUInt16BE(offset + 5), height: data.readUInt16BE(offset + 3) }
      }
      offset += length
    }
  }

  return null
}

/**
 * Check if an EPUB already has a cover page as its first spine item.
 * Looks for the first spine itemref and checks if the corresponding
 * manifest item is marked as a cover or contains only an image.
 */
function hasCoverPage(zip: AdmZip, opfPath: string, opf: Record<string, unknown>): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pkg = (opf as any)?.package ?? (opf as any)?.["opf:package"]
  if (!pkg) return false

  const spine = pkg.spine
  if (!spine) return false
  const itemrefs = Array.isArray(spine.itemref) ? spine.itemref : spine.itemref ? [spine.itemref] : []
  if (itemrefs.length === 0) return false

  const firstRef = itemrefs[0]
  const firstId: string = firstRef["@_idref"] || ""

  const manifest = pkg.manifest?.item
  if (!manifest) return false
  const items: Record<string, string>[] = Array.isArray(manifest) ? manifest : [manifest]

  const firstItem = items.find(item => item["@_id"] === firstId)
  if (!firstItem) return false
  const href = firstItem["@_href"] || ""

  // 1. First spine item's id or href contains "cover"
  if (firstId.toLowerCase().includes("cover") || href.toLowerCase().includes("cover")) return true

  // 2. First item has properties="cover-image" (EPUB3)
  if (firstItem["@_properties"]?.includes("cover-image")) return true

  // 3. OPF <guide> has a cover reference matching the first spine item
  const guide = pkg.guide
  if (guide) {
    const refs = Array.isArray(guide.reference) ? guide.reference : guide.reference ? [guide.reference] : []
    for (const ref of refs) {
      if (ref["@_type"] === "cover" && href && ref["@_href"]?.includes(href.split("/").pop() || "")) return true
    }
  }

  // 4. Content analysis: check if the XHTML is mostly an image wrapper
  const opfDir = opfPath.includes("/") ? opfPath.substring(0, opfPath.lastIndexOf("/") + 1) : ""
  const pagePath = href.startsWith("/") ? href.slice(1) : opfDir + href
  const entry = zip.getEntry(pagePath)
  if (!entry) return false

  const content = entry.getData().toString("utf-8").toLowerCase()
  const hasImage = content.includes("<img") || content.includes("<image") || content.includes("<svg")
  // Strip tags AND style/script blocks before measuring visible text
  const visibleText = content
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim()

  return hasImage && visibleText.length < 200
}

/**
 * Find the cover image href from OPF metadata.
 * Returns the resolved path relative to the EPUB root.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findCoverImageHref(opfPath: string, pkg: any): { href: string; mediaType: string } | null {
  const manifest = pkg.manifest?.item
  if (!manifest) return null
  const items: Record<string, string>[] = Array.isArray(manifest) ? manifest : [manifest]

  let coverItem: Record<string, string> | undefined

  // EPUB3: <item properties="cover-image" .../>
  coverItem = items.find(item =>
    item["@_properties"]?.split(/\s+/).includes("cover-image")
  )

  // EPUB2: <meta name="cover" content="<item-id>"/>
  if (!coverItem) {
    const metadata = pkg.metadata
    if (metadata) {
      const metas = Array.isArray(metadata.meta) ? metadata.meta : metadata.meta ? [metadata.meta] : []
      const coverMeta = metas.find((m: Record<string, string>) => m["@_name"] === "cover")
      if (coverMeta) {
        const coverId = coverMeta["@_content"]
        coverItem = items.find(item => item["@_id"] === coverId)
      }
    }
  }

  if (!coverItem) return null

  const href = coverItem["@_href"]
  const mediaType = coverItem["@_media-type"] || "image/jpeg"
  if (!href) return null

  const opfDir = opfPath.includes("/") ? opfPath.substring(0, opfPath.lastIndexOf("/") + 1) : ""
  const resolvedHref = href.startsWith("/") ? href.slice(1) : opfDir + href

  return { href: resolvedHref, mediaType }
}

/**
 * Ensure the EPUB has a cover page as its first content page.
 * If the EPUB already has one, returns the original buffer unchanged.
 * If not, injects a simple XHTML cover page referencing the embedded cover image.
 * Returns null if no cover image is found in the EPUB metadata.
 */
export function ensureCoverPage(epubBuffer: Buffer): Buffer | null {
  try {
    const zip = new AdmZip(epubBuffer)

    // Find OPF path from container.xml
    const containerEntry = zip.getEntry("META-INF/container.xml")
    if (!containerEntry) return null
    const container = parser.parse(containerEntry.getData().toString("utf-8"))
    const rootfile = container?.container?.rootfiles?.rootfile
    const opfPath: string | undefined = Array.isArray(rootfile)
      ? rootfile[0]?.["@_full-path"]
      : rootfile?.["@_full-path"]
    if (!opfPath) return null

    // Parse OPF
    const opfEntry = zip.getEntry(opfPath)
    if (!opfEntry) return null
    const opf = parser.parse(opfEntry.getData().toString("utf-8"))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pkg = (opf as any)?.package ?? (opf as any)?.["opf:package"]
    if (!pkg) return null

    const alreadyHasCover = hasCoverPage(zip, opfPath, opf)
    const opfDir = opfPath.includes("/") ? opfPath.substring(0, opfPath.lastIndexOf("/") + 1) : ""

    if (!alreadyHasCover) {
      // No cover page — inject one
      const coverInfo = findCoverImageHref(opfPath, pkg)
      const coverEntry = coverInfo ? zip.getEntry(coverInfo.href) : null
      if (coverInfo && coverEntry) {
        const coverImageRelative = coverInfo.href.startsWith(opfDir)
          ? coverInfo.href.substring(opfDir.length)
          : coverInfo.href
        const coverDimensions = getImageDimensions(coverEntry.getData()) ?? { width: 600, height: 800 }
        const coverImageHref = escapeXmlAttr(coverImageRelative)

        const xtcLinkTag = `<link rel="stylesheet" href="_xtc_styles.css" type="text/css"/>`
        const coverXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Cover</title>
${xtcLinkTag}
<style type="text/css" title="_xtc_cover_fix">${COVER_CENTER_CSS}</style>
</head>
<body><div class="_xtc_cover_center"><div class="_xtc_cover_cell"><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100%" height="100%" viewBox="0 0 ${coverDimensions.width} ${coverDimensions.height}" preserveAspectRatio="xMidYMid meet"><image href="${coverImageHref}" xlink:href="${coverImageHref}" width="${coverDimensions.width}" height="${coverDimensions.height}" preserveAspectRatio="xMidYMid meet"/></svg></div></div></body>
</html>`

        const coverPagePath = opfDir + "_xtc_cover.xhtml"
        zip.addFile(coverPagePath, Buffer.from(coverXhtml, "utf-8"))

        // Update OPF: add cover page + CSS manifest items and spine entry
        let opfContent = opfEntry.getData().toString("utf-8")
        const manifestClose = opfContent.indexOf("</manifest>")
        if (manifestClose !== -1) {
          opfContent = opfContent.slice(0, manifestClose) +
            `  <item id="_xtc_cover_page" href="_xtc_cover.xhtml" media-type="application/xhtml+xml"/>\n  ` +
            opfContent.slice(manifestClose)
        }
        const spineMatch = opfContent.match(/<spine[^>]*>/)
        if (spineMatch) {
          const spineTagEnd = opfContent.indexOf(">", opfContent.indexOf(spineMatch[0])) + 1
          opfContent = opfContent.slice(0, spineTagEnd) + `\n    <itemref idref="_xtc_cover_page"/>` + opfContent.slice(spineTagEnd)
        }
        zip.deleteFile(opfPath)
        zip.addFile(opfPath, Buffer.from(opfContent, "utf-8"))
      }
    }

    // Always inject image aspect-ratio CSS
    injectImageCss(zip, opfPath, pkg)

    return zip.toBuffer()
  } catch {
    return null
  }
}
