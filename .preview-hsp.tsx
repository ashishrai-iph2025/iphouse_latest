import { createRoot } from 'react-dom/client'
import '@/app/globals.css'
import { MirrorBars } from '@/app/admin/reports/page'
import { themeFor } from '@/lib/reportTheme'

/* The two hosting-provider cards, on the shape that can show all three figures.
 *
 * They were plain hbars: identified and removed, and the website count hidden
 * in an axis tick's <title>. The numbers below are the reported ones — Netulu
 * at 9.9K against providers in the hundreds, which is exactly the spread that
 * makes a third bar unreadable and a second axis dishonest.
 *
 * The DOMAIN GAUGE OPENS. Each provider's count comes with the domains behind
 * it, so the gauge is a control rather than a figure — click it and the estate
 * is listed under the row. The notices gauge on the host card deliberately does
 * not: its rows are notice ids, and a drawer of GUIDs is not something anyone
 * can act on. Both states are in this preview.
 *
 *   ?dark=1        the dark half of the theme
 *   ?nolist=1      counts with no domains behind them — what the card draws when
 *                  the server could not vouch for the list, and what it drew
 *                  before the drawer existed
 */
const q = new URLSearchParams(location.search)
const dark = q.get('dark') === '1'
const noList = q.get('nolist') === '1'
const m = themeFor('iphouse', dark)

/* Domains generated from the provider's own name so the list and the number
   above it always agree — which is the property the drawer exists to make
   checkable, so a preview that faked it would be previewing nothing. */
const domainsFor = (label: string, n: number) => {
  const stem = label.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 10) || 'host'
  return Array.from({ length: n }, (_, i) =>
    i === 0 ? `${stem}.net` : `${i % 3 === 0 ? 'cdn' : 'srv'}${i}.${stem}${100 + i}.com`)
}

const mk = (rows: [string, number, number, number, number?][]) =>
  rows.map(([label, urls, removed, extra, extra2]) =>
    ({
      label, value: label, urls, removed, extra, extra2,
      extraDomains: noList ? undefined : domainsFor(label, extra),
    }))

const LINKING = mk([
  ['Netulu Incorporated', 9900, 9800, 412],
  ['ALEXHOST SRL', 1300, 1300, 96],
  ['SpectraIP B.V.', 769, 765, 74],
  ['AYOSOFT LTD', 658, 647, 61],
  ['DexDC - AYOSOFT LTD, GB', 512, 512, 38],
  ['SINO WORLDWIDE TRADING LIMITED', 419, 252, 29],
  ['Shinjiru Technology Sdn Bhd', 292, 283, 24],
  ['Virtual Systems LLC', 286, 281, 22],
  ['Amanah Tech Inc.', 187, 187, 15],
  ['Google LLC', 179, 115, 11],
])

const HOST = mk([
  ['Netulu Incorporated', 2800, 2700, 188, 96],
  ['IP Connect Inc', 253, 196, 31, 22],
  ['AYOSOFT LTD', 190, 183, 27, 19],
  ['Altrosky Technology Ltd.', 180, 125, 22, 14],
  ['BestDC Limited', 176, 113, 19, 12],
  ['TOV VAIZ PARTNER', 117, 103, 14, 9],
  ['CLIENT1151', 116, 116, 12, 8],
  ['FOP Dmytro Nedilskyi', 80, 80, 9, 6],
  ['TECHOFF SRV LIMITED', 64, 52, 7, 5],
  ['SINO WORLDWIDE TRADING LIMITED', 64, 64, 6, 4],
])

const Card = ({ title, rows, cfg }: { title: string; rows: any[]; cfg: any }) => (
  <div className="rounded-2xl shadow-card border overflow-hidden mb-5"
    style={{ background: m.surface, borderColor: dark ? 'rgba(255,255,255,.08)' : '#f1f3f6' }}>
    <div className="px-4 py-3 border-b" style={{ borderColor: dark ? 'rgba(255,255,255,.08)' : '#f1f3f6' }}>
      <h3 className="text-[14px] font-bold" style={{ color: dark ? '#fff' : '#14254A' }}>{title}</h3>
    </div>
    <div className="p-4 pt-3">
      <MirrorBars rows={rows} m={m} onPick={() => {}} {...cfg} />
    </div>
  </div>
)

createRoot(document.getElementById('root')!).render(
  <div className={`p-6 min-h-screen ${dark ? 'dark' : ''}`}
    style={{ background: dark ? '#0f1b33' : '#eef2f7' }}>
    <div className="max-w-[1100px]">
      <Card title="Hosting Providers - Linking Websites" rows={LINKING}
        cfg={{ nameHead: 'Hosting provider', removedName: 'De-indexed',
               counts: [{ key: 'extra', name: 'Linking domains', list: 'extraDomains' }] }} />
      <Card title="Hosting Providers - Host Websites" rows={HOST}
        cfg={{ nameHead: 'Hosting provider', removedName: 'Removed',
               counts: [{ key: 'extra', name: 'Host domains', list: 'extraDomains' },
                        // No list: see the note at the top of this file.
                        { key: 'extra2', name: 'Notices' }] }} />
    </div>
  </div>
)
