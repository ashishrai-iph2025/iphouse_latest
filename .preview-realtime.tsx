import { createRoot } from 'react-dom/client'
import RealtimeCard from '@/components/shared/RealtimeCard'
import '@/app/globals.css'

// The live-counts card with its endpoint stubbed. Same harness pattern as
// .preview-cal.tsx.
//
// The rows are the ones off a real reading, and they are the reason the bar
// changed: Open Web holds 26,613 of 27,294, so against that peak every other
// platform's bar was under one percent of the cell and the removal split inside
// it was a fraction of a pixel.

const PLATFORMS = [
  ['openweb', 'Open Web', 26613, 16737], ['telegram', 'Telegram', 240, 108],
  ['x', 'X (Twitter)', 160, 0], ['vkvideo', 'VKvideo', 68, 0],
  ['reddit', 'reddit.com', 47, 0], ['tiktok', 'TikTok', 44, 0],
  ['bilibili', 'BiliBili', 30, 0], ['apps', 'Mobile apps', 27, 0],
  ['youtube', 'YouTube', 18, 18], ['facebook', 'Facebook', 15, 15],
  ['jaco', 'jaco.live', 10, 0], ['twitch', 'Twitch.tv', 9, 3],
  ['kick', 'kick.com', 5, 0], ['discord', 'Discord.com', 3, 0],
  ['rutube', 'Rutube.ru', 3, 0], ['instagram', 'Instagram', 1, 1],
  ['okru', 'OK.ru', 1, 0],
] as const

/* ?norem=1 answers WITHOUT removals — the war-room shape. That branch still
   draws volume against the busiest platform, and it is the one the bar change
   must not have touched. */
const NO_REMOVALS = new URLSearchParams(location.search).get('norem') === '1'

const payload = {
  ok: true,
  view: 'sports',
  source: 'warehouse',
  total: 27294,
  ...(NO_REMOVALS ? {} : { totalRemoved: 16879 }),
  platforms: PLATFORMS.map(([key, label, count, removed]) => ({
    key, label, family: 'web', count,
    ...(NO_REMOVALS ? {} : {
      removed,
      removalBasis: key === 'openweb' ? 'approved delisting notice' : 'unreachable URL',
    }),
  })),
}

const real = window.fetch.bind(window)
window.fetch = ((input: any, init?: any) => {
  const url = String(typeof input === 'string' ? input : input?.url ?? '')
  if (url.startsWith('/api/realtime/') || url.startsWith('/api/warroom/realtime')) {
    return Promise.resolve(new Response(JSON.stringify(payload), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))
  }
  return real(input, init)
}) as typeof window.fetch

/* THE CARD'S OWN THREE SLICERS, which only appear when the caller has options
   for them — so without this the picker bar along the foot is simply absent and
   the preview cannot show it.

   Real fixture labels, because their LENGTH is the point: the Asset control is
   the one that had to show "Serie A: Juventus vs Mila…" in a track fixed at
   170px, and the bar is what decides how much room it gets. */
const dimOptions = {
  franchiseName: [
    { key: 'seriea', label: 'Serie A', count: 12480 },
    { key: 'laliga', label: 'LaLiga', count: 9312 },
    { key: 'ligue1', label: 'Ligue 1', count: 2201 },
  ],
  matchDay: [
    { key: 'md3', label: 'Matchday 3', count: 4120 },
    { key: 'md4', label: 'Matchday 4', count: 3980 },
  ],
  assetId: [
    { key: 'a1', label: 'Serie A: Juventus vs Milan (07-09-2026)', count: 481 },
    { key: 'a2', label: 'LaLiga: Real Madrid vs Rayo Vallecano (07-09-2026)', count: 444 },
    { key: 'a3', label: 'Serie A: Venezia vs Fiorentina (12-09-2026)', count: 370 },
    { key: 'a4', label: 'Ligue 1: Paris Saint-Germain vs Olympique de Marseille (14-09-2026)', count: 258 },
    { key: 'a5', label: 'Serie A: Lazio vs Milan (12-09-2026)', count: 407 },
    { key: 'a6', label: 'Serie A: Cagliari vs Lecce (07-09-2026)', count: 333 },
    { key: 'a7', label: 'Serie A: Udinese vs Lazio (08-09-2026)', count: 296 },
    { key: 'a8', label: 'LaLiga: Sevilla vs Valencia (12-09-2026)', count: 259 },
  ],
}

createRoot(document.getElementById('root')!).render(
  <div className="bg-[#eef2f7] min-h-[100dvh] p-6">
    <RealtimeCard view="sports" windowOptions={[24, 48, 72, 96, 120, 144, 168]}
      dimOptions={dimOptions} />
  </div>,
)
