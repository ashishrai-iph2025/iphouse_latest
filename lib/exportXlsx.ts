'use client'

/*
 * Excel export, written here rather than pulled in.
 *
 * An .xlsx is a ZIP of five small XML parts. That is the whole format for a
 * single sheet of text and numbers, and it is written below in about a hundred
 * lines — against SheetJS at roughly a megabyte of parser and writer for a
 * hundred file formats this product does not read. This repository ships an
 * SBOM and has a stated dependency-patch cadence (DEPENDENCY_PATCH_CADENCE.md);
 * a dependency is a standing obligation, and it should buy more than five XML
 * templates.
 *
 * Entries are STORED, not deflated, because compression is the one part that
 * would actually need a library. A results export is text and compresses well,
 * so the file is two to four times larger than it needs to be — which for a
 * thousand rows is a couple of megabytes, and Excel neither notices nor cares.
 * If exports ever grow to where that matters, CompressionStream('deflate-raw')
 * is now in every browser this product supports and slots in at writeEntry.
 *
 * Everything is written as an INLINE STRING except values that are wholly
 * numeric. No shared-string table (a second part, an index, and a dictionary,
 * to save bytes we are already not compressing) and no cell formats: a date
 * exported here is the text the screen showed, in the reader's own zone, which
 * is the point — see the note on exportRows.
 */

import { localStamp, safeFileName, type CsvColumn } from './exportCsv'
import {
  LOGO_XLSX_H, XLSX_DRAWING_RELS, XLSX_SHEET_DRAWING, colWidthPx, exportLogo,
  xlsxLogoContentTypes, xlsxLogoDrawing, xlsxSheetRels,
} from './exportBrand'

/* ── CRC-32, which the ZIP central directory requires per entry ───────────── */

let crcTable: Uint32Array | null = null

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/* ── A minimal ZIP writer ─────────────────────────────────────────────────── */

interface Entry { name: string; data: Uint8Array; crc: number; offset: number }

const utf8 = (s: string) => new TextEncoder().encode(s)

/** `text` is encoded as UTF-8; `bytes` goes in untouched — the mark is a PNG,
 *  and a PNG run through TextEncoder is a corrupt PNG. */
interface ZipEntry { name: string; text?: string; bytes?: Uint8Array }

function zip(files: ZipEntry[]): Blob {
  const parts: Uint8Array[] = []
  const entries: Entry[] = []
  let offset = 0

  const push = (b: Uint8Array) => { parts.push(b); offset += b.length }

  /* MS-DOS date/time, which is what the format stores. A fixed stamp rather
     than `now`: it makes the same rows export to a byte-identical file, which
     is worth more when comparing two downloads than a timestamp nobody reads
     out of a ZIP header. 1980-01-01 is the epoch of this field. */
  const dosTime = 0
  const dosDate = 33 // (1980-1980)<<9 | 1<<5 | 1

  for (const f of files) {
    const name = utf8(f.name)
    const data = f.bytes ?? utf8(f.text ?? '')
    const crc = crc32(data)
    entries.push({ name: f.name, data, crc, offset })

    const head = new DataView(new ArrayBuffer(30))
    head.setUint32(0, 0x04034b50, true)  // local file header
    head.setUint16(4, 20, true)          // version needed
    head.setUint16(6, 0x0800, true)      // UTF-8 names
    head.setUint16(8, 0, true)           // stored
    head.setUint16(10, dosTime, true)
    head.setUint16(12, dosDate, true)
    head.setUint32(14, crc, true)
    head.setUint32(18, data.length, true)
    head.setUint32(22, data.length, true)
    head.setUint16(26, name.length, true)
    head.setUint16(28, 0, true)
    push(new Uint8Array(head.buffer))
    push(name)
    push(data)
  }

  const dirStart = offset
  for (const e of entries) {
    const name = utf8(e.name)
    const rec = new DataView(new ArrayBuffer(46))
    rec.setUint32(0, 0x02014b50, true)   // central directory header
    rec.setUint16(4, 20, true)
    rec.setUint16(6, 20, true)
    rec.setUint16(8, 0x0800, true)
    rec.setUint16(10, 0, true)
    rec.setUint16(12, dosTime, true)
    rec.setUint16(14, dosDate, true)
    rec.setUint32(16, e.crc, true)
    rec.setUint32(20, e.data.length, true)
    rec.setUint32(24, e.data.length, true)
    rec.setUint16(28, name.length, true)
    rec.setUint32(42, e.offset, true)
    push(new Uint8Array(rec.buffer))
    push(name)
  }

  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)     // end of central directory
  end.setUint16(8, entries.length, true)
  end.setUint16(10, entries.length, true)
  end.setUint32(12, offset - dirStart, true)
  end.setUint32(16, dirStart, true)
  push(new Uint8Array(end.buffer))

  return new Blob(parts as BlobPart[], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
}

/* ── The sheet ────────────────────────────────────────────────────────────── */

/**
 * XML text escaping.
 *
 * Character by character rather than by regex, because the interesting half of
 * this is a set of CONTROL characters, and a source file is a bad place to keep
 * literal ones: they are invisible in a diff, survive a copy-paste as something
 * else, and one of them landing inside a character class silently changes what
 * the class matches.
 *
 * XML 1.0 cannot carry C0 controls at all — not escaped, not as a numeric
 * reference — apart from tab, newline and carriage return. Scraped titles and
 * channel names do contain them, and a single stray 0x1F makes the whole
 * workbook refuse to open rather than making one cell wrong. They are dropped.
 */
function xml(v: string): string {
  let out = ''
  for (const ch of v) {
    const code = ch.codePointAt(0) as number
    // 0x09 tab, 0x0A newline, 0x0D carriage return are the three that are legal.
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue
    out += ch === '&' ? '&amp;'
      : ch === '<' ? '&lt;'
      : ch === '>' ? '&gt;'
      : ch === '"' ? '&quot;'
      : ch
  }
  return out
}

/** 0 → A, 25 → Z, 26 → AA. */
function colRef(i: number): string {
  let s = ''
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) {
    s = String.fromCharCode(65 + (n % 26)) + s
  }
  return s
}

/* A value Excel should treat as a NUMBER rather than as text. Deliberately
   strict: a bare integer or decimal and nothing else. An id that happens to be
   all digits is still a number and will lose its leading zeros — but so would
   it in every spreadsheet, and the alternative is view counts that cannot be
   summed, which is most of what these exports are opened for. */
const NUMERIC = /^-?\d+(\.\d+)?$/

/**
 * Column widths, in characters, from the widest cell in each.
 *
 * Only needed so the mark can be centred over the table — see brandFor in
 * lib/xlsx.ts for the same reasoning. Capped, because one long URL would
 * otherwise put the middle of the sheet a thousand pixels off screen.
 */
function widthsOf(header: string[], rows: string[][]): number[] {
  return header.map((h, i) => {
    let w = String(h ?? '').length
    for (const r of rows) w = Math.max(w, String(r[i] ?? '').length)
    return Math.min(58, Math.max(9, w + 2))
  })
}

function sheetXml(header: string[], rows: string[][], brand: { w: number; h: number } | null): string {
  const cell = (text: string, ref: string) => {
    if (text === '') return ''
    if (NUMERIC.test(text) && Math.abs(Number(text)) < 1e15) {
      return `<c r="${ref}"><v>${text}</v></c>`
    }
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(text)}</t></is></c>`
  }
  const line = (cells: string[], rowNo: number) =>
    `<row r="${rowNo}">${cells.map((c, i) => cell(c, `${colRef(i)}${rowNo}`)).join('')}</row>`

  /* An empty first row, tall enough to clear the mark floating over it. The
     picture is anchored to the sheet rather than held in a cell — a spreadsheet
     has no cell that holds an image — so without a row made room for it the
     mark would sit on top of the header. Row heights are in points, three
     quarters of a pixel each. */
  const lead = brand ? 1 : 0
  const brandRow = brand
    ? `<row r="1" ht="${(brand.h + 10) * 0.75}" customHeight="1"/>`
    : ''

  /* `drawing` goes LAST inside <worksheet>, and that is the schema's order
     rather than a preference: a part out of sequence is not a workbook that
     opens oddly, it is one Excel refuses to open. The `r` namespace comes with
     it, since the reference is an r:id. */
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' +
    (brand ? ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' : '')

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<worksheet ${ns}><sheetData>` +
    brandRow +
    line(header, 1 + lead) +
    rows.map((r, i) => line(r, i + 2 + lead)).join('') +
    '</sheetData>' + (brand ? XLSX_SHEET_DRAWING : '') + '</worksheet>'
}

/** A sheet name Excel will accept: 31 characters, none of []:*?/\ */
function safeSheetName(name: string): string {
  return (name.replace(/[[\]:*?/\\]+/g, ' ').trim().slice(0, 31)) || 'Data'
}



/**
 * Build the workbook and hand it to the browser as a download.
 *
 * Same signature as downloadCsv, so a caller chooses a format and nothing else
 * about the call changes.
 */
export async function downloadXlsx<T>(
  fileName: string, columns: CsvColumn<T>[], rows: T[], sheetName = 'Data',
): Promise<void> {
  const header = columns.map(c => String(c.label ?? c.key))
  const body = rows.map(row => columns.map(c => {
    const v = c.get ? c.get(row) : (row as any)?.[c.key]
    return v === null || v === undefined ? '' : String(v)
  }))

  /* The IP House mark, at the top of the sheet. Async only because of this: it
     is fetched and rasterised once per page (lib/exportBrand.ts) and memoised,
     so a second export waits on nothing. Null where it would not load, and the
     workbook is then exactly what it was before this existed — a download is
     somebody's work leaving the building and a decorative image is not a reason
     to withhold it. */
  const logo = await exportLogo()
  const brand = logo
    ? (() => {
      const h = LOGO_XLSX_H
      const w = Math.round(h * logo.ratio)
      // Centred over the TABLE: a sheet is as wide as the reader drags it, so
      // the only stable middle is the middle of the columns it actually has.
      const tableW = widthsOf(header, body).reduce((a, chars) => a + colWidthPx(chars), 0)
      return { w, h, offsetX: Math.max(0, Math.round((tableW - w) / 2)) }
    })()
    : null

  const files: ZipEntry[] = [
    {
      name: '[Content_Types].xml',
      text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        (logo ? xlsxLogoContentTypes(1) : '') +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' +
        ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets><sheet name="${xml(safeSheetName(sheetName))}" sheetId="1" r:id="rId1"/></sheets>` +
        '</workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '</Relationships>',
    },
    { name: 'xl/worksheets/sheet1.xml', text: sheetXml(header, body, brand) },
  ]

  if (logo && brand) {
    files.push(
      { name: 'xl/media/logo.png', bytes: logo.bytes },
      { name: 'xl/worksheets/_rels/sheet1.xml.rels', text: xlsxSheetRels(0) },
      { name: 'xl/drawings/drawing1.xml', text: xlsxLogoDrawing(brand.w, brand.h, brand.offsetX, 4) },
      { name: 'xl/drawings/_rels/drawing1.xml.rels', text: XLSX_DRAWING_RELS },
    )
  }

  const blob = zip(files)

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const stamp = localStamp()
  a.href = url
  a.download = `${safeFileName(fileName)}_${stamp}.xlsx`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Revoked on the next tick so Safari has actually started the download.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
