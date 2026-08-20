'use client'

/**
 * /admin/guidelines — how to actually turn things on.
 *
 * Every one of these tasks spans several screens, and none of them says so. A
 * client with the Reports module granted and no warehouse mapping sees an empty
 * report; one with API credentials and no module grant sees no nav item; one
 * with a dashboard module and no PowerBI credentials sees a tile that opens
 * nothing. Each failure looks like the LAST screen touched is broken, which is
 * the screen least likely to be at fault.
 *
 * So this is written as ordered steps across screens, with the reason each step
 * exists and what it looks like when it is the missing one. It is deliberately
 * a page in the product rather than a document elsewhere: the steps name
 * screens, and a link is worth more than a screenshot that goes stale.
 */

import { useState } from 'react'
import { Link } from 'react-router-dom'
import AdminPageHeader from '@/components/admin/AdminPageHeader'

const ORANGE = '#FC934C'

interface Step {
  /** The screen this step happens on. */
  where: string
  href?: string
  /** What to do there. */
  what: string
  /** Why — the step is skippable-looking without it. */
  why?: string
}

interface Guide {
  id: string
  title: string
  summary: string
  icon: string
  /** Picked up by the accent rail, the step numbers and the icon tile, so a
      guide reads as one thing rather than four unrelated boxes. Matches the
      colour the Configuration grid already gives those screens. */
  color: string
  steps: Step[]
  /** What the reader sees when a step was missed. The fastest way to diagnose
      a half-finished setup is to recognise its symptom. */
  symptoms?: { missing: string; looks: string }[]
  note?: string
}

const GUIDES: Guide[] = [
  {
    id: 'api-module',
    color: '#7C3AED',
    icon: '🔑',
    title: 'Allow an API-based module',
    summary:
      'Search Case List, Download Data, IP Tracking, War Room and the other MarkScan-backed pages. ' +
      'Each needs BOTH a working API credential on the company and the module granted to the login — ' +
      'either one alone shows nothing.',
    steps: [
      {
        where: 'Configuration → API Modules',
        href: '/admin/modules',
        what: 'Check the module exists and is not disabled. Create it if it is missing.',
        why: 'Everything below keys on this row. A module that is not here cannot be granted to anyone.',
      },
      {
        where: 'Configuration → Manage API Credentials',
        href: '/admin/api-credentials',
        what: 'Set the API username and password for the client company.',
        why:
          'These are the company’s MarkScan credentials. The portal exchanges them for a token on ' +
          'sign-in, and every API-backed page is hidden while that token cannot be obtained — for the ' +
          'whole company, not just this login.',
      },
      {
        where: 'Configuration → API Module Permissions',
        href: '/admin/module-permissions',
        what: 'Open the login and tick the module. Save.',
        why: 'The grant is per LOGIN, not per company — each person who needs the page needs their own tick.',
      },
      {
        where: 'The client’s own portal',
        what: 'Ask them to sign out and back in.',
        why: 'The API token is resolved at sign-in, so a credential added mid-session is not picked up until the next one.',
      },
    ],
    symptoms: [
      { missing: 'API credentials', looks: 'Every API-backed item is missing from the nav, including ones that were granted.' },
      { missing: 'The module grant', looks: 'Other API pages work; this one item is absent for this person only.' },
      { missing: 'A fresh sign-in', looks: 'The admin screens show it enabled and the client still cannot see it.' },
    ],
  },
  {
    id: 'reports',
    color: '#2763C4',
    icon: '📊',
    title: 'Enable Reports for a client',
    summary:
      'Reports reads the analytics warehouse, not MarkScan, so it needs a different chain: a service ' +
      'connection, a company mapped to a warehouse client, and the module granted.',
    steps: [
      {
        where: 'Configuration → Report Configuration → Connection',
        href: '/admin/report-config',
        what: 'Set the reports API address and key, then use Test connection.',
        why:
          'Configured once for the whole portal, not per client. The test reports three things ' +
          'separately — reachable, key accepted, and whether that service can reach its own warehouse — ' +
          'because they fail separately and are fixed differently.',
      },
      {
        where: 'Report Configuration → Clients',
        href: '/admin/report-config',
        what:
          'Find the portal client and set its warehouse client. Where a name matches, one is offered as ' +
          'a suggestion — confirm it rather than assuming it.',
        why:
          'This mapping is the data boundary: it decides whose numbers the login reads. It is explicit ' +
          'precisely because a near-match on company name would silently show one company another’s data.',
      },
      {
        where: 'Configuration → API Module Permissions',
        href: '/admin/module-permissions',
        what: 'Open the login and tick Reports. Save.',
        why:
          'Ticking Reports removes Dashboard automatically — the two show the same figures, so a login ' +
          'gets one of them. Reports takes precedence.',
      },
    ],
    symptoms: [
      { missing: 'The warehouse mapping', looks: 'The report opens and says the account is not linked to a reporting client.' },
      { missing: 'The connection', looks: 'Every client’s report is unavailable, not just this one.' },
      { missing: 'The module grant', looks: 'No Reports item in the nav; the client lands on Dashboard instead.' },
    ],
    note:
      'Reports does NOT need MarkScan API credentials — it is a different backend from the API-based ' +
      'modules above. A client with no API credentials can still be given Reports.',
  },
  {
    id: 'dashboard',
    color: '#F59E0B',
    icon: '📈',
    title: 'Enable the Dashboard for a client',
    summary:
      'The Dashboard is the PowerBI tile page. It is what a login gets when Reports has NOT been ' +
      'granted, so in most cases there is nothing to switch on — only tiles to give it.',
    steps: [
      {
        where: 'Configuration → PowerBI API Credentials',
        href: '/admin/powerbi-creds',
        what: 'Configure the PowerBI credentials.',
        why: 'Set once for the portal. Without it the tiles exist but open nothing.',
      },
      {
        where: 'Configuration → PowerBI Dashboard Modules',
        href: '/admin/dashboard-modules',
        what: 'Create the dashboard modules and assign them to the client, each with its report link.',
        why:
          'The tiles on a client’s Dashboard are exactly the modules assigned to that company here. ' +
          'A company with none assigned sees an empty Dashboard even though the page itself is working.',
      },
      {
        where: 'Configuration → API Module Permissions',
        href: '/admin/module-permissions',
        what:
          'Make sure Reports is NOT ticked for the login. Dashboard may be ticked or left alone — ' +
          'it is the default either way.',
        why:
          'Reports and Dashboard are one entitlement with two faces. Where Reports is granted it wins ' +
          'and Dashboard disappears from the nav, which is the usual reason a Dashboard "stops working" ' +
          'right after someone was given Reports.',
      },
    ],
    symptoms: [
      { missing: 'Assigned dashboard modules', looks: 'The Dashboard opens with no tiles on it.' },
      { missing: 'PowerBI credentials', looks: 'Tiles appear but the report does not load when opened.' },
      { missing: 'Nothing — Reports is granted', looks: 'No Dashboard in the nav at all, and /dashboard sends the reader to Reports.' },
    ],
  },
  {
    id: 'email',
    color: '#0891B2',
    icon: '✉️',
    title: 'Update an email template',
    summary:
      'Three screens, in this order: what sends the mail, what triggers it, and what it says. Editing ' +
      'the wording first is the usual mistake — a template with no working sender changes nothing.',
    steps: [
      {
        where: 'Configuration → Email Credentials',
        href: '/admin/settings',
        what: 'Check the SMTP settings and the from-address.',
        why: 'Everything below is delivered through this. A template is correct and invisible without it.',
      },
      {
        where: 'Configuration → Email Event Types',
        href: '/admin/email-event-types',
        what: 'Find the event the mail belongs to and note the variables it offers.',
        why:
          'The variables are per event. A placeholder that the event does not provide renders empty in ' +
          'the sent mail rather than failing, so it is worth reading the list before writing the body.',
      },
      {
        where: 'Configuration → Email Templates',
        href: '/admin/email-templates',
        what: 'Edit the subject and body, using only the variables that event offers. Save.',
        why: 'This is the wording that actually goes out.',
      },
      {
        where: 'Anywhere',
        what: 'Trigger the event once and read the result in a real inbox.',
        why:
          'The rendered mail is the only place a wrong variable name shows up — it is an empty gap in ' +
          'the text, not an error anyone is told about.',
      },
    ],
  },
]

export default function GuidelinesPage() {
  /* Open by ID rather than a boolean per card: only one guide is followed at a
     time, and four expanded at once is four screens of prose with no way to see
     the list of tasks it came from. */
  const [open, setOpen] = useState<string | null>(null)
  const active = GUIDES.find(g => g.id === open) ?? null

  return (
    <div className="p-6 fade-in">
      <AdminPageHeader
        breadcrumb={[
          { label: 'Configuration', href: '/admin/configuration' },
          { label: 'Setup Guidelines' },
        ]}
        title="Setup Guidelines"
        description="Step-by-step, across the screens each task actually touches."
      />

      {/* Said once, at the top: it is the reason the page exists and the reason
          the symptom tables below are worth reading. */}
      <div className="mb-5 rounded-2xl border border-blue-100 bg-blue-50/60 px-5 py-4">
        <p className="text-sm text-[#14254A] leading-relaxed">
          Every one of these spans several screens. A half-finished setup fails on the{' '}
          <strong>last</strong> screen the client touches — which is the screen least likely to be at
          fault — so each guide ends with the symptom each missing step produces.
        </p>
      </div>

      {/* Same grid the Configuration page uses, so the two read as one product
          and this page fills the width rather than sitting in a column. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-5 items-stretch">
        {GUIDES.map(g => {
          const isOpen = open === g.id
          return (
            <button
              key={g.id}
              type="button"
              onClick={() => setOpen(isOpen ? null : g.id)}
              aria-expanded={isOpen}
              className={`group relative h-full text-left bg-white rounded-2xl border shadow-card
                transition-all duration-200 p-5 flex flex-col gap-3.5 overflow-hidden
                ${isOpen
                  ? 'border-transparent shadow-lg -translate-y-1'
                  : 'border-gray-100 hover:shadow-lg hover:-translate-y-1'}`}
              style={isOpen ? { boxShadow: `0 0 0 2px ${g.color}` } : undefined}
            >
              <span
                className={`absolute left-0 top-0 bottom-0 w-1 transition-opacity ${
                  isOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                style={{ background: g.color }}
                aria-hidden
              />
              <div className="flex items-start gap-3">
                <div className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl flex-shrink-0"
                  style={{ background: `${g.color}15` }}>
                  {g.icon}
                </div>
                <h3 className="font-semibold text-sm text-[#14254A] leading-snug pt-1">
                  {g.title}
                </h3>
              </div>
              <p className="text-xs text-gray-500 leading-relaxed">{g.summary}</p>
              <div className="mt-auto pt-1 flex items-center gap-1.5">
                <span className="text-xs font-semibold" style={{ color: g.color }}>
                  {isOpen ? 'Hide steps' : `${g.steps.length} steps`}
                </span>
                <span className={`text-xs font-semibold transition-transform ${
                  isOpen ? 'rotate-90' : 'group-hover:translate-x-0.5'}`}
                  style={{ color: g.color }} aria-hidden>
                  →
                </span>
              </div>
            </button>
          )
        })}
      </div>

      {/* The steps open BELOW the grid, at full width.

          Inside a card they would be a column three inches wide, and these are
          sentences rather than labels. Here the numbered steps and the symptom
          table sit side by side on a wide screen, which is the pairing a reader
          actually uses: follow the steps, or recognise the symptom. */}
      {active && (
        <div className="mt-5 bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden fade-in">
          <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-3"
            style={{ background: `${active.color}0C` }}>
            <span className="w-9 h-9 rounded-xl grid place-items-center text-lg flex-shrink-0"
              style={{ background: `${active.color}20` }} aria-hidden>{active.icon}</span>
            <h2 className="font-bold text-[#14254A]">{active.title}</h2>
            <button type="button" onClick={() => setOpen(null)}
              className="ml-auto text-xs font-semibold text-gray-400 hover:text-[#14254A]">
              Close
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[1.6fr_1fr] gap-8 p-6">
            <ol className="space-y-5">
              {active.steps.map((s, i) => (
                <li key={i} className="flex gap-4">
                  <div className="flex flex-col items-center flex-shrink-0">
                    {/* The number carries the ORDER, which is the whole point —
                        these steps depend on each other. */}
                    <span className="w-7 h-7 rounded-full grid place-items-center text-xs font-bold text-white"
                      style={{ background: active.color }}>
                      {i + 1}
                    </span>
                    {/* A rail joining one step to the next, so the sequence is
                        visible before a word is read. */}
                    {i < active.steps.length - 1 && (
                      <span className="w-px flex-1 mt-1" style={{ background: `${active.color}30` }} aria-hidden />
                    )}
                  </div>
                  <div className="min-w-0 flex-1 pb-1">
                    <p className="text-sm font-semibold">
                      {s.href
                        ? <Link to={s.href} className="hover:underline" style={{ color: active.color }}>
                            {s.where} <span aria-hidden>↗</span>
                          </Link>
                        : <span className="text-[#14254A]">{s.where}</span>}
                    </p>
                    <p className="text-sm text-gray-700 mt-1">{s.what}</p>
                    {s.why && (
                      <p className="text-xs text-gray-500 mt-1.5 leading-relaxed border-l-2 pl-3"
                        style={{ borderColor: `${active.color}30` }}>
                        {s.why}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ol>

            <div className="space-y-4">
              {active.note && (
                <p className="text-xs rounded-xl px-4 py-3 bg-amber-50 text-amber-800 border border-amber-100 leading-relaxed">
                  {active.note}
                </p>
              )}

              {active.symptoms && active.symptoms.length > 0 && (
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-2">
                    If it is not working
                  </p>
                  <div className="rounded-xl border border-gray-100 overflow-hidden">
                    {active.symptoms.map((sy, i) => (
                      <div key={i} className={`px-4 py-3 ${i > 0 ? 'border-t border-gray-100' : ''}`}>
                        <p className="text-xs font-semibold" style={{ color: ORANGE }}>
                          Missing: {sy.missing}
                        </p>
                        <p className="text-xs text-gray-600 mt-1 leading-relaxed">{sy.looks}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
