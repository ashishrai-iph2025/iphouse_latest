// A <canvas> does not survive cloneNode. These are the two ways round it.
//
// Both of the report's export paths work by taking a copy of the card and
// serialising it — the panel PNG puts the copy through a <foreignObject>
// (lib/chartImage.ts), the whole-page PDF writes it into a second document
// (lib/printReport.ts). Neither carries a canvas across: `cloneNode` copies the
// ELEMENT, and the bitmap painted into it stays behind, so what serialises is a
// correctly sized, entirely blank box.
//
// That was invisible while every chart on the page was SVG. The Toast UI engine
// is canvas-only, so the moment a reader selects it, every panel it draws
// exports blank while looking perfect on screen — the worst kind of bug,
// because the person who hits it is the one putting the chart in front of a
// client.
//
// ── Why there are two functions and not one ──────────────────────────────────
//
// The obvious fix — swap each canvas for an <img> of its own pixels — works for
// the PDF and DOES NOT work for the PNG, and the reason is worth writing down
// because it looks like it should.
//
// An SVG loaded through an `<img>` is a sandboxed document: it may not fetch
// anything. Chrome counts a nested `data:` URI as a fetch, so an <img
// src="data:image/png;…"> inside the <foreignObject> is simply not painted —
// no error, no console warning, just a transparent hole where the chart was.
// (Measured: a probe SVG built exactly that way rasterises to zero non-empty
// pixels.) It is the same rule that stops Poppins loading in that path.
//
// So the PDF, which is a real second document and may load data: URIs, gets
// `flattenCanvases`. The PNG, which is not, leaves the canvas in place — an
// empty one serialises as a transparent box of the right size — and paints the
// real bitmaps over the top afterwards, on a canvas, where no sandbox applies.

/**
 * Replace every <canvas> in `dst` with an image of the matching canvas in
 * `src`. The two trees must be a node and its own `cloneNode(true)` — they are
 * walked in step by child index, which `cloneNode` guarantees.
 *
 * For a clone that lands in a REAL document. See the note above for why the
 * PNG path cannot use this.
 */
export function flattenCanvases(src: Element, dst: Element): void {
  if (src instanceof HTMLCanvasElement) {
    if (!(dst instanceof HTMLElement)) return
    const box = src.getBoundingClientRect()
    const w = Math.round(box.width) || src.width
    const h = Math.round(box.height) || src.height
    if (!w || !h) return
    let url: string
    try {
      url = src.toDataURL('image/png')
    } catch {
      /* Tainted by a cross-origin draw. Nothing here does that today, but a
         blank box is a better outcome than an exception that takes the whole
         export down with it. */
      return
    }
    const img = document.createElement('img')
    img.src = url
    img.width = w
    img.height = h
    // Said in CSS as well as in the attributes: the PNG path inlines computed
    // styles onto everything else, and an <img> with no style rule of its own
    // picks up the `img{max-width:100%}` of whatever document it lands in.
    img.style.width = `${w}px`
    img.style.height = `${h}px`
    img.style.display = 'block'
    dst.replaceWith(img)
    return
  }
  const sk = src.children
  const dk = dst.children
  for (let i = 0; i < sk.length && i < dk.length; i++) flattenCanvases(sk[i], dk[i])
}

/** A live canvas and where it sits inside the panel, in CSS pixels. */
export interface CanvasOverlay {
  canvas: HTMLCanvasElement
  x: number
  y: number
  w: number
  h: number
}

/**
 * Every canvas in `root`, with its offset from `root`'s own top-left.
 *
 * For the PNG path: the rasteriser draws the panel first and then paints these
 * over it, at these offsets, straight from the live elements. Positions are
 * measured rather than tracked, so a chart that laid itself out differently at
 * this width lands where it actually is.
 */
export function canvasOverlays(root: HTMLElement): CanvasOverlay[] {
  const base = root.getBoundingClientRect()
  return Array.from(root.querySelectorAll('canvas'))
    .map(canvas => {
      const box = canvas.getBoundingClientRect()
      return {
        canvas,
        x: box.left - base.left,
        y: box.top - base.top,
        w: box.width,
        h: box.height,
      }
    })
    // A zero-sized canvas is one the library created and never drew into;
    // drawImage throws on it rather than drawing nothing.
    .filter(o => o.w > 0 && o.h > 0)
}
