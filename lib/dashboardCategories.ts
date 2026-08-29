/*
 * The categories a dashboard module can be filed under.
 *
 * One list, read by both screens that have an opinion about it: the catalogue
 * on /admin/dashboard-modules, where a module is GIVEN its category, and the
 * picker on /admin/registrations, where a category is how an admin narrows a
 * long module list down to the handful a person should get.
 *
 * Kept here rather than in either of them because the two have to agree
 * exactly. A category spelled "Warroom" in the picker and "War Room" in the
 * catalogue is not a typo that shows up as a typo — it is a filter that
 * silently matches nothing, on a screen whose whole job is to hide things.
 *
 * The server mirrors this list in go-server/handlers/admin/modules.go and
 * validates writes against it, because a value the UI cannot offer can still
 * arrive by hand. Change one and change the other; there are two of them
 * because a browser constant is not access control.
 */

export const DASHBOARD_CATEGORIES = ['VOD', 'Sports', 'War Room'] as const

export type DashboardCategory = (typeof DASHBOARD_CATEGORIES)[number]

/** What an uncategorised module carries. Empty string rather than null — see
    the note on migration 006: one spelling of "not set", not two. */
export const NO_CATEGORY = ''

/** True for a value this build knows about. A module categorised by an older
    or newer build keeps its value in the database; this only decides whether
    a picker can offer it. */
export function isKnownCategory(v: string): v is DashboardCategory {
  return (DASHBOARD_CATEGORIES as readonly string[]).includes(v)
}

/** How a category reads in a list. An uncategorised module is not blank — the
    reader would take a blank cell for a rendering fault rather than for the
    real and fixable state it is. */
export function categoryLabel(v: string | null | undefined): string {
  const s = String(v ?? '').trim()
  return s === NO_CATEGORY ? 'Uncategorised' : s
}

/* Chip colours, one per category, so the same subject reads the same on both
   screens. Deliberately away from brand orange: orange means "selected" in the
   pickers these chips sit inside, and a category that is permanently orange
   would read as a category that is permanently chosen. */
export const CATEGORY_CHIP: Record<string, string> = {
  'VOD':      'bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300',
  'Sports':   'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  'War Room': 'bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
}

export const UNCATEGORISED_CHIP =
  'bg-gray-100 text-gray-500 dark:bg-white/10 dark:text-white/45'

export const chipFor = (v: string | null | undefined): string =>
  CATEGORY_CHIP[String(v ?? '').trim()] ?? UNCATEGORISED_CHIP
