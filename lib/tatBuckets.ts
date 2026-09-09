// The five turnaround bands, enforced on the page.
//
// ── Why this exists twice ────────────────────────────────────────────────────
//
// go-server/handlers/tatbuckets.go does the same job on the way out, and it is
// the right place for it: the server knows which tables carry a removal
// timestamp and can MEASURE the turnaround rather than re-read somebody's
// banding of it. Nothing here can do that.
//
// This is the second line, and it earns its keep for one reason: the panel is
// assembled from several platforms and several code paths — the measured path,
// the folded path, the summary's merge of both, and a Redis payload that may
// have been written by an older build — and a single one of them letting a
// "Pending" row through puts it back on the page. The rule is small, it is
// absolute, and the page is the only layer where it applies to every path at
// once and can be verified without a deploy.
//
// ── What the rule is ─────────────────────────────────────────────────────────
//
//   · a row whose label is not a DURATION is not a turnaround, and is dropped;
//   · every row that is one is folded into the band its upper edge falls in;
//   · the five bands come out in duration order, always, whatever order the
//     server sent them in.
//
// Keep the bands here in step with sportsTATBands in the Go file. They are the
// same five, and the day they are not, a client's Summary and their Open Web
// report stop being addable.

/** One band: lo < minutes <= hi. */
interface Band { label: string; lo: number; hi: number }

export const TAT_BANDS: Band[] = [
  { label: '0-15 min', lo: -1, hi: 15 },
  { label: '15-30 min', lo: 15, hi: 30 },
  { label: '30 min-1 hr', lo: 30, hi: 60 },
  { label: '1-2 hr', lo: 60, hi: 120 },
  { label: '2 hr+', lo: 120, hi: Infinity },
]

const UNIT_MINUTES: Record<string, number> = {
  sec: 1 / 60, second: 1 / 60,
  min: 1, minute: 1,
  hr: 60, hour: 60,
  day: 60 * 24, week: 60 * 24 * 7, month: 60 * 24 * 30,
}

/** Every quantity in a label, not just the first: a range has two. */
const QUANTITY = /(\d+(?:\.\d+)?)\s*(sec|second|min|minute|hr|hour|day|week|month)s?/gi
/** "2 hr+", "2 hrs and above", "60 min or more" — a band with no upper edge. */
const OPEN_ENDED = /(\+|\babove\b|\bplus\b|\bmore\b|\bover\b|\bonward)/i
/** What separates the two edges of a range, as against the parts of one
 *  duration: "30 min - 1 hr" is a range, "1 hr 30 min" is ninety minutes. */
const RANGE_SEP = /(-|–|—|\bto\b|\bupto\b|\bup to\b)/i

/**
 * Where a bucket label sits on the time axis, in minutes — or null where it is
 * not a duration at all.
 *
 * Its UPPER edge, which is both how a row is banded and how a set of bands is
 * ordered. The two have to be the same number or a panel can be folded
 * correctly and then sorted wrongly, which is exactly what happened: the sort
 * this replaces read the first number in the label and ignored its unit, so
 * "1-2 hr" (1) came before "15-30 min" (15) and the ramp ran
 * 0-15, 1-2 hr, 2 hr+, 15-30, 30 min-1 hr.
 *
 * On the five bands it yields 15, 30, 60, 120, 120.001 — strictly increasing,
 * so their own order needs no special case.
 */
export function durationMinutes(label: string): number | null {
  const s = String(label ?? '').trim().toLowerCase()
  if (!s) return null

  const mins: number[] = []
  // Fresh lastIndex each call — a /g regex is stateful and this one is shared.
  QUANTITY.lastIndex = 0
  for (let m = QUANTITY.exec(s); m; m = QUANTITY.exec(s)) {
    const n = Number(m[1])
    const mult = UNIT_MINUTES[m[2].toLowerCase()]
    if (isFinite(n) && mult) mins.push(n * mult)
  }
  if (mins.length === 0) return null

  if (OPEN_ENDED.test(s)) {
    /* Open-ended: the number is the FLOOR. Without the nudge "2 hr+" lands on
       120 exactly, which the band below closes on, and the slowest bucket is
       both banded and sorted as the second slowest. */
    return mins[mins.length - 1] + 0.001
  }
  return RANGE_SEP.test(s)
    ? mins[mins.length - 1]                  // a range: the last is its top
    : mins.reduce((a, b) => a + b, 0)        // one duration, maybe in two units
}

/**
 * The band a label belongs to, or -1 where it is not a duration at all.
 *
 * PLACED BY ITS UPPER EDGE. "00 - 30min" spans two of our bands and nothing in
 * the row says how it divides; its upper edge is thirty minutes, so the
 * strongest thing the data supports is "no later than 15-30 min". The other
 * direction would claim those rows came down inside a quarter of an hour, which
 * is a claim about enforcement nothing supports. A fold never flatters.
 */
export function tatBandFor(label: string): number {
  const upper = durationMinutes(label)
  if (upper === null) return -1
  const i = TAT_BANDS.findIndex(b => upper > b.lo && upper <= b.hi)
  return i >= 0 ? i : TAT_BANDS.length - 1
}

const num = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0)

/**
 * A turnaround breakdown as the five bands, in order, with everything that is
 * not a turnaround dropped.
 *
 * Returns the rows UNCHANGED when the breakdown is empty, and an empty list
 * when it held rows but none of them were durations — a window in which nothing
 * has come down has no turnaround to distribute, and the panel says "no data"
 * rather than drawing five noughts.
 */
export function foldTatRows(rows: any[]): any[] {
  if (!Array.isArray(rows) || rows.length === 0) return rows

  const urls = TAT_BANDS.map(() => 0)
  const removed = TAT_BANDS.map(() => 0)
  let any = false

  for (const r of rows) {
    const i = tatBandFor(String(r?.label ?? ''))
    if (i < 0) continue          // "Pending", "Unknown", a blank
    urls[i] += num(r?.urls)
    removed[i] += num(r?.removed)
    if (urls[i] || removed[i]) any = true
  }
  if (!any) return []

  return TAT_BANDS.map((b, i) => ({
    label: b.label,
    /* No `value`. A band is computed rather than stored, so there is nothing in
       the warehouse a click could narrow to. */
    urls: urls[i],
    removed: removed[i],
  }))
}
