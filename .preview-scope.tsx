import { createRoot } from 'react-dom/client'
import '@/app/globals.css'
import ReportScopePanel from '@/components/admin/ReportScopePanel'

/* The Report scope tab, with its three endpoints stubbed.
 *
 * The COMPONENT is the real one, imported rather than reimplemented — same
 * harness pattern as .preview-realtime.tsx, and for the same reason.
 *
 * The VALUES are the ones off the live warehouse for DAZN: nine franchises and
 * nine match days, which is what the asset master's facets actually return, and
 * a title search that answers the way the master does. The point of using real
 * ones is length — "Women's Tennis Association" beside "Boxing" is what the tick
 * list has to lay out, not a row of four-letter placeholders.
 *
 *   ?hidden=1   opens with a franchise, a match day and two titles already left
 *               out, which is the state somebody arrives at to change
 */
const q = new URLSearchParams(location.search)
const preHidden = q.get('hidden') === '1'

const FRANCHISES = [
  'Belgian Pro League', 'Boxing', 'Bundesliga', 'Formula One', 'LaLiga',
  'MotoGP', 'National Rugby League', 'Serie A', "Women's Tennis Association",
]
const MATCHDAYS = [
  'Matchday 1', 'Matchday 2', 'Matchday 26', 'Matchday 27',
  'Matchday 3', 'Matchday 4', 'Matchday 5', 'Matchday 6', 'Matchday 7',
]

const TITLES = [
  { id: 'A1', name: 'Serie A: Juventus vs Milan (07-09-2026)', franchise: 'Serie A' },
  { id: 'A2', name: 'LaLiga: Real Madrid vs Rayo Vallecano (07-09-2026)', franchise: 'LaLiga' },
  { id: 'A3', name: 'Serie A: Venezia vs Fiorentina (12-09-2026)', franchise: 'Serie A' },
  { id: 'A4', name: 'Arsenal Vs Juventus', franchise: '' },
]

const hidden = preHidden
  ? { franchise: ['Boxing'], matchDay: ['Matchday 27'], asset: ['A2', 'A4'] }
  : { franchise: [], matchDay: [], asset: [] }

const real = window.fetch.bind(window)
window.fetch = ((input: any, init?: any) => {
  const url = String(typeof input === 'string' ? input : input?.url ?? '')
  const json = (body: any) =>
    Promise.resolve(new Response(JSON.stringify(body), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))

  if (url.startsWith('/api/admin/report-client-map')) {
    return json({
      warehouseClients: [
        { id: '70408704-E460-41EB-8304-022DFAFE704C', name: 'DAZN Limited' },
        { id: 'E7A5B834-F231-49D2-A408-D72CDFF06D17', name: 'Another Client' },
      ],
    })
  }

  if (url.startsWith('/api/admin/report-dim-values')) {
    const search = new URL(url, location.origin).searchParams.get('q') || ''
    if (search) {
      const hit = TITLES.filter(t => t.name.toLowerCase().includes(search.toLowerCase()))
      return json({ franchise: FRANCHISES, matchDay: MATCHDAYS, hidden, assets: hit })
    }
    return json({
      franchise: FRANCHISES, matchDay: MATCHDAYS, hidden,
      // What the endpoint returns when nothing is searched: the hidden titles,
      // resolved to their names.
      assets: TITLES.filter(t => hidden.asset.includes(t.id)),
    })
  }

  if (url.startsWith('/api/admin/report-dim-exclusions')) {
    return json({ success: true })
  }
  return real(input, init)
}) as typeof window.fetch

createRoot(document.getElementById('root')!).render(
  <div className="bg-[#eef2f7] min-h-[100dvh] p-6">
    <div className="max-w-5xl">
      <ReportScopePanel />
    </div>
  </div>,
)
