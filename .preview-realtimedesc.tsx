/*
 * What the Realtime ⓘ holds, with and without a configured description.
 *
 * It used to be both: the admin's paragraph, then four more they did not write.
 * Now the configured text is the whole tooltip, and the card's own note is the
 * fallback for when nothing is configured — which is how every other panel on
 * the report already behaves.
 *
 * scopeNote is not exported (it is internal to the card), so this reproduces
 * the ONE line that changed — the InfoDot expression — against a stand-in for
 * the card's own note. What is under test is the choice, not the prose.
 */
const cardsOwnNote = [
  'Everything found for this client in the last 7 days, counted up to the stamp above. …',
  'Counted live and de-duplicated per URL, so a page found on three days counts once. …',
  '"Removed" is not one thing: approved delisting notice on the open web, and URL no longer reachable elsewhere.',
  '2 platforms could not be counted on this reading, so the totals are a floor rather than an exact figure.',
  'Re-read every 30 seconds; the stamp above says how old this reading is.',
].join('\n\n')

/** The expression now in RealtimeCard.tsx. */
const tooltip = (desc?: string) => desc?.trim() || cardsOwnNote

const configured =
  'Live count of infringements identified. The data is refreshed every 30 seconds and remains ' +
  'available for infringements identified during the last 7 days.'

const show = (name: string, v: string) =>
  `${name}\n${'─'.repeat(name.length)}\n${v}\n`

document.getElementById('root')!.textContent = [
  show('1 · a description IS configured — only that text', tooltip(configured)),
  show('2 · nothing configured — the card\'s own note, unchanged', tooltip(undefined)),
  show('3 · configured as whitespace only — treated as none', tooltip('   \n  ')),
].join('\n')
