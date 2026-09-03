'use client'

/**
 * THE loader. Every waiting state in this app that occupies a region — a page,
 * a panel, a modal body, a dropdown, the full-screen overlay — uses this one.
 *
 * The logo draws ITSELF, one piece at a time: the four bars rise off the
 * baseline left to right, then "IP HOUSE" arrives letter by letter, the
 * finished mark holds, fades, and the cycle restarts. Underneath it a gradient
 * rail glides back and forth, continuously.
 *
 * WHAT THIS REPLACED
 *
 * Three separate loaders and a scattering of bordered-circle spinners: a
 * full-screen navigation overlay that patched history.pushState to fire on every
 * route change (a Next.js-app-router habit this Vite/React-Router app has no need
 * for — it stacked a second loader on top of the page's own and is now gone), the
 * inline components/ui/PageLoader (both a gradient ring around a pulsing logo),
 * and roughly twenty `rounded-full animate-spin` divs that had each picked their
 * own size, colour and border weight. Those are now this, so a wait looks the
 * same wherever the reader meets one.
 *
 * Small in-BUTTON spinners are deliberately NOT this — see `bars` below.
 *
 * WHY THE BARS ARE SVG AND THE WORDMARK IS THE PNG
 *
 * Two halves, two techniques, and the reason is fidelity in both cases.
 *
 * The bars are paths, because they have to animate INDEPENDENTLY — four
 * separate risers is the whole effect — and a raster can only be moved as one
 * lump. Their geometry is measured off the asset, not drawn by eye.
 *
 * The wordmark is the PNG itself, revealed left to right. It is set in a
 * typeface this repo does not ship, so redrawing it as live text would put a
 * near-miss of the brand on screen — which is worse than not showing it. The
 * image is clipped to the wordmark's own slice of the logo and the SVG bars are
 * drawn over the space where the PNG's bars sit, so the two halves compose back
 * into the real mark, aligned.
 *
 * INDETERMINATE ON PURPOSE. The server cannot say how far through it is, so a
 * progress bar would be a number this component invented. Everything here
 * loops: motion means "still working", and nothing on screen claims to know
 * more than that.
 */

import { useId } from 'react'

/**
 * The four bars, measured off public/newlogo.png rather than eyeballed: the
 * asset's own pixels were scanned column by column for their top and bottom
 * edges, and those edges scaled into this coordinate space. An approximation
 * here would read as a slightly-wrong logo, which is the one thing a loader
 * built out of a logo cannot afford.
 *
 * The coordinate space is the WHOLE logo (2000 x 549, the asset's 6300 x 1728
 * scaled down), not just the bars — that is what lets the SVG and the clipped
 * PNG sit in one box and line up. Baseline y=549, so every bar rises off one
 * floor.
 */
const BARS = [
  'M23,267 L109,303 L109,549 L23,549 Z',
  'M163,189 L249,229 L249,549 L163,549 Z',
  'M306,109 L397,154 L397,549 L306,549 Z',
  'M458,25 L816,239 L816,549 L458,549 Z',
]

/** The full logo, and the bars on their own. `bars` mode crops the viewBox to
 *  x=840 — just past where bar 4 ends — instead of scaling the whole lockup
 *  down, which would leave the wordmark's width as empty space. */
const BOX_FULL = '0 0 2000 549'
const BOX_BARS = '0 0 840 549'
const ASPECT_FULL = 549 / 2000
const ASPECT_BARS = 549 / 840

/** The logo's one and only colour. The asset is flat #14254A throughout —
 *  every bar, every letter — so the SVG half needs no shading to match it. */
const NAVY = '#14254A'

/** The brand gradient, as used on the rail. Same two stops the rest of the app
 *  reaches for. */
const GRAD_FROM = '#FC934C'
const GRAD_TO = '#FFC82B'

/**
 * Where the clip starts, as a percentage of the logo's width.
 *
 * It sits in the DEAD SPACE between the halves — bar 4 ends at 40.78% and the
 * "I" begins at 46.40%, so anywhere between the two is equivalent and the
 * middle is the safest. Too low and the clip would expose the PNG's own bar 4
 * underneath the SVG one; too high and it would shave the "I".
 */
const WORD_LEFT = 43.5

/**
 * The right-hand inset at each step of the reveal, in percent: one hidden state
 * followed by one stop per glyph of "IP HOUSE".
 *
 * Discrete stops and not a wipe, because a wipe slides across the letters and
 * at this size that is a smear rather than letters arriving.
 *
 * Each stop is the MIDDLE of the gap after its glyph, taken from the same
 * column scan that produced the bars. Landing on a glyph's own edge would clip
 * its antialiasing and put a frayed letter on screen for a fifth of a second;
 * landing in the gap means every frame shows whole letters. The letters are not
 * uniform in width — "I" is a quarter of the width of "P" — so even spacing
 * would have revealed two of them at once and stalled on another.
 */
const WORD_STEPS = [56.5, 51.08, 41.26, 31.31, 22.64, 14.05, 5.99, 0]

export type ReportLoaderProps = {
  /** What is being waited on. Pass null to show the mark alone. */
  label?: string | null
  /** The detail line — the platform, the window, whatever names this wait. */
  sublabel?: string | null
  /** Logo width in px. Everything else scales from it. */
  size?: number
  /**
   * Fill the height of whatever contains it and centre inside, rather than
   * sitting at its natural height. For a panel whose height is already known,
   * so content does not jump when the loader is replaced by it.
   */
  fill?: boolean
  /**
   * Draw the four bars WITHOUT the wordmark, for a space too small to read it
   * in. Below roughly 90px the letters stop being letters, and an illegible
   * wordmark is worse than none.
   *
   * This is also why a small in-button spinner is still a spinner. At the 12–16px
   * that fits beside a button label even the bars are four indistinct ticks, and
   * a button that resized itself to fit a logo while you waited would be a
   * worse button. Those stay as they are, on purpose.
   */
  bars?: boolean
  /**
   * Force the light-on-dark treatment regardless of theme, for a permanently
   * dark surface — the full-screen overlay is navy in light mode too, where the
   * theme-driven rule would put a navy logo on a navy ground.
   */
  onDark?: boolean
  /** The gliding gradient rail. Defaults on, except in `bars` mode where the
   *  spaces are too tight to give it room. */
  rail?: boolean
  className?: string
}

export default function ReportLoader({
  label = 'Loading',
  sublabel,
  size = 190,
  fill = false,
  bars: barsOnly = false,
  onDark = false,
  rail,
  className = '',
}: ReportLoaderProps) {
  /* Scoped per instance: two loaders on one page would otherwise share one set
     of keyframe names and the second would inherit the first's phase. useId
     because it is stable across the server and client render. */
  const uid = useId().replace(/:/g, '')
  const bar = `iplB-${uid}-`
  const word = `iplW-${uid}`
  const fade = `iplF-${uid}`
  const glow = `iplG-${uid}`
  const glide = `iplR-${uid}`

  const showRail = rail ?? !barsOnly

  /*
   * ONE CYCLE, IN PERCENTAGES. Every phase below is a share of it, so the
   * timing retunes in one place without the bars and the letters drifting apart.
   *
   *    0 – 25%   the four bars rise, staggered
   *   30 – 58%   "IP HOUSE" arrives, one letter per stop
   *   58 – 84%   the finished mark holds
   *   84 – 95%   it fades out
   *   95 – 100%  a short blackout, in which everything resets unseen
   */
  const CYCLE = '3s'
  const BAR_STAGGER = 4 // % between one bar starting and the next
  const BAR_RISE = 13 // % a single bar takes to reach full height
  const WORD_START = 30
  const WORD_END = 58

  /*
   * The stagger is baked into each bar's KEYFRAMES rather than expressed as an
   * animation-delay, which is the obvious way to write it and was wrong here.
   *
   * A delay shifts that bar's whole timeline, wrap included — so the last bar
   * was still finishing the previous cycle while the first had begun the next,
   * and the blackout that covers the reset no longer lined up with it. All four
   * share one un-delayed timeline instead, and every reset lands inside the
   * same blacked-out window.
   */
  const barFrames = BARS.map((_, i) => {
    const from = i * BAR_STAGGER
    const to = from + BAR_RISE
    // The first bar starts at 0, where `0%, 0%` would be a duplicated selector.
    const held = from === 0 ? '0%' : `0%, ${from}%`
    return `@keyframes ${bar}${i} {
          ${held} { transform: scaleY(0); }
          ${to}%, 100% { transform: scaleY(1); }
        }`
  }).join('\n        ')

  const wordFrames = WORD_STEPS.map((right, i) => {
    const at = WORD_START + ((WORD_END - WORD_START) / (WORD_STEPS.length - 1)) * i
    return `${at.toFixed(1)}% { clip-path: inset(0 ${right}% 0 ${WORD_LEFT}%); }`
  }).join('\n          ')

  const ink = onDark ? '#fff' : NAVY
  const markH = size * (barsOnly ? ASPECT_BARS : ASPECT_FULL)

  return (
    <div
      /* `status` and not `alert`: a progress report, not something that
         interrupts. Polite so it is announced when the reader next pauses
         rather than cutting across what they are reading. */
      role="status"
      aria-live="polite"
      className={[
        'ipl-root flex flex-col items-center justify-center text-center select-none',
        /* Breathing room by default, less of it in `bars` mode — those sit in
           dropdowns and table bodies where a tall gap reads as a broken layout.
           `className` wins over either. */
        fill ? 'h-full w-full min-h-[240px]' : barsOnly ? 'py-4' : 'py-10',
        className,
      ].join(' ')}
    >
      {/* The two halves share this box, which is the logo's own aspect ratio.
          It also owns the fade, for both halves at once — see the keyframes.
          Decorative: the label below carries the meaning, and a screen reader
          reading out a logo mid-wait is noise. */}
      <div
        aria-hidden="true"
        className={`ipl-mark-${uid} relative`}
        style={{ width: size, height: markH }}
      >
        <svg
          viewBox={barsOnly ? BOX_BARS : BOX_FULL}
          className="absolute inset-0 h-full w-full"
          style={{ overflow: 'visible' }}
        >
          {BARS.map((d, i) => (
            <path
              key={i}
              d={d}
              style={{
                /* fill-box + bottom origin, so each bar scales off the floor it
                   shares rather than the middle of the viewBox. */
                transformBox: 'fill-box',
                transformOrigin: 'bottom',
                animation: `${bar}${i} ${CYCLE} cubic-bezier(.34,1.15,.6,1) infinite`,
              }}
            />
          ))}
        </svg>

        {!barsOnly && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src="/newlogo.png"
            alt=""
            className={`ipl-word-${uid} absolute inset-0 h-full w-full`}
            style={{
              objectFit: 'contain',
              /* Starts fully clipped, so the wordmark is absent until the bars
                 have finished rather than flashing on the first frame. */
              clipPath: `inset(0 ${WORD_STEPS[0]}% 0 ${WORD_LEFT}%)`,
              animation: `${word} ${CYCLE} steps(1, end) infinite`,
            }}
          />
        )}
      </div>

      {/* The rail sits OUTSIDE the fading mark and never blanks. During the
          mark's blackout it is the only thing still moving, which is what keeps
          the loader from looking frozen at the loop point. */}
      {showRail && (
        <div
          aria-hidden="true"
          className={`ipl-rail-${uid} overflow-hidden rounded-full`}
          style={{ width: size, height: 3, marginTop: Math.round(size * 0.06) }}
        >
          <div
            className="h-full rounded-full"
            style={{
              width: '45%',
              background: `linear-gradient(90deg,${GRAD_FROM},${GRAD_TO})`,
              animation: `${glide} 1.5s ease-in-out infinite alternate`,
            }}
          />
        </div>
      )}

      {label && (
        <p className={`ipl-label-${uid} mt-4 text-[13px] font-semibold`}>{label}</p>
      )}
      {sublabel && <p className={`ipl-sub-${uid} mt-1 text-[11px]`}>{sublabel}</p>}

      <style>{`
        .ipl-mark-${uid} svg path { fill: ${ink}; }
        .ipl-label-${uid} { color: ${ink}; animation: ${glow} ${CYCLE} ease-in-out infinite; }
        .ipl-sub-${uid}   { color: ${onDark ? 'rgba(255,255,255,.55)' : '#6b7280'}; }
        .ipl-rail-${uid}  { background: ${onDark ? 'rgba(255,255,255,.16)' : 'rgba(20,37,74,.10)'}; }
        ${onDark ? `.ipl-word-${uid} { filter: brightness(0) invert(1); }` : `
        /* The asset is navy on transparent; the sidebar treats it the same way. */
        .dark .ipl-mark-${uid} svg path { fill: #fff; }
        .dark .ipl-word-${uid} { filter: brightness(0) invert(1); }
        .dark .ipl-label-${uid} { color: #fff; }
        .dark .ipl-sub-${uid}   { color: rgba(255,255,255,.55); }
        .dark .ipl-rail-${uid}  { background: rgba(255,255,255,.16); }`}

        /* Bars: each rises once and then STAYS up for the rest of the cycle.
           They are not animated back down — the container's fade takes the
           finished mark away and the reset happens behind it. The overshoot is
           in the easing, not the keyframes, so a bar settles onto its height
           instead of stopping dead at it. */
        ${barFrames}

        /* Letters: one per stop. steps(1,end) is what makes each keyframe a
           JUMP — interpolating between them would slide the clip across the
           word and turn the letters into a smear. Holds complete from
           ${WORD_END}% to the wrap. */
        @keyframes ${word} {
          0%, ${(WORD_START - 0.1).toFixed(1)}% { clip-path: inset(0 ${WORD_STEPS[0]}% 0 ${WORD_LEFT}%); }
          ${wordFrames}
          100% { clip-path: inset(0 ${WORD_STEPS[WORD_STEPS.length - 1]}% 0 ${WORD_LEFT}%); }
        }

        /* The fade lives on the CONTAINER so both halves leave together. Doing
           it per-element let the wordmark blink out as one lump while the bars
           were still on screen.
           Opacity is 0 at 0% for a second reason: a bar at scaleY(0) is a
           zero-height box that still antialiases into a visible hairline, and
           it flashed across the baseline at the top of every cycle. */
        @keyframes ${fade} {
          0%        { opacity: 0; }
          3%, 84%   { opacity: 1; }
          95%, 100% { opacity: 0; }
        }
        .ipl-mark-${uid} { animation: ${fade} ${CYCLE} linear infinite; }

        /* 122% and not 100%: the segment is 45% of the rail, so it reaches the
           far edge at (100/45 - 1) of its own width. The alternate direction
           sends it back rather than snapping to the start. */
        @keyframes ${glide} {
          0%   { transform: translateX(0); }
          100% { transform: translateX(122%); }
        }

        @keyframes ${glow} {
          0%, 100% { opacity: .5; }
          45%, 70% { opacity: 1; }
        }

        /* Motion is the only thing saying "still working", so it is REDUCED and
           not removed: the logo settles complete, the rail holds still, and only
           the label breathes. Nothing rises, nothing wipes, nothing glides. */
        @media (prefers-reduced-motion: reduce) {
          .ipl-mark-${uid}, .ipl-rail-${uid} > * {
            animation: none !important;
          }
          .ipl-mark-${uid} { opacity: 1 !important; }
          .ipl-rail-${uid} > * { width: 100% !important; opacity: .5; }
          .ipl-mark-${uid} svg path {
            animation: none !important;
            transform: none !important;
          }
          .ipl-word-${uid} {
            animation: none !important;
            clip-path: inset(0 ${WORD_STEPS[WORD_STEPS.length - 1]}% 0 ${WORD_LEFT}%) !important;
          }
          .ipl-label-${uid} { animation: ${glow} 4s ease-in-out infinite; }
        }
      `}</style>
    </div>
  )
}
