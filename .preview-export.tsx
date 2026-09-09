import { chartToPng } from '@/lib/chartImage'
import { buildPrintDocument } from '@/lib/printReport'
import { exportLogo } from '@/lib/exportBrand'
import '@/app/globals.css'

// What actually comes out of the two picture exports, on the page, so the mark's
// placement can be looked at rather than described.
//
// No React and no timers: everything is awaited at module scope, which is the
// only shape a headless screenshot reliably catches — a render scheduled behind
// a setTimeout is a render the virtual-time clock has already run past.

const root = document.getElementById('root')!
root.className = 'p-6 bg-[#eef2f7] min-h-screen space-y-6'

const h = (tag: string, cls: string, html: string) => {
  const el = document.createElement(tag)
  el.className = cls
  el.innerHTML = html
  return el
}

/* A stand-in panel, shaped like a real card body: a title line and a few rows
   of bars. chartToPng rasterises whatever is in it. */
const panel = h('div', 'bg-white rounded-2xl border border-gray-100 p-4 w-[560px]', `
  <p class="text-[11.5px] text-gray-400 mb-2">Links found against links taken down</p>
  ${['Telegram 18,420', 'Facebook Watch 12,310', 'Dailymotion 9,080', 'VK 4,120'].map((t, i) => `
    <div class="flex items-center gap-2 mb-1.5">
      <span class="w-[130px] text-[11px] text-gray-600">${t.split(' ').slice(0, -1).join(' ')}</span>
      <span class="flex-1 h-2 rounded-sm" style="width:${90 - i * 18}%;background:#14254A"></span>
      <span class="text-[10px] font-bold text-[#14254A]">${t.split(' ').pop()}</span>
    </div>`).join('')}
`)
root.appendChild(h('p', 'text-[11px] font-bold uppercase tracking-widest text-gray-400', 'The panel on screen'))
root.appendChild(panel)

const logo = await exportLogo()

// ── The PNG export ──────────────────────────────────────────────────────────
const asPng = async (dark: boolean) => {
  const blob = await chartToPng(panel, {
    title: 'Identification & removal',
    subtitle: 'DAZN · 1 Aug 2026 – 31 Dec 2026 · Franchise: LaLiga',
    footer: 'IP House · Reports',
    scale: 1, dark,
  })
  const url = await new Promise<string>(res => {
    const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.readAsDataURL(blob)
  })
  const shot = new Image()
  shot.src = url
  shot.style.cssText = 'border:2px solid #FC934C;display:block'
  root.appendChild(shot)
  await shot.decode()
}

root.appendChild(h('p', 'text-[11px] font-bold uppercase tracking-widest text-gray-400 pt-2',
  `The downloaded PNG${logo ? '' : ' — the mark did not load'}`))
await asPng(false)
// The dark export too: the mark is navy ink and has to come out white on it.
root.appendChild(h('p', 'text-[11px] font-bold uppercase tracking-widest text-gray-400 pt-2',
  'The same PNG on the dark theme'))
await asPng(true)

// ── The PDF's first page ────────────────────────────────────────────────────
root.appendChild(h('p', 'text-[11px] font-bold uppercase tracking-widest text-gray-400 pt-2',
  'The PDF, as it is built'))
const html = buildPrintDocument(panel, {
  fileName: 'preview',
  title: 'Open Web — Sports',
  client: 'DAZN',
  window: '1 Aug 2026 – 31 Dec 2026',
  filters: [{ label: 'Franchise', value: 'LaLiga' }, { label: 'Match day', value: 'Matchday 4' }],
}, logo?.dataUrl)
const frame = document.createElement('iframe')
frame.style.cssText = 'width:900px;height:430px;border:2px solid #FC934C;background:#fff;display:block'
root.appendChild(frame)
frame.contentDocument!.open()
frame.contentDocument!.write(html)
frame.contentDocument!.close()
