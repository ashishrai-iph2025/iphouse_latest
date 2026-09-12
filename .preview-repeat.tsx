import { createRoot } from 'react-dom/client'
import '@/app/globals.css'
import { RepeatOffenders } from '@/app/admin/reports/page'
import { themeFor } from '@/lib/reportTheme'

/* The card on its new measure: times BACK after a takedown, with the account's
 * own state beside it. The pairing is the finding — a profile removed four
 * times and still not suspended is defying enforcement; one that was suspended
 * has been dealt with. The old card could show neither.
 */
const dark = new URLSearchParams(location.search).get('dark') === '1'
const m = themeFor('iphouse', dark)

const ROWS = [
  ['https://www.reddit.com/r/AssasinationClassroom/', 23, 25, 25, 'Not Available'],
  ['https://x.com/hazard3den10',                       3,  4,  4, 'Suspended'],
  ['https://x.com/HarryFixedmatch',                    2,  8,  4, 'Not Available'],
  ['https://x.com/liverpoolitv',                       2,  8,  6, 'Not Available'],
  ['https://x.com/alsabahalyoum',                      2,  7,  7, 'Suspended'],
  ['https://live.vkvideo.ru/vitalsportbasic',          1,  2,  2, 'Not Available'],
  ['https://www.facebook.com/profile.php?id=00000000', 1,  2,  2, 'Suspended'],
].map(([label, repeats, urls, removed, profileStatus]) =>
  ({ label, value: label, repeats, urls, removed, profileStatus }))

createRoot(document.getElementById('root')!).render(
  <div className={`p-6 min-h-screen ${dark ? 'dark' : ''}`}
    style={{ background: dark ? '#0f1b33' : '#eef2f7' }}>
    <div className="rounded-2xl shadow-card border overflow-hidden max-w-[1000px]"
      style={{ background: m.surface, borderColor: dark ? 'rgba(255,255,255,.08)' : '#f1f3f6' }}>
      <div className="px-4 py-3 border-b" style={{ borderColor: dark ? 'rgba(255,255,255,.08)' : '#f1f3f6' }}>
        <h3 className="text-[14px] font-bold" style={{ color: dark ? '#fff' : '#14254A' }}>
          Repeat Offenders - Top 10 Channels / Profiles
        </h3>
      </div>
      <div className="p-4 pt-3">
        <RepeatOffenders rows={ROWS} m={m} onPick={() => {}} />
      </div>
    </div>
  </div>
)
