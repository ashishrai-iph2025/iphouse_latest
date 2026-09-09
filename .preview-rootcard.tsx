import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@/app/globals.css'
import { MirrorBars } from '@/app/admin/reports/page'
import { REPORT_THEMES, themeFor } from '@/lib/reportTheme'

/* The combined root-domain card, in its new default shape.
 *
 * The ROWS are real: sixty hostnames off the live warehouse for one client's
 * Open Web report, folded to brands by the server's own foldDomainRows. The
 * COMPONENT is the real one too — imported from the reports page rather than
 * reimplemented here, because a preview that reimplements what it previews
 * agrees with the page exactly once, on the day it is written.
 *
 *   ?theme=slate   any key from REPORT_THEMES
 *   ?dark=1        the dark half of it
 *   ?nomirrors=1   the no-mirror-counts fallback — what a stale server, or a
 *                  panel whose rows never carried the figure, actually draws
 */
/* Two cards now, one per side of the enforcement.
 *
 * The LINKING rows are real: hostnames off the live warehouse for one client's
 * Open Web report, folded to brands by the server's own foldDomainRows. The
 * HOST rows are the same brands on the other table — deliberately a DIFFERENT
 * population, because that is the whole point of the split: an operator can run
 * a big linking footprint and a small hosting one, and one card summing both
 * hid exactly that.
 *
 * The COMPONENT is the real one, imported from the reports page rather than
 * reimplemented here — a preview that reimplements what it previews agrees with
 * the page exactly once, on the day it is written.
 *
 *   ?theme=slate   any key from REPORT_THEMES
 *   ?dark=1        the dark half of it
 *   ?nomirrors=1   the no-mirror-counts fallback
 */
const HOST_ROWS = [
  ['vipbox', 812, 604, 4], ['livetv', 655, 601, 2], ['daddylive', 470, 388, 2],
  ['jonstream', 402, 291, 3], ['viprow', 388, 240, 1], ['fbstream', 301, 190, 1],
  ['olympicweb', 275, 160, 1], ['qatarstreams', 190, 121, 1],
] as const

const ROWS = [
  ['vipbox', 1907, 1482, 9], ['viprow', 1331, 951, 3], ['livetv', 1273, 1159, 2],
  ['vipboxtv', 969, 648, 1], ['fbstream', 925, 619, 1], ['daddylive', 903, 765, 3],
  ['liveleagues', 895, 652, 1], ['jonstream', 879, 657, 4], ['olympicweb', 842, 542, 1],
  ['qatarstreams', 803, 598, 1],
] as const

const q = new URLSearchParams(location.search)
const dark = q.get('dark') === '1'
const noMirrors = q.get('nomirrors') === '1'

const shape = ([label, urls, removed, mirrors]: readonly [string, number, number, number]) =>
  ({ label, value: label, urls, removed, mirrors: noMirrors ? 0 : mirrors })
const rows = ROWS.map(shape)
const hostRows = HOST_ROWS.map(shape)

function Preview() {
  const [themeKey, setThemeKey] = useState(q.get('theme') || 'iphouse')
  const [active, setActive] = useState('')
  const m = themeFor(themeKey, dark)

  return (
    <div className={`p-6 min-h-screen ${dark ? 'dark' : ''}`}
      style={{ background: dark ? '#0f1b33' : '#eef2f7' }}>
      <div className="flex flex-wrap gap-1.5 mb-4 max-w-[900px]">
        {REPORT_THEMES.map(t => (
          <button key={t.key} onClick={() => setThemeKey(t.key)}
            className={`px-2 py-1 rounded text-[11px] border ${
              t.key === themeKey ? 'bg-[#14254A] text-white border-[#14254A]'
                : 'bg-white text-[#14254A] border-gray-300'}`}>{t.label}</button>
        ))}
        <button onClick={() => setActive('')}
          className="px-2 py-1 rounded text-[11px] border bg-white text-gray-500 border-gray-300">
          clear pick{active ? `: ${active}` : ''}
        </button>
      </div>

      <div className="rounded-2xl shadow-card border overflow-hidden max-w-[900px]"
        style={{ background: m.surface, borderColor: dark ? 'rgba(255,255,255,.08)' : '#f1f3f6' }}>
        <div className="flex items-center gap-2 px-4 py-3 border-b"
          style={{ borderColor: dark ? 'rgba(255,255,255,.08)' : '#f1f3f6' }}>
          <h3 className="text-[14px] font-bold" style={{ color: dark ? '#fff' : '#14254A' }}>
            Linking Domain - Identification, De-Indexing &amp; Mirrors
          </h3>
        </div>
        <div className="p-4 pt-3">
          <MirrorBars rows={rows} m={m} activeVal={active} onPick={setActive}
            removedName="De-indexed" nameHead="Linking domain" />
        </div>
      </div>

      <div className="rounded-2xl shadow-card border overflow-hidden max-w-[900px] mt-5"
        style={{ background: m.surface, borderColor: dark ? 'rgba(255,255,255,.08)' : '#f1f3f6' }}>
        <div className="flex items-center gap-2 px-4 py-3 border-b"
          style={{ borderColor: dark ? 'rgba(255,255,255,.08)' : '#f1f3f6' }}>
          <h3 className="text-[14px] font-bold" style={{ color: dark ? '#fff' : '#14254A' }}>
            Host Domain - Identification, Removal &amp; Mirrors
          </h3>
        </div>
        <div className="p-4 pt-3">
          <MirrorBars rows={hostRows} m={m} activeVal={active} onPick={setActive}
            removedName="Removed" nameHead="Host domain" />
        </div>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
