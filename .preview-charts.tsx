import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { EngineChart, ENGINES } from '@/lib/charts/engines'
import type { ChartForm, ChartSpec } from '@/lib/charts/spec'
import { REPORT_THEMES, themeFor } from '@/lib/reportTheme'
import '@/app/globals.css'

// Every engine against every form, on one page, with no API behind it. Same
// harness pattern as .preview-cal.tsx.
//
// The screen where an engine and a theme are actually CHOSEN is Report
// Configuration -> Appearance; .preview-appearance.tsx is the harness for that
// one. This is the matrix underneath it: 5 engines x 7 forms x 7 themes, which
// no real report shows all of.

const ROWS = [
  { label: 'Telegram', value: 'tg', urls: 18420, removed: 15980 },
  { label: 'Facebook Watch', value: 'fb', urls: 12310, removed: 7420 },
  { label: 'Dailymotion', value: 'dm', urls: 9080, removed: 8110 },
  { label: 'Streaming site — very long channel name here', value: 'ss', urls: 6440, removed: 2110 },
  { label: 'VK', value: 'vk', urls: 4120, removed: 3980 },
  { label: 'Odysee', value: 'od', urls: 2210, removed: 640 },
  { label: 'Rumble', value: 'ru', urls: 1180, removed: 940 },
]

const DAYS = Array.from({ length: 14 }, (_, i) => ({
  label: `2026-08-${String(i + 1).padStart(2, '0')}`,
  urls: 900 + Math.round(Math.sin(i / 2) * 400) + i * 40,
  removed: 500 + Math.round(Math.cos(i / 3) * 260) + i * 30,
}))

function spec(form: ChartForm, themeKey: string, dark: boolean, active: string,
  onPick: (v: string) => void): ChartSpec {
  const m = themeFor(themeKey, dark)
  if (form === 'line' || form === 'area' || form === 'group-column') {
    return {
      form, m, dark, height: 200,
      categories: DAYS.map(d => d.label.slice(5)),
      titles: DAYS.map(d => d.label),
      picks: DAYS.map(d => d.label),
      labels: false,
      series: [
        { name: 'Identified', color: m.ident, data: DAYS.map(d => d.urls) },
        { name: 'Removed', color: m.removed, data: DAYS.map(d => d.removed) },
      ],
      onPick, activeVal: active,
    }
  }
  const base = {
    form, m, dark, height: 240,
    categories: ROWS.map(r => (r.label.length > 22 ? `${r.label.slice(0, 11)}…${r.label.slice(-10)}` : r.label)),
    titles: ROWS.map(r => r.label),
    picks: ROWS.map(r => r.value),
    onPick, activeVal: active,
  }
  if (form === 'donut') {
    return {
      ...base,
      sliceColors: ROWS.map((_, i) => m.cat[i % m.cat.length]),
      series: [{ name: 'Identified', color: m.ident, data: ROWS.map(r => r.urls) }],
    }
  }
  if (form === 'stack-100') {
    const share = ROWS.map(r => Math.round((r.removed / r.urls) * 100))
    return {
      ...base, suffix: '%',
      series: [
        { name: 'Removed', color: m.removed, data: share },
        { name: 'Active', color: m.identSoft, data: share.map(v => 100 - v) },
      ],
    }
  }
  if (form === 'single-bar') {
    return {
      ...base, labels: true,
      series: [{ name: 'Identified', color: m.ident, data: ROWS.map(r => r.urls) }],
    }
  }
  return {
    ...base, labels: form === 'group-bar',
    series: [
      { name: 'Identified', color: m.ident, data: ROWS.map(r => r.urls) },
      { name: 'Removed', color: m.removed, data: ROWS.map(r => r.removed) },
    ],
  }
}

const FORMS: ChartForm[] = [
  'group-bar', 'group-column', 'single-bar', 'stack-100', 'donut', 'line', 'area',
]

const Q = new URLSearchParams(location.search)

function App() {
  const [engine, setEngine] = useState(Q.get('engine') || 'apex')
  const [theme, setTheme] = useState(Q.get('theme') || 'iphouse')
  const [dark, setDark] = useState(Q.get('dark') === '1')
  const [active, setActive] = useState('')
  document.documentElement.classList.toggle('dark', dark)

  /* ?png=1 runs the panel through the real PNG exporter and puts the result on
     the page, so a screenshot shows what a reader would actually download.
     Worth having for the canvas engines especially: they look right on screen
     and can still export blank. */
  useEffect(() => {
    if (Q.get('png') !== '1') return
    const t = setTimeout(async () => {
      const { chartToPng } = await import('@/lib/chartImage')
      const host = document.getElementById('png-out')
      if (!host) return
      const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-panel]'))
      for (const card of cards.slice(0, 2)) {
        try {
          const blob = await chartToPng(card, { title: card.dataset.panel || '', subtitle: 'exported PNG', scale: 1 })
          const img = new Image()
          /* A data URL, not a blob: URL. Headless Chrome under a virtual-time
             budget does not paint a blob image before the screenshot is taken,
             so the export appeared to have failed when it had not. */
          img.src = await new Promise<string>(res => {
            const fr = new FileReader()
            fr.onload = () => res(String(fr.result))
            fr.readAsDataURL(blob)
          })
          img.style.border = '2px solid #FC934C'
          img.style.margin = '6px'
          host.appendChild(img)
        } catch (e) {
          const p = document.createElement('pre'); p.textContent = String(e); host.appendChild(p)
        }
      }
    }, 2000)
    return () => clearTimeout(t)
  }, [])

  return (
    <div className={dark ? 'p-4 min-h-screen bg-[#0f1d33]' : 'p-4 min-h-screen bg-[#f3f6fb]'}>
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <button onClick={() => setDark(d => !d)}
          className="px-2 py-1 rounded-lg border text-[11px] font-semibold border-gray-300">
          {dark ? 'Light' : 'Dark'}
        </button>
        <span className="text-[11px] text-gray-500 dark:text-white/60">
          engine <b>{engine}</b> · theme <b>{theme}</b> · filtered to <b>{active || '—'}</b>
        </span>
        <span className="flex gap-1">
          {ENGINES.map(e => (
            <button key={e.key} onClick={() => setEngine(e.key)}
              className={`px-2 py-1 rounded border text-[10px] ${engine === e.key ? 'bg-[#14254A] text-white' : 'border-gray-300 text-gray-600'}`}>
              {e.label}
            </button>
          ))}
        </span>
        <span className="flex gap-1">
          {REPORT_THEMES.map(t => (
            <button key={t.key} onClick={() => setTheme(t.key)}
              className={`px-2 py-1 rounded border text-[10px] ${theme === t.key ? 'bg-[#14254A] text-white' : 'border-gray-300 text-gray-600'}`}>
              {t.label}
            </button>
          ))}
        </span>
        <button onClick={() => setActive('')}
          className="px-2 py-1 rounded border text-[10px] border-gray-300 text-gray-600">clear filter</button>
      </div>

      <div id="png-out" className="flex flex-wrap bg-white/50 mb-3" />

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        {FORMS.map(f => (
          <div key={f} data-panel={f} className="bg-white dark:bg-[#1a2d55] rounded-2xl border border-gray-100
            dark:border-white/10 p-4">
            <h3 className="text-[12px] font-bold mb-2 text-[#14254A] dark:text-white">{f}</h3>
            <EngineChart engine={engine} spec={spec(f, theme, dark, active, setActive)}
              fallback={<p className="text-xs text-gray-400 py-8 text-center">built-in fallback for {f}</p>} />
          </div>
        ))}
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
