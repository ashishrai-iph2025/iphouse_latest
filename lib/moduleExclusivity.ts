/**
 * Dashboard and Reports are one entitlement with two faces.
 *
 * They present the same client's figures, so a login is given exactly one of
 * them. The server already resolves this when the nav is read — see
 * effectiveNavModules in go-server/handlers/misc.go — which means a login with
 * both ticked is not broken, merely misleading: the screen says two, the portal
 * gives one.
 *
 * This is the other half. Enforcing it where the boxes are ticked means the
 * form can never claim something the product will not honour, and an admin is
 * not left wondering why the second grant did nothing.
 *
 * Kept here rather than in either picker because two of them exist — Module
 * Permissions and Registration Requests — and a rule copied into both is a rule
 * that will be changed in one.
 */

/** The two module names the rule is about, compared case-insensitively because
    they come from a database column rather than a literal. */
const DASHBOARD = 'dashboard'
const REPORTS = 'reports'

function nameOf(id: number, modules: { id: number; name: string }[]): string {
  return (modules.find(m => m.id === id)?.name ?? '').trim().toLowerCase()
}

/**
 * Apply the rule after `justToggled` was switched on.
 *
 * The module just ticked wins, and its counterpart is dropped. That direction
 * matters: an admin ticking Reports on an account that already has Dashboard
 * means "give them Reports", and silently refusing — or clearing the box they
 * just clicked — would read as the click not registering.
 *
 * Anything else in the selection is untouched.
 */
export function enforceDashboardReports(
  selected: number[],
  justToggled: number,
  modules: { id: number; name: string }[],
): number[] {
  const toggledName = nameOf(justToggled, modules)
  const counterpart =
    toggledName === DASHBOARD ? REPORTS :
    toggledName === REPORTS ? DASHBOARD : ''
  if (!counterpart) return selected
  if (!selected.includes(justToggled)) return selected // it was just unticked

  return selected.filter(id => id === justToggled || nameOf(id, modules) !== counterpart)
}

/**
 * Whether a selection breaks the rule.
 *
 * Used to keep Select All honest and to refuse a save assembled some other way
 * — a stored grant made before the rule existed, for instance, reaching the
 * form through an edit.
 */
export function hasBothDashboardAndReports(
  selected: number[],
  modules: { id: number; name: string }[],
): boolean {
  let dash = false
  let rep = false
  for (const id of selected) {
    const n = nameOf(id, modules)
    if (n === DASHBOARD) dash = true
    if (n === REPORTS) rep = true
  }
  return dash && rep
}

/**
 * The selection "Select all" should produce.
 *
 * Everything except the Dashboard, because Reports is in the list and wins.
 * Select All previously ticked both and so produced a selection the rule
 * immediately contradicted — the one place a bulk action can quietly create the
 * state the form spends its time preventing.
 */
export function selectAllRespectingRule(
  all: number[],
  modules: { id: number; name: string }[],
): number[] {
  const hasReports = all.some(id => nameOf(id, modules) === REPORTS)
  if (!hasReports) return all
  return all.filter(id => nameOf(id, modules) !== DASHBOARD)
}

/** The message both pickers show. One sentence, in one place. */
export const DASHBOARD_REPORTS_HINT =
  'Dashboard and Reports show the same figures — pick one. Reports takes precedence.'
