// The colours a report is DRAWN in, as a set Report Configuration chooses.
//
// ── Why this left app/admin/reports/page.tsx ─────────────────────────────────
//
// There used to be exactly one palette — `MARKS`, light and dark — sitting a
// hundred lines below the page's imports. That was right while there was one:
// the marks and the components that draw them were the same concern.
//
// A report that can be re-themed per client makes them two. The palette is now
// picked at runtime, has to be readable by the chart-engine adapters in
// lib/charts (which know nothing about the report page), has to survive being
// handed to a third-party library that wants a flat array of hex strings, and
// one of them is BUILT from colours somebody typed into an admin screen. So it
// lives here, on its own, and the page reads a theme out of it rather than
// holding one.
//
// ── The rule the named themes keep ───────────────────────────────────────────
//
// IDENTIFICATION IS NAVY. REMOVAL IS ORANGE. That pairing is not decoration —
// it is the same on the dashboard, in War Room, on the infringement pages and
// in every deck a client has already been sent, and a reader who has learnt
// "orange is the bit we took down" must not have to re-learn it because
// somebody preferred a different grid colour.
//
// So each of the six named themes varies:
//
//   · the CATEGORICAL ramp — how a six-way split is told apart
//   · the SEQUENTIAL ramp  — how magnitude is tinted, on the map and heat grid
//   · the SURFACE, GRID and AXIS — how loud the chart's furniture is
//
// and does NOT vary which family `ident` and `removed` come from. Monochrome is
// the deliberate edge case: everything else goes grey precisely so that the one
// orange left on the page is still removal.
//
// ── And the one that is allowed to break it ──────────────────────────────────
//
// `custom` takes two colours — identification and removal — plus a categorical
// set, and derives the rest (see buildCustomTheme). A client whose own brand is
// green gets a green report, and every mark on it means what that client's
// people expect rather than what ours do.
//
// That is precisely why the whole appearance choice lives in Report
// Configuration, under the `report-config` grant, and NOT on the report as a
// reading preference. Changing a grid colour is taste. Changing what removal is
// coloured changes what the page SAYS, and a report two people read has to say
// the same thing to both of them — so it is one decision per client, made by
// staff, alongside the layout it belongs with.
//
// ── Light and dark are both spelled out ──────────────────────────────────────
//
// Not derived. Full navy is invisible on a navy card, so a dark theme's navy
// family has to START lighter rather than be the light one with a filter over
// it; and the ink that reads on a fill is a different decision in each. Two
// hand-picked sets per theme is a few dozen numbers nobody has to re-derive.

export interface MarkTheme {
  ident: string          // series 1 — links identified
  identSoft: string      // a lighter step of the same hue, for "the remainder"
  removed: string        // series 2 — links taken down
  cat: string[]          // categorical identity, fixed order, never cycled
  other: string          // the folded tail of a categorical split
  ordinal: string[]      // funnel stages: one hue, strongest step first
  seq: string[]          // magnitude, lowest intensity first
  seqInk: boolean[]      // true where a label on that step must be dark
  segInk: string         // label colour inside a filled segment, this theme
  surface: string        // card background — the colour the 2px spacers wear
  grid: string
  axis: string
}

export const BRAND_NAVY   = '#14254A'
export const BRAND_ORANGE = '#FC934C'
export const BRAND_GOLD   = '#FFC82B'

/* Tints of the three brand colours. The number is how much white is mixed in,
   so N60 is navy at 40% strength against a white card. Named rather than
   computed at runtime: these exact steps were chosen so neighbouring
   categorical slots differ in lightness as well as family. */
const N40 = '#727C92'
const N55 = '#959DAE'
const N62 = '#A6ACBA'
const N72 = '#BDC2CC'
const N75 = '#C4C8D1'
const N80 = '#D0D3DA'
const N85 = '#DCDEE3'
const N92 = '#EDEEF0'
const N30 = '#5B6680'
const N20 = '#43516E'
const O40 = '#FDBE94'   // orange + 40% white
const O55 = '#FECEAE'
const G45 = '#FFE18A'   // gold + 45% white

/** A theme, plus what the picker needs to describe it. */
export interface ReportTheme {
  key: string
  label: string
  hint: string
  /** Three chips in the picker: what a reader actually recognises a theme by. */
  swatch: [string, string, string]
  light: MarkTheme
  dark: MarkTheme
}

/* ── 1 · IP House ──────────────────────────────────────────────────────────
   The house palette, unchanged. Brand only: navy, orange and gold, plus tints
   of those three, so every mark on the page is one of our colours at some
   strength and nothing else.

   What that costs, so it is not rediscovered later: mixing navy toward white
   desaturates it, so the navy steps read as blue-greys rather than as distinct
   hues, and adjacent categorical steps are separated more by lightness than by
   colour. Every component prints the value beside its mark, which is the relief
   that makes a low-separation set readable. */
const IPHOUSE: ReportTheme = {
  key: 'iphouse',
  label: 'IP House',
  hint: 'The house palette — navy, orange and gold only',
  swatch: [BRAND_NAVY, BRAND_ORANGE, BRAND_GOLD],
  light: {
    ident: BRAND_NAVY, identSoft: N62, removed: BRAND_ORANGE,
    // Order alternates family before it steps lightness, so the first slices —
    // the ones that carry most of the total — are the easiest to tell apart.
    cat: [BRAND_NAVY, BRAND_ORANGE, BRAND_GOLD, N40, O40, G45, N72, O55],
    other: N75,
    ordinal: [BRAND_NAVY, N40, N75],
    seq: [N85, N75, N62, N40, BRAND_NAVY],
    seqInk: [true, true, true, false, false],
    segInk: BRAND_NAVY,
    surface: '#ffffff',
    grid: N92,
    axis: N40,
  },
  dark: {
    // Full navy is invisible on a navy card, so the family starts lighter here.
    ident: N55, identSoft: N75, removed: BRAND_ORANGE,
    cat: [N55, BRAND_ORANGE, BRAND_GOLD, N75, O40, G45, N30, O55],
    other: N30,
    ordinal: [N75, N55, N30],
    seq: [N20, N30, N40, N62, N80],
    seqInk: [false, false, false, true, true],
    // Dark-theme fills are light tints and brand orange/gold, so a dark label
    // beats a white one on all of them.
    segInk: BRAND_NAVY,
    surface: '#1a2d55',
    grid: 'rgba(255,255,255,0.10)',
    axis: N55,
  },
}

/* ── 2 · Slate ─────────────────────────────────────────────────────────────
   The same two series against cooler, lower-chroma company. Gold is the loudest
   thing on an IP House chart, and on a page of twelve panels it starts to shout;
   here the tail of the categorical ramp steps through slate instead, so the
   first two slices — which carry most of every split — keep the attention. The
   grid is a shade heavier because the marks are quieter. */
const SLATE: ReportTheme = {
  key: 'slate',
  label: 'Slate',
  hint: 'Cooler neutrals, quieter tail — for pages with many panels',
  swatch: ['#1E3A5F', BRAND_ORANGE, '#64748B'],
  light: {
    ident: '#1E3A5F', identSoft: '#94A3B8', removed: BRAND_ORANGE,
    cat: ['#1E3A5F', BRAND_ORANGE, '#64748B', '#F8B77E', '#94A3B8', '#CBD5E1', '#475569', '#E2E8F0'],
    other: '#CBD5E1',
    ordinal: ['#1E3A5F', '#64748B', '#CBD5E1'],
    seq: ['#E2E8F0', '#CBD5E1', '#94A3B8', '#64748B', '#1E3A5F'],
    seqInk: [true, true, true, false, false],
    segInk: '#1E3A5F',
    surface: '#ffffff',
    grid: '#E8ECF1',
    axis: '#64748B',
  },
  dark: {
    ident: '#93A9C4', identSoft: '#CBD5E1', removed: BRAND_ORANGE,
    cat: ['#93A9C4', BRAND_ORANGE, '#CBD5E1', '#F8B77E', '#64748B', '#E2E8F0', '#475569', O55],
    other: '#475569',
    ordinal: ['#CBD5E1', '#93A9C4', '#475569'],
    seq: ['#33415C', '#475569', '#64748B', '#93A9C4', '#CBD5E1'],
    seqInk: [false, false, false, true, true],
    segInk: '#0F1D33',
    surface: '#1a2d55',
    grid: 'rgba(255,255,255,0.09)',
    axis: '#93A9C4',
  },
}

/* ── 3 · Vivid ─────────────────────────────────────────────────────────────
   For a projector and for a slide. A boardroom beamer eats saturation and
   crushes the light end of a tint ramp, so both are pushed: the categorical
   steps are fully saturated hues rather than tints of two, and the sequential
   ramp starts several steps darker than it does on screen. Not the default,
   because at reading distance on a laptop this is louder than the numbers. */
const VIVID: ReportTheme = {
  key: 'vivid',
  label: 'Vivid',
  hint: 'Saturated and high-key — survives a projector',
  swatch: ['#12306E', '#F97316', '#0EA5E9'],
  light: {
    ident: '#12306E', identSoft: '#7CA0DE', removed: '#F97316',
    cat: ['#12306E', '#F97316', '#0EA5E9', '#FACC15', '#7C3AED', '#10B981', '#7CA0DE', '#FDBA74'],
    other: '#B4BECE',
    ordinal: ['#12306E', '#4C6FB5', '#A9BFE4'],
    seq: ['#DCE7F8', '#A9BFE4', '#6E92D0', '#3A63AE', '#12306E'],
    seqInk: [true, true, false, false, false],
    segInk: '#0B1F49',
    surface: '#ffffff',
    grid: '#E4EAF3',
    axis: '#5B7098',
  },
  dark: {
    ident: '#7CA0DE', identSoft: '#B7CBEC', removed: '#FB923C',
    cat: ['#7CA0DE', '#FB923C', '#38BDF8', '#FDE047', '#A78BFA', '#34D399', '#B7CBEC', '#FDBA74'],
    other: '#44557A',
    ordinal: ['#B7CBEC', '#7CA0DE', '#3A63AE'],
    seq: ['#152A52', '#26417A', '#3A63AE', '#6E92D0', '#B7CBEC'],
    seqInk: [false, false, false, true, true],
    segInk: '#0B1F49',
    surface: '#1a2d55',
    grid: 'rgba(255,255,255,0.12)',
    axis: '#9FB6DF',
  },
}

/* ── 4 · Contrast ──────────────────────────────────────────────────────────
   Accessibility first. The categorical ramp is the Okabe–Ito set — hues chosen
   to stay distinguishable under all three common forms of colour blindness —
   with navy and orange holding the first two slots so the convention survives.
   Every neighbouring pair also steps in LIGHTNESS, so the set still separates
   in greyscale or on a failing monitor, and the grid and axis are darker than
   anywhere else here. */
const CONTRAST: ReportTheme = {
  key: 'contrast',
  label: 'Contrast',
  hint: 'Colour-blind safe, heavier grid, stronger ink',
  swatch: ['#0B1F3F', '#D55E00', '#0072B2'],
  light: {
    ident: '#0B1F3F', identSoft: '#8FA3BC', removed: '#D55E00',
    cat: ['#0B1F3F', '#D55E00', '#0072B2', '#E69F00', '#009E73', '#CC79A7', '#56B4E9', '#7A6A00'],
    other: '#8A8A8A',
    ordinal: ['#0B1F3F', '#4E6B8F', '#A8B7C9'],
    seq: ['#DEE5EC', '#B3C2D2', '#7E95B0', '#48678C', '#0B1F3F'],
    seqInk: [true, true, true, false, false],
    segInk: '#0B1F3F',
    surface: '#ffffff',
    grid: '#D3DAE2',
    axis: '#41546C',
  },
  dark: {
    ident: '#A8C4E6', identSoft: '#D3E1F2', removed: '#F0782B',
    cat: ['#A8C4E6', '#F0782B', '#56B4E9', '#F0C24A', '#3FCFA3', '#EE9BC4', '#D3E1F2', '#D8C468'],
    other: '#6E7A8C',
    ordinal: ['#D3E1F2', '#A8C4E6', '#4E6B8F'],
    seq: ['#16294A', '#28405F', '#48678C', '#7E95B0', '#D3E1F2'],
    seqInk: [false, false, false, true, true],
    segInk: '#0B1F3F',
    surface: '#1a2d55',
    grid: 'rgba(255,255,255,0.18)',
    axis: '#B7C7DA',
  },
}

/* ── 5 · Monochrome ────────────────────────────────────────────────────────
   For paper, for a photocopy, and for the report that ends up printed in black
   and white by somebody three forwards down the chain. Everything is grey
   EXCEPT removal, which keeps the orange — the one distinction that has to
   survive is identified against removed, and a single spot colour comes off a
   greyscale printer as the only mid-tone that is not on the grey ramp. */
const MONO: ReportTheme = {
  key: 'monochrome',
  label: 'Monochrome',
  hint: 'Greyscale, with removal the only colour — for print',
  swatch: ['#1F2937', BRAND_ORANGE, '#9CA3AF'],
  light: {
    ident: '#1F2937', identSoft: '#9CA3AF', removed: BRAND_ORANGE,
    cat: ['#1F2937', BRAND_ORANGE, '#6B7280', '#9CA3AF', '#4B5563', '#D1D5DB', '#374151', '#E5E7EB'],
    other: '#D1D5DB',
    ordinal: ['#1F2937', '#6B7280', '#D1D5DB'],
    seq: ['#F3F4F6', '#D1D5DB', '#9CA3AF', '#6B7280', '#1F2937'],
    seqInk: [true, true, true, false, false],
    segInk: '#111827',
    surface: '#ffffff',
    grid: '#EBEDF0',
    axis: '#6B7280',
  },
  dark: {
    ident: '#C6CBD3', identSoft: '#E5E7EB', removed: BRAND_ORANGE,
    cat: ['#C6CBD3', BRAND_ORANGE, '#9CA3AF', '#E5E7EB', '#6B7280', '#F3F4F6', '#4B5563', O55],
    other: '#4B5563',
    ordinal: ['#E5E7EB', '#C6CBD3', '#6B7280'],
    seq: ['#2A3446', '#3F4A5C', '#6B7280', '#9CA3AF', '#E5E7EB'],
    seqInk: [false, false, false, true, true],
    segInk: '#111827',
    surface: '#1a2d55',
    grid: 'rgba(255,255,255,0.10)',
    axis: '#A8AEB9',
  },
}

/* ── 6 · Midnight ──────────────────────────────────────────────────────────
   Built for the dark UI rather than adapted to it. The light half is a deep-ink
   variant of the same idea — a near-black navy on white — so switching the app
   between light and dark does not switch the report's character with it, which
   is what every other theme here does. */
const MIDNIGHT: ReportTheme = {
  key: 'midnight',
  label: 'Midnight',
  hint: 'Deep ink on both grounds — reads the same light or dark',
  swatch: ['#0B1729', '#FFA766', '#5EC6D6'],
  light: {
    ident: '#0B1729', identSoft: '#8C97A8', removed: '#F07C2B',
    cat: ['#0B1729', '#F07C2B', '#2E8C9E', '#E0B341', '#5B6B82', '#8FCBD6', '#3B4A60', '#F6C99A'],
    other: '#B9C0CB',
    ordinal: ['#0B1729', '#4A5A72', '#B9C0CB'],
    seq: ['#E3E6EB', '#B9C0CB', '#8C97A8', '#4A5A72', '#0B1729'],
    seqInk: [true, true, true, false, false],
    segInk: '#0B1729',
    surface: '#ffffff',
    grid: '#E7E9ED',
    axis: '#5B6B82',
  },
  dark: {
    ident: '#8FB8D6', identSoft: '#C3D8E9', removed: '#FFA766',
    cat: ['#8FB8D6', '#FFA766', '#5EC6D6', '#F2CE6B', '#C3D8E9', '#9FE0C7', '#5A7590', '#FFCFA6'],
    other: '#3E5068',
    ordinal: ['#C3D8E9', '#8FB8D6', '#3E5068'],
    seq: ['#122238', '#1E3652', '#33506F', '#5A7590', '#C3D8E9'],
    seqInk: [false, false, false, true, true],
    segInk: '#0B1729',
    surface: '#1a2d55',
    grid: 'rgba(255,255,255,0.11)',
    axis: '#8FA6BF',
  },
}

export const REPORT_THEMES: ReportTheme[] = [
  IPHOUSE, SLATE, VIVID, CONTRAST, MONO, MIDNIGHT,
]

/** What a report is drawn in when nobody has said otherwise. */
export const DEFAULT_THEME = IPHOUSE.key

const BY_KEY = new Map(REPORT_THEMES.map(t => [t.key, t]))

export function isReportTheme(key: string): boolean {
  return BY_KEY.has(key)
}

/**
 * The theme a report should be drawn in.
 *
 * `custom` is only read when the key asks for it, so a client that has picked a
 * named palette costs nothing to resolve even with a stored custom palette
 * sitting beside it.
 *
 * Falls back to IP House rather than throwing: a theme key reaches this from
 * the database, and a palette that was renamed or removed has to degrade to the
 * house one rather than take the report down with it.
 */
export function reportTheme(
  key: string | undefined,
  custom?: Partial<CustomPalette> | null,
): ReportTheme {
  if (key === CUSTOM_THEME) return buildCustomTheme(custom)
  return BY_KEY.get(key || '') ?? IPHOUSE
}

/** The half of it this reader is looking at. */
export function themeFor(
  key: string | undefined,
  dark: boolean,
  custom?: Partial<CustomPalette> | null,
): MarkTheme {
  const t = reportTheme(key, custom)
  return dark ? t.dark : t.light
}


/* -- 7 . Custom -----------------------------------------------------------

   A palette typed into Report Configuration, for a client whose own brand is
   not ours.

   -- Why two colours and a list, and not twelve ----------------------------

   A MarkTheme has a dozen fields and most of them are not decisions - they are
   consequences. The sequential ramp has to be one hue stepping in lightness or
   it stops reading as magnitude; the grid has to be quieter than every mark on
   it; the ink inside a filled segment is arithmetic, not taste. Asking somebody
   to choose all twelve produces a report where the heat grid is unreadable and
   nobody can say why.

   So the screen asks for what genuinely IS a decision - what identification
   looks like, what removal looks like, and the set that tells a six-way split
   apart - and everything else is derived from those below.

   -- Where the dark half comes from ----------------------------------------

   Derived too, and it has to be: an admin picking colours is looking at one
   theme, and the reader may be in the other. A dark card cannot take the same
   ink a white one does, so each colour is pushed toward the card it will sit on
   until it clears it. That is a worse result than the hand-picked pairs above -
   which is the honest reason those six exist and are offered first.
*/

/** What Report Configuration stores for the custom theme. */
export interface CustomPalette {
  /** Series 1 - links identified. */
  ident: string
  /** Series 2 - links taken down. */
  removed: string
  /** The categorical set, in the order slices are handed out. 2-8 entries. */
  cat: string[]
}

export const CUSTOM_THEME = 'custom'

/** What the editor opens on: the house palette, so a first edit is a nudge. */
export const DEFAULT_CUSTOM: CustomPalette = {
  ident: BRAND_NAVY,
  removed: BRAND_ORANGE,
  cat: [BRAND_NAVY, BRAND_ORANGE, BRAND_GOLD, '#727C92', '#FDBE94', '#FFE18A'],
}

/** #rgb and #rrggbb both, because both get typed. */
export const isHexColor = (v: string) =>
  /^#?[0-9a-f]{3}$/i.test(String(v ?? '').trim()) || /^#?[0-9a-f]{6}$/i.test(String(v ?? '').trim())

const clamp255 = (n: number) => Math.max(0, Math.min(255, Math.round(n)))

/** Anything this cannot read comes back as black rather than as an exception. */
function toRgb(hex: string): [number, number, number] {
  const h = String(hex || '').trim().replace(/^#/, '')
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h
  if (!/^[0-9a-f]{6}$/i.test(full)) return [0, 0, 0]
  const n = parseInt(full, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const toHex = (c: [number, number, number]) =>
  '#' + c.map(v => clamp255(v).toString(16).padStart(2, '0')).join('')

/** `t` of the way from `a` to `b`. */
function mix(a: string, b: string, t: number): string {
  const x = toRgb(a)
  const y = toRgb(b)
  return toHex([0, 1, 2].map(i => x[i] + (y[i] - x[i]) * t) as [number, number, number])
}

const lighten = (c: string, t: number) => mix(c, '#ffffff', t)
const darken = (c: string, t: number) => mix(c, '#000000', t)

/**
 * Perceived brightness, 0-1 (WCAG relative luminance).
 *
 * Used for one question only, asked in several places: is this fill light
 * enough that a label on it has to be dark? A plain average of the channels
 * answers it wrongly for saturated blues and yellows, which is most of a brand
 * palette.
 */
function luminance(hex: string): number {
  const [r, g, b] = toRgb(hex).map(v => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Ink that reads on this fill. */
const inkFor = (bg: string) => (luminance(bg) > 0.45 ? '#111827' : '#FFFFFF')

/** Whichever of the two fills would swallow a dark label. */
const darkerOf = (a: string, b: string) => (luminance(a) < luminance(b) ? a : b)

/**
 * Enough categorical steps to fill the eight slots, from however many were
 * given.
 *
 * Cycling the input would put the same colour on slices 1 and 4 of a seven-way
 * split. Extending it with LIGHTENED repeats keeps every slot distinct: slot
 * n+k is the same hue as slot k at half strength, which is exactly how the
 * hand-built themes above run out their tails.
 */
function extendCat(cat: string[]): string[] {
  const seed = (cat ?? []).filter(isHexColor)
  const base = seed.length > 0 ? seed : DEFAULT_CUSTOM.cat
  const out = base.slice()
  for (let i = 0; out.length < 8; i++) out.push(lighten(base[i % base.length], 0.45))
  return out.slice(0, 8)
}

/**
 * A full theme, light and dark, from the three things an admin chose.
 *
 * Not memoised: it is a few dozen string operations, and the alternative is a
 * cache keyed on a palette object the admin screen rebuilds on every keystroke.
 */
export function buildCustomTheme(palette: Partial<CustomPalette> | null | undefined): ReportTheme {
  const ident = isHexColor(palette?.ident ?? '') ? palette!.ident! : DEFAULT_CUSTOM.ident
  const removed = isHexColor(palette?.removed ?? '') ? palette!.removed! : DEFAULT_CUSTOM.removed
  const cat = extendCat(palette?.cat ?? DEFAULT_CUSTOM.cat)

  /* The light half is the chosen colours as given: the admin is looking at a
     white card while they pick, so what they see is what a light reader gets. */
  const lSoft = lighten(ident, 0.6)
  const lSeq = [
    lighten(ident, 0.88), lighten(ident, 0.74),
    lighten(ident, 0.55), lighten(ident, 0.3), ident,
  ]

  /* The dark half moves every colour toward the card it will sit on until it
     clears it. A brand navy on a navy panel is invisible, so anything darker
     than the card is lifted; anything already light enough is left alone. */
  const lift = (c: string) => (luminance(c) < 0.34 ? lighten(c, 0.55) : c)
  const dIdent = lift(ident)
  const dRemoved = lift(removed)
  const dSoft = lighten(dIdent, 0.4)
  const dSeq = [
    darken(dIdent, 0.72), darken(dIdent, 0.55),
    darken(dIdent, 0.34), darken(dIdent, 0.15), dIdent,
  ]

  return {
    key: CUSTOM_THEME,
    label: 'Custom',
    hint: 'Colours set for this client in Report Configuration',
    swatch: [ident, removed, cat[2] ?? cat[0]],
    light: {
      ident,
      identSoft: lSoft,
      removed,
      cat,
      other: lighten(ident, 0.78),
      ordinal: [ident, lighten(ident, 0.45), lighten(ident, 0.75)],
      seq: lSeq,
      seqInk: lSeq.map(c => luminance(c) > 0.45),
      // Sits on `removed` and on `identSoft` both, so it is chosen against
      // whichever of the two is darker.
      segInk: inkFor(darkerOf(removed, lSoft)),
      surface: '#ffffff',
      grid: lighten(ident, 0.92),
      axis: mix(ident, '#6B7280', 0.6),
    },
    dark: {
      ident: dIdent,
      identSoft: dSoft,
      removed: dRemoved,
      cat: cat.map(lift),
      other: darken(dIdent, 0.55),
      ordinal: [dSoft, dIdent, darken(dIdent, 0.45)],
      seq: dSeq,
      seqInk: dSeq.map(c => luminance(c) > 0.45),
      segInk: inkFor(darkerOf(dRemoved, dSoft)),
      surface: '#1a2d55',
      grid: 'rgba(255,255,255,0.10)',
      axis: lighten(dIdent, 0.25),
    },
  }
}
