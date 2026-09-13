import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@/app/globals.css'
import SearchableSelect from '@/components/ui/SearchableSelect'

/* The slicer, at the three widths it actually gets.
 *
 * The COMPONENT is the real one, imported rather than reimplemented — a preview
 * that reimplements what it previews agrees with the page exactly once, on the
 * day it is written.
 *
 * The WIDTHS are the ones in the product: 244px is the report's filter rail,
 * 170px was the realtime card's fixed track, and 400px is what that track can
 * now grow to. The point of showing all three at once is that the option list
 * must read the same in every one of them — it is sized to its own longest
 * label, not to the control that opened it.
 *
 * The NAMES are real fixture labels off the asset master, which is where this
 * started: "Serie A: Juventus vs Milan (07-09…" in a list somebody is supposed
 * to choose from.
 *
 *   ?dark=1    the dark half
 *   ?long=1    a pathological label — longer than any list can be wide, so the
 *              wrapping is what is being looked at rather than the sizing
 */
const q = new URLSearchParams(location.search)
const dark = q.get('dark') === '1'
const long = q.get('long') === '1'

const FIXTURES = [
  'Serie A: Juventus vs Milan (07-09-2026)',
  'LaLiga: Real Madrid vs Rayo Vallecano (07-09-2026)',
  'Serie A: Lazio vs Milan (12-09-2026)',
  'Serie A: Venezia vs Fiorentina (12-09-2026)',
  'Serie A: Cagliari vs Lecce (07-09-2026)',
  'Serie A: Udinese vs Lazio (08-09-2026)',
  'LaLiga: Sevilla vs Valencia (12-09-2026)',
  'LaLiga: Racing Santander vs Alaves (13-09-2026)',
  'Serie A: Internazionale vs Atalanta (13-09-2026)',
  'LaLiga: Athletic Club vs Real Sociedad (14-09-2026)',
  'Ligue 1: Paris Saint-Germain vs Olympique de Marseille (14-09-2026)',
  'Alianza Contra la Piratería Audiovisual',
  ...(long
    ? ['Serie A: Associazione Calcio Milan vs Football Club Internazionale Milano, ' +
       'Stadio Giuseppe Meazza, San Siro (28-09-2026)']
    : []),
]

const options = FIXTURES.map((label, i) => ({ key: `f${i}`, label, count: (13 - i) * 37 }))
const SHORT = [
  { key: 'ow', label: 'Open Web', count: 20185 },
  { key: 'sm', label: 'Social Media', count: 4021 },
  { key: 'tg', label: 'Telegram', count: 918 },
]

function Bench({ width, note }: { width: number; note: string }) {
  const [a, setA] = useState('')
  const [b, setB] = useState('f3')
  return (
    <div className="mb-7">
      <div className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-2">
        {width}px — {note}
      </div>
      <div style={{ width }} className="flex flex-col gap-2">
        {/* Empty, and holding a long value: the closed control is the only place
            the current selection is stated, so both states matter. */}
        <SearchableSelect options={options} value={a} onChange={setA}
          placeholder="All" emptyLabel="All" compact={width <= 244} />
        <SearchableSelect options={options} value={b} onChange={setB}
          placeholder="All" emptyLabel="All" compact={width <= 244} />
        {/* A short list must NOT be dragged wide by the long one beside it. */}
        <SearchableSelect options={SHORT} value="" onChange={() => {}}
          placeholder="All" emptyLabel="All" compact={width <= 244} />
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <div className={`p-6 min-h-screen ${dark ? 'dark' : ''}`}
    style={{ background: dark ? '#0f1b33' : '#eef2f7' }}>
    <div className="flex flex-wrap gap-10 items-start">
      <Bench width={170} note="the realtime card's old fixed track" />
      <Bench width={244} note="the report's filter rail" />
      <Bench width={400} note="what the realtime card's track can grow to" />
    </div>
  </div>
)
