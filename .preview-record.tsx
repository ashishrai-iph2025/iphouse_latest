import { createRoot } from 'react-dom/client'
import '@/app/globals.css'
import { RecordDetail } from '@/components/infringement/ResultsView'
import { TimeZoneProvider } from '@/lib/timezone'

/* The Open Web record drawer, on each END of the pair.
 *
 * An Open Web result is a PAIR — the page carrying the link and the host
 * serving the file — and a row is one end of it. The upstream sends the whole
 * envelope either way, so a LINKING row arrived carrying DMCA Removal Status,
 * Removal Status and their two timestamps, all empty, and the drawer printed
 * them: three "Not recorded" cards level with the one status that says
 * something. Nothing will ever fill them — no notice goes to a host on behalf
 * of a linking URL — so they read as a stalled pipeline rather than a complete
 * one.
 *
 * Both ends are shown below with the SAME field envelope, so the only
 * difference between the two panels is which end the row is.
 */

/*
 * The real Open Web envelope, field for field.
 *
 *   delistingremovalstatus / delistingTime          → Google de-indexing  ┐
 *   bingdelistingremovalstatus / bingdelistingTime  → Bing de-indexing    │ LINK
 *   dmcaremovalstatus / dmcaRemovalTime             → the link coming down┘
 *   removalstatus / removalTime                     → the HOST coming down
 *
 * The Bing pair is not in the API response yet. It is here because the day it
 * lands the drawer has to place and name it with no release on this side, and
 * a preview that only covers today's payload cannot show whether it will.
 */
const envelope = {
  assetName: 'WTA - Toronto Open',
  infringementType: 'Live Stream',
  urlUploadDate: '2026-09-05T05:34:00',
  enforcementTime: '2026-09-05T22:23:00',

  infringingURL: 'https://example-linking.invalid/watch?id=0000',
  infringingDomain: 'example-linking.invalid',

  // ── The linking end's three outcomes ──
  delistingremovalstatus: 'Approved',
  delistingTime: '2026-09-06T07:11:00',
  bingdelistingremovalstatus: 'Approved',
  bingdelistingTime: '2026-09-06T07:11:00',
  dmcaremovalstatus: 'Active',
  dmcaRemovalTime: null,

  // ── The host end's ──
  removalstatus: null,
  removalTime: null,
}

/** Today's payload: the same row before the Bing columns exist. */
const { bingdelistingremovalstatus, bingdelistingTime, ...beforeBing } = envelope

const CASES = [
  {
    title: 'Linking row — as the API answers TODAY',
    note: 'No Bing columns yet. Google de-indexing, the link’s own removal, and nothing from the host end.',
    row: beforeBing,
  },
  {
    title: 'Linking row — once Bing ships',
    note: 'The two new fields place and name themselves: Google, then Bing, then the link’s removal. No release needed on this side.',
    row: envelope,
  },
  {
    title: 'Linking row — Bing keys present but EMPTY',
    note: 'The shape the API will ship first: both keys there, both "". Blank is the answer on an enforcement field — nothing submitted to Bing yet — so they hold their place and read "Not recorded" rather than vanishing and moving the card beside them.',
    row: { ...envelope, bingdelistingremovalstatus: '', bingdelistingTime: '' },
  },
  {
    title: 'Host row — carries a host URL',
    note: 'The mirror image. Only the host’s own removal; every de-indexing and the link’s DMCA takedown are the other end’s.',
    row: {
      ...envelope,
      sourceURL: 'https://example-host.invalid/stream/0000.m3u8',
      sourceDomain: 'example-host.invalid',
      removalstatus: 'Dead',
      removalTime: '2026-09-06T09:44:00',
    },
  },
  {
    title: 'Telegram row — not Open Web, no pair',
    note: 'openWeb is false, so nothing is hidden and nothing is renamed: a post has no host behind it and its removal status is its own.',
    row: {
      assetName: 'WTA - Toronto Open', infringementType: 'Live Stream', platform: 'Telegram',
      postURL: 'https://t.me/example/0000',
      urlUploadDate: '2026-09-05T05:34:00', enforcementTime: '2026-09-05T22:23:00',
      removalStatus: 'Dead', removalTime: '2026-09-06T01:02:00',
    },
    openWeb: false,
  },
]

/** ?only=<substring> renders one case, for looking at it on its own. */
const only = new URLSearchParams(location.search).get('only')?.toLowerCase()
const shown = only ? CASES.filter(c => c.title.toLowerCase().includes(only)) : CASES

createRoot(document.getElementById('root')!).render(
  <TimeZoneProvider>
    <div className="p-6 min-h-screen" style={{ background: '#eef2f7' }}>
      {shown.map(c => (
        <div key={c.title} className="rounded-2xl border border-gray-200 bg-white overflow-hidden max-w-[900px] mb-6">
          <div className="px-4 py-3 border-b border-gray-100">
            <h3 className="text-[14px] font-bold text-[#14254A]">{c.title}</h3>
            <p className="text-[11px] text-gray-400 mt-0.5">{c.note}</p>
          </div>
          <RecordDetail row={c.row} openWeb={c.openWeb ?? true} onPreview={() => {}} />
        </div>
      ))}
    </div>
  </TimeZoneProvider>
)
