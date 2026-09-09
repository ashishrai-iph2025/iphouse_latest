import { createRoot } from 'react-dom/client'
import ReportAppearancePanel from '@/components/admin/ReportAppearancePanel'
import '@/app/globals.css'

// Report Configuration → Appearance, with the three endpoints it talks to
// stubbed in memory. Same harness pattern as .preview-cal.tsx; the point is to
// see the screen without a login and a warehouse behind it.

const Q = new URLSearchParams(location.search)
if (Q.get('dark') === '1') document.documentElement.classList.add('dark')

// ?custom=1 opens on a custom palette, which is the half of the screen that is
// otherwise hidden behind a click.
const CUSTOM_FIRST = Q.get('custom') === '1'

const store: Record<string, any> = {
  '': CUSTOM_FIRST
    ? { engine: 'echarts', theme: 'custom', source: '',
        custom: { ident: '#0F7B5F', removed: '#D6455E', cat: ['#0F7B5F', '#D6455E', '#E7B93B', '#3E7CB1', '#8A5CD1'] } }
    : { engine: 'native', theme: 'iphouse', custom: null, source: '' },
  'c-2': { engine: 'echarts', theme: 'custom', source: 'c-2',
    custom: { ident: '#0F7B5F', removed: '#D6455E', cat: ['#0F7B5F', '#D6455E', '#E7B93B', '#3E7CB1'] } },
}

const real = window.fetch.bind(window)
window.fetch = (async (input: any, init?: any) => {
  const url = String(typeof input === 'string' ? input : input?.url ?? '')
  const json = (body: any) => new Response(JSON.stringify(body), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })

  if (url.startsWith('/api/admin/report-client-map')) {
    return json({ success: true, warehouseClients: [
      { id: 'c-1', name: 'Northern Broadcast Group' },
      { id: 'c-2', name: 'Vermilion Sports Media' },
      { id: 'c-3', name: 'Harbour Studios' },
    ] })
  }

  if (url.startsWith('/api/admin/report-appearance')) {
    const id = new URL(url, location.origin).searchParams.get('clientId') || ''
    const method = String(init?.method || 'GET').toUpperCase()
    if (method === 'PUT') {
      const body = JSON.parse(String(init?.body || '{}'))
      store[body.clientId || ''] = {
        engine: body.engine, theme: body.theme,
        custom: body.custom ?? store[body.clientId || '']?.custom ?? null,
        source: body.clientId || '',
      }
      return json({ success: true, appearance: store[body.clientId || ''] })
    }
    if (method === 'DELETE') { delete store[id]; return json({ success: true }) }
    const own = store[id]
    const got = own ?? { ...store[''], source: '' }
    return json({
      success: true, appearance: got, inherited: !!id && !own,
      clients: Object.keys(store).filter(Boolean),
    })
  }
  return real(input, init)
}) as typeof window.fetch

createRoot(document.getElementById('root')!).render(
  <div className="p-6 min-h-screen bg-[#f3f6fb] dark:bg-[#0f1d33]">
    <ReportAppearancePanel />
  </div>,
)
