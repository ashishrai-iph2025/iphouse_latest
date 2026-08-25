'use client'

/* Line icons for the Configuration modules.
 *
 * The cards used to carry emoji. Emoji are quick to author but they are a
 * different artwork per platform, they carry their own colour (which fights the
 * card accent), they sit on their own baseline, and half of them render as a
 * flat glyph on Windows and a glossy 3D one on macOS. A single stroked set at
 * one weight makes nineteen tiles read as one product surface.
 *
 * All paths are drawn on a 24×24 grid with `currentColor`, so the caller sets
 * size and colour and nothing else has to change. `strokeWidth` stays 1.6 —
 * heavy enough to hold at 20px, light enough not to blob at 40px.
 *
 * The emoji fields survive in lib/configModules.ts: the Manage Access toggle
 * grid still uses them, and that is a dense 3-across picker where a glyph reads
 * faster than a line icon. */

type Paths = React.ReactNode

const ICONS: Record<string, Paths> = {
  /* Setup Guidelines — an open book */
  guidelines: <>
    <path d="M12 6.5C10.5 5.2 8.6 4.5 6.5 4.5H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h2.5c2.1 0 4 .7 5.5 2" />
    <path d="M12 6.5c1.5-1.3 3.4-2 5.5-2H20a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-2.5c-2.1 0-4 .7-5.5 2" />
    <path d="M12 6.5v14" />
  </>,

  /* API Modules — a stack of service blocks */
  modules: <>
    <rect x="3" y="3" width="7.5" height="7.5" rx="1.6" />
    <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6" />
    <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6" />
    <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6" />
  </>,

  /* Manage API Credentials — a key */
  'api-credentials': <>
    <circle cx="7.5" cy="15.5" r="3.5" />
    <path d="M10 13 20 3" />
    <path d="M17.5 5.5 20 8" />
    <path d="M15 8l2 2" />
  </>,

  /* PowerBI Dashboard Modules — bars inside a frame */
  'dashboard-modules': <>
    <rect x="3" y="3.5" width="18" height="17" rx="2" />
    <path d="M8 16v-3.5" />
    <path d="M12 16V8" />
    <path d="M16 16v-5.5" />
  </>,

  /* API Module Permissions — shield with a tick */
  'module-permissions': <>
    <path d="M12 2.8 4.5 6v6c0 4.4 3.1 7.9 7.5 9.2 4.4-1.3 7.5-4.8 7.5-9.2V6z" />
    <path d="m9 12 2.2 2.2L15.5 10" />
  </>,

  /* PowerBI API Credentials — a plug/connector */
  'powerbi-creds': <>
    <path d="M9 3v5" />
    <path d="M15 3v5" />
    <path d="M6.5 8h11v3a5.5 5.5 0 0 1-11 0z" />
    <path d="M12 16.5V21" />
  </>,

  /* PowerBI Workspace — layered datasets */
  'powerbi-workspace': <>
    <path d="m12 3 9 4.5-9 4.5-9-4.5z" />
    <path d="m3 12 9 4.5 9-4.5" />
    <path d="m3 16.5 9 4.5 9-4.5" />
  </>,

  /* Email Credentials — an envelope */
  settings: <>
    <rect x="2.5" y="5" width="19" height="14" rx="2" />
    <path d="m3.5 7 7.4 5.3a2 2 0 0 0 2.2 0L20.5 7" />
  </>,

  /* Session Timeout — a clock */
  'idle-timeout': <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5.2l3.2 2" />
  </>,

  /* Registration Requests — a clipboard with lines */
  'registration-requests': <>
    <path d="M9 4.5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-12a2 2 0 0 0-2-2h-2" />
    <rect x="9" y="2.5" width="6" height="4" rx="1.2" />
    <path d="M8.5 12h7" />
    <path d="M8.5 15.5h4.5" />
  </>,

  /* Tracking Report — an activity trace */
  tracking: <>
    <path d="M3 12.5h4l2.5-6.5 4 13 2.5-6.5H21" />
  </>,

  /* Asset Based Access — a folder under lock */
  'asset-access': <>
    <path d="M21 11V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V9" />
    <circle cx="12" cy="13.5" r="1.6" />
    <path d="M12 15.1v2" />
  </>,

  /* War Room Assets — a crosshair on target */
  'war-room-assets': <>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="3.5" />
    <path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3" />
  </>,

  /* Report Configuration — sliders */
  'report-config': <>
    <path d="M4 7h9M17 7h3" />
    <path d="M4 12h3M11 12h9" />
    <path d="M4 17h11M19 17h1.5" />
    <circle cx="15" cy="7" r="2" />
    <circle cx="9" cy="12" r="2" />
    <circle cx="17" cy="17" r="2" />
  </>,

  /* Email Templates — a document with a header block */
  'email-templates': <>
    <rect x="4" y="3" width="16" height="18" rx="2" />
    <rect x="7.5" y="6.5" width="9" height="4" rx="1" />
    <path d="M7.5 14h9M7.5 17.5h6" />
  </>,

  /* Email Event Types — a bell */
  'email-event-types': <>
    <path d="M18 9a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16S18 14 18 9" />
    <path d="M13.7 19a2 2 0 0 1-3.4 0" />
  </>,

  /* Client Admins — a pair of people */
  'client-admins': <>
    <circle cx="9.5" cy="8" r="3.2" />
    <path d="M3.5 19.5a6 6 0 0 1 12 0" />
    <path d="M16 5.2a3.2 3.2 0 0 1 0 5.6" />
    <path d="M17.5 14.2a6 6 0 0 1 3 5.3" />
  </>,

  /* Security Policy — a shield with a keyhole */
  'security-policy': <>
    <path d="M12 2.8 4.5 6v6c0 4.4 3.1 7.9 7.5 9.2 4.4-1.3 7.5-4.8 7.5-9.2V6z" />
    <circle cx="12" cy="11" r="1.8" />
    <path d="M12 12.8v2.7" />
  </>,

  /* AWS Credentials — a padlock */
  'aws-credentials': <>
    <rect x="4.5" y="10" width="15" height="10.5" rx="2" />
    <path d="M8 10V7.5a4 4 0 0 1 8 0V10" />
    <path d="M12 14v2.5" />
  </>,

  /* Database Backup — a database cylinder */
  'database-backup': <>
    <ellipse cx="12" cy="5.8" rx="7.5" ry="3" />
    <path d="M4.5 5.8v12.4c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V5.8" />
    <path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3" />
  </>,
}

/* Anything without a bespoke drawing gets a gear rather than a blank tile, so a
   module added to the catalogue without an icon still ships looking deliberate. */
const FALLBACK: Paths = <>
  <circle cx="12" cy="12" r="3.2" />
  <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
</>

interface Props {
  /** ConfigModule.key */
  name:   string
  size?:  number
  className?: string
}

export default function ConfigIcon({ name, size = 22, className }: Props) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"
      className={className} aria-hidden focusable="false"
    >
      {ICONS[name] ?? FALLBACK}
    </svg>
  )
}
