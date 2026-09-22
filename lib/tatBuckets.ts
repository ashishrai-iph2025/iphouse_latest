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
// Keep the bands here in step with sportsTATBands and vodTATBands in the Go
// file. They are the same sets, and the day they are not, a client's Summary and
// their Open Web report stop being addable.
//
// ── TWO RULERS, AND WHY THIS FILE HAS TO KNOW BOTH ───────────────────────────
//
// This used to hold the five minute-scale bands and nothing else, and folded
// EVERY turnaround panel through them. That silently destroyed the VOD panels:
// the server bands Agg_Daily_Youtube_MasterNew and Agg_Daily_Telegram_MasterNew
// on an hour scale — "0-6 hours" through "24 hours+", which is what those
// tables actually store — and every one of those labels is over two hours, so
// all four landed in "2 hr+". YouTube and Telegram drew one bar holding 100% of
// the rows under five labels of which four were permanently zero, and no
// amount of correctness on the server could survive the trip through here.
//
// So the ruler is DETECTED rather than imposed: a breakdown whose every
// measured label is one of the hour bands is folded on the hour ruler, and
// everything else on the minute ruler. Detection is safe here in a way it is
// not on the server — see tatBandsFor's note over there, which warns that a
// quiet fortnight leaves a VOD table with no hour-scale label to detect. By the
// time rows reach this file the server has already chosen, and what arrives is
// a complete band set; all this has to do is not wreck it. Where nothing
// parses as a duration at all there is nothing to fold either way, and the
// minute ruler's empty set is what comes back.

/** One band: lo < minutes <= hi. */
interface Band { label: string; lo: number; hi: number }

/** The bands a live event is judged on — sports, Open Web, and the Summary. */
export const TAT_BANDS: Band[] = [
  { label: '0-15 min', lo: -1, hi: 15 },
  { label: '15-30 min', lo: 15, hi: 30 },
  { label: '30 min-1 hr', lo: 30, hi: 60 },
  { label: '1-2 hr', lo: 60, hi: 120 },
  { label: '2 hr+', lo: 120, hi: Infinity },
]

/**
 * The bands the VOD tables are judged on — a different SCALE, not a different
 * opinion. A live stream is worth little an hour after kick-off; a film is
 * worth the same tomorrow, and the warehouse bands it in hours.
 *
 * Mirrors vodTATBands in go-server/handlers/tatbuckets.go, labels included:
 * these strings are matched against what the server sent, so a difference of
 * one character here puts the panel back on the wrong ruler.
 */
export const VOD_TAT_BANDS: Band[] = [
  { label: '0-6 hours', lo: -1, hi: 360 },
  { label: '6-12 hours', lo: 360, hi: 720 },
  { label: '12-24 hours', lo: 720, hi: 1440 },
  { label: '24 hours+', lo: 1440, hi: Infinity },
]

const VOD_LABELS = new Set(VOD_TAT_BANDS.map(b => b.label))

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
export function tatBandFor(label: string, bands: Band[] = TAT_BANDS): number {
  const upper = durationMinutes(label)
  if (upper === null) return -1
  const i = bands.findIndex(b => upper > b.lo && upper <= b.hi)
  return i >= 0 ? i : bands.length - 1
}

const num = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0)

/**
 * The ruler a breakdown is already on.
 *
 * The hour ruler only where EVERY measured label is one of its own — an exact
 * label match, not a parse, because the question being asked is "did the server
 * already band this on the hour scale", and only the server's own strings can
 * answer it. One foreign spelling in the set means this is not a VOD band set
 * and folding it on four hour-wide bands would lump a minute-scale report into
 * its first one.
 *
 * Rows that are not durations at all ("Pending") are ignored for the purpose of
 * deciding: they appear on both rulers and say nothing about which is in use.
 */
function rulerFor(rows: any[]): Band[] {
  let measured = 0
  for (const r of rows) {
    const label = String(r?.label ?? '')
    if (durationMinutes(label) === null) continue
    measured++
    if (!VOD_LABELS.has(label.trim())) return TAT_BANDS
  }
  return measured > 0 ? VOD_TAT_BANDS : TAT_BANDS
}

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

  const bands = rulerFor(rows)
  const urls = bands.map(() => 0)
  const removed = bands.map(() => 0)
  let any = false

  for (const r of rows) {
    const i = tatBandFor(String(r?.label ?? ''), bands)
    if (i < 0) continue          // "Pending", "Unknown", a blank
    urls[i] += num(r?.urls)
    removed[i] += num(r?.removed)
    if (urls[i] || removed[i]) any = true
  }
  if (!any) return []

  return bands.map((b, i) => ({
    label: b.label,
    /* No `value`. A band is computed rather than stored, so there is nothing in
       the warehouse a click could narrow to. */
    urls: urls[i],
    removed: removed[i],
  }))
}
