/*
 * The list pill and the drawer, on the same row, side by side.
 *
 * They disagreed: the list said ACTIVE and the panel said Dead. Two causes —
 * the pill looked for `removalStatus` where Open Web sends `removalstatus`, so
 * it found nothing and get()'s "—" was read as live; and Open Web rows are
 * PAIRS, so even once found, the pill has to read the end the row is on.
 */
import { resolveFields, isLiveStatus } from '@/lib/infringementFields'
import { rowIsSourceUrl } from '@/lib/platformCategories'

// The reported row: a HOST row (it carries both URLs), host file confirmed gone.
const hostRow = {
  assetName: 'My Best Friend, His Girlfriend and Me',
  infringingURL: 'https://example-linking.invalid/a/',
  sourceURL: 'https://example-host.invalid/download/0000',
  delistingremovalstatus: 'Approved',
  dmcaremovalstatus: 'Active',   // the LINK is still up
  removalstatus: 'Dead',         // the HOST file is gone
}
// The same pair's other end.
const linkingRow = {
  assetName: 'My Best Friend, His Girlfriend and Me',
  infringingURL: 'https://example-linking.invalid/a/',
  delistingremovalstatus: 'Approved',
  dmcaremovalstatus: 'Active',
  removalstatus: null,
}
// A row that genuinely reports nothing.
const silentRow = { assetName: 'No status at all', infringingURL: 'https://example-linking.invalid/b/' }

const cases: [string, any][] = [
  ['host row (the reported one)', hostRow],
  ['linking row (same pair)', linkingRow],
  ['row with no status at all', silentRow],
]

const out = cases.map(([name, row]) => {
  const f = resolveFields(row, 'Open Web')
  const known = f.status !== '—'
  const live = known && isLiveStatus(f.status)
  return [
    name,
    `  side          ${rowIsSourceUrl(row) ? 'HOST' : 'LINKING'}`,
    `  pill reads    ${known ? f.status : 'Unknown'}   (${live ? 'green/live' : 'grey'})`,
    `  drawer shows  ${rowIsSourceUrl(row)
        ? 'Host Removal Status: ' + (row.removalstatus ?? '—')
        : 'Linking Removal Status: ' + (row.dmcaremovalstatus ?? '—')}`,
  ].join('\n')
}).join('\n\n')

document.getElementById('root')!.textContent = out
