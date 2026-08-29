'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import AdminPageHeader from '@/components/admin/AdminPageHeader'
import ConfigIcon from '@/components/admin/ConfigIcon'
import { useTheme } from '@/lib/ThemeContext'
import {
  CONFIG_MODULES,
  SUPER_ADMIN_MODULES,
  CONFIG_GROUPS,
  type ConfigModule,
  type ConfigGroupKey,
} from '@/lib/configModules'

/* ─────────────────────────────────────────────────────────────────────────────
   Configuration — the admin console's front door.

   Nineteen tiles in one undifferentiated grid is a wall, not a menu: nothing
   tells you where to look, and finding "the SMTP one" means reading every card.
   Three things fix that, in order of how much work they save:

     1. Sections.  Modules are grouped by the decision they belong to (access,
        integrations, reporting, comms, operations) and inherit their section's
        accent, so colour means something instead of being nineteen hues.
     2. Search.    Matches title, description AND unwritten synonyms — "smtp",
        "s3", "lockout" — because people type the thing they want, not the
        formal name we gave the screen. `/` or ⌘K focuses it from anywhere on
        the page; Enter opens the top hit.
     3. Pins.      Most admins live in three of these. A pinned row at the top,
        stored per browser, turns the daily case into a zero-scroll case.

   A density toggle (cards ↔ rows) is the last piece: cards are right when you
   are learning the console, rows are right once you know it and just want the
   list short. Both preferences persist in localStorage — they are per-person
   comfort settings, not account data worth a round trip.
   ───────────────────────────────────────────────────────────────────────── */

const LS_VIEW = 'iph.configuration.view'
const LS_PINS = 'iph.configuration.pins'

/* The section accents are chosen for ink-on-white. On the dark page (#0f1f3d,
   cards #1a2d55) violet and blue in particular sink into the surface, so each
   one has a lifted counterpart at the same hue. Same idea as the palette swap
   in AdminHomeClient. */
const DARK_ACCENT: Record<string, string> = {
  '#0078D4': '#5AAEF5',
  '#7C3AED': '#A78BFA',
  '#FC934C': '#FDAE73',
  '#0891B2': '#38BFD8',
  '#10B981': '#34D399',
  '#DC2626': '#F87171',
}
const accent = (color: string, dark: boolean) => (dark ? DARK_ACCENT[color] ?? color : color)

/* ── Local preferences ──────────────────────────────────────────────────── */
function readPins(): string[] {
  try {
    const raw = localStorage.getItem(LS_PINS)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : []
  } catch { return [] }
}

/* ── Search ─────────────────────────────────────────────────────────────── */
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

function matches(mod: ConfigModule, q: string, groupLabel: string) {
  if (!q) return true
  const hay = norm([mod.title, mod.desc, groupLabel, ...(mod.keywords ?? [])].join(' '))
  /* Every word has to appear somewhere, in any order: "powerbi cred" should
     find PowerBI API Credentials without the user guessing our word order. */
  return norm(q).split(' ').every(term => hay.includes(term))
}

/** Title with the matched run highlighted, so a hit explains itself. */
function Highlight({ text, query }: { text: string; query: string }) {
  const q = norm(query)
  if (!q) return <>{text}</>
  const at = text.toLowerCase().indexOf(q.split(' ')[0])
  if (at < 0) return <>{text}</>
  const len = q.split(' ')[0].length
  return (
    <>
      {text.slice(0, at)}
      <mark className="bg-[#FFC82B]/40 text-inherit rounded-sm px-0.5">{text.slice(at, at + len)}</mark>
      {text.slice(at + len)}
    </>
  )
}

/* ── Icons used by the chrome (not by the modules) ──────────────────────── */
const SearchGlyph = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" />
  </svg>
)
const StarGlyph = ({ filled }: { filled: boolean }) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'}
    stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="m12 3.6 2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z" />
  </svg>
)

/* ── Card (grid view) ───────────────────────────────────────────────────── */
/* The whole tile navigates, but the pin is its own control — so the link is a
   transparent overlay rather than a wrapper. A <button> inside an <a> is
   invalid HTML and, in practice, unclickable. */
function ModuleCard({ mod, query, pinned, onPin, dark }: {
  mod: ConfigModule; query: string; pinned: boolean; onPin: (key: string) => void; dark: boolean
}) {
  const c = accent(mod.color, dark)
  return (
    <div className="group relative h-full bg-white rounded-2xl border border-gray-100 shadow-card
                    hover:shadow-lg hover:-translate-y-0.5 transition-all duration-200
                    p-4 pr-11 flex flex-col gap-3 overflow-hidden
                    focus-within:ring-2 focus-within:ring-[#0078D4]/60 focus-within:ring-offset-2
                    focus-within:ring-offset-[#eef2f7] dark:focus-within:ring-offset-[#0f1f3d]">
      <span className="absolute left-0 top-0 bottom-0 w-1 opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ background: c }} aria-hidden />

      <Link to={mod.href} className="absolute inset-0 rounded-2xl focus:outline-none" aria-label={`Open ${mod.title}`} />

      <div className="flex items-start gap-3">
        <span className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 transition-colors"
          style={{ background: dark ? `${mod.color}2E` : `${mod.color}14`, color: c }}>
          <ConfigIcon name={mod.key} size={21} />
        </span>
        <h3 className="font-semibold text-[13px] text-[#14254A] leading-snug pt-1.5">
          <Highlight text={mod.title} query={query} />
        </h3>
      </div>

      <p className="text-[11.5px] text-gray-500 leading-relaxed line-clamp-3">{mod.desc}</p>

      <span className="mt-auto pt-0.5 inline-flex items-center gap-1 text-[11px] font-semibold" style={{ color: c }}>
        Open
        <span className="transition-transform group-hover:translate-x-0.5" aria-hidden>→</span>
      </span>

      <PinButton mod={mod} pinned={pinned} onPin={onPin} className="absolute top-3 right-3" />
    </div>
  )
}

/* ── Row (list view) ────────────────────────────────────────────────────── */
function ModuleRow({ mod, query, pinned, onPin, dark }: {
  mod: ConfigModule; query: string; pinned: boolean; onPin: (key: string) => void; dark: boolean
}) {
  const c = accent(mod.color, dark)
  return (
    <div className="group relative flex items-center gap-3.5 px-4 py-3 bg-white
                    hover:bg-gray-50 transition-colors
                    focus-within:ring-2 focus-within:ring-inset focus-within:ring-[#0078D4]/60">
      <span className="absolute left-0 top-0 bottom-0 w-[3px] opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ background: c }} aria-hidden />

      <Link to={mod.href} className="absolute inset-0 focus:outline-none" aria-label={`Open ${mod.title}`} />

      <span className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
        style={{ background: dark ? `${mod.color}2E` : `${mod.color}14`, color: c }}>
        <ConfigIcon name={mod.key} size={18} />
      </span>

      <div className="min-w-0 flex-1">
        <p className="font-semibold text-[13px] text-[#14254A] leading-tight truncate">
          <Highlight text={mod.title} query={query} />
        </p>
        <p className="text-[11px] text-gray-500 leading-snug truncate">{mod.desc}</p>
      </div>

      <PinButton mod={mod} pinned={pinned} onPin={onPin} className="relative" />

      <span className="text-gray-300 group-hover:translate-x-0.5 transition-transform flex-shrink-0" aria-hidden>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}
          strokeLinecap="round" strokeLinejoin="round"><path d="m9 5 7 7-7 7" /></svg>
      </span>
    </div>
  )
}

function PinButton({ mod, pinned, onPin, className = '' }: {
  mod: ConfigModule; pinned: boolean; onPin: (key: string) => void; className?: string
}) {
  return (
    <button
      type="button"
      onClick={e => { e.preventDefault(); e.stopPropagation(); onPin(mod.key) }}
      aria-pressed={pinned}
      title={pinned ? `Unpin ${mod.title}` : `Pin ${mod.title} to the top`}
      className={`${className} z-10 flex-shrink-0 p-1.5 rounded-lg transition-all
        ${pinned
          ? 'text-[#FFC82B] opacity-100'
          : 'text-gray-300 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-[#FFC82B]'}
        hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0078D4]/60`}
    >
      <StarGlyph filled={pinned} />
    </button>
  )
}

/* ── Skeleton ───────────────────────────────────────────────────────────── */
/* Shaped like the grid it replaces, so the page does not jump when data lands. */
function Skeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4" aria-hidden>
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="h-[136px] rounded-2xl bg-white border border-gray-100 shadow-card p-4">
          <div className="flex gap-3">
            <div className="w-11 h-11 rounded-xl bg-gray-100 animate-pulse" />
            <div className="flex-1 pt-2 space-y-2">
              <div className="h-2.5 w-2/3 rounded bg-gray-100 animate-pulse" />
            </div>
          </div>
          <div className="mt-4 space-y-2">
            <div className="h-2 w-full rounded bg-gray-100 animate-pulse" />
            <div className="h-2 w-4/5 rounded bg-gray-100 animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────────────── */
export default function ConfigurationPage() {
  // Modules the current admin is allowed to see (grant-based: default deny).
  // A Super Admin shares specific modules; an admin sees only those.
  const [granted, setGranted] = useState<Set<string> | null>(null)
  const [role,    setRole]    = useState<number>(0)
  const [loading, setLoading] = useState(true)

  const [query,  setQuery]  = useState('')
  const [group,  setGroup]  = useState<ConfigGroupKey | 'all'>('all')
  const [view,   setView]   = useState<'grid' | 'list'>('grid')
  const [pins,   setPins]   = useState<string[]>([])

  const searchRef   = useRef<HTMLInputElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const [stuck, setStuck] = useState(false)
  const navigate  = useNavigate()
  const dark      = useTheme().theme === 'dark'

  useEffect(() => {
    fetch('/api/admin/my-config-access', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (d.success && Array.isArray(d.granted)) setGranted(new Set(d.granted))
        else setGranted(new Set())
        setRole(Number(d.role ?? 0))
      })
      .catch(() => setGranted(new Set()))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    setPins(readPins())
    try {
      const v = localStorage.getItem(LS_VIEW)
      if (v === 'grid' || v === 'list') setView(v)
    } catch { /* private mode / storage disabled — defaults are fine */ }
  }, [])

  function togglePin(key: string) {
    setPins(prev => {
      const next = prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
      try { localStorage.setItem(LS_PINS, JSON.stringify(next)) } catch { /* non-fatal */ }
      return next
    })
  }

  function chooseView(v: 'grid' | 'list') {
    setView(v)
    try { localStorage.setItem(LS_VIEW, v) } catch { /* non-fatal */ }
  }

  /* The toolbar only earns a dividing rule once it is actually floating over
     content. A hairline that is always there reads as a stray border; one that
     appears on scroll explains why the bar stopped moving. The sentinel is a
     1px row directly above the sticky element, watched against <main>'s scroll
     box rather than the viewport — <main> is what scrolls here. */
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(([entry]) => setStuck(!entry.isIntersecting), {
      root: el.closest('main'),
      threshold: 1,
    })
    io.observe(el)
    return () => io.disconnect()
  }, [loading])

  /* `/` and ⌘/Ctrl-K focus the search from anywhere that is not already a field.
     Esc clears and blurs — the standard escape hatch for a filtered list. */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement as HTMLElement | null
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      if ((e.key === '/' && !typing) || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      } else if (e.key === 'Escape' && typing && el === searchRef.current) {
        setQuery('')
        searchRef.current?.blur()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /* Everything this admin may open, in catalogue order. */
  const allowed = useMemo<ConfigModule[]>(() => {
    if (!granted) return []
    return [
      ...CONFIG_MODULES.filter(m => !m.hideCard && granted.has(m.key)),
      ...(role === 2 ? SUPER_ADMIN_MODULES : []),
    ]
  }, [granted, role])

  const groupLabel = (k: ConfigGroupKey) => CONFIG_GROUPS.find(g => g.key === k)?.label ?? ''

  const filtered = useMemo(
    () => allowed.filter(m => (group === 'all' || m.group === group) && matches(m, query, groupLabel(m.group))),
    [allowed, group, query],
  )

  const pinnedMods = useMemo(
    () => pins.map(k => allowed.find(m => m.key === k)).filter((m): m is ConfigModule => !!m),
    [pins, allowed],
  )

  /* Sections only exist for groups this admin actually has something in — an
     empty "Communications" heading is noise that implies missing access. */
  const sections = useMemo(
    () => CONFIG_GROUPS
      .map(g => ({ group: g, mods: filtered.filter(m => m.group === g.key) }))
      .filter(s => s.mods.length > 0),
    [filtered],
  )

  const browsing = !query && group === 'all'          // the un-filtered, "just looking" state
  const showPinned = browsing && pinnedMods.length > 0

  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && filtered.length > 0) {
      e.preventDefault()
      navigate(filtered[0].href)
    }
  }

  const cardProps = (m: ConfigModule) => ({
    mod: m, query, pinned: pins.includes(m.key), onPin: togglePin, dark,
  })

  return (
    <div className="p-6 pt-5 fade-in">

      <AdminPageHeader
        breadcrumb={[{ label: 'Configuration' }]}
        title="Configuration"
        description="Manage system settings, API access, credentials, and permissions."
      />

      {/* ── Toolbar ──
          Sticky against <main>'s scroll box so search and the section filter stay
          reachable however far down the page you are. The negative margin lets
          its background span the full width of the content column while the
          controls stay on the page's 24px gutter. */}
      {!loading && allowed.length > 0 && (<>
        <div ref={sentinelRef} className="h-px -mt-px" aria-hidden />
        <div className={`sticky top-0 z-20 -mx-6 px-6 pt-2 pb-3 mb-1
                        bg-[#eef2f7]/95 dark:bg-[#0f1f3d]/95 backdrop-blur transition-shadow
                        ${stuck ? 'border-b border-gray-200/70 shadow-[0_6px_16px_-12px_rgba(20,37,74,0.5)]' : 'border-b border-transparent'}`}>
          <div className="flex flex-col lg:flex-row lg:items-center gap-3">

            {/* Search */}
            <div className="relative flex-1 min-w-0 lg:max-w-md">
              <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none">
                <SearchGlyph />
              </span>
              <input
                ref={searchRef}
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={onSearchKeyDown}
                type="search"
                placeholder="Search settings — try “smtp”, “backup”, “permissions”"
                aria-label="Search configuration modules"
                className="w-full h-10 pl-10 pr-16 rounded-xl bg-white border border-gray-200
                           text-[13px] text-[#14254A] placeholder:text-gray-400
                           shadow-card focus:outline-none focus:border-[#0078D4]
                           focus:ring-2 focus:ring-[#0078D4]/20 transition-all"
              />
              {query ? (
                <button
                  onClick={() => { setQuery(''); searchRef.current?.focus() }}
                  aria-label="Clear search"
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-[#14254A] transition-colors text-sm leading-none"
                >
                  ✕
                </button>
              ) : (
                <kbd className="absolute right-3 top-1/2 -translate-y-1/2 hidden sm:block
                                text-[10px] font-semibold text-gray-400 border border-gray-200
                                rounded px-1.5 py-0.5 pointer-events-none select-none">
                  /
                </kbd>
              )}
            </div>

            {/* Section filter, and the view toggle beside it.

                TWO BOXES, NOT ONE, and the nesting is the point: the chips
                scroll and the toggle does not.

                They were one row — `overflow-x-auto` with `justify-end` and the
                toggle as its last child — which fails in both directions at
                once. `justify-end` on a scroll container pushes the overflow
                off the START, where there is no way to scroll back to it, and
                the toggle, being last, was the first thing carried past the
                right edge: on a wide screen it sat half-clipped against the
                gutter, which is what it looked like.

                So the toggle is a sibling of the scroller and never inside it.
                The scroller takes `min-w-0` so it may shrink below its content
                and scroll from its natural left edge; the outer box carries the
                `justify-end`, which now only ever right-aligns things that
                fit. */}
            <div className="flex items-center gap-2 min-w-0 lg:flex-1 lg:justify-end">
              <div className="flex items-center gap-1.5 min-w-0 overflow-x-auto
                              -mx-1 px-1 py-0.5 scrollbar-none">
                <FilterChip label="All" count={allowed.length} active={group === 'all'} onClick={() => setGroup('all')} />
                {CONFIG_GROUPS.map(g => {
                  const n = allowed.filter(m => m.group === g.key).length
                  if (!n) return null
                  return (
                    <FilterChip
                      key={g.key} label={g.label} count={n} dot={accent(g.color, dark)}
                      active={group === g.key} onClick={() => setGroup(group === g.key ? 'all' : g.key)}
                    />
                  )
                })}
              </div>

              {/* Density toggle */}
              <div className="flex-shrink-0 flex items-center p-0.5 rounded-lg bg-white border border-gray-200 shadow-card">
                {(['grid', 'list'] as const).map(v => (
                  <button
                    key={v}
                    onClick={() => chooseView(v)}
                    aria-pressed={view === v}
                    title={v === 'grid' ? 'Card view' : 'Compact list'}
                    className={`p-1.5 rounded-md transition-colors ${
                      view === v ? 'bg-[#14254A] dark:bg-[#31538f] text-white' : 'text-gray-400 hover:text-[#14254A]'
                    }`}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      {v === 'grid'
                        ? <><rect x="3" y="3" width="7.5" height="7.5" rx="1.5" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" /><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" /><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" /></>
                        : <><path d="M4 6h16M4 12h16M4 18h16" /></>}
                    </svg>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Result count — announced, so a screen reader hears the list shrink. */}
          {!browsing && (
            <p className="mt-2 text-[11px] text-gray-500" role="status" aria-live="polite">
              {filtered.length} of {allowed.length} {allowed.length === 1 ? 'module' : 'modules'}
              {query && <> matching <span className="font-semibold text-[#14254A]">“{query}”</span></>}
              {' · '}
              <button onClick={() => { setQuery(''); setGroup('all') }}
                className="font-semibold text-[#0078D4] hover:underline">
                Clear
              </button>
            </p>
          )}
        </div>
      </>)}

      {loading && <div className="mt-4"><Skeleton /></div>}

      {/* ── Pinned ──
          Only while browsing: once you are searching or filtering, a fixed row
          at the top is answering a question you did not ask. */}
      {showPinned && (
        <Section
          title="Pinned"
          desc="Your shortcuts on this browser. Use the star on any card to add or remove one."
          color={dark ? '#FFC82B' : '#E0A800'}
          count={pinnedMods.length}
        >
          {view === 'grid' ? (
            <Grid>{pinnedMods.map(m => <ModuleCard key={m.key} {...cardProps(m)} />)}</Grid>
          ) : (
            <List>{pinnedMods.map(m => <ModuleRow key={m.key} {...cardProps(m)} />)}</List>
          )}
        </Section>
      )}

      {/* ── Sections ── */}
      {sections.map(({ group: g, mods }) => (
        <Section key={g.key} title={g.label} desc={g.desc} color={accent(g.color, dark)} count={mods.length}>
          {view === 'grid' ? (
            <Grid>{mods.map(m => <ModuleCard key={m.key} {...cardProps(m)} />)}</Grid>
          ) : (
            <List>{mods.map(m => <ModuleRow key={m.key} {...cardProps(m)} />)}</List>
          )}
        </Section>
      ))}

      {/* ── Empty states ── */}
      {!loading && allowed.length === 0 && (
        <EmptyState
          title="No configuration modules shared with you"
          body="Configuration access is granted per module. Ask a Super Admin to share the ones you need and they will appear here."
        />
      )}

      {!loading && allowed.length > 0 && filtered.length === 0 && (
        <EmptyState
          title={query ? `Nothing matches “${query}”` : 'Nothing in this section'}
          body="Try a shorter term, or search by what the screen does — “password”, “refresh”, “s3”."
          action={
            <button
              onClick={() => { setQuery(''); setGroup('all'); searchRef.current?.focus() }}
              className="mt-4 px-4 py-2 rounded-xl bg-[#14254A] dark:bg-[#31538f] text-white text-xs font-semibold hover:bg-[#0078D4] transition-colors"
            >
              Reset search
            </button>
          }
        />
      )}
    </div>
  )
}

/* ── Layout primitives ──────────────────────────────────────────────────── */

/* Four across at the widest. Five would fit on a 1080p sidebar-collapsed
   window, but the descriptions stop being readable before the tiles do. */
function Grid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 items-stretch">
      {children}
    </div>
  )
}

function List({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-gray-100 shadow-card overflow-hidden divide-y divide-gray-100">
      {children}
    </div>
  )
}

function Section({ title, desc, color, count, children }: {
  title: string; desc?: string; color: string; count: number; children: React.ReactNode
}) {
  return (
    <section className="mt-6 first:mt-4">
      <div className="flex items-baseline gap-2.5 mb-3">
        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 self-center" style={{ background: color }} aria-hidden />
        <h2 className="text-[11px] font-bold uppercase tracking-[0.13em] text-[#14254A]">{title}</h2>
        <span className="text-[10px] font-semibold text-gray-400 tabular-nums">{count}</span>
        {/* `shrink min-w-0` so the description gives way to the rule rather than
            pushing it off the row on a narrow column. */}
        {desc && <p className="hidden md:block shrink min-w-0 truncate text-[11px] text-gray-400">{desc}</p>}
        <span className="flex-1 min-w-[24px] h-px bg-gray-200/70 self-center ml-1" aria-hidden />
      </div>
      {children}
    </section>
  )
}

function FilterChip({ label, count, active, onClick, dot }: {
  label: string; count: number; active: boolean; onClick: () => void; dot?: string
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`flex-shrink-0 inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border text-[11.5px] font-semibold
        transition-all whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0078D4]/50
        ${active
          ? 'bg-[#14254A] dark:bg-[#31538f] text-white border-[#14254A] dark:border-[#31538f] shadow-card'
          : 'bg-white text-gray-500 border-gray-200 hover:text-[#14254A] hover:border-gray-300'}`}
    >
      {dot && <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: dot }} aria-hidden />}
      {label}
      <span className={`tabular-nums text-[10px] ${active ? 'text-white/60' : 'text-gray-400'}`}>{count}</span>
    </button>
  )
}

function EmptyState({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="mt-6 bg-white rounded-2xl border border-gray-100 shadow-card px-6 py-14 text-center">
      <div className="w-12 h-12 mx-auto rounded-2xl bg-gray-50 flex items-center justify-center text-gray-300">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}
          strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" />
        </svg>
      </div>
      <p className="mt-3 text-sm font-semibold text-[#14254A]">{title}</p>
      <p className="mt-1 text-xs text-gray-500 max-w-sm mx-auto leading-relaxed">{body}</p>
      {action}
    </div>
  )
}
