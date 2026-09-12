// A page, as a PDF somebody can send on.
//
// ── Why this opens a second window instead of styling this one ───────────────
//
// The obvious way to print a page is an `@media print` block that hides the
// chrome. It does not survive contact with this app. The report lives inside a
// shell that is exactly one viewport tall with the scrolling on an inner
// `main`, both rails are `position: sticky`, and there are two different shells
// — AdminShell for /admin/reports and ClientShell for /reports — wrapping the
// same component. Print a scroll container and Chromium gives you the first
// screenful and nothing else; unpick that with `height: auto !important` up a
// chain you do not own and you are one refactor away from a silently broken
// export.
//
// So the document that gets printed is BUILT, not un-styled. A blank same-origin
// window, the page's own stylesheets, and a clone of the report with the parts
// that are not the report removed. Nothing has to be hidden because nothing else
// was ever put in — which is also the only version of "do not print the
// navigation and filter panes" that cannot regress when somebody adds a third
// pane.
//
// ── Why the paper is the report's own width ──────────────────────────────────
//
// The charts are Recharts, measured to their container when they rendered and
// cloned at that size — an SVG cannot reflow after the fact. Print them onto a
// narrower page and they either overflow it or, scaled to fit, drift out of step
// with the HTML legends underneath them, which are laid out by CSS and do
// reflow.
//
// The page is therefore cut to the centre column's measured width, so every
// chart lands at exactly the size it was drawn at. It is not A4, and it is not
// meant to be: this is a document to read and forward, and the browser scales it
// to the sheet on the day somebody actually puts it on paper.
//
// ── Why the breakpoint rules are copied forward ──────────────────────────────
//
// A media query in a print job is evaluated against the PAGE BOX, not the
// window. The report's grid is `grid-cols-2 xl:grid-cols-12`, so a page narrower
// than 1280px silently prints the two-column phone layout of a report the reader
// is looking at in twelve columns — the one thing "same structure" rules out.
//
// Rather than hand-listing the utilities that matters for, every width-based
// rule that is ACTIVE ON SCREEN right now is harvested out of the page's own
// stylesheets and re-emitted after them. The printed layout is then the layout
// in front of the reader, whatever width their window happens to be, and a
// utility added to the page next year is carried over without anyone
// remembering to add it here.

import { flattenCanvases } from '@/lib/flattenCanvas'
import { exportLogo, LOGO_PDF_H } from '@/lib/exportBrand'

/** Marks a node as this application's chrome: present on screen, never in the
    PDF. Read by the clone below, and by nothing else. */
export const PRINT_HIDE_ATTR = 'data-print-hide'

export interface PrintFilter {
  label: string
  value: string
}

export interface PrintReportOptions {
  /** The PDF's name. Becomes the print window's <title>, which is what the
      browser offers as the filename in the Save-as-PDF dialog. */
  fileName: string
  /** Printed large at the top — the report this is. */
  title: string
  /** Whose numbers these are. */
  client?: string
  /** The window the report covers, already formatted for reading. */
  window?: string
  /** Every slicer that was set, by name — the filter pane's selections, which
      are the one part of that pane worth carrying into a document that no
      longer has it. An empty list says so rather than being left out: "no
      filters" and "the filters were not recorded" are different claims. */
  filters?: PrintFilter[]
  /** The element to measure the page width from. Defaults to the printed node,
      which is wider than the charts once the rails are dropped. */
  measureFrom?: HTMLElement | null
}

/** A page narrower than this is a measurement that went wrong, not a report. */
const MIN_PAGE_WIDTH = 720
const PAGE_MARGIN = 24

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * The page's own stylesheets, as markup the second window can load.
 *
 * `<link>` hrefs are taken resolved rather than as written: the new document's
 * base URL is `about:blank`, so a relative `/assets/index-abc.css` would resolve
 * against nothing. `<style>` blocks — which is how Vite serves CSS in dev — are
 * copied verbatim.
 */
function styleMarkup(): string {
  const out: string[] = []
  document.querySelectorAll<HTMLElement>('link[rel="stylesheet"], style').forEach(el => {
    if (el instanceof HTMLLinkElement) {
      if (el.href) out.push(`<link rel="stylesheet" href="${esc(el.href)}">`)
    } else {
      out.push(`<style>${el.textContent ?? ''}</style>`)
    }
  })
  return out.join('\n')
}

/**
 * Every width-conditional rule that is in force on screen at this moment,
 * flattened so it applies on paper too — see the note at the top.
 *
 * Emitted AFTER the stylesheets it came from, which is what makes it win: a
 * breakpoint utility and the base utility it overrides have the same
 * specificity, so the later declaration decides. No `!important` is needed, and
 * using one would break the cascade for anything the page overrides on purpose.
 *
 * A stylesheet this document cannot read is skipped rather than fatal. That is
 * a cross-origin sheet, which this app does not have and which would carry no
 * layout for these panels if it did.
 */
function activeWidthRules(): string {
  const out: string[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList
    try {
      rules = (sheet as CSSStyleSheet).cssRules
    } catch {
      continue
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSMediaRule)) continue
      const q = rule.conditionText || ''
      // Only the width breakpoints, and only the ones the reader is actually
      // under. A `print` block is already going to apply; re-emitting it would
      // simply double it.
      if (!/width/.test(q) || /print/.test(q)) continue
      let active = false
      try {
        active = window.matchMedia(q).matches
      } catch {
        continue
      }
      if (!active) continue
      for (const inner of Array.from(rule.cssRules)) out.push(inner.cssText)
    }
  }
  return out.join('\n')
}

/**
 * The rules that are about the printed document rather than about the report.
 *
 * Four jobs, and each is a failure mode rather than a preference:
 *
 *   · paint. Browsers drop background colours from print by default, which on a
 *     dark theme is white text on white paper. `print-color-adjust: exact` is
 *     the whole reason the export is legible in either theme.
 *   · scrollers. A panel that scrolls sideways on screen has content past its
 *     right edge; on paper there is nothing to scroll, so the overflow is
 *     released and the panel prints whole.
 *   · page breaks. A card cut in half across a page boundary is the single
 *     thing that makes an exported dashboard look broken, so panels and the
 *     filter block are kept intact.
 *   · sticky. Everything pinned on screen is pinned to a scroll container that
 *     does not exist here, and left alone it prints in the wrong place.
 */
function printCss(pageW: number, pageH: number): string {
  return `
@page { size: ${pageW}px ${pageH}px; margin: ${PAGE_MARGIN}px; }

html, body {
  height: auto !important; min-height: 0 !important; overflow: visible !important;
  margin: 0; padding: 0; background: #fff;
}
*, *::before, *::after {
  -webkit-print-color-adjust: exact !important;
  print-color-adjust: exact !important;
}

.pr-doc { width: 100%; }

/* Nothing in a document travels with the reader. */
.pr-doc [style*="position: sticky"], .pr-doc .sticky,
.pr-doc [class*="sticky"] { position: static !important; top: auto !important; }

/* A panel that scrolls on screen has to print whole — there is no scrollbar on
   paper, and what is past the edge would simply be lost. */
.pr-doc [class*="overflow-x-auto"], .pr-doc [class*="overflow-y-auto"],
.pr-doc [class*="overflow-auto"] { overflow: visible !important; }
.pr-doc [class*="max-h-"] { max-height: none !important; }

/* The panels themselves, and the filter block, stay in one piece. */
.pr-doc .grid > *, .pr-filters { break-inside: avoid; page-break-inside: avoid; }

/* ── The document's own furniture ──────────────────────────────────────── */
/* The mark, above everything, at the left margin. Its own band rather than a
   corner of the title row: this is the first thing on a document somebody is
   going to forward. Left rather than centred so it lines up with the title,
   the scope line and the table beneath it — one edge down the whole page. */
.pr-brand { text-align: left; margin: 0 0 14px; }
.pr-brand img { height: ${LOGO_PDF_H}px; width: auto; display: inline-block; }
.pr-head {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 16px;
  padding: 0 0 12px; margin: 0 0 14px; border-bottom: 2px solid #14254A;
}
.pr-head h1 {
  margin: 0; font-size: 21px; line-height: 1.2; font-weight: 800; color: #14254A;
}
.pr-head .pr-sub { margin: 5px 0 0; font-size: 12px; color: #5a6b8c; }
.pr-head .pr-client { font-weight: 700; color: #FC934C; }
.pr-head .pr-taken { font-size: 10.5px; color: #8a97ae; white-space: nowrap; padding-top: 3px; }

.pr-filters {
  margin: 0 0 16px; padding: 11px 14px; border: 1px solid #dfe5ef; border-radius: 12px;
  background: #f7f9fc;
}
.pr-filters h2 {
  margin: 0 0 8px; font-size: 9.5px; font-weight: 800; letter-spacing: .16em;
  text-transform: uppercase; color: #8a97ae;
}
.pr-filters dl {
  margin: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px 18px;
}
.pr-filters div { min-width: 0; }
.pr-filters dt {
  font-size: 9px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase;
  color: #94a2ba; margin: 0 0 1px;
}
.pr-filters dd {
  margin: 0; font-size: 12px; font-weight: 600; color: #14254A; overflow-wrap: anywhere;
}
.pr-filters .pr-none { font-size: 12px; color: #8a97ae; margin: 0; }

.pr-foot {
  margin-top: 16px; padding-top: 8px; border-top: 1px solid #e4e9f2;
  font-size: 9.5px; color: #94a2ba;
}
`
}

function headerMarkup(o: PrintReportOptions, taken: string, logoDataUrl?: string): string {
  const sub = [
    o.client && `<span class="pr-client">${esc(o.client)}</span>`,
    o.window && esc(o.window),
  ].filter(Boolean).join(' &nbsp;·&nbsp; ')

  const filters = o.filters ?? []
  const list = filters.length
    ? `<dl>${filters.map(f =>
        `<div><dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd></div>`).join('')}</dl>`
    : '<p class="pr-none">No filters were applied — this report covers everything in the window above.</p>'

  return `
${logoDataUrl ? `<div class="pr-brand"><img src="${logoDataUrl}" alt="IP House"></div>` : ''}
<header class="pr-head">
  <div>
    <h1>${esc(o.title)}</h1>
    ${sub ? `<p class="pr-sub">${sub}</p>` : ''}
  </div>
  <div class="pr-taken">Generated ${esc(taken)}</div>
</header>
<section class="pr-filters">
  <h2>Filters applied</h2>
  ${list}
</section>`
}

/**
 * The whole printed document, as markup — the part of this file with no side
 * effects, so what lands in the PDF can be asserted on rather than only looked
 * at through a print preview.
 *
 * The reader's theme comes with it. Chart colours — grid lines, marks, the
 * palette itself — are chosen in JS from the dark flag and baked into the SVG
 * that gets cloned, so recolouring the page around them on the way to paper
 * would put dark-theme marks on a light card. What is on screen is what prints.
 */
export function buildPrintDocument(
  node: HTMLElement, o: PrintReportOptions, logoDataUrl?: string,
): string {
  const measured = Math.round(
    (o.measureFrom ?? node).getBoundingClientRect().width)
  const pageW = Math.max(MIN_PAGE_WIDTH, measured) + PAGE_MARGIN * 2
  // A page a third taller than it is wide: enough that a row of panels and its
  // neighbour share a sheet, without the long thin pages a full A4 ratio gives
  // at this width.
  const pageH = Math.round(pageW * 1.32)

  /* The report, less this application. Removed from the CLONE rather than
     hidden in the printed CSS, so what is not wanted is not in the file at all
     — a `display: none` pane is still a pane somebody can pull back out of the
     PDF's structure tree, and this one is a client's report. */
  const clone = node.cloneNode(true) as HTMLElement
  /* Canvas-drawn panels — the Toast UI chart engine — become <img> of the same
     pixels first. `clone.outerHTML` below writes a <canvas> out as an empty
     element, so without this the PDF has a correctly sized blank where each of
     those charts was. See lib/flattenCanvas.ts. */
  flattenCanvases(node, clone)
  clone.querySelectorAll(`[${PRINT_HIDE_ATTR}]`).forEach(el => el.remove())

  const taken = new Date().toLocaleString()
  return `<!doctype html>
<html lang="en" class="${esc(document.documentElement.className)}">
<head>
<meta charset="utf-8">
<title>${esc(o.fileName)}</title>
${styleMarkup()}
<style>${activeWidthRules()}</style>
<style>${printCss(pageW, pageH)}</style>
</head>
<body>
<div class="pr-doc">
${headerMarkup(o, taken, logoDataUrl)}
${clone.outerHTML}
<footer class="pr-foot">${esc(o.title)}${o.client ? ` · ${esc(o.client)}` : ''} · generated ${esc(taken)}</footer>
</div>
</body>
</html>`
}

/**
 * Print `node` as a PDF, without the chrome around it.
 *
 * Resolves to null when the print dialog was reached, or to a sentence for the
 * reader when it was not. The only way it is not reached is a blocked pop-up, which is
 * a thing they can fix and therefore a thing worth saying out loud rather than
 * failing silently under a button that appeared to do nothing.
 *
 * The reader's theme is kept. Chart colours — grid lines, marks, the palette
 * itself — are chosen in JS from the dark flag and baked into the SVG that gets
 * cloned, so recolouring the page around them on the way to paper would put
 * dark-theme marks on a light card. What is on screen is what prints.
 */
export async function printReport(
  node: HTMLElement, o: PrintReportOptions,
): Promise<string | null> {
  // Opened FIRST, synchronously, while the click that asked for it is still on
  // the stack — a pop-up blocker judges by that, and any work done before this
  // call is enough to lose the window.
  const win = window.open('', '_blank')
  if (!win) {
    return 'Your browser blocked the print window. Allow pop-ups for this site, then try again.'
  }

  /* AFTER the window is open, never before. The pop-up blocker judges by
     whether a click is still on the stack, and an await here before window.open
     would lose the window on every export. Undefined where the mark would not
     load: the document is still produced, headed by its title alone. */
  const logo = await exportLogo()
  const html = buildPrintDocument(node, o, logo?.dataUrl)

  win.document.open()
  win.document.write(html)
  win.document.close()

  /* Printed once the stylesheets and fonts the document just pulled have
     actually arrived. Firing on `load` alone is not enough — a web font that
     lands after the dialog opens re-lays every label in the report, and the
     preview the reader accepts is not the one they get. */
  const start = () => {
    const go = () => {
      try {
        win.focus()
        win.print()
      } catch {
        /* The window was closed before the dialog opened. Nothing to recover. */
      }
    }
    const fonts = (win.document as any).fonts
    if (fonts?.ready) fonts.ready.then(go).catch(go)
    else go()
  }

  if (win.document.readyState === 'complete') setTimeout(start, 60)
  else win.addEventListener('load', () => setTimeout(start, 60))

  // Closed once the dialog is dismissed, whether it was saved or cancelled —
  // an orphan tab of un-styled markup left behind on every export is its own
  // small mess.
  win.addEventListener('afterprint', () => {
    try { win.close() } catch { /* already gone */ }
  })

  return null
}
