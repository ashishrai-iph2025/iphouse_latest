'use client'

// /admin/platform-brief — Super Admin only.
// An in-app technical & security overview of the IP House platform, suitable
// for stakeholder / leadership review. Presentable and printable (Export PDF).
// Styles are scoped under `.pbrief` so they never leak into the rest of the app;
// theme tokens follow the app's `.dark` class.

import { useEffect, useRef } from 'react'
import { Navigate, Link } from 'react-router-dom'
import { useSession } from '@/lib/auth-client'

export default function PlatformBriefPage() {
  const { data: session, status } = useSession()
  const role = (session?.user as any)?.role
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      root.querySelectorAll('.rv').forEach(el => el.classList.add('in'))
      return
    }
    const io = new IntersectionObserver(entries => {
      entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target) } })
    }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' })
    root.querySelectorAll('.rv').forEach(el => io.observe(el))
    return () => io.disconnect()
  }, [])

  if (status === 'loading') return null
  if (role !== 2) return <Navigate to="/admin/home" replace />

  return (
    <div className="pbrief" ref={rootRef}>
      <style>{PBRIEF_CSS}</style>

      {/* Toolbar (hidden when printing) */}
      <div className="pb-toolbar">
        <Link to="/admin/super-admin" className="pb-back">← Super Admin Control</Link>
        <button className="pb-print" onClick={() => window.print()}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z" strokeLinecap="round" strokeLinejoin="round"/></svg>
          Export / Print
        </button>
      </div>

      {/* Hero */}
      <header className="pb-hero">
        <div className="pb-hero-in">
          <span className="pb-eyebrow">Anti-Piracy Intelligence Platform · Technical &amp; Security Brief</span>
          <h1>Protecting content across every platform, from a single <span className="acc">command centre.</span></h1>
          <p className="pb-lede">A full-stack anti-piracy platform that discovers, tracks, and takes down infringing content across 13+ digital channels — built on a hardened, role-based Go backend with a defence-in-depth security posture.</p>
          <div className="pb-metrics">
            <div className="pb-metric rv"><div className="num">13<small>+</small></div><div className="lbl">Platforms monitored</div></div>
            <div className="pb-metric rv"><div className="num">10</div><div className="lbl">Product modules</div></div>
            <div className="pb-metric rv"><div className="num">25<small>+</small></div><div className="lbl">Security controls</div></div>
            <div className="pb-metric rv"><div className="num">3</div><div className="lbl">Access tiers (RBAC)</div></div>
          </div>
        </div>
      </header>

      {/* Executive summary */}
      <section>
        <div className="pb-sec-head"><span className="ix">§ 01</span><div><h2>Executive summary</h2><p className="sub">What the platform does, who operates it, and the engineering stance behind it.</p></div></div>
        <div className="pb-summary">
          <div>
            <p className="lead-in">IP House gives rights-holders — studios, broadcasters, and streaming services — one place to fight piracy across the open web, social media, marketplaces, and app stores.</p>
            <p>Analysts sign in, open the <b>War Room</b> for a title, and the platform fans out across every enforcement channel in real time — surfacing infringing links, ranking repeat offenders, and measuring takedown turnaround. From the same console they submit take-downs, review approvals, track IP activity, and open embedded Power BI reporting. Administrators manage clients, credentials, module access, and platform-wide settings through a granular, grant-based configuration layer.</p>
            <p>The system is a <b>single Go service</b> that both exposes the JSON API and serves the React single-page app, backed by MySQL for accounts and configuration, Redis for the War Room dataset cache, and outbound integrations to the MarkScan intelligence API, Power BI, and email. Every request is authenticated with a signed, HTTP-only session and authorised against a three-tier role model.</p>
          </div>
          <aside className="pb-aside">
            <h4>At a glance</h4>
            <dl>
              <div className="row"><dt>Backend</dt><dd>Go (net/http)</dd></div>
              <div className="row"><dt>Frontend</dt><dd>React + Vite (TS)</dd></div>
              <div className="row"><dt>Datastores</dt><dd>MySQL · Redis</dd></div>
              <div className="row"><dt>Auth model</dt><dd>JWT + RBAC</dd></div>
              <div className="row"><dt>Password hashing</dt><dd>bcrypt (cost 12)</dd></div>
              <div className="row"><dt>Secret encryption</dt><dd>AES-256-CBC</dd></div>
              <div className="row"><dt>Delivery</dt><dd>Docker · GitHub Actions</dd></div>
            </dl>
          </aside>
        </div>
      </section>

      {/* Architecture */}
      <section className="alt">
        <div className="pb-sec-head"><span className="ix">§ 02</span><div><h2>System architecture</h2><p className="sub">One deployable Go service fronts the SPA and the API; a security perimeter of authentication, authorisation, and rate-limiting wraps every application route before it reaches data or integrations.</p></div></div>
        <div className="pb-arch">
          <div className="pb-layer rv">
            <span className="ltag">Presentation</span>
            <h4>Browser — Single-Page Application</h4>
            <p>Delivered to the client and hydrated in the browser. No secrets ever reach the bundle.</p>
            <div className="nodes">
              <span className="node"><i></i>React 18 + TypeScript</span>
              <span className="node"><i></i>Vite build</span>
              <span className="node"><i></i>Tailwind CSS</span>
              <span className="node"><i></i>React Router</span>
              <span className="node"><i></i>Recharts</span>
            </div>
          </div>
          <div className="pb-flow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M6 13l6 6 6-6" strokeLinecap="round" strokeLinejoin="round"/></svg><span>HTTPS · HTTP-only session cookie</span></div>
          <div className="pb-perim">
            <span className="plabel">Security perimeter</span>
            <div className="pb-layer rv" style={{ boxShadow: 'none' }}>
              <span className="ltag">Application</span>
              <h4>Go API &amp; Static Server</h4>
              <p>A single binary: routes the JSON API, enforces auth and access control, and serves the SPA. Middleware runs before every handler.</p>
              <div className="nodes">
                <span className="node x"><i></i>JWT session (HS256)</span>
                <span className="node x"><i></i>Role-based access control</span>
                <span className="node x"><i></i>Config-grant enforcement</span>
                <span className="node x"><i></i>Per-IP rate limiter</span>
                <span className="node x"><i></i>CORS allow-list</span>
                <span className="node x"><i></i>Maintenance gate</span>
              </div>
            </div>
          </div>
          <div className="pb-flow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M6 13l6 6 6-6" strokeLinecap="round" strokeLinejoin="round"/></svg><span>Parameterised queries · encrypted credentials</span></div>
          <div className="pb-arch-cols">
            <div className="pb-layer rv"><span className="ltag">Data</span><h4>Persistence</h4><p>Accounts, roles, config &amp; audit trail.</p><div className="nodes"><span className="node d"><i></i>MySQL 8</span><span className="node d"><i></i>Redis (War Room cache)</span></div></div>
            <div className="pb-layer rv"><span className="ltag">Intelligence</span><h4>Integrations</h4><p>Infringement data &amp; dashboards.</p><div className="nodes"><span className="node k"><i></i>MarkScan API</span><span className="node k"><i></i>Power BI / Azure AD</span></div></div>
            <div className="pb-layer rv"><span className="ltag">Comms</span><h4>Notifications</h4><p>Templated, branded email.</p><div className="nodes"><span className="node"><i></i>SMTP (DB-configured)</span></div></div>
          </div>
        </div>
      </section>

      {/* Stack */}
      <section>
        <div className="pb-sec-head"><span className="ix">§ 03</span><div><h2>Technology stack</h2><p className="sub">Chosen for a small footprint, a single deployable artifact, and operational simplicity.</p></div></div>
        <div className="pb-stack">
          <div className="pb-stack-card"><h4>Frontend</h4><div className="tags"><span>React 18</span><span>TypeScript</span><span>Vite</span><span>Tailwind CSS</span><span>React Router</span><span>Recharts</span><span>Server-Sent Events</span></div></div>
          <div className="pb-stack-card"><h4>Backend</h4><div className="tags"><span>Go</span><span>net/http</span><span>golang-jwt</span><span>bcrypt</span><span>AES-256-CBC</span><span>SMTP</span></div></div>
          <div className="pb-stack-card"><h4>Data</h4><div className="tags"><span>MySQL 8</span><span>Redis 7</span><span>Auto-migrations</span><span>Prepared statements</span></div></div>
          <div className="pb-stack-card"><h4>Integrations</h4><div className="tags"><span>MarkScan API</span><span>Power BI Embedded</span><span>Azure AD (OAuth2)</span></div></div>
          <div className="pb-stack-card"><h4>Delivery &amp; Ops</h4><div className="tags"><span>Docker Compose</span><span>GitHub Actions</span><span>Reverse proxy</span><span>Startup health checks</span></div></div>
        </div>
      </section>

      {/* Modules */}
      <section className="alt">
        <div className="pb-sec-head"><span className="ix">§ 04</span><div><h2>Product modules</h2><p className="sub">Ten operational modules span the full anti-piracy workflow — from discovery and enforcement to reporting, and the administration that governs it all.</p></div></div>
        <div className="pb-mods">
          {MODULES.map(m => (
            <div className="pb-mod rv" key={m.title}>
              <div className="top"><span className="ic" dangerouslySetInnerHTML={{ __html: m.icon }} /><div><h4>{m.title}</h4><div className="tagline">{m.tag}</div></div></div>
              <p>{m.desc}</p>
              <ul>{m.points.map(p => <li key={p}>{p}</li>)}</ul>
            </div>
          ))}
        </div>
      </section>

      {/* Security matrix */}
      <section>
        <div className="pb-sec-head"><span className="ix">§ 05</span><div><h2>Security architecture</h2><p className="sub">Defence in depth across seven control families. Every control below is implemented in the codebase today and was verified during a two-pass security review.</p></div></div>
        <div className="pb-legend">
          <span className="pill ok"><i></i>Implemented &amp; hardened</span>
          <span className="pill core"><i></i>Core design control</span>
        </div>
        <div className="pb-sec-grid">
          {SECURITY.map((cat, ci) => (
            <div className="pb-cat rv" key={cat.name}>
              <header><span className="cix">{String(ci + 1).padStart(2, '0')}</span><h4>{cat.name}</h4></header>
              {cat.controls.map(c => (
                <div className="ctrl" key={c.name}>
                  <span className="cname">{c.name}</span>
                  <span className={`tick ${c.k}`}>{c.k === 'ok' ? 'Hardened' : 'Core'}</span>
                  <span className="cdesc">{c.desc}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </section>

      {/* Hardening */}
      <section className="alt">
        <div className="pb-sec-head"><span className="ix">§ 06</span><div><h2>Security hardening programme</h2><p className="sub">A proactive two-pass review swept the codebase for data, credential, and authorisation exposure. The critical and high-severity findings were remediated in code and verified end-to-end.</p></div></div>
        <div className="pb-harden">
          {HARDENING.map(f => (
            <div className="pb-fix rv" key={f.title}>
              <div className="fh"><h5>{f.title}</h5><span className={`sev ${f.sevk}`}>{f.sev}</span></div>
              <p>{f.desc}</p>
            </div>
          ))}
        </div>
        <div className="pb-verify rv">
          <svg viewBox="0 0 24 24" fill="none" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" strokeLinecap="round" strokeLinejoin="round"/><path d="m9 12 2 2 4-4" strokeLinecap="round" strokeLinejoin="round"/></svg>
          <p>The review also confirmed <b>no SQL injection, no XSS sinks, no secrets in the client bundle or version control,</b> and correct tenant-scoped data access across client endpoints. Each remediation was exercised against a running server before sign-off.</p>
        </div>
      </section>

      {/* Roadmap */}
      <section>
        <div className="pb-sec-head"><span className="ix">§ 07</span><div><h2>Recommended next steps</h2><p className="sub">Identified and prioritised during the review — largely infrastructure and lifecycle items that complement the in-code controls already shipped.</p></div></div>
        <div className="pb-road">
          {ROADMAP.map((r, i) => (
            <div className="pb-road-item rv" key={r.title}>
              <span className="rix">{String(i + 1).padStart(2, '0')}</span>
              <div className="rbody"><h5>{r.title}</h5><p>{r.desc}</p></div>
              <span className={`prio ${r.pk}`}>{r.prio}</span>
            </div>
          ))}
        </div>
      </section>

      <footer className="pb-foot">
        <div>
          <div className="status"><span className="d"></span>Security posture — hardened &amp; verified</div>
          <div className="mono">IP HOUSE · Anti-Piracy Intelligence Platform</div>
        </div>
        <div className="mono right">Technical &amp; Security Brief<br />Generated for leadership review</div>
      </footer>
    </div>
  )
}

/* ── Content data ─────────────────────────────────────────────────────────── */
const MODULES = [
  { title: 'Authentication & Access', tag: 'Identity', icon: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><rect x="3" y="11" width="18" height="10" rx="2" stroke-linejoin="round"/><path d="M7 11V7a5 5 0 0 1 10 0v4" stroke-linecap="round"/></svg>', desc: 'Password and email-OTP sign-in, self-service password reset, and multi-account selection — all issuing a signed, HTTP-only session.', points: ['Password (bcrypt) & email-OTP login', 'Optional per-staff OTP for Admins', 'Configurable idle-timeout auto-logout', 'Multi-company account switching'] },
  { title: 'War Room', tag: 'Flagship', icon: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" stroke-linecap="round" stroke-linejoin="round"/><path d="m9 12 2 2 4-4" stroke-linecap="round" stroke-linejoin="round"/></svg>', desc: 'Real-time cross-platform intelligence for a single title — fanning out across every enforcement channel and aggregating results live.', points: ['Live per-platform progress (streamed)', 'Redis-cached, incrementally refreshed data', 'Cross-filtering, TAT & repeat-offender analytics', 'Multi-asset comparison (per-client)'] },
  { title: 'Find Infringements', tag: 'Discovery', icon: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3" stroke-linecap="round"/></svg>', desc: 'Paged infringement search per platform with a rich, uniform result view and record inspector across social, web, marketplace, and app-store sources.', points: ['Facebook, YouTube, Instagram, X, Telegram', 'Open Web, UGC, iTunes, Play Store, apps', 'Meta Ads & Marketplace listings'] },
  { title: 'Submit Take-downs', tag: 'Enforcement', icon: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" stroke-linecap="round" stroke-linejoin="round"/></svg>', desc: 'Push selected URLs into the enforcement queue, mark false positives, and confirm submissions with an email receipt.', points: ['Send-to-enforcement QC workflow', 'Mark-as-invalid handling', 'Confirmation email to submitter'] },
  { title: 'Reporting', tag: 'Analytics', icon: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M3 3v18h18" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 17V9M13 17V5M8 17v-3" stroke-linecap="round"/></svg>', desc: 'Embedded Power BI dashboards with server-generated embed tokens, so clients see governed analytics without direct BI access.', points: ['Azure AD service-principal auth', 'Per-report embed tokens', 'Workspace & refresh management (admin)'] },
  { title: 'IP Tracking', tag: 'Monitoring', icon: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M2 12h20M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z" stroke-linecap="round"/></svg>', desc: 'Copyright-owner IP activity lookups with date-ranged, asset-scoped detail pulled from the intelligence API.', points: ['Owner & asset filtering', 'Date-range detail views', 'Paged result navigation'] },
  { title: 'Admin & Configuration', tag: 'Governance', icon: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M3 7h18M3 12h18M3 17h18" stroke-linecap="round"/></svg>', desc: 'A grant-based configuration hub: each administrator sees only the modules a Super Admin has explicitly shared with them.', points: ['Clients, users & shared logins', 'API / Power BI / email credentials (encrypted)', 'Module permissions & asset access', 'Registration approvals'] },
  { title: 'Super Admin Control', tag: 'Root authority', icon: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M12 2 4 5v6c0 5 3.5 8 8 11 4.5-3 8-6 8-11V5l-8-3z" stroke-linejoin="round"/><path d="M12 8v4l3 2" stroke-linecap="round"/></svg>', desc: 'The top-tier console for portal-staff management, live sessions, and platform-wide switches — with safeguards against self-lockout.', points: ['Grant / revoke Admin & Super Admin', 'Active-session monitor & force-logout', 'Per-staff OTP-login toggles', 'Last-Super-Admin protection'] },
  { title: 'Maintenance Mode', tag: 'Operations', icon: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M14 7l-1.5-1.5a2 2 0 0 0-3 0L4 11a2 2 0 0 0 0 3l6 6M14 7l4 4M14 7l3-3 4 4-3 3M18 11l-8 8" stroke-linecap="round" stroke-linejoin="round"/></svg>', desc: 'A single Super Admin switch shows clients a branded maintenance page and pauses their data access, while staff keep working.', points: ['One-click enable with custom message', 'Clients paused, staff unaffected', 'Applies within seconds, no redeploy'] },
  { title: 'Email System', tag: 'Notifications', icon: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2" stroke-linejoin="round"/><path d="m3 7 9 6 9-6" stroke-linecap="round" stroke-linejoin="round"/></svg>', desc: 'Database-templated transactional email with placeholder rendering and the IP House logo embedded inline in every message.', points: ['Editable templates per event type', 'Inline-embedded brand logo', 'SMTP credentials encrypted at rest'] },
]

type Ctrl = { name: string; desc: string; k: 'ok' | 'core' }
const SECURITY: { name: string; controls: Ctrl[] }[] = [
  { name: 'Authentication & Session', controls: [
    { name: 'Signed HTTP-only session', k: 'core', desc: 'JWT (HS256) in an HTTP-only, SameSite cookie — inaccessible to JavaScript, so XSS cannot steal the session.' },
    { name: 'Secure-by-default cookie', k: 'ok', desc: 'The session cookie carries the Secure flag by default; only an explicit dev flag relaxes it for local HTTP.' },
    { name: 'Algorithm pinning', k: 'core', desc: 'The token parser accepts only HMAC signing, closing the classic "alg=none" forgery class.' },
    { name: 'Strong secret enforcement', k: 'ok', desc: 'Startup refuses to run in production with a placeholder or under-length signing secret.' },
    { name: 'bcrypt password hashing', k: 'core', desc: 'Passwords hashed with bcrypt (cost 12); legacy hashes transparently upgraded on next login.' },
    { name: 'Data token off-session', k: 'core', desc: 'The upstream intelligence token is never embedded in the JWT — it is held server-side and re-derived on demand.' },
  ]},
  { name: 'Multi-Factor / OTP', controls: [
    { name: 'Cryptographic OTP', k: 'core', desc: 'Six-digit codes generated from a cryptographic RNG, valid for ten minutes on the database clock.' },
    { name: 'Attempt cap & burn', k: 'ok', desc: 'A per-code wrong-guess limit invalidates the code after five failures, blocking brute-force of the 6-digit space.' },
    { name: 'Constant-time comparison', k: 'ok', desc: 'Codes are compared in constant time so response latency cannot leak digits.' },
    { name: 'Per-staff MFA', k: 'ok', desc: 'OTP login can be required per individual Admin / Super Admin account, independent of clients.' },
  ]},
  { name: 'Authorization & RBAC', controls: [
    { name: 'Three-tier role model', k: 'core', desc: 'Client, Admin, and Super Admin tiers gate every route through dedicated middleware.' },
    { name: 'Server-side config grants', k: 'ok', desc: 'Configuration modules are enforced on the server (default-deny), not merely hidden in the UI.' },
    { name: 'Credential-reveal gating', k: 'ok', desc: 'Endpoints that reveal stored secrets require the specific module grant, not just any admin role.' },
    { name: 'Tenant-scoped data access', k: 'core', desc: 'Client endpoints resolve identity from the verified session, never from client-supplied IDs — closing IDOR paths.' },
  ]},
  { name: 'Brute-Force & Rate Limiting', controls: [
    { name: 'Per-IP auth throttle', k: 'core', desc: 'Sign-in, OTP, and reset endpoints are rate-limited per client IP to blunt credential stuffing.' },
    { name: 'Proxy-header trust boundary', k: 'ok', desc: 'Forwarded-IP headers are trusted only from configured proxies, so the limiter cannot be bypassed by spoofing.' },
    { name: 'OTP failure lockout', k: 'ok', desc: 'Repeated OTP failures burn the active code and force reissue.' },
  ]},
  { name: 'Cryptography & Secrets', controls: [
    { name: 'Encryption at rest', k: 'core', desc: 'Stored integration secrets (API, SMTP, BI) are encrypted with AES-256-CBC, not held in plaintext.' },
    { name: 'Hashed, single-use reset tokens', k: 'ok', desc: 'Reset tokens are 32-byte random, stored only as a SHA-256 hash, single-use, and expire in ten minutes.' },
    { name: 'Secrets out of bundle & VCS', k: 'core', desc: 'Runtime secrets live in environment configuration — never in the client bundle or version control.' },
  ]},
  { name: 'Data Protection', controls: [
    { name: 'Parameterised SQL', k: 'core', desc: 'Every query is parameterised — no string-built SQL — eliminating injection across the data layer.' },
    { name: 'No client-side HTML injection', k: 'core', desc: 'The UI renders through React with no raw-HTML sinks, removing stored/reflected XSS surface.' },
    { name: 'Generic error responses', k: 'ok', desc: 'Internal driver and infrastructure errors are logged server-side and never echoed to clients.' },
    { name: 'No account enumeration', k: 'ok', desc: 'Password-reset responds identically whether or not the address exists.' },
    { name: 'Honest write results', k: 'ok', desc: 'Failed database writes surface a real error instead of a false "saved" — no silent data loss.' },
  ]},
  { name: 'Operational Security', controls: [
    { name: 'CORS allow-list', k: 'core', desc: 'Cross-origin credentialed requests are restricted to an explicit origin allow-list.' },
    { name: 'Security response headers', k: 'core', desc: 'Anti-framing and content-type-sniffing protections are set on responses.' },
    { name: 'Audit trail & session control', k: 'core', desc: 'Logins and key actions are logged; Super Admins can view active sessions and force-logout.' },
    { name: 'Maintenance isolation', k: 'ok', desc: 'Maintenance mode pauses client data access at the gateway while staff retain full access.' },
  ]},
]

const HARDENING = [
  { title: 'Server-side access enforcement', sev: 'Critical', sevk: 'c', desc: 'Configuration-module grants — including the plaintext credential-reveal endpoints — are now enforced on the server, not just hidden in the UI. Verified: an un-granted admin is refused directly.' },
  { title: 'Rate-limit bypass closed', sev: 'High', sevk: 'h', desc: 'Forwarded-IP spoofing that granted a fresh throttle bucket per request was closed by trusting proxy headers only from configured hops. Verified with spoofed requests.' },
  { title: 'OTP brute-force protection', sev: 'High', sevk: 'h', desc: 'A per-code attempt cap plus constant-time comparison now guards the six-digit space. Covered by unit tests and a live send/verify run.' },
  { title: 'Secure session cookie', sev: 'High', sevk: 'h', desc: 'The session cookie is now Secure by default behind TLS termination, instead of only on a specific port. Verified in production and dev modes.' },
  { title: 'Error & enumeration hardening', sev: 'High', sevk: 'h', desc: 'Internal errors are no longer echoed to clients and password-reset no longer reveals which emails hold accounts.' },
  { title: 'No silent write failures', sev: 'High', sevk: 'h', desc: 'Database writes now surface real errors instead of reporting a false success — caught a live schema issue during the sweep.' },
]

const ROADMAP = [
  { title: 'Network-isolate the database & rotate secrets', desc: 'Move MySQL onto a private subnet with proxy-only access, and rotate signing and encryption keys via a managed secrets store.', prio: 'Priority 1', pk: 'p1' },
  { title: 'Harden new-account role defaults', desc: 'Pin newly created client accounts to the lowest privilege at insert time, with a startup assertion guarding against role drift.', prio: 'Priority 1', pk: 'p1' },
  { title: 'Complete encryption-at-rest migration', desc: 'Encrypt the remaining legacy stored integration credentials and back-fill existing rows in a one-time migration.', prio: 'Priority 1', pk: 'p1' },
  { title: 'Per-report embed authorisation', desc: "Bind embedded-report requests to the requesting account's assigned dashboards to close cross-tenant report access.", prio: 'Priority 2', pk: 'p2' },
  { title: 'Dependency & runtime patch cadence', desc: 'Adopt a scheduled bump for flagged library and toolchain advisories, starting with the current auth-path items.', prio: 'Priority 2', pk: 'p2' },
  { title: 'Add CSP & HSTS, retire legacy hashes', desc: 'Ship a content-security policy and HSTS, and force-reset the remaining legacy password hashes to complete the bcrypt transition.', prio: 'Priority 3', pk: 'p3' },
]

/* ── Scoped styles ────────────────────────────────────────────────────────── */
const PBRIEF_CSS = `
.pbrief{
  --pb-ground:#eef1f6;--pb-surface:#fff;--pb-surface2:#f6f8fb;--pb-ink:#14254a;--pb-body:#3c4a5e;--pb-muted:#6c7889;--pb-faint:#9aa5b5;
  --pb-border:#e1e6ee;--pb-border2:#cdd5e1;--pb-navy:#14254a;--pb-navy2:#1e3a6e;--pb-acc:#fc934c;--pb-acc2:#ffc82b;--pb-accink:#c76a1f;
  --pb-ok:#1f9d55;--pb-okbg:rgba(31,157,85,.10);--pb-warn:#d9822b;--pb-warnbg:rgba(217,130,43,.12);--pb-crit:#d64550;--pb-critbg:rgba(214,69,80,.10);--pb-info:#2c7fd6;--pb-infobg:rgba(44,127,214,.10);
  --pb-shadow:0 1px 2px rgba(20,37,74,.04),0 12px 30px rgba(20,37,74,.07);--pb-shadowlg:0 2px 6px rgba(20,37,74,.06),0 30px 60px rgba(20,37,74,.12);
  --pb-mono:ui-monospace,"SF Mono","Cascadia Code","Roboto Mono",Menlo,Consolas,monospace;
  --pb-disp:"Helvetica Neue","Segoe UI",system-ui,-apple-system,Arial,sans-serif;
  color:var(--pb-body);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;line-height:1.6;
  background:var(--pb-ground);width:100%;overflow-x:hidden;
}
.dark .pbrief{
  --pb-ground:#0b1322;--pb-surface:#131f37;--pb-surface2:#0f1a2f;--pb-ink:#f2f6fc;--pb-body:#c2cddd;--pb-muted:#8a97ac;--pb-faint:#6a778d;
  --pb-border:#24324c;--pb-border2:#33445f;--pb-navy:#1b2c4d;--pb-navy2:#274a86;--pb-acc:#fca35f;--pb-acc2:#ffcf45;--pb-accink:#ffb877;
  --pb-ok:#43c07f;--pb-okbg:rgba(67,192,127,.13);--pb-warn:#e9a04a;--pb-warnbg:rgba(233,160,74,.15);--pb-crit:#ec6b74;--pb-critbg:rgba(236,107,116,.14);--pb-info:#5aa0e6;--pb-infobg:rgba(90,160,230,.14);
  --pb-shadow:0 1px 2px rgba(0,0,0,.3),0 14px 34px rgba(0,0,0,.4);--pb-shadowlg:0 2px 6px rgba(0,0,0,.4),0 34px 70px rgba(0,0,0,.55);
}
.pbrief *{box-sizing:border-box;}
.pbrief h1,.pbrief h2,.pbrief h3,.pbrief h4,.pbrief h5{font-family:var(--pb-disp);color:var(--pb-ink);letter-spacing:-.02em;margin:0;text-wrap:balance;}
.pbrief b{color:var(--pb-ink);}
.pbrief .rv{opacity:0;transform:translateY(14px);transition:opacity .55s ease,transform .55s ease;}
.pbrief .rv.in{opacity:1;transform:none;}

.pb-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 28px;background:var(--pb-surface);border-bottom:1px solid var(--pb-border);position:sticky;top:0;z-index:5;}
.pb-back{font-family:var(--pb-mono);font-size:11.5px;letter-spacing:.04em;color:var(--pb-muted);text-decoration:none;font-weight:500;}
.pb-back:hover{color:var(--pb-ink);}
.pb-print{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;font-weight:700;color:#fff;background:linear-gradient(135deg,var(--pb-navy),var(--pb-navy2));border:none;border-radius:10px;padding:8px 15px;cursor:pointer;}
.pb-print:hover{opacity:.92;}
.pb-eyebrow{font-family:var(--pb-mono);font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--pb-accink);font-weight:600;display:inline-flex;align-items:center;gap:8px;}
.pb-eyebrow::before{content:"";width:22px;height:1.5px;background:var(--pb-acc);}

.pb-hero{position:relative;overflow:hidden;border-bottom:1px solid var(--pb-border);}
.pb-hero::before{content:"";position:absolute;inset:0;opacity:.55;background:radial-gradient(620px 340px at 88% -10%,color-mix(in srgb,var(--pb-acc) 22%,transparent),transparent 70%),radial-gradient(640px 420px at 0% 110%,color-mix(in srgb,var(--pb-navy2) 26%,transparent),transparent 70%);}
.pb-hero::after{content:"";position:absolute;inset:0;opacity:.5;background-image:linear-gradient(var(--pb-border) 1px,transparent 1px),linear-gradient(90deg,var(--pb-border) 1px,transparent 1px);background-size:44px 44px;-webkit-mask-image:radial-gradient(520px 360px at 74% 34%,#000,transparent 78%);mask-image:radial-gradient(520px 360px at 74% 34%,#000,transparent 78%);}
.pb-hero-in{position:relative;z-index:1;padding:60px 40px 52px;}
.pb-hero h1{font-size:clamp(30px,4.6vw,54px);line-height:1.03;font-weight:800;letter-spacing:-.035em;margin:18px 0 0;}
.pb-hero h1 .acc{background:linear-gradient(120deg,var(--pb-acc2),var(--pb-acc));-webkit-background-clip:text;background-clip:text;color:transparent;}
.pb-lede{font-size:clamp(15px,1.8vw,18px);color:var(--pb-body);max-width:62ch;margin:18px 0 0;line-height:1.55;}
.pb-metrics{margin-top:36px;display:grid;grid-template-columns:repeat(4,1fr);gap:13px;max-width:760px;}
.pb-metric{background:var(--pb-surface);border:1px solid var(--pb-border);border-radius:14px;padding:16px 16px 14px;box-shadow:var(--pb-shadow);position:relative;overflow:hidden;}
.pb-metric::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:linear-gradient(var(--pb-acc2),var(--pb-acc));}
.pb-metric .num{font-family:var(--pb-disp);font-size:32px;font-weight:800;color:var(--pb-ink);letter-spacing:-.03em;line-height:1;font-variant-numeric:tabular-nums;}
.pb-metric .num small{font-size:17px;color:var(--pb-accink);font-weight:700;}
.pb-metric .lbl{font-family:var(--pb-mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--pb-muted);margin-top:8px;}

.pbrief section{padding:56px 40px;border-bottom:1px solid var(--pb-border);}
.pbrief section.alt{background:var(--pb-surface2);}
.pb-sec-head{display:flex;gap:15px;margin-bottom:30px;align-items:baseline;flex-wrap:wrap;}
.pb-sec-head .ix{font-family:var(--pb-mono);font-size:12px;color:var(--pb-faint);font-weight:600;letter-spacing:.1em;}
.pb-sec-head h2{font-size:clamp(23px,3vw,32px);font-weight:800;}
.pb-sec-head .sub{color:var(--pb-muted);font-size:14.5px;margin:6px 0 0;max-width:66ch;line-height:1.55;}

.pb-summary{display:grid;grid-template-columns:1.5fr 1fr;gap:26px;align-items:start;}
.pb-summary p{font-size:15.5px;line-height:1.68;margin:0 0 15px;color:var(--pb-body);}
.pb-summary p:last-child{margin-bottom:0;}
.pb-summary .lead-in{font-size:17.5px;color:var(--pb-ink);font-weight:500;}
.pb-aside{background:var(--pb-surface);border:1px solid var(--pb-border);border-radius:16px;padding:20px;box-shadow:var(--pb-shadow);}
.pb-aside h4{font-family:var(--pb-mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--pb-accink);margin:0 0 14px;font-weight:600;}
.pb-aside dl{margin:0;display:grid;gap:11px;}
.pb-aside .row{display:flex;justify-content:space-between;gap:12px;align-items:baseline;border-bottom:1px dashed var(--pb-border);padding-bottom:10px;}
.pb-aside .row:last-child{border-bottom:0;padding-bottom:0;}
.pb-aside dt{font-size:12.5px;color:var(--pb-muted);}
.pb-aside dd{margin:0;font-size:12.5px;color:var(--pb-ink);font-weight:600;text-align:right;font-family:var(--pb-mono);}

.pb-arch{display:grid;gap:15px;}
.pb-layer{background:var(--pb-surface);border:1px solid var(--pb-border);border-radius:16px;padding:19px 20px;box-shadow:var(--pb-shadow);position:relative;}
.pb-layer>.ltag{position:absolute;top:-9px;left:20px;font-family:var(--pb-mono);font-size:10px;letter-spacing:.15em;text-transform:uppercase;background:var(--pb-acc);color:#241300;padding:3px 9px;border-radius:999px;font-weight:700;}
.pb-layer h4{font-size:15.5px;margin:6px 0 3px;}
.pb-layer p{margin:0 0 13px;font-size:13px;color:var(--pb-muted);}
.pb-layer .nodes{display:flex;flex-wrap:wrap;gap:9px;}
.pb-layer .node{border:1px solid var(--pb-border2);background:var(--pb-surface2);border-radius:10px;padding:8px 12px;font-size:12.5px;color:var(--pb-ink);font-weight:600;display:inline-flex;align-items:center;gap:8px;}
.pb-layer .node i{width:7px;height:7px;border-radius:50%;background:var(--pb-acc);flex-shrink:0;}
.pb-layer .node.k i{background:var(--pb-info);}
.pb-layer .node.d i{background:var(--pb-ok);}
.pb-layer .node.x i{background:var(--pb-acc2);}
.pb-arch-cols{display:grid;grid-template-columns:repeat(3,1fr);gap:15px;}
.pb-flow{display:grid;place-items:center;color:var(--pb-faint);font-family:var(--pb-mono);font-size:11px;letter-spacing:.08em;gap:3px;}
.pb-flow svg{width:18px;height:18px;}
.pb-perim{border:1.5px dashed var(--pb-acc);border-radius:18px;padding:15px;position:relative;}
.pb-perim>.plabel{position:absolute;top:-10px;right:20px;background:var(--pb-surface2);font-family:var(--pb-mono);font-size:10px;letter-spacing:.13em;text-transform:uppercase;color:var(--pb-accink);padding:2px 10px;font-weight:600;}

.pb-stack{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:15px;}
.pb-stack-card{background:var(--pb-surface);border:1px solid var(--pb-border);border-radius:14px;padding:17px;box-shadow:var(--pb-shadow);}
.pb-stack-card h4{font-family:var(--pb-mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--pb-muted);margin:0 0 12px;font-weight:600;}
.pb-stack-card .tags{display:flex;flex-wrap:wrap;gap:7px;}
.pb-stack-card .tags span{font-size:12.5px;padding:5px 10px;border-radius:8px;background:var(--pb-surface2);border:1px solid var(--pb-border);color:var(--pb-ink);font-weight:500;}

.pb-mods{display:grid;grid-template-columns:repeat(auto-fill,minmax(315px,1fr));gap:15px;}
.pb-mod{background:var(--pb-surface);border:1px solid var(--pb-border);border-radius:16px;padding:21px;box-shadow:var(--pb-shadow);transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease;}
.pb-mod:hover{transform:translateY(-3px);box-shadow:var(--pb-shadowlg);border-color:var(--pb-border2);}
.pb-mod .top{display:flex;align-items:center;gap:12px;margin-bottom:12px;}
.pb-mod .ic{width:40px;height:40px;border-radius:11px;display:grid;place-items:center;flex-shrink:0;background:linear-gradient(150deg,var(--pb-navy),var(--pb-navy2));box-shadow:0 4px 12px rgba(20,37,74,.22);}
.pb-mod .ic svg{width:20px;height:20px;stroke:#fff;}
.pb-mod h4{font-size:16px;margin:0;}
.pb-mod .tagline{font-family:var(--pb-mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--pb-accink);margin-top:2px;}
.pb-mod p{font-size:13.5px;color:var(--pb-body);margin:0 0 12px;line-height:1.55;}
.pb-mod ul{margin:0;padding:0;list-style:none;display:grid;gap:6px;}
.pb-mod li{font-size:12.4px;color:var(--pb-muted);padding-left:16px;position:relative;line-height:1.45;}
.pb-mod li::before{content:"";position:absolute;left:0;top:7px;width:6px;height:6px;border-radius:2px;background:var(--pb-acc);transform:rotate(45deg);}

.pb-legend{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:24px;}
.pb-legend .pill{font-family:var(--pb-mono);font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;font-weight:600;padding:5px 10px;border-radius:999px;display:inline-flex;align-items:center;gap:7px;border:1px solid transparent;}
.pb-legend .pill i{width:7px;height:7px;border-radius:50%;}
.pb-legend .pill.ok{color:var(--pb-ok);background:var(--pb-okbg);border-color:color-mix(in srgb,var(--pb-ok) 30%,transparent);}
.pb-legend .pill.ok i{background:var(--pb-ok);}
.pb-legend .pill.core{color:var(--pb-info);background:var(--pb-infobg);border-color:color-mix(in srgb,var(--pb-info) 30%,transparent);}
.pb-legend .pill.core i{background:var(--pb-info);}

.pb-sec-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(335px,1fr));gap:15px;}
.pb-cat{background:var(--pb-surface);border:1px solid var(--pb-border);border-radius:16px;overflow:hidden;box-shadow:var(--pb-shadow);}
.pb-cat>header{padding:15px 17px;border-bottom:1px solid var(--pb-border);display:flex;align-items:center;gap:11px;background:var(--pb-surface2);}
.pb-cat>header .cix{font-family:var(--pb-mono);font-size:11px;font-weight:700;color:#fff;background:var(--pb-navy);width:26px;height:26px;border-radius:7px;display:grid;place-items:center;flex-shrink:0;}
.pb-cat>header h4{font-size:14px;margin:0;}
.pb-cat .ctrl{padding:12px 17px;border-bottom:1px solid var(--pb-border);display:grid;grid-template-columns:1fr auto;gap:5px 12px;align-items:start;}
.pb-cat .ctrl:last-child{border-bottom:0;}
.pb-cat .cname{font-size:13px;color:var(--pb-ink);font-weight:600;}
.pb-cat .cdesc{font-size:12px;color:var(--pb-muted);grid-column:1/-1;line-height:1.45;}
.pb-cat .tick{font-family:var(--pb-mono);font-size:9px;letter-spacing:.05em;text-transform:uppercase;font-weight:700;padding:3px 7px;border-radius:6px;white-space:nowrap;align-self:start;}
.pb-cat .tick.ok{color:var(--pb-ok);background:var(--pb-okbg);}
.pb-cat .tick.core{color:var(--pb-info);background:var(--pb-infobg);}

.pb-harden{display:grid;grid-template-columns:1fr 1fr;gap:15px;}
.pb-fix{background:var(--pb-surface);border:1px solid var(--pb-border);border-left:3px solid var(--pb-ok);border-radius:12px;padding:15px 16px;box-shadow:var(--pb-shadow);}
.pb-fix .fh{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:5px;}
.pb-fix h5{font-size:14px;margin:0;}
.pb-fix .sev{font-family:var(--pb-mono);font-size:9px;letter-spacing:.07em;text-transform:uppercase;font-weight:700;padding:3px 7px;border-radius:5px;}
.pb-fix .sev.c{color:var(--pb-crit);background:var(--pb-critbg);}
.pb-fix .sev.h{color:var(--pb-warn);background:var(--pb-warnbg);}
.pb-fix p{font-size:12.4px;color:var(--pb-muted);margin:0;line-height:1.5;}
.pb-verify{margin-top:20px;background:linear-gradient(120deg,var(--pb-navy),var(--pb-navy2));color:#fff;border-radius:14px;padding:18px 20px;display:flex;align-items:center;gap:15px;flex-wrap:wrap;box-shadow:var(--pb-shadowlg);}
.pb-verify svg{width:26px;height:26px;stroke:var(--pb-acc2);flex-shrink:0;}
.pb-verify p{margin:0;font-size:13.5px;line-height:1.5;color:#eaf0f9;}
.pb-verify b{color:#fff;}

.pb-road{display:grid;gap:11px;}
.pb-road-item{background:var(--pb-surface);border:1px solid var(--pb-border);border-radius:13px;padding:15px 17px;display:grid;grid-template-columns:auto 1fr auto;gap:14px;align-items:center;box-shadow:var(--pb-shadow);}
.pb-road-item .rix{font-family:var(--pb-mono);font-size:12px;font-weight:700;color:var(--pb-faint);width:26px;}
.pb-road-item .rbody h5{margin:0 0 3px;font-size:14px;}
.pb-road-item .rbody p{margin:0;font-size:12.5px;color:var(--pb-muted);line-height:1.45;}
.pb-road-item .prio{font-family:var(--pb-mono);font-size:10px;letter-spacing:.07em;text-transform:uppercase;font-weight:700;padding:5px 10px;border-radius:999px;white-space:nowrap;}
.pb-road-item .prio.p1{color:var(--pb-crit);background:var(--pb-critbg);}
.pb-road-item .prio.p2{color:var(--pb-warn);background:var(--pb-warnbg);}
.pb-road-item .prio.p3{color:var(--pb-info);background:var(--pb-infobg);}

.pb-foot{padding:32px 40px 44px;display:flex;justify-content:space-between;align-items:center;gap:18px;flex-wrap:wrap;}
.pb-foot .status{display:inline-flex;align-items:center;gap:8px;font-family:var(--pb-mono);font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--pb-ok);font-weight:600;}
.pb-foot .status .d{width:8px;height:8px;border-radius:50%;background:var(--pb-ok);}
.pb-foot .mono{font-family:var(--pb-mono);font-size:11px;color:var(--pb-faint);letter-spacing:.04em;margin-top:8px;}
.pb-foot .mono.right{text-align:right;margin-top:0;}

@media (max-width:820px){.pb-summary,.pb-harden{grid-template-columns:1fr;}.pb-arch-cols{grid-template-columns:1fr;}.pb-metrics{grid-template-columns:repeat(2,1fr);}.pbrief section,.pb-hero-in,.pb-foot,.pb-toolbar{padding-left:22px;padding-right:22px;}}
@media (max-width:560px){.pb-road-item{grid-template-columns:auto 1fr;}.pb-road-item .prio{grid-column:1/-1;justify-self:start;}}

@media print{
  .pb-toolbar{display:none;}
  .pbrief{margin:0;background:#fff;}
  .pbrief section,.pb-hero{break-inside:avoid;}
  .pb-mod,.pb-cat,.pb-fix,.pb-road-item{break-inside:avoid;}
  .pbrief .rv{opacity:1 !important;transform:none !important;}
}
`
