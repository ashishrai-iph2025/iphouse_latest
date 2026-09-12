// A panel, as a PNG somebody can put in a deck.
//
// ── Why this captures the PANEL and not the <svg> ────────────────────────────
//
// It used to serialise the chart's SVG. That worked for five of this report's
// visuals and for none of the rest, because most of them are not SVG at all:
//
//   Recharts, so an <svg>   ·  the trend, the rate, the donut, the bar chart,
//                              the column chart
//   Hand-drawn <svg>        ·  the world map, the season columns
//   Plain HTML and CSS      ·  GROUPED BARS — which is the default every
//                              breakdown opens on — plus stacked 100%, single
//                              bars, the ranked table, the heat grid and the
//                              repeat-offender list
//
// So the option was greyed out on most of the page, under a tooltip that said
// the panel was showing a table when it was showing a chart. There is no
// version of "find the chart element" that covers a set like that: the chart
// IS the panel body, in whatever it happens to be made of.
//
// The body is therefore cloned, its computed styles are written onto the clone,
// and the whole thing is rasterised through a <foreignObject>. One path, every
// visual, and what comes out is what was on screen — including the value
// labels, the axis and the legend, none of which had to be redrawn by hand.
//
// ── What is copied, and what is deliberately not ─────────────────────────────
//
// Computed styles are inlined for HTML elements ONLY. An SVG element's layout
// lives in presentation attributes — `transform="translate(60,10)"` on a
// Recharts group, for one — and those serialise on their own; writing the
// computed CSS `transform: none` over the top of them would flatten every chart
// into its top-left corner. Their type is handled by one rule in the wrapper
// instead.
//
// ── Why the fonts change ─────────────────────────────────────────────────────
//
// An SVG loaded through an <img> cannot fetch anything — no stylesheets, no web
// fonts — so Poppins is not available no matter what the clone's CSS says.
// A system stack is substituted as the styles are copied, so the result is
// consistent between browsers rather than falling back to whatever the
// renderer's default happens to be.

import { safeFilename, saveBlob } from '@/lib/xlsx'
import { canvasOverlays, type CanvasOverlay } from '@/lib/flattenCanvas'
import { exportLogo, LOGO_PNG_H } from '@/lib/exportBrand'

const FONT = '"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'

export interface ChartImageOptions {
  /** The panel's name, printed across the top. */
  title: string
  /** The window, the client and the filters — what the picture is OF. Printed
      under the title, because a chart in a deck a month later has no page
      around it to say. */
  subtitle?: string
  /** Where it came from, printed small along the bottom. */
  footer?: string
  /** Device pixels per CSS pixel. Two is the difference between a chart that
      survives a projector and one that does not. */
  scale?: number
  dark?: boolean
}

/* The properties worth carrying, rather than every one the browser computes.
 *
 * A full computed style is ~340 declarations. Written onto three hundred nodes
 * that is a megabyte and a half of style attributes before the image is even
 * encoded, and the great majority of them — every `scroll-*`, every `-webkit-`
 * alias, every animation property on an element that does not animate — change
 * nothing about a still picture of a bar chart.
 *
 * These are what these panels are actually built out of: boxes, flex and grid,
 * type, and paint. */
const COPY_PROPS = [
  'display', 'position', 'top', 'right', 'bottom', 'left', 'z-index', 'float',
  'box-sizing', 'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'overflow-x', 'overflow-y', 'visibility',

  'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis',
  'align-items', 'align-self', 'align-content', 'justify-content', 'justify-items',
  'gap', 'row-gap', 'column-gap', 'order',
  'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row',
  'grid-auto-flow', 'grid-auto-rows',

  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant-numeric',
  'line-height', 'letter-spacing', 'text-align', 'text-transform', 'text-decoration-line',
  'text-overflow', 'white-space', 'word-break', 'vertical-align', 'direction',

  'color', 'background-color', 'background-image', 'background-size',
  'background-position', 'background-repeat', 'opacity', 'box-shadow',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-top-left-radius', 'border-top-right-radius',
  'border-bottom-left-radius', 'border-bottom-right-radius',
  'transform', 'transform-origin', 'list-style-type',
]

/** Walk the original and the clone together, writing what the browser resolved
 *  onto the copy. In step because cloneNode(true) preserves child order. */
function inlineStyles(src: Element, dst: Element): void {
  /* SVG subtrees are left entirely alone — see the note at the top on why
     writing computed CSS over presentation attributes destroys them. Their
     children are skipped with them. */
  if (!(src instanceof SVGElement)) {
    const cs = window.getComputedStyle(src)
    const out = (dst as HTMLElement).style
    for (const p of COPY_PROPS) {
      const v = cs.getPropertyValue(p)
      if (!v) continue
      // Poppins cannot be fetched by an image; substituted here rather than
      // left to the renderer's default.
      out.setProperty(p, p === 'font-family' ? FONT : v)
    }
    const sk = src.children
    const dk = dst.children
    for (let i = 0; i < sk.length && i < dk.length; i++) inlineStyles(sk[i], dk[i])
  }
}

/**
 * The panel body, as an image the canvas can draw — plus the canvases it could
 * not carry.
 *
 * A canvas-drawn chart (the Toast UI engine) clones as an empty element and
 * cannot be substituted with a data-URI <img>, because this SVG is loaded
 * through an <img> and may not fetch anything. It survives as a transparent box
 * of the right size, and the caller paints the real pixels into that box
 * afterwards. See lib/flattenCanvas.ts.
 */
async function bodyToImage(root: HTMLElement): Promise<{
  img: HTMLImageElement; w: number; h: number; overlays: CanvasOverlay[]
}> {
  const box = root.getBoundingClientRect()
  const w = Math.max(1, Math.ceil(box.width))
  const h = Math.max(1, Math.ceil(box.height))

  const clone = root.cloneNode(true) as HTMLElement
  inlineStyles(root, clone)
  clone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml')
  /* Its own box, said explicitly. The clone is about to be laid out inside a
     foreignObject with no parent to take a width from, and a panel that
     measured 900px on the page would otherwise reflow to the object's own. */
  clone.style.width = `${w}px`
  clone.style.height = `${h}px`
  clone.style.margin = '0'

  const markup = new XMLSerializer().serializeToString(clone)
  const src =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    // The one rule the SVG subtrees need, since their styles were not inlined.
    `<style>text{font-family:${FONT};}</style>` +
    `<foreignObject x="0" y="0" width="100%" height="100%">${markup}</foreignObject>` +
    `</svg>`

  const img = new Image()
  // encodeURIComponent rather than btoa: the labels are full of non-Latin-1
  // characters — dashes, accented club names — and btoa throws on every one.
  /* onload, NOT decode(), for the reason set out in lib/exportBrand.ts: in a
     HIDDEN document Chromium never settles decode() — it neither resolves nor
     rejects — so a reader who starts an export and switches tab gets no file
     and no error. onload is all drawImage needs. The rejection path matters
     here too: a malformed serialisation should fail the export loudly rather
     than leave it pending forever. */
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('panel image failed to load'))
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(src)}`
  })
  return { img, w, h, overlays: canvasOverlays(root) }
}

/**
 * A panel, as a PNG blob, captioned.
 *
 * `root` is the card's body — the chart and everything drawn with it. The
 * title, the scope and the footer come from the options and are painted around
 * it, because those live in the card's header, which is this application's
 * chrome and not part of the picture.
 */
export async function chartToPng(root: HTMLElement, opts: ChartImageOptions): Promise<Blob> {
  const { img, w, h, overlays } = await bodyToImage(root)
  /* Null where the mark would not load. The picture is still produced — a
     download is somebody's work leaving the building, and a decorative image
     is not a reason to withhold it. */
  const logo = await exportLogo()

  const scale = opts.scale ?? 2
  const dark = !!opts.dark
  const ink = dark ? '#F1F5F9' : '#14254A'
  const muted = dark ? 'rgba(241,245,249,0.6)' : '#6B7C93'
  const faint = dark ? 'rgba(241,245,249,0.38)' : '#9AA7B8'
  const paper = dark ? '#1A2D55' : '#FFFFFF'

  const PAD = 24
  const titleH = 26
  const subH = opts.subtitle ? 18 : 0
  /* The mark's own band, above the title. Centred on the SHEET rather than over
     the panel, which is the same thing here — the panel is the sheet less two
     equal margins — and stays right if those margins ever differ. */
  const logoH = logo ? LOGO_PNG_H : 0
  const logoW = logo ? Math.round(LOGO_PNG_H * logo.ratio) : 0
  const brandH = logo ? logoH + 14 : 0
  const footH = opts.footer ? 26 : 0
  const totalW = w + PAD * 2
  const headH = PAD + brandH + titleH + subH + 8
  const totalH = headH + h + footH + PAD

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(totalW * scale)
  canvas.height = Math.round(totalH * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser would not give us a canvas to draw on.')
  ctx.scale(scale, scale)

  // An explicit ground. A PNG with a transparent background looks fine in this
  // application and unreadable on a dark slide.
  ctx.fillStyle = paper
  ctx.fillRect(0, 0, totalW, totalH)

  /* The mark first, top and centre, and everything the header held before it
     moves down by its band.

     ON A DARK EXPORT IT IS DRAWN WHITE. The wordmark is navy ink — it is the
     same file the navy sidebar renders with `brightness-0 invert` — and a navy
     mark on this export's #1A2D55 paper is a mark nobody can see. Recoloured
     rather than swapped for a second asset: `source-in` fills the shape the
     mark already has, so the two stay one file and cannot drift apart. */
  if (logo) {
    /* LEFT, level with the title and the content below it, rather than centred
       over the canvas. A picture of one card is not a letterhead — the mark
       belongs where the reading starts, in line with everything else on it. */
    const x = PAD
    if (dark) {
      const tint = document.createElement('canvas')
      tint.width = Math.max(1, logoW)
      tint.height = Math.max(1, logoH)
      const tctx = tint.getContext('2d')
      if (tctx) {
        tctx.drawImage(logo.img, 0, 0, logoW, logoH)
        tctx.globalCompositeOperation = 'source-in'
        tctx.fillStyle = '#FFFFFF'
        tctx.fillRect(0, 0, logoW, logoH)
        ctx.drawImage(tint, x, PAD, logoW, logoH)
      }
    } else {
      ctx.drawImage(logo.img, x, PAD, logoW, logoH)
    }
  }

  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = ink
  ctx.font = `700 16px ${FONT}`
  ctx.fillText(opts.title, PAD, PAD + brandH + 16)

  if (opts.subtitle) {
    ctx.fillStyle = muted
    ctx.font = `400 11.5px ${FONT}`
    ctx.fillText(opts.subtitle, PAD, PAD + brandH + titleH + 10)
  }

  ctx.drawImage(img, PAD, headH, w, h)

  /* The canvas-drawn charts, into the transparent boxes the panel left for
     them. Guarded individually: one chart that will not composite must not cost
     the reader the whole picture. */
  for (const o of overlays) {
    try { ctx.drawImage(o.canvas, PAD + o.x, headH + o.y, o.w, o.h) } catch { /* skip it */ }
  }

  if (opts.footer) {
    ctx.fillStyle = faint
    ctx.font = `400 10px ${FONT}`
    ctx.fillText(opts.footer, PAD, totalH - PAD + 8)
  }

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('The image could not be encoded.')), 'image/png')
  })
}

/** The whole job, for a caller that only wants the file. */
export async function downloadChartPng(
  root: HTMLElement, filename: string, opts: ChartImageOptions,
): Promise<void> {
  saveBlob(await chartToPng(root, opts), `${safeFilename(filename)}.png`)
}
