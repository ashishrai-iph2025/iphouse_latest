import { createRoot } from 'react-dom/client'
import ProgramCalendar, { type AssetRow } from '@/components/client/ProgramCalendar'
import '@/app/globals.css'

// Shaped like the real catalogue in the screenshot: seven genres, most of them
// carrying a single sub-genre, one carrying six. That mix is the whole reason
// the legend needed laying out in parallel.
const CATS: Array<[string, string]> = [
  ['Sports', 'Wrestling'], ['Sports', 'Football'], ['Sports', 'Boxing'],
  ['Television', 'Web Series'], ['Movies', 'NPC'], ['Sports', 'Cricket'],
  ['Originals', 'Documentary'], ['Sports', 'Tennis'], ['Sports', 'Snooker'],
  ['Sports', 'Darts'], ['Adult', 'Adult'], ['Games', 'Games'],
  ['Originals', 'Web Series'], ['Movies', 'Fast Movies'], ['Television', 'Television'],
]
const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T00:00:00Z`

const now = new Date()
const Y = now.getUTCFullYear()
const M = now.getUTCMonth() + 1

const rows: AssetRow[] = []
let n = 0
for (const [mo, yr] of [[M === 1 ? 12 : M - 1, M === 1 ? Y - 1 : Y], [M, Y]] as Array<[number, number]>) {
  for (let d = 1; d <= 28; d += 1) {
    const many = d % 7 === 3 ? 6 : d % 3 === 0 ? 2 : d % 2 === 0 ? 1 : 0
    for (let k = 0; k < many; k++) {
      const [g, sg] = CATS[n % CATS.length]
      rows.push({
        Id: `a${n}`,
        AssetName: `${sg} — ${['Night', 'Cup', 'Series', 'Open', 'Classic'][k % 5]} ${d}/${mo}`,
        StartDate: iso(yr, mo, d),
        EndDate: k === 0 && d % 9 === 0 ? iso(yr, mo, Math.min(28, d + 4)) : null,
        MatchDay: `Matchday ${d}`, Genre: g, SubGenre: sg,
        IsWarRoom: n % 3 === 0 ? 1 : 0,
        FranchiseName: 'Example FC', IsExclusive: 1, IsGlobal: 1,
      })
      n++
    }
  }
}
rows.push({ Id: 'long', AssetName: 'Snooker of DAZN (2024–2032)', StartDate: iso(Y, M, 12), EndDate: iso(Y + 6, 12, 31), Genre: 'Sports', SubGenre: 'Snooker', IsWarRoom: 1 })
rows.push({ Id: 'rel', AssetName: 'A Film With No Start Date', StartDate: null, ReleaseDate: iso(Y, M, 5), Genre: 'Movies', SubGenre: 'NPC' })
rows.push({ Id: 'nodate', AssetName: 'No Dates At All', Genre: 'Sports', SubGenre: 'Wrestling' })

const realFetch = window.fetch.bind(window)
window.fetch = ((input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url
  if (typeof url === 'string' && url.includes('/api/reports/assets')) {
    return Promise.resolve(new Response(JSON.stringify({ ok: true, rows }), {
      headers: { 'Content-Type': 'application/json' },
    }))
  }
  return realFetch(input, init)
}) as typeof window.fetch

// Mirrors /welcome: a greeting above the card, so the measured top edge is real.
createRoot(document.getElementById('root')!).render(
  <div className="bg-[#eef2f7] min-h-[100dvh]">
    <div className="w-full mx-auto px-3 sm:px-5 lg:px-10 py-4 sm:py-6 max-w-screen-2xl space-y-5">
      <h1 className="text-[22px] font-extrabold text-[#14254A]">
        Hi, Gaurav.
        <span className="font-normal text-[14px] text-gray-500 ml-2">
          here’s what’s happened with your protection this week.
        </span>
      </h1>
      <ProgramCalendar />
      {/* Mirrors /welcome exactly: the week's figures sit BELOW the calendar.
          Without this the harness cannot catch a fit rule that mistakes
          "everything under the card" for "the page's bottom gutter" — which is
          precisely the bug it did not catch the first time. */}
      <div className="rounded-2xl border border-gray-100 bg-white p-5" style={{ minHeight: 420 }}>
        <p className="text-[15px] font-extrabold text-[#14254A]">This week</p>
        <p className="text-[13px] text-gray-500 mt-2">
          Stand-in for the overview block. Its height is deliberately large: the
          calendar above must still fill the first screen, and this must be
          reached by scrolling rather than by shrinking the month.
        </p>
      </div>
    </div>
  </div>,
)
