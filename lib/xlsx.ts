// A real .xlsx, written here, with nothing installed.
//
// ── Why not a library ────────────────────────────────────────────────────────
//
// The obvious answer is SheetJS. It is also 800KB into a bundle that is
// currently 330KB, for the one feature of it this product uses — a grid of
// strings and numbers with a bold header — and the npm build of it is not the
// one its authors maintain. A workbook of that shape is about two hundred lines
// of XML in a zip, and this is those two hundred lines.
//
// ── Why not CSV ──────────────────────────────────────────────────────────────
//
// A report is a dozen charts. CSV is one table per file, so the download would
// be a dozen files or a dozen tables run together in one, and neither is the
// thing that was asked for: the point of the export is that the charts arrive
// as a set, each one named, in the order they are on the page. That is a
// workbook with a tab per chart, which is a format CSV does not have.
//
// ── Why STORED rather than deflated ──────────────────────────────────────────
//
// Every entry goes in uncompressed. `CompressionStream('deflate-raw')` exists
// and would roughly quarter the file, but it is async, it is not in every
// browser this product supports, and the numbers involved are small — a report
// with two thousand rows across a dozen sheets writes about 400KB. A download
// that is reliably produced beats one that is smaller.
//
// The result opens in Excel, LibreOffice, Numbers and Google Sheets with no
// "the file format does not match its extension" warning, which is the thing
// the HTML-table-named-.xls trick can never manage.

import {
  LOGO_XLSX_H, XLSX_DRAWING_RELS, XLSX_SHEET_DRAWING, colWidthPx, exportLogo,
  xlsxLogoContentTypes, xlsxLogoDrawing, xlsxSheetRels,
} from '@/lib/exportBrand'

/** One cell. `null`/`undefined` are written as genuinely empty, NOT as "" or 0
 *  — a blank is a fact about the data and a zero is a different one. */
export type Cell = string | number | null | undefined

export interface Sheet {
  /** The tab's name. Sanitised and de-duplicated on the way in — Excel refuses
      a workbook with two tabs of one name rather than opening it oddly. */
  name: string
  /** Printed into A1, above the table. The tab name is limited to 31
      characters and strips punctuation Excel reserves, so a panel called
      "Top domains — identified & removed" survives only here. */
  title?: string
  /** The scope the sheet was taken under, in A2. A table of numbers with no
      window and no filters on it is a table somebody will read the wrong way a
      month from now. */
  subtitle?: string
  head: string[]
  rows: Cell[][]
}

/* ── XML ──────────────────────────────────────────────────────────────────── */

/** XML-escape, and drop the control characters XML 1.0 has no encoding for.
 *  Warehouse rows carry whatever a scraper found in a page title, and one stray
 *  0x0B is the difference between a workbook and a repair dialog. */
function xml(v: string): string {
  return v
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** A1, Z1, AA1… Spelled out rather than assumed to stay under 26 columns. */
function colName(i: number): string {
  let s = ''
  let n = i
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  }
  return s
}

/* Style ids, matching the order of <cellXfs> in styles.xml below. */
const S_BODY = 0
const S_HEAD = 1
const S_TITLE = 2
const S_SUB = 3
const S_NUM = 4

function cellXml(ref: string, v: Cell, style: number): string {
  if (v === null || v === undefined || v === '') {
    // Still emitted, with its style, so the header fill and the banding do not
    // break where a row has a gap in it.
    return `<c r="${ref}" s="${style}"/>`
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    return `<c r="${ref}" s="${style === S_BODY ? S_NUM : style}"><v>${v}</v></c>`
  }
  /* Inline strings rather than a shared-strings table. The table is a size
     optimisation for workbooks that repeat one string thousands of times;
     these repeat almost nothing, and it is a whole second part to keep
     consistent for no gain here. */
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(String(v))}</t></is></c>`
}

/*
── COLUMN WIDTHS: THE WIDEST VALUE, IN FULL ─────────────────────────────────

	Every column is sized to its longest cell so nothing arrives cut off.

	It used to cap at 58 characters, which is narrower than a great many of the
	values this report carries — an infringing URL with its query string runs
	past 200. Excel does not wrap or ellipsize a too-narrow cell: it shows what
	fits and hides the rest behind the next column, so a reader scanning a
	downloaded sheet sees a URL that ends in the middle and no indication that
	it does. The value is intact in the cell and invisible on the screen, which
	is the worst of both.

	The cap existed to stop one long column pushing the others off-screen. That
	is a real cost, but it is a NAVIGATION cost the reader can fix by dragging a
	column, and they can only fix it if the data is there to find. A silently
	truncated display is not fixable, because nothing says anything is missing.

	A ceiling remains, an order of magnitude higher, and it is only about
	Excel's own limit: the format refuses a width above 255 characters and
	rejects the file. So values longer than that still need a drag — but they
	are a handful of extreme URLs rather than most of a column.

	The +2 is padding for the cell border and the autofilter arrow on the header
	row, which otherwise sits on top of the last character of the title.
*/
const XLSX_MIN_COL_CHARS = 9
const XLSX_MAX_COL_CHARS = 255   // the format's own ceiling; wider is rejected

function sheetWidths(s: Sheet): number[] {
  return s.head.map((h, i) => {
    let w = String(h ?? '').length
    for (const line of s.rows) {
      const v = line[i]
      if (v !== null && v !== undefined) w = Math.max(w, String(v).length)
    }
    return Math.min(XLSX_MAX_COL_CHARS, Math.max(XLSX_MIN_COL_CHARS, w + 2))
  })
}

function sheetXml(s: Sheet, brand: SheetBrand | null): string {
  const rows: string[] = []
  let r = 0

  const row = (cells: string[], attrs = '') => {
    r += 1
    rows.push(`<row r="${r}"${attrs}>${cells.join('')}</row>`)
  }

  /* An empty row, tall enough to clear the mark floating over it.

     The picture is ANCHORED rather than in a cell — a spreadsheet has no cell
     that holds an image — so nothing about the grid knows it is there, and
     without a row made room for it the mark would sit on top of the title.
     Height in POINTS, which is what a row is measured in; three quarters of a
     pixel each. */
  if (brand) row([], ` ht="${(brand.h + 10) * 0.75}" customHeight="1"`)

  if (s.title) row([cellXml(`A${r + 1}`, s.title, S_TITLE)])
  if (s.subtitle) row([cellXml(`A${r + 1}`, s.subtitle, S_SUB)])
  if (s.title || s.subtitle) row([]) // a blank line, so the table starts clear

  const headRow = r + 1
  row(s.head.map((h, i) => cellXml(`${colName(i)}${headRow}`, h, S_HEAD)))

  for (const line of s.rows) {
    const at = r + 1
    row(s.head.map((_, i) => cellXml(`${colName(i)}${at}`, line[i], S_BODY)))
  }

  const widths = sheetWidths(s)
  const cols = widths.length
    ? `<cols>${widths.map((w, i) =>
        `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : ''

  /* The header row is frozen and filtered. Both are what somebody does first
     on receiving a sheet of a few hundred rows, and neither survives being
     left to them — a reader who scrolls past the header is reading unlabelled
     columns, which is how an "identified" figure gets quoted as a "removed"
     one. */
  const freeze = `<sheetViews><sheetView workbookViewId="0">` +
    `<pane ySplit="${headRow}" topLeftCell="A${headRow + 1}" activePane="bottomLeft" state="frozen"/>` +
    `</sheetView></sheetViews>`
  const filter = s.rows.length
    ? `<autoFilter ref="A${headRow}:${colName(Math.max(0, s.head.length - 1))}${r}"/>`
    : ''

  /* `drawing` LAST, and that is not a preference. The worksheet element has a
     fixed child order in the schema — sheetViews, cols, sheetData, autoFilter,
     then a long tail ending in drawing — and a part out of order is not a
     workbook that opens oddly, it is one Excel refuses to open. The `r`
     namespace comes with it, since the reference is an r:id. */
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' +
    (brand ? ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' : '')

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet ${ns}>${freeze}${cols}<sheetData>${rows.join('')}</sheetData>${filter}${
    brand ? XLSX_SHEET_DRAWING : ''}</worksheet>`
}

/** What one sheet needs to know about the mark floating over it: how big it is
 *  drawn, and how far in it sits to be centred over that sheet's own columns. */
interface SheetBrand { w: number; h: number; offsetX: number }

/**
 * Where the mark goes on one sheet.
 *
 * Centred over THE TABLE, not over the window: a sheet is as wide as the reader
 * drags it and there is no page to centre on, so the only stable middle is the
 * middle of the columns the sheet actually has. Those are set in characters a
 * few lines above; Excel renders a character of Calibri 11 as seven pixels plus
 * five of padding, which is what colWidthPx converts.
 *
 * At the LEFT edge — column A, no offset. See exportBrand.ts for why a sheet is
 * the one artefact where centring is the wrong answer: there is no page to be
 * centred on, so "the middle" moves whenever a column does.
 */
function brandFor(s: Sheet, logo: { ratio: number } | null): SheetBrand | null {
  if (!logo) return null
  const h = LOGO_XLSX_H
  return { w: Math.round(h * logo.ratio), h, offsetX: 0 }
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="4">
<font><sz val="11"/><color rgb="FF1F2937"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
<font><b/><sz val="14"/><color rgb="FF14254A"/><name val="Calibri"/></font>
<font><sz val="10"/><color rgb="FF7A8699"/><name val="Calibri"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF14254A"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`

/* ── Tab names ────────────────────────────────────────────────────────────── */

/** Excel's rules, not ours: 31 characters, none of `[]:*?/\`, not blank, and no
 *  two the same in one workbook. Broken, the file does not open oddly — it does
 *  not open. */
function tabNames(sheets: Sheet[]): string[] {
  const used = new Set<string>()
  return sheets.map((s, i) => {
    let base = String(s.name ?? '').replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31)
    if (!base) base = `Sheet ${i + 1}`
    let name = base
    let n = 2
    // Numbered from the second collision, and the suffix eats into the 31
    // rather than pushing past it.
    while (used.has(name.toLowerCase())) {
      const tag = ` (${n++})`
      name = base.slice(0, 31 - tag.length) + tag
    }
    used.add(name.toLowerCase())
    return name
  })
}

/* ── Zip ──────────────────────────────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

function crc32(b: Uint8Array): number {
  let c = 0xFFFFFFFF
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

/** MS-DOS date and time, which is what a zip entry carries. Two-second
 *  resolution and an epoch of 1980; both are the format's, not a shortcut. */
function dosStamp(d: Date): { date: number; time: number } {
  return {
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
  }
}

/** One entry. `text` is encoded as UTF-8; `bytes` goes in as it is — the mark
 *  is a PNG, and a PNG run through TextEncoder is a corrupt PNG. */
interface ZipEntry { name: string; text?: string; bytes?: Uint8Array }

function zip(files: ZipEntry[]): Blob {
  const enc = new TextEncoder()
  const { date, time } = dosStamp(new Date())
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const f of files) {
    const nameBytes = enc.encode(f.name)
    const data = f.bytes ?? enc.encode(f.text ?? '')
    const crc = crc32(data)

    const local = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)      // version needed to extract
    lv.setUint16(6, 0x0800, true)  // UTF-8 names
    lv.setUint16(8, 0, true)       // stored
    lv.setUint16(10, time, true)
    lv.setUint16(12, date, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)

    const dir = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(dir.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)      // version made by
    cv.setUint16(6, 20, true)      // version needed
    cv.setUint16(8, 0x0800, true)
    cv.setUint16(10, 0, true)
    cv.setUint16(12, time, true)
    cv.setUint16(14, date, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint32(42, offset, true)
    dir.set(nameBytes, 46)

    parts.push(local, data)
    central.push(dir)
    offset += local.length + data.length
  }

  const centralSize = central.reduce((a, c) => a + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, files.length, true)
  ev.setUint16(10, files.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)

  /* Flattened into ONE buffer rather than handed to Blob as a list of views.
     Blob accepts the list perfectly well at runtime; TypeScript will not, since
     a Uint8Array's buffer is an ArrayBufferLike and a BlobPart wants an
     ArrayBuffer. Copying once, over a few hundred kilobytes, is cheaper than
     the cast that would otherwise sit here explaining itself. */
  const all = [...parts, ...central, end]
  const out = new Uint8Array(all.reduce((a, c) => a + c.length, 0))
  let at = 0
  for (const c of all) { out.set(c, at); at += c.length }

  return new Blob([out], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
}

/* ── The workbook ─────────────────────────────────────────────────────────── */

/**
 * The workbook, with the IP House mark at the top of every sheet.
 *
 * Async only because of the mark: it is fetched, rasterised once and memoised
 * (lib/exportBrand.ts), so the second export of a session waits on nothing. A
 * mark that will not load resolves to null and the workbook is built exactly as
 * it was before this existed — the numbers are what the reader asked for.
 */
export async function buildWorkbook(sheets: Sheet[]): Promise<Blob> {
  const names = tabNames(sheets)
  const logo = await exportLogo()
  const brands = sheets.map(s => brandFor(s, logo))

  const files: ZipEntry[] = [
    {
      name: '[Content_Types].xml',
      text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) =>
  `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
${logo ? xlsxLogoContentTypes(sheets.length) : ''}
</Types>`,
    },
    {
      name: '_rels/.rels',
      text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${names.map((n, i) =>
  `<sheet name="${xml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) =>
  `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    },
    { name: 'xl/styles.xml', text: STYLES },
    ...sheets.map((s, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`, text: sheetXml(s, brands[i]),
    })),
  ]

  /* The picture, once, plus a drawing part per sheet pointing at it. One media
     entry however many tabs there are; a drawing part cannot be shared between
     sheets, so those are per-sheet even though every one of them says the same
     thing. */
  if (logo) {
    files.push({ name: 'xl/media/logo.png', bytes: logo.bytes })
    for (let i = 0; i < sheets.length; i++) {
      const b = brands[i]
      if (!b) continue
      files.push(
        { name: `xl/worksheets/_rels/sheet${i + 1}.xml.rels`, text: xlsxSheetRels(i) },
        { name: `xl/drawings/drawing${i + 1}.xml`, text: xlsxLogoDrawing(b.w, b.h, b.offsetX, 4) },
        { name: `xl/drawings/_rels/drawing${i + 1}.xml.rels`, text: XLSX_DRAWING_RELS },
      )
    }
  }

  return zip(files)
}

/* ── Handing it to the browser ────────────────────────────────────────────── */

/** A filename with nothing in it a filesystem will argue about. */
export function safeFilename(s: string): string {
  return String(s).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'export'
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Not revoked synchronously: Safari has not finished reading the blob when
  // the click returns, and revoking under it produces a download of zero bytes.
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

export async function downloadWorkbook(filename: string, sheets: Sheet[]): Promise<void> {
  saveBlob(await buildWorkbook(sheets), `${safeFilename(filename)}.xlsx`)
}
