'use client'

/*
Report Configuration → Appearance.

Two settings, per client, with a shared default underneath them:

  · ENGINE — which charting library draws the panels. The report's own
    components, ApexCharts, ECharts, Toast UI, or the sparkline strips.
  · THEME  — which palette every mark is coloured from: one of six named sets,
    or `custom`, whose colours are typed in below.

── Why this is here and not on the report ───────────────────────────────────

It began as a control in the report's own toolbar, which is where a reading
preference belongs — and it is not one. A palette carries MEANING in this
product: identification is navy, removal is orange, on the dashboard, in War
Room and in every deck a client has already been sent. The custom palette exists
precisely so a client whose brand is green can have that changed, and the moment
one reader can change it, two people looking at the same page are reading two
different documents.

So it is a decision made once per client, by staff, on the screen where the rest
of that client's report is arranged. The server agrees — see
go-server/handlers/reportappearance.go, which serves it behind the same
`report-config` grant and hands readers only the resolved answer.

── The preview is the point ─────────────────────────────────────────────────

Every control here changes something that cannot be described in a sentence —
"cooler neutrals", "a shared cross-series tooltip", "#0F7B5F". The two panels at
the bottom are the real renderers on stand-in rows, so the choice is made by
looking rather than by imagining. They are also the only way to see what a
custom palette does to a sequential ramp, which is derived rather than chosen.
*/

import { useCallback, useEffect, useMemo, useState } from 'react'
import SearchableSelect from '@/components/ui/SearchableSelect'
import { EngineChart, ENGINES, NATIVE } from '@/lib/charts/engines'
import type { ChartSpec } from '@/lib/charts/spec'
import {
  CUSTOM_THEME, DEFAULT_CUSTOM, DEFAULT_THEME, REPORT_THEMES,
  buildCustomTheme, isHexColor, reportTheme, type CustomPalette,
} from '@/lib/reportTheme'

/** The most a report ever hands out before it folds the tail into "Other". */
const MAX_CAT = 8

interface Appearance {
  engine: string
  theme: string
  custom?: Partial<CustomPalette> | null
  /** Which row the server answered from: '' is the shared default. */
  source?: string
}

/**
 * Tracks the app's dark theme, so the preview is drawn in the half the person
 * configuring it is actually looking at.
 *
 * The palettes carry a light set and a dark set and they are not derived from
 * one another — see lib/reportTheme.ts — so previewing the wrong one would show
 * colours no reader in this theme will ever see.
 */
function useIsDark(): boolean {
  const [dark, setDark] = useState(false)
  useEffect(() => {
    const check = () => setDark(document.documentElement.classList.contains('dark'))
    check()
    const obs = new MutationObserver(check)
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])
  return dark
}

const normaliseHex = (v: string) => {
  const t = String(v ?? '').trim()
  return t.startsWith('#') ? t : `#${t}`
}

/** A colour, as a swatch you can click and a hex field you can paste into. */
function ColorField({ label, hint, value, onChange, onRemove }: {
  label: string
  hint?: string
  value: string
  onChange: (v: string) => void
  onRemove?: () => void
}) {
  const ok = isHexColor(value)
  return (
    <div className="flex items-start gap-2">
      {/* The native picker, sized as a swatch. It only speaks #rrggbb, so a
          field mid-edit ("#0f7") is not pushed into it — it would silently
          rewrite what somebody is still typing. */}
      <input type="color" aria-label={label}
        value={ok && value.length === 7 ? value : '#000000'}
        onChange={e => onChange(e.target.value)}
        className="w-9 h-9 mt-4 rounded-lg border border-gray-200 dark:border-white/15 bg-transparent
          cursor-pointer p-0.5 shrink-0" />
      <div className="min-w-0">
        <label className="block text-[11px] font-semibold text-[#14254A] dark:text-white/85 truncate">
          {label}
        </label>
        <input type="text" value={value} spellCheck={false}
          onChange={e => onChange(e.target.value)}
          onBlur={e => onChange(normaliseHex(e.target.value))}
          className={`w-[104px] px-2 py-1 rounded-lg text-[11px] font-mono border bg-white
            dark:bg-white/5 dark:text-white ${ok
              ? 'border-gray-200 dark:border-white/15'
              : 'border-red-300 text-red-600 dark:border-red-400/50'}`} />
        {/* Under the field, not beside it: beside it the two-line hints pushed
            the swatches out of alignment with each other. */}
        {hint && (
          <span className="block text-[10px] text-gray-400 leading-snug mt-1 max-w-[150px]">{hint}</span>
        )}
      </div>
      {onRemove && (
        <button type="button" onClick={onRemove} title="Remove this colour"
          className="shrink-0 mt-4 w-6 h-6 grid place-items-center rounded-md text-gray-300
            hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors">
          ✕
        </button>
      )}
    </div>
  )
}

/** One selectable card, in either of the two lists. */
function Choice({ on, title, hint, note, swatch, onClick }: {
  on: boolean
  title: string
  hint: string
  note?: string
  swatch?: string[]
  onClick: () => void
}) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on}
      className={`text-left p-3 rounded-xl border transition-colors ${
        on
          ? 'border-[#FC934C] bg-[#FC934C]/[0.07] dark:bg-[#FC934C]/10'
          : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50 dark:border-white/15 dark:hover:bg-white/5'
      }`}>
      <span className="flex items-center gap-2">
        {swatch && (
          /* Three chips, not one: a palette is recognised by the relationship
             between its colours, and a single square of navy is the same square
             on four of the seven. */
          <span className="shrink-0 flex items-center gap-[2px]" aria-hidden="true">
            {swatch.map((c, i) => (
              <span key={i} className="w-3 h-3 rounded-[3px] ring-1 ring-black/10"
                style={{ background: c }} />
            ))}
          </span>
        )}
        <span className={`text-xs font-bold truncate ${
          on ? 'text-[#14254A] dark:text-white' : 'text-gray-600 dark:text-gray-300'}`}>
          {title}
        </span>
        {on && <span className="ml-auto shrink-0 text-[#FC934C] font-bold">✓</span>}
      </span>
      <span className="block text-[10.5px] text-gray-400 leading-snug mt-1">{hint}</span>
      {note && (
        <span className="block text-[10px] text-gray-400/85 italic leading-snug mt-0.5">{note}</span>
      )}
    </button>
  )
}

/* Stand-in rows for the preview. Deliberately shaped like the real thing — one
   dominant platform, a long tail and one name too long for an axis — because
   those are the three cases a palette or an engine gets wrong. */
const PREVIEW_ROWS = [
  { label: 'Telegram', urls: 18420, removed: 15980 },
  { label: 'Facebook Watch', urls: 12310, removed: 7420 },
  { label: 'Dailymotion', urls: 9080, removed: 8110 },
  { label: 'A streaming site with a very long name', urls: 6440, removed: 2110 },
  { label: 'VK', urls: 4120, removed: 3980 },
  { label: 'Odysee', urls: 2210, removed: 640 },
]

const shortLabel = (s: string) =>
  s.length <= 20 ? s : `${s.slice(0, 10)}…${s.slice(-9)}`

export default function ReportAppearancePanel() {
  const dark = useIsDark()

  const [clientId, setClientId] = useState('')
  const [directory, setDirectory] = useState<{ id: string; name: string }[]>([])
  const [withOwn, setWithOwn] = useState<string[]>([])

  const [saved, setSaved] = useState<Appearance>({ engine: NATIVE, theme: DEFAULT_THEME })
  const [draft, setDraft] = useState<Appearance>({ engine: NATIVE, theme: DEFAULT_THEME })
  const [inherited, setInherited] = useState(false)

  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')

  /* The palette being edited, kept separate from `draft.theme` so switching to
     Slate and back does not throw away colours somebody just typed. Only sent
     when the theme is Custom — see the server's COALESCE on the palette column,
     which keeps the stored set for exactly the same reason. */
  const [palette, setPalette] = useState<CustomPalette>(DEFAULT_CUSTOM)

  const nameOf = useCallback((id: string) =>
    directory.find(c => c.id === id)?.name || id, [directory])

  /* The warehouse's own client directory. Shared with the client-mapping tab
     rather than fetched from a list of its own, and it degrades to ids — the
     shared default can still be set with the analytics database out of reach. */
  useEffect(() => {
    fetch('/api/admin/report-client-map', { credentials: 'include' })
      .then(r => r.json())
      .then(j => setDirectory(Array.isArray(j.warehouseClients)
        ? j.warehouseClients.map((c: any) => ({ id: String(c.id), name: String(c.name || c.id) }))
        : []))
      .catch(() => { /* the picker degrades to ids, which still work */ })
  }, [])

  const load = useCallback(async (id: string) => {
    setLoading(true); setErr(''); setMsg('')
    try {
      const r = await fetch(`/api/admin/report-appearance?clientId=${encodeURIComponent(id)}`,
        { credentials: 'include' })
      const j = await r.json()
      if (!j.success) throw new Error(j.error || 'Could not load the appearance')
      const a: Appearance = {
        engine: String(j.appearance?.engine || NATIVE),
        theme: String(j.appearance?.theme || DEFAULT_THEME),
        custom: j.appearance?.custom ?? null,
        source: String(j.appearance?.source ?? ''),
      }
      setSaved(a)
      setDraft(a)
      setInherited(!!j.inherited)
      setWithOwn(Array.isArray(j.clients) ? j.clients.map(String) : [])
      if (a.custom) {
        setPalette({
          ident: String(a.custom.ident || DEFAULT_CUSTOM.ident),
          removed: String(a.custom.removed || DEFAULT_CUSTOM.removed),
          cat: Array.isArray(a.custom.cat) && a.custom.cat.length > 0
            ? a.custom.cat.map(String) : DEFAULT_CUSTOM.cat,
        })
      } else {
        setPalette(DEFAULT_CUSTOM)
      }
    } catch (e: any) {
      setErr(e?.message || 'Network error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load(clientId) }, [clientId, load])

  const badColours = draft.theme === CUSTOM_THEME && (
    !isHexColor(palette.ident) || !isHexColor(palette.removed) ||
    palette.cat.some(c => !isHexColor(c)) || palette.cat.length === 0
  )

  const dirty = draft.engine !== saved.engine
    || draft.theme !== saved.theme
    || (draft.theme === CUSTOM_THEME && JSON.stringify(palette) !== JSON.stringify(saved.custom ?? null))

  async function save() {
    setBusy('save'); setErr(''); setMsg('')
    try {
      const r = await fetch('/api/admin/report-appearance', {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId,
          engine: draft.engine,
          theme: draft.theme,
          // Sent whenever there is a valid set, not only on the custom theme:
          // that is what lets somebody try Slate for a week and come back to
          // their own colours without retyping them.
          custom: badColours ? null : palette,
        }),
      })
      const j = await r.json()
      if (!j.success) { setErr(j.error || 'Could not save the appearance'); return }
      setMsg(clientId ? `Appearance saved for ${nameOf(clientId)}.` : 'Default appearance saved.')
      await load(clientId)
    } catch (e: any) {
      setErr(e?.message || 'Network error')
    } finally {
      setBusy('')
    }
  }

  async function reset() {
    setBusy('reset'); setErr(''); setMsg('')
    try {
      const r = await fetch(`/api/admin/report-appearance?clientId=${encodeURIComponent(clientId)}`,
        { method: 'DELETE', credentials: 'include' })
      const j = await r.json()
      if (!j.success) { setErr(j.error || 'Could not reset the appearance'); return }
      setMsg(clientId
        ? `${nameOf(clientId)} follows the shared appearance again.`
        : 'Default appearance back to the built-in charts in the IP House palette.')
      await load(clientId)
    } catch (e: any) {
      setErr(e?.message || 'Network error')
    } finally {
      setBusy('')
    }
  }

  /* What the preview is drawn in. Rebuilt on every keystroke while a custom
     palette is being edited, which is the point of it — buildCustomTheme is a
     few dozen string operations and cheaper than the render it feeds. */
  const theme = useMemo(
    () => (draft.theme === CUSTOM_THEME ? buildCustomTheme(palette) : reportTheme(draft.theme)),
    [draft.theme, palette])
  const m = dark ? theme.dark : theme.light

  const previewSpec = (form: 'group-bar' | 'donut'): ChartSpec => ({
    form,
    m,
    dark,
    height: form === 'donut' ? 210 : 230,
    categories: PREVIEW_ROWS.map(r => shortLabel(r.label)),
    titles: PREVIEW_ROWS.map(r => r.label),
    labels: form === 'group-bar',
    ...(form === 'donut'
      ? {
        sliceColors: PREVIEW_ROWS.map((_, i) => m.cat[i % m.cat.length]),
        series: [{ name: 'Identified', color: m.ident, data: PREVIEW_ROWS.map(r => r.urls) }],
      }
      : {
        series: [
          { name: 'Identified', color: m.ident, data: PREVIEW_ROWS.map(r => r.urls) },
          { name: 'Removed', color: m.removed, data: PREVIEW_ROWS.map(r => r.removed) },
        ],
      }),
  })

  const scopeLabel = clientId ? nameOf(clientId) : 'every client'

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-500 dark:text-white/45 max-w-3xl leading-relaxed">
        What a report is <strong>drawn with</strong> and <strong>drawn in</strong>. Set it once for
        everybody, or give one client its own — a client with its own takes it whole, so a later
        change to the shared setting cannot half-recolour a report you set up deliberately.
        Readers have no switch for this: a palette says what a mark <em>means</em> on these pages,
        so two people opening the same report have to see the same colours.
      </p>

      {err && (
        <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2
          dark:bg-red-500/10 dark:border-red-400/25 dark:text-red-300">{err}</p>
      )}
      {msg && !err && (
        <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2
          dark:bg-emerald-500/10 dark:border-emerald-400/25 dark:text-emerald-300">{msg}</p>
      )}

      {/* ── Whose report ─────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 flex-wrap">
        <label className="text-[11px] font-bold uppercase tracking-widest text-gray-400">
          Setting for
        </label>
        <span className="w-[300px] max-w-full">
          <SearchableSelect
            options={directory.map(c => ({
              key: c.id,
              label: withOwn.includes(c.id) ? `${c.name}  ·  has its own appearance` : c.name,
            }))}
            value={clientId}
            onChange={setClientId}
            placeholder="All clients (shared appearance)"
            emptyLabel="All clients (shared appearance)" />
        </span>
        {inherited && (
          <span className="px-2 py-1 rounded-lg text-[10.5px] font-bold uppercase tracking-wide
            bg-amber-50 text-amber-800 border border-amber-200
            dark:bg-amber-500/10 dark:border-amber-400/25 dark:text-amber-200">
            Following the shared appearance — saving creates one for this client
          </span>
        )}
        {directory.length === 0 && (
          <span className="text-[11px] text-gray-400">
            Client list unavailable — the shared appearance can still be set.
          </span>
        )}
      </div>

      {loading ? (
        <div className="bg-white dark:bg-[#1a2d55] rounded-2xl shadow-card border border-gray-100
          dark:border-white/10 p-8 text-center text-sm text-gray-400">
          Loading the appearance…
        </div>
      ) : (
        <>
          {/* ── Chart engine ─────────────────────────────────────────────── */}
          <div className="bg-white dark:bg-[#1a2d55] rounded-2xl shadow-card border border-gray-100
            dark:border-white/10 p-5 sm:p-6">
            <h2 className="font-bold text-[#14254A] dark:text-white">Chart engine</h2>
            <p className="text-xs text-gray-500 dark:text-white/45 mt-1 max-w-2xl leading-relaxed">
              Which library draws the charts. Whichever you pick, the world map, the heat grid, the
              ranked tables and the repeat-offender list keep the report&rsquo;s own shapes — no
              general charting library has a version of those worth having — and any panel the
              chosen library declines falls back to them too.
            </p>
            <div className="grid gap-2 mt-4 sm:grid-cols-2 xl:grid-cols-3">
              {ENGINES.map(e => (
                <Choice key={e.key} on={draft.engine === e.key}
                  title={e.key === NATIVE ? `${e.label} (default)` : e.label}
                  hint={e.hint} note={e.note}
                  onClick={() => setDraft(d => ({ ...d, engine: e.key }))} />
              ))}
            </div>
          </div>

          {/* ── Theme ────────────────────────────────────────────────────── */}
          <div className="bg-white dark:bg-[#1a2d55] rounded-2xl shadow-card border border-gray-100
            dark:border-white/10 p-5 sm:p-6">
            <h2 className="font-bold text-[#14254A] dark:text-white">Report theme</h2>
            <p className="text-xs text-gray-500 dark:text-white/45 mt-1 max-w-2xl leading-relaxed">
              The palette every mark is coloured from. The six named sets all keep the house
              convention — identification navy, removal orange — and vary what surrounds it.{' '}
              <strong>Custom</strong> is the one that does not: use it where a client&rsquo;s own
              brand should win, and remember that the rest of their portal will still be navy and
              orange.
            </p>
            <div className="grid gap-2 mt-4 sm:grid-cols-2 xl:grid-cols-4">
              {REPORT_THEMES.map(t => (
                <Choice key={t.key} on={draft.theme === t.key}
                  title={t.key === DEFAULT_THEME ? `${t.label} (default)` : t.label}
                  hint={t.hint} swatch={t.swatch}
                  onClick={() => setDraft(d => ({ ...d, theme: t.key }))} />
              ))}
              <Choice on={draft.theme === CUSTOM_THEME}
                title="Custom"
                hint="Your own colours, set below"
                swatch={[palette.ident, palette.removed, palette.cat[2] ?? palette.cat[0]]}
                onClick={() => setDraft(d => ({ ...d, theme: CUSTOM_THEME }))} />
            </div>

            {draft.theme === CUSTOM_THEME && (
              <div className="mt-5 pt-5 border-t border-gray-100 dark:border-white/10">
                <h3 className="text-xs font-bold uppercase tracking-widest text-gray-400">
                  Custom colours
                </h3>
                <p className="text-xs text-gray-500 dark:text-white/45 mt-1.5 max-w-2xl leading-relaxed">
                  Three decisions; everything else is worked out from them. The sequential ramp on
                  the map and heat grid, the neutral for a folded &ldquo;Other&rdquo;, the grid, the
                  axis and the ink inside a filled segment are all derived — they are consequences
                  of these colours rather than separate choices, and picking them by hand is how a
                  heat grid ends up unreadable. The dark-theme half is derived too: anything too
                  dark to show on a navy card is lifted until it does.
                </p>

                <div className="flex flex-wrap gap-5 mt-4">
                  <ColorField label="Identification" hint="Series one — links found"
                    value={palette.ident}
                    onChange={v => setPalette(p => ({ ...p, ident: v }))} />
                  <ColorField label="Removal" hint="Series two — links taken down"
                    value={palette.removed}
                    onChange={v => setPalette(p => ({ ...p, removed: v }))} />
                </div>

                <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400 mt-5">
                  Categorical set
                </p>
                <p className="text-[11px] text-gray-400 mt-1 max-w-2xl leading-snug">
                  In the order slices are handed out, so the first two carry most of every split and
                  need to be the easiest pair to tell apart. Past six slices a report folds the tail
                  into a neutral &ldquo;Other&rdquo;, so more than eight are never drawn.
                </p>
                <div className="flex flex-wrap gap-4 mt-3">
                  {palette.cat.map((c, i) => (
                    <ColorField key={i} label={`Slice ${i + 1}`} value={c}
                      onChange={v => setPalette(p => ({
                        ...p, cat: p.cat.map((x, j) => (j === i ? v : x)),
                      }))}
                      // Two is the floor: one colour is not a categorical set.
                      onRemove={palette.cat.length > 2
                        ? () => setPalette(p => ({ ...p, cat: p.cat.filter((_, j) => j !== i) }))
                        : undefined} />
                  ))}
                  {palette.cat.length < MAX_CAT && (
                    <button type="button"
                      onClick={() => setPalette(p => ({ ...p, cat: [...p.cat, '#94A3B8'] }))}
                      className="self-end px-3 py-2 rounded-xl text-[11px] font-bold border border-dashed
                        border-gray-300 text-gray-500 hover:border-[#FC934C] hover:text-[#FC934C]
                        dark:border-white/20 dark:text-white/50 transition-colors">
                      + Add a colour
                    </button>
                  )}
                </div>

                {badColours ? (
                  <p className="text-xs text-red-600 mt-3">
                    Every colour has to be a hex value, like <span className="font-mono">#14254A</span>.
                  </p>
                ) : (
                  <DerivedStrip palette={palette} />
                )}
              </div>
            )}
          </div>

          {/* ── Preview ──────────────────────────────────────────────────── */}
          <div className="bg-white dark:bg-[#1a2d55] rounded-2xl shadow-card border border-gray-100
            dark:border-white/10 p-5 sm:p-6">
            <div className="flex items-baseline gap-2 flex-wrap">
              <h2 className="font-bold text-[#14254A] dark:text-white">Preview</h2>
              <span className="text-[11px] text-gray-400">
                stand-in rows · {ENGINES.find(e => e.key === draft.engine)?.label ?? draft.engine}
                {' · '}{draft.theme === CUSTOM_THEME ? 'Custom' : (reportTheme(draft.theme).label)}
                {' · '}{dark ? 'dark' : 'light'} theme
              </span>
            </div>
            <div className="grid gap-4 mt-4 lg:grid-cols-2">
              {(['group-bar', 'donut'] as const).map(form => (
                <div key={form} className="rounded-xl border border-gray-100 dark:border-white/10 p-3"
                  style={{ background: m.surface }}>
                  <p className="text-[11px] font-bold mb-2" style={{ color: m.ident }}>
                    {form === 'donut' ? 'Share of identified links' : 'Identification & removal'}
                  </p>
                  {/* The real renderer, not a mock-up: an engine and a palette are
                      both things you can only judge by looking at one. */}
                  <EngineChart engine={draft.engine} spec={previewSpec(form)}
                    fallback={
                      <PreviewFallback spec={previewSpec(form)} />
                    } />
                </div>
              ))}
            </div>
          </div>

          {/* ── Save ─────────────────────────────────────────────────────── */}
          <div className="flex items-center gap-3 flex-wrap">
            <button type="button" onClick={save} disabled={!!busy || badColours || !dirty}
              className="px-4 py-2 rounded-xl text-xs font-bold text-white bg-[#14254A]
                hover:opacity-90 transition-opacity disabled:opacity-50">
              {busy === 'save'
                ? 'Saving…'
                : clientId ? 'Save for this client' : 'Save the shared appearance'}
            </button>
            <button type="button" onClick={() => load(clientId)} disabled={!!busy || !dirty}
              className="px-4 py-2 rounded-xl text-xs font-semibold border border-gray-200 text-gray-600
                hover:bg-gray-50 dark:border-white/15 dark:text-white/60 dark:hover:bg-white/5
                disabled:opacity-50">
              Discard changes
            </button>
            {/* Only where there is a row to drop. Offering it against a client
                that is already following the shared setting would be a button
                that does nothing and reads as though it should. */}
            {(!clientId || !inherited) && (
              <button type="button" onClick={reset} disabled={!!busy}
                className="px-4 py-2 rounded-xl text-xs font-semibold border border-gray-200 text-gray-500
                  hover:border-red-300 hover:text-red-600 dark:border-white/15 dark:text-white/50
                  transition-colors disabled:opacity-50">
                {busy === 'reset'
                  ? 'Resetting…'
                  : clientId ? 'Follow the shared appearance' : 'Back to the IP House default'}
              </button>
            )}
            <span className="text-[11px] text-gray-400 dark:text-white/35">
              Applies to every report {scopeLabel === 'every client' ? 'for every client' : `for ${scopeLabel}`}.
            </span>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * What the palette above turns into.
 *
 * The sequential ramp, the folded "Other" and the dark-card colours are all
 * DERIVED — see buildCustomTheme — and none of them appears on the panels in
 * the preview below: the ramp is only drawn by the world map and the heat grid,
 * and the dark half is only seen by a reader in the other theme. So they are
 * shown here, where the decision that produces them is being made. A dark
 * identification colour that vanishes on a navy card is visible in this strip
 * and nowhere else on the screen.
 */
function DerivedStrip({ palette }: { palette: CustomPalette }) {
  const t = buildCustomTheme(palette)
  const Row = ({ label, colors, note }: { label: string; colors: string[]; note?: string }) => (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="w-[124px] shrink-0 text-[9.5px] uppercase tracking-widest text-gray-400">
        {label}
      </span>
      <span className="flex gap-[3px]">
        {colors.map((c, i) => (
          <span key={i} title={c} className="w-7 h-4 rounded-[3px] ring-1 ring-black/10"
            style={{ background: c }} />
        ))}
      </span>
      {note && <span className="text-[10px] text-gray-400">{note}</span>}
    </div>
  )
  return (
    <div className="mt-5 pt-4 border-t border-gray-100 dark:border-white/10 space-y-2">
      <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400">
        Worked out from those
      </p>
      <div className="rounded-xl p-3 space-y-2" style={{ background: t.light.surface }}>
        <Row label="Magnitude ramp" colors={t.light.seq}
          note="the world map and the heat grid" />
        <Row label="Other · grid · axis" colors={[t.light.other, t.light.grid, t.light.axis]}
          note="a folded tail, and the chart's furniture" />
      </div>
      <div className="rounded-xl p-3 space-y-2" style={{ background: t.dark.surface }}>
        <Row label="On the dark card" colors={[t.dark.ident, t.dark.removed]}
          note="lifted until they clear a navy panel" />
        <Row label="Dark categorical" colors={t.dark.cat} />
      </div>
    </div>
  )
}

/**
 * What the preview shows on the built-in engine.
 *
 * The report's own renderers live in app/admin/reports/page.tsx and are not
 * exported — importing that page here to draw two sample panels would pull the
 * whole report, its world map and its export machinery into this screen's
 * bundle. A palette read off flat bars is the same palette, and the engine
 * cards above already say what "Built-in" looks like on a real report.
 */
function PreviewFallback({ spec }: { spec: ChartSpec }) {
  const { m } = spec
  const values = spec.series[0]?.data ?? []
  const max = Math.max(1, ...spec.series.flatMap(s => s.data))
  const total = values.reduce((a, b) => a + b, 0)
  const donut = spec.form === 'donut'

  return (
    <div className="flex flex-col gap-1.5 py-1" style={{ minHeight: spec.height }}>
      {spec.categories.map((label, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="w-[38%] shrink-0 truncate text-[11px]" style={{ color: m.axis }}
            title={spec.titles[i]}>
            {label}
          </span>
          <span className="flex-1 min-w-0 flex flex-col gap-[2px]">
            {donut ? (
              <span className="block h-2.5 rounded-sm" style={{
                width: `${(values[i] / max) * 100}%`,
                background: spec.sliceColors?.[i] ?? m.cat[i % m.cat.length],
              }} />
            ) : spec.series.map(s => (
              <span key={s.name} className="block h-2 rounded-sm" style={{
                width: `${(s.data[i] / max) * 100}%`, background: s.color,
              }} />
            ))}
          </span>
          <span className="shrink-0 text-[10.5px] font-bold tabular-nums" style={{ color: m.ident }}>
            {donut
              ? `${Math.round((values[i] / (total || 1)) * 100)}%`
              : spec.series.map(s => (s.data[i] ?? 0).toLocaleString()).join(' · ')}
          </span>
        </div>
      ))}
      {/* The ramps a custom palette DERIVES rather than sets. Nothing else on
          this screen shows them, and they are where a badly chosen
          identification colour actually goes wrong. */}
      <div className="flex items-center gap-3 mt-2 pt-2 border-t"
        style={{ borderColor: m.grid }}>
        <span className="text-[9.5px] uppercase tracking-widest" style={{ color: m.axis }}>
          Magnitude ramp
        </span>
        <span className="flex gap-[2px]">
          {m.seq.map((c, i) => (
            <span key={i} className="w-6 h-3 rounded-[2px]" style={{ background: c }} />
          ))}
        </span>
        <span className="text-[9.5px] uppercase tracking-widest ml-2" style={{ color: m.axis }}>
          Other
        </span>
        <span className="w-6 h-3 rounded-[2px]" style={{ background: m.other }} />
      </div>
    </div>
  )
}
