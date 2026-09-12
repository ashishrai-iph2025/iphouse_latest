// The IP House mark, on everything that leaves the product as a file.
//
// A panel PNG, a report PDF and a workbook are all things somebody forwards.
// The moment one leaves the browser it has no page around it and no address
// bar above it — it is a picture of numbers with no statement of whose numbers
// they are. The mark, top and centre, is that statement, and it is the one part
// of the export that has to be identical across all three: three exports of one
// reading must not arrive looking like three different companies.
//
// ── Why the bitmap is re-rendered rather than used as it ships ───────────────
//
// public/newlogo.png is 6300×1728 and 105KB, which is right for a retina
// screen and wrong for a file. Embedded as-is it would be a quarter of a
// typical workbook, in three copies of a mark forty pixels tall. It is decoded
// once, drawn into a canvas at the size an export actually shows it, and read
// back as PNG bytes — a couple of kilobytes, and the same pixels reach the
// canvas rasteriser, the print document and the spreadsheet package.
//
// ── Why every failure is silent ──────────────────────────────────────────────
//
// `logo()` resolves to null rather than rejecting. A download is somebody's
// work leaving the building; a decorative image that would not load must not be
// the reason they do not get it. Every caller draws the header without it.

const LOGO_SRC = '/newlogo.png'

/** How tall the mark is drawn, in CSS pixels, in each of the three exports. */
export const LOGO_PNG_H = 26
export const LOGO_PDF_H = 30
export const LOGO_XLSX_H = 34

/* Rasterised at twice the largest of those, so the PNG export — which is itself
   rendered at 2× — has real pixels to draw rather than an upscale. */
const RASTER_H = LOGO_XLSX_H * 2

export interface ExportLogo {
  /** Decoded and ready for ctx.drawImage. */
  img: HTMLImageElement
  /** The same pixels as a PNG file, for the spreadsheet package. */
  bytes: Uint8Array
  /** A data URL, for a document that cannot reach the server's own paths. */
  dataUrl: string
  /** The rasterised size. Callers scale by height and keep this ratio. */
  width: number
  height: number
  /** width / height — what a caller needs to place it at any height. */
  ratio: number
}

let pending: Promise<ExportLogo | null> | null = null

/**
 * The mark, loaded and rasterised once per page.
 *
 * Memoised on the PROMISE rather than on the result, so a reader who exports a
 * panel and the whole report a second apart does not fetch and re-decode it
 * twice.
 */
export function exportLogo(): Promise<ExportLogo | null> {
  return (pending ??= load())
}

/*
	How long any one step of the logo load may take before the export gives up on
	it and ships unbranded.

	Generous, because this is a local asset and the only thing waiting on it is a
	file the reader has already asked for — a slow disk should not cost them the
	branding. Short enough that a stall is a two-second delay rather than a
	download that never arrives.
*/
const LOGO_DEADLINE_MS = 2000

/** Rejects if the step has not settled in time, so a stall degrades to null the
    same way an error does. */
function withDeadline<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('logo load timed out')), LOGO_DEADLINE_MS)),
  ])
}

async function load(): Promise<ExportLogo | null> {
  try {
    const src = new Image()
    /* Same-origin, so this does not taint the canvas the PNG export draws it
       into — a tainted canvas cannot be read back and the whole download fails
       at toBlob with a security error rather than at the image. Set anyway, so
       that stays true if the asset ever moves to a CDN. */
    src.crossOrigin = 'anonymous'
    /* onload, NOT decode(), and a deadline over the top of it.

       decode() was the obvious choice — it settles when the image is ready to
       paint, so the drawImage below cannot land on nothing — and it is the
       reason an export could hang forever. In a HIDDEN document Chromium never
       settles it: not resolved, not rejected, no error for the catch below to
       turn into a null. Measured on this asset, same tab, same server: onload
       fired in 9ms and decode() was still pending after five seconds. A reader
       who clicks Download and switches tab while it works has a hidden
       document, and got no file and no message.

       onload is enough for what this actually does. decode() guarantees paint
       readiness for compositing; drawImage only needs the image loaded, which
       is exactly what onload means.

       The deadline is belt and braces over that. Nothing about a decorative
       image should be able to withhold somebody's export — that is what the
       comment at the head of this function has always claimed, and a race is
       what makes it true for a stall as well as for a failure. */
    await withDeadline(new Promise<void>((resolve, reject) => {
      src.onload = () => resolve()
      src.onerror = () => reject(new Error('logo failed to load'))
      src.src = LOGO_SRC
    }))

    const ratio = src.naturalWidth / Math.max(1, src.naturalHeight)
    const height = RASTER_H
    const width = Math.round(height * ratio)

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(src, 0, 0, width, height)

    const blob: Blob | null = await withDeadline(
      new Promise<Blob | null>(res => canvas.toBlob(res, 'image/png')))
    if (!blob) return null

    const bytes = new Uint8Array(await blob.arrayBuffer())

    /* Handed back as an <img> of the RASTERISED pixels rather than the original.
       The print document is written into a blank window whose base URL is
       about:blank, where a root-relative path resolves to nothing; a data URL
       resolves anywhere, and this one is small enough to inline. */
    const dataUrl = canvas.toDataURL('image/png')
    const img = new Image()
    await withDeadline(new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('rasterised logo failed to load'))
      img.src = dataUrl
    }))

    return { img, bytes, dataUrl, width, height, ratio }
  } catch {
    // Offline, blocked, moved, or a canvas this browser would not give us.
    return null
  }
}

/* ── The spreadsheet side ─────────────────────────────────────────────────────

   An image in an .xlsx is four parts and two relationships, and both of this
   product's workbook writers need the same four. They are here rather than
   duplicated because getting one of them subtly wrong does not produce a
   workbook with a missing picture — it produces a workbook Excel refuses to
   open, and debugging that twice is once too many.

   Callers still add two things themselves, because only they know their own
   part numbering: the `xl/media/logo.png` entry (the bytes above) and the
   Content-Types entries below.
*/

/** One CSS pixel, in the English Metric Units OOXML positions things in. */
export const EMU_PER_PX = 9525

/** Excel's column width unit is characters; this is that in pixels, for
 *  Calibri 11, which is the font both writers set. */
export const colWidthPx = (chars: number) => Math.round(chars * 7 + 5)

/** The Content-Types this adds: the PNG default, and one Override per drawing. */
export function xlsxLogoContentTypes(sheetCount: number): string {
  return '<Default Extension="png" ContentType="image/png"/>' +
    Array.from({ length: sheetCount }, (_, i) =>
      `<Override PartName="/xl/drawings/drawing${i + 1}.xml"` +
      ' ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>').join('')
}

/**
 * One sheet's drawing part: the mark, floating over the top-left cell, offset
 * to sit at the LEFT of the table.

 * Left rather than centred, and that is a property of the artefact rather than
 * a taste: a spreadsheet has no page width to be centred on. Its "middle" is
 * the middle of whatever columns it happens to have, so the same mark lands in
 * a different place on every sheet, and moves when a column is widened. Column
 * A's left edge is the one fixed point every sheet shares — and it is where a
 * reader's eye starts, which is the other half of the argument.
 *
 * `oneCellAnchor` rather than `twoCellAnchor`, deliberately: the picture keeps
 * the size given here whatever the reader does to the column widths, where a
 * two-cell anchor would stretch it between them.
 *
 * And NO `editAs` attribute. It is tempting — it is what pins a two-cell anchor
 * against row inserts — but CT_OneCellAnchor does not have it in the schema,
 * and a strict reader does not shrug at an attribute that is not there: it
 * fails the whole drawing part, which is a workbook with no picture in it at
 * best and one Excel offers to repair at worst. Verified against a real reader
 * both ways round.
 */
export function xlsxLogoDrawing(w: number, h: number, offsetXpx: number, offsetYpx: number): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"' +
    ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    '<xdr:oneCellAnchor>' +
    '<xdr:from><xdr:col>0</xdr:col>' +
    `<xdr:colOff>${Math.round(offsetXpx * EMU_PER_PX)}</xdr:colOff>` +
    '<xdr:row>0</xdr:row>' +
    `<xdr:rowOff>${Math.round(offsetYpx * EMU_PER_PX)}</xdr:rowOff></xdr:from>` +
    `<xdr:ext cx="${Math.round(w * EMU_PER_PX)}" cy="${Math.round(h * EMU_PER_PX)}"/>` +
    '<xdr:pic>' +
    '<xdr:nvPicPr><xdr:cNvPr id="1" name="IP House"/><xdr:cNvPicPr/></xdr:nvPicPr>' +
    '<xdr:blipFill>' +
    '<a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId1"/>' +
    '<a:stretch><a:fillRect/></a:stretch>' +
    '</xdr:blipFill>' +
    '<xdr:spPr><a:xfrm><a:off x="0" y="0"/>' +
    `<a:ext cx="${Math.round(w * EMU_PER_PX)}" cy="${Math.round(h * EMU_PER_PX)}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>' +
    '</xdr:pic><xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>'
}

/** Every drawing points at the one media part; there is only ever one image. */
export const XLSX_DRAWING_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1"' +
  ' Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"' +
  ' Target="../media/logo.png"/>' +
  '</Relationships>'

/** A sheet's own rels, pointing at its drawing. One drawing part per sheet:
 *  a part shared between two sheets is not valid OOXML. */
export function xlsxSheetRels(sheetIndex: number): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rIdDrawing"' +
    ' Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing"' +
    ` Target="../drawings/drawing${sheetIndex + 1}.xml"/>` +
    '</Relationships>'
}

/** What goes inside the <worksheet> element, last. Order matters in OOXML:
 *  `drawing` comes after sheetData, autoFilter and mergeCells. */
export const XLSX_SHEET_DRAWING = '<drawing r:id="rIdDrawing"/>'
