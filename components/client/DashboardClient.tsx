'use client'

import { useState, useEffect, useRef } from 'react'

interface Module {
  moduleId:   number
  moduleName: string
  moduleIcon: string
  link:       string
  noLinkMsg:  string
  active:     number
  default:    number
}

interface Props {
  userName:    string
  userLogo:    string
  companyLogo: string
  modules:     Module[]
}

function extractReportId(url: string): string {
  try { return new URL(url).searchParams.get('reportId') || url } catch { return url }
}

/** A single navigation/module button. Shared by the open sidebar and the
 *  collapsed hover fly-out so both render identically. */
function NavModuleButton({
  label, isActive, onClick, className = '',
}: { label: string; isActive: boolean; onClick: () => void; className?: string }) {
  return (
    <button
      onClick={onClick}
      className={[
        'text-left rounded-xl font-semibold transition-all',
        isActive ? 'text-white shadow-md' : 'text-gray-600 hover:text-white',
        className,
      ].join(' ')}
      style={isActive ? {
        background: 'linear-gradient(135deg, #FFC82B 0%, #FC934C 100%)',
        boxShadow:  '0 8px 20px -4px rgba(252,147,76,0.4)',
      } : { transition: 'all 0.2s' }}
      onMouseEnter={e => { if (!isActive) { const el = e.currentTarget; el.style.background = 'linear-gradient(135deg, #FFC82B 0%, #FC934C 100%)'; el.style.boxShadow = '0 8px 20px -4px rgba(252,147,76,0.4)' } }}
      onMouseLeave={e => { if (!isActive) { const el = e.currentTarget; el.style.background = ''; el.style.boxShadow = '' } }}
    >
      {label}
    </button>
  )
}

export default function DashboardClient({ userName, modules }: Props) {
  const [activeId,     setActiveId]     = useState<number | null>(null)
  const [loadingEmbed, setLoadingEmbed] = useState(false)
  const [embedError,   setEmbedError]   = useState('')
  const [pbiReady,     setPbiReady]     = useState(false)
  const [sidebarOpen,  setSidebarOpen]  = useState(true)
  const [hoverMenu,    setHoverMenu]    = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Load PowerBI client script once
  useEffect(() => {
    if ((window as any).powerbi) { setPbiReady(true); return }
    const s = document.createElement('script')
    s.src = 'https://cdn.jsdelivr.net/npm/powerbi-client/dist/powerbi.js'
    s.onload  = () => setPbiReady(true)
    s.onerror = () => setEmbedError('Failed to load PowerBI client library')
    document.head.appendChild(s)
  }, [])

  async function embedReport(mod: Module) {
    if (!containerRef.current || !pbiReady) return
    setActiveId(mod.moduleId)
    setLoadingEmbed(true)
    setEmbedError('')

    const reportId = extractReportId(mod.link)
    try {
      const res  = await fetch(`/api/embed-token?reportId=${encodeURIComponent(reportId)}`)
      const ct   = res.headers.get('content-type') || ''

      if (!ct.includes('application/json')) {
        // A non-JSON response means something in front of the app (a security
        // check, proxy, or gateway) intercepted the request before it reached
        // our API — never surface that raw payload to the user.
        throw new Error(
          res.ok
            ? 'Unexpected response from the server — please try again.'
            : `The dashboard service is temporarily unavailable (error ${res.status}). Please try again in a moment, or contact support if this persists.`
        )
      }
      const data = await res.json().catch(() => { throw new Error('Invalid response from server — please try again.') })
      if (!res.ok || data.error) throw new Error(data.error || `Server error (${res.status}) — please try again or contact support.`)

      const pbi = (window as any).powerbi
      pbi.reset(containerRef.current)
      pbi.embed(containerRef.current, {
        type:        'report',
        tokenType:   1,
        accessToken: data.embedToken,
        embedUrl:    data.embedUrl,
        id:          data.reportId,
        settings: {
          panes: {
            filters:        { visible: false },
            pageNavigation: { visible: true },
          },
        },
      })
    } catch (err: any) {
      setEmbedError(err.message || 'Error loading report content.')
    } finally {
      setLoadingEmbed(false)
    }
  }

  // Auto-load first active module once PowerBI is ready
  useEffect(() => {
    if (!pbiReady) return
    const first = modules.find(m => m.active === 1 && m.link?.trim())
    if (first) embedReport(first)
  }, [pbiReady]) // eslint-disable-line react-hooks/exhaustive-deps

  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'short', year: 'numeric',
  })

  const activeModules = modules.filter(m => m.active === 1 && m.link?.trim())

  // Full viewport height minus the 56px navbar
  return (
    <div className="flex flex-col" style={{ height: 'calc(100dvh - 92px)', background: '#14254A' }}>

      {/* Sidebar + embed — fills remaining height */}
      <div className="flex flex-col md:flex-row flex-1 min-h-0 gap-3 md:gap-5 px-3 sm:px-5 md:px-6 pt-3 md:pt-5 pb-3 md:pb-5">

        {/* Sidebar toggle button — with hover fly-out menu when collapsed */}
        <div
          className="hidden md:block relative flex-shrink-0 self-start"
          style={{ marginTop: '2px' }}
          onMouseEnter={() => { if (!sidebarOpen) setHoverMenu(true) }}
          onMouseLeave={() => setHoverMenu(false)}
        >
          <button
            onClick={() => { setSidebarOpen(o => !o); setHoverMenu(false) }}
            title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar — hover for quick menu'}
            className="flex items-center justify-center w-6 h-8 rounded-lg text-white/60 hover:text-white hover:bg-white/10 transition-colors"
          >
            {sidebarOpen ? '‹' : '›'}
          </button>

          {/* Hover fly-out: visible only while collapsed and hovered.
              pl-2 acts as a hover bridge so the menu stays open while the
              pointer travels from the icon to the panel. */}
          {!sidebarOpen && hoverMenu && (
            <div className="absolute left-full top-0 z-40 pl-2 fade-in">
              <div className="w-56 bg-white rounded-2xl shadow-xl border border-gray-100 p-3 flex flex-col">
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-gray-400 px-1 mb-2">Navigation</p>
                <nav className="flex flex-col gap-1 max-h-[60vh] overflow-y-auto">
                  {activeModules.length === 0 ? (
                    <p className="text-xs text-gray-400 p-2">No modules found</p>
                  ) : activeModules.map(m => (
                    <NavModuleButton
                      key={m.moduleId}
                      label={m.moduleName}
                      isActive={activeId === m.moduleId}
                      onClick={() => { embedReport(m); setHoverMenu(false) }}
                      className="w-full px-4 py-2.5 text-sm"
                    />
                  ))}
                </nav>
              </div>
            </div>
          )}
        </div>

        {/* Sidebar — horizontal scroll on mobile, fixed sidebar on desktop */}
        {sidebarOpen && (
          <aside className="md:w-60 md:flex-shrink-0 md:self-start bg-white rounded-2xl shadow-sm border border-gray-100 p-3 md:p-5 flex flex-col">
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-gray-400 mb-2 md:mb-4">Navigation</p>
            <nav className="flex flex-row md:flex-col gap-1.5 md:gap-1 overflow-x-auto md:overflow-x-visible pb-1 md:pb-0">
              {activeModules.length === 0 ? (
                <p className="text-xs text-gray-400 p-2">No modules found</p>
              ) : activeModules.map(m => (
                <NavModuleButton
                  key={m.moduleId}
                  label={m.moduleName}
                  isActive={activeId === m.moduleId}
                  onClick={() => embedReport(m)}
                  className="md:w-full px-3 md:px-4 py-2 md:py-2.5 text-xs md:text-sm whitespace-nowrap md:whitespace-normal flex-shrink-0 md:flex-shrink"
                />
              ))}
            </nav>
          </aside>
        )}

        {/* PowerBI embed area */}
        <div className="flex-1 min-w-0 bg-[#14254A] rounded-2xl overflow-hidden relative">
          {loadingEmbed && (
            <div className="absolute inset-0 bg-white/90 flex flex-col items-center justify-center z-10 gap-3">
              <div className="w-9 h-9 border-[3px] border-gray-200 border-t-[#FC934C] rounded-full animate-spin" />
              <p className="text-sm font-semibold text-gray-500">Loading Dashboard…</p>
            </div>
          )}
          {!loadingEmbed && embedError && (
            <div className="absolute inset-0 flex items-center justify-center p-8">
              <div className="bg-white/10 border border-red-400/40 rounded-2xl px-8 py-6 max-w-md text-center">
                <svg className="mx-auto mb-3 text-red-400" width="32" height="32" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                </svg>
                <p className="text-red-300 font-semibold text-sm mb-1">Unable to load report</p>
                <p className="text-white/50 text-xs leading-relaxed">{embedError}</p>
                <button
                  onClick={() => { setEmbedError(''); if (activeId) { const m = modules.find(x => x.moduleId === activeId); if (m) embedReport(m) } }}
                  className="mt-4 px-4 py-1.5 rounded-lg text-xs font-semibold bg-white/10 hover:bg-white/20 text-white transition-colors"
                >
                  Try again
                </button>
              </div>
            </div>
          )}
          {!loadingEmbed && !embedError && !activeId && (
            <div className="absolute inset-0 flex items-center justify-center">
              <p className="text-white/30 text-sm">Select a module to view the report</p>
            </div>
          )}
          <div ref={containerRef} className="w-full h-full" />
        </div>

      </div>
    </div>
  )
}
