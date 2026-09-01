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

function zip(files: { name: string; text: string }[]): Blob {
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
    const data = utf8(f.text)
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

function sheetXml(header: string[], rows: string[][]): string {
  const cell = (text: string, ref: string) => {
    if (text === '') return ''
    if (NUMERIC.test(text) && Math.abs(Number(text)) < 1e15) {
      return `<c r="${ref}"><v>${text}</v></c>`
    }
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(text)}</t></is></c>`
  }
  const line = (cells: string[], rowNo: number) =>
    `<row r="${rowNo}">${cells.map((c, i) => cell(c, `${colRef(i)}${rowNo}`)).join('')}</row>`

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
    line(header, 1) +
    rows.map((r, i) => line(r, i + 2)).join('') +
    '</sheetData></worksheet>'
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
export function downloadXlsx<T>(
  fileName: string, columns: CsvColumn<T>[], rows: T[], sheetName = 'Data',
): void {
  const header = columns.map(c => String(c.label ?? c.key))
  const body = rows.map(row => columns.map(c => {
    const v = c.get ? c.get(row) : (row as any)?.[c.key]
    return v === null || v === undefined ? '' : String(v)
  }))

  const blob = zip([
    {
      name: '[Content_Types].xml',
      text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
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
    { name: 'xl/worksheets/sheet1.xml', text: sheetXml(header, body) },
  ])

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
