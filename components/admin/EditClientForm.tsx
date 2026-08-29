'use client'

import { useEffect, useState } from 'react'
import SearchableSelect from '@/components/ui/SearchableSelect'
import { useRouter } from '@/lib/router'
import { Link } from 'react-router-dom'

interface Client {
  userId: number; name: string; email: string
  deleted: number; api_user_name: string; api_password: string
  /** The analytics client this company's Reports read. */
  ClientID_MS3?: string | null
  /** Whether a MarkScan password is stored — presence only; the value is never
      sent to the browser. Without it an empty password box is ambiguous: it
      looks identical whether one is stored and being kept, or none was ever
      set. */
  has_api_password?: boolean | number
}

/** Canonical 36-character UUID, 8-4-4-4-12. Mirrors the server's check so a
    mistyped id is caught before a round trip, not instead of one. */
const UUID36 = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export default function EditClientForm({ client }: { client: Client }) {
  const router = useRouter()
  const [form, setForm] = useState({
    name:        client.name,
    email:       client.email,
    apiUserName: client.api_user_name || '',
    apiPassword: '',
    deleted:     client.deleted,
    clientIdMs3: client.ClientID_MS3 || '',
  })
  const [error,   setError]   = useState('')
  const [saving,  setSaving]  = useState(false)

  /* Session timeout, kept in its own state rather than folded into `form`.

     It is a different table reached by a different endpoint, and `form` is
     posted wholesale to /api/admin/clients — anything added to it would be sent
     somewhere that has no column for it. Saved by the same button, though: see
     handleSubmit. */
  /* What is already on file, as opposed to what is being typed.

     `hasStoredPassword` is fixed at mount rather than recomputed: it describes
     the row as it was loaded, and the box below is about whether to REPLACE
     that. It stops being the truth the moment a save succeeds, and a save
     navigates away. */
  const hasStoredPassword = client.has_api_password === true || Number(client.has_api_password) === 1
  const hasStoredUsername = !!(client.api_user_name || '').trim()

  const [idle, setIdle] = useState({ minutes: 30, active: false })
  const [idleLoaded, setIdleLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/admin/idle-timeout?userId=${client.userId}`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (cancelled) return
        const row = (d?.settings || [])[0]
        if (row) {
          setIdle({
            minutes: Number(row.idle_minutes) || 30,
            active:  Number(row.is_active) === 1,
          })
        }
        setIdleLoaded(true)
      })
      /* Left at the default and marked unloaded, so the section can say it
         could not read the current value rather than presenting 30 minutes as
         if that were the stored answer — and then writing it on Save. */
      .catch(() => { if (!cancelled) setIdleLoaded(false) })
    return () => { cancelled = true }
  }, [client.userId])

  function handle(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    const val = e.target.type === 'number' ? Number(e.target.value) : e.target.value
    setForm(f => ({ ...f, [e.target.name]: val }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault(); setError('')
    // Caught here as well as on the server: a wrong id does not fail loudly, it
    // quietly points this company's report at nothing — or at somebody else.
    const cid = form.clientIdMs3.trim().replace(/^[{"']|[}"']$/g, '')
    if (cid && !UUID36.test(cid)) {
      setError('Reporting Client ID must be a 36-character UUID, e.g. 3fa85f64-5717-4562-b3fc-2c963f66afa6')
      return
    }
    if (idle.minutes < 1 || idle.minutes > 480) {
      setError('Idle timeout must be between 1 and 480 minutes.')
      return
    }
    setSaving(true)
    try {
      const payload: any = { userId: client.userId, ...form, clientIdMs3: cid }
      if (!form.apiPassword) delete payload.apiPassword
      const res  = await fetch('/api/admin/clients', {
        credentials: 'include',
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      })
      const data = await res.json()
      if (!data.success) { setError(data.error || 'Failed to save'); return }

      /* Two writes behind one button, and the second is only attempted once
         the first has succeeded — the company is the thing being edited, and a
         timeout saved against a company whose own update failed would be a
         setting for a state the reader never got.

         Only when it was read successfully. Posting an unread section would
         write the placeholder 30 over whatever is actually stored. */
      if (idleLoaded) {
        const idleRes = await fetch('/api/admin/idle-timeout', {
          credentials: 'include',
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            userId: client.userId,
            idleMinutes: idle.minutes,
            isActive: idle.active ? 1 : 0,
          }),
        })
        const idleData = await idleRes.json().catch(() => ({}))
        if (!idleData?.success) {
          // Named specifically: the rest of the form HAS been saved, and
          // "Failed to save" would send somebody back to re-enter all of it.
          setError('The client was saved, but the session timeout could not be. Try that part again.')
          return
        }
      }
      router.push('/admin/clients')
    } catch { setError('Unexpected error') }
    finally { setSaving(false) }
  }

  return (
    <>
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-5 py-3 text-sm mb-4">{error}</div>
      )}

      {/* THREE SECTIONS ACROSS, NOT ONE COLUMN DOWN.

          The five groups this form holds answer three separate questions —
          who the client is, where their data comes from, and how their people's
          sessions behave — and stacked in a single narrow card they read as one
          long list of unrelated fields, with Session Timeout a scroll away from
          the name it belongs to. Side by side, each column is a subject, and the
          page is legible without scrolling at all.

          Every section names itself AND says what it governs: a heading like
          "Reporting" is only meaningful to somebody who already knows what it
          does, which is not the person who needs it. */}
      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

          <Section title="Company"
            hint="Who this client is, and whether the portal treats the account as live.">
            <Field label="Full Name *">
              <input autoComplete="off" name="name" type="text" value={form.name} onChange={handle} required
                className={INPUT} />
            </Field>
            <Field label="Email Address *">
              <input autoComplete="off" name="email" type="email" value={form.email} onChange={handle} required
                className={INPUT} />
            </Field>
            <Field label="Status">
              {/* The house picker. A native <select> has its list drawn by the
                  OPERATING SYSTEM — square corners, the system blue highlight,
                  the system font — which is what the rest of this form is not.
                  `clearable={false}` because there is no third state: a company
                  is active or it is not. */}
              <SearchableSelect
                options={[
                  { key: '0', label: 'Active' },
                  { key: '1', label: 'Inactive (soft-deleted)' },
                ]}
                value={String(form.deleted)}
                onChange={v => setForm(f => ({ ...f, deleted: Number(v) }))}
                clearable={false} />
              <p className="text-xs text-brand-muted mt-1.5 leading-relaxed">
                Inactive hides the company and bars its logins. Nothing is deleted.
              </p>
            </Field>
          </Section>

          {/* The two halves of "where the numbers come from", together because
              that is the question, even though they answer different ends of
              it: the credentials say how we FETCH this client's data from
              MarkScan, the id says which client the analytics warehouse knows
              them as. */}
          <Section title="Data sources"
            hint="Where this client's figures come from — the MarkScan account we fetch with, and the warehouse client their Reports read.">
            {/* Whether this company can reach MarkScan at all, said before the
                two fields rather than left to be inferred from them — a filled
                username with no password reads as configured and is not. */}
            {hasStoredUsername && hasStoredPassword ? (
              <p className="flex items-start gap-2 text-xs text-emerald-700 bg-emerald-50
                border border-emerald-200 rounded-xl px-3 py-2 leading-relaxed">
                <span aria-hidden>✓</span>
                <span>
                  <strong>MarkScan credentials are set.</strong> Leave both fields as they are to
                  keep them; type a new password only if you are replacing it.
                </span>
              </p>
            ) : (
              <p className="flex items-start gap-2 text-xs text-amber-800 bg-amber-50
                border border-amber-200 rounded-xl px-3 py-2 leading-relaxed">
                <span aria-hidden>!</span>
                <span>
                  <strong>
                    {!hasStoredUsername && !hasStoredPassword
                      ? 'No MarkScan credentials are set.'
                      : !hasStoredPassword
                        ? 'A username is set but no password is.'
                        : 'A password is set but no username is.'}
                  </strong>{' '}
                  This company&rsquo;s data pages stay empty until both are filled in.
                </span>
              </p>
            )}

            <Field label={<>API Username</>}>
              <input autoComplete="off" name="apiUserName" type="text" value={form.apiUserName} onChange={handle}
                placeholder={hasStoredUsername ? undefined : 'Not set'}
                className={INPUT} />
            </Field>

            <Field label={
              <span className="flex items-center gap-2 flex-wrap">
                API Password
                {/* The state of the STORED value, on the label — the box itself
                    is empty in both cases and cannot show it. */}
                {hasStoredPassword ? (
                  <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-md
                    bg-emerald-50 text-emerald-700 border border-emerald-200">
                    Stored
                  </span>
                ) : (
                  <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-md
                    bg-amber-50 text-amber-800 border border-amber-200">
                    Not set
                  </span>
                )}
              </span>
            }>
              <input autoComplete="off" name="apiPassword" type="password" value={form.apiPassword} onChange={handle}
                placeholder={hasStoredPassword
                  ? 'Leave blank to keep the stored password'
                  : 'Enter a password'}
                className={INPUT} />
              <p className="text-xs text-brand-muted mt-1.5 leading-relaxed">
                {hasStoredPassword
                  ? 'The stored password is never shown. Type here only to replace it.'
                  : 'No password is stored for this company yet.'}
              </p>
            </Field>
            <Field label={<>Reporting Client ID <span className="text-xs font-normal text-brand-muted">(ClientID_MS3)</span></>}>
              <input autoComplete="off" name="clientIdMs3" type="text" value={form.clientIdMs3}
                onChange={handle} spellCheck={false}
                placeholder="3fa85f64-5717-4562-b3fc-2c963f66afa6"
                className={`${INPUT} font-mono`} />
              <p className="text-xs text-brand-muted mt-1.5 leading-relaxed">
                The 36-character analytics client id this company&apos;s Reports read. Leave blank and
                its logins are told the report is not set up yet — they are never shown an empty one,
                which would read as &ldquo;no infringements found&rdquo;.
              </p>
            </Field>
          </Section>

          <Section title="Session timeout"
            hint="How long this client's people may sit idle before the portal signs them out.">
            <label className="flex items-start gap-3 cursor-pointer select-none">
              <button type="button" role="switch" aria-checked={idle.active}
                onClick={() => setIdle(v => ({ ...v, active: !v.active }))}
                className={`relative inline-flex items-center h-6 w-11 rounded-full transition-colors
                  flex-shrink-0 mt-0.5 ${idle.active ? 'bg-emerald-500' : 'bg-gray-200'}`}>
                <span className={`inline-block w-[18px] h-[18px] bg-white rounded-full shadow transform
                  transition-transform ${idle.active ? 'translate-x-[24px]' : 'translate-x-[3px]'}`} />
              </button>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-gray-700">Auto-logout on inactivity</span>
                <span className="block text-xs text-brand-muted mt-0.5">
                  {idle.active
                    ? `Signed out after ${idle.minutes} minute${idle.minutes === 1 ? '' : 's'} of inactivity.`
                    : 'Off — this company follows the portal-wide default.'}
                </span>
              </span>
            </label>

            {/* Reachable while it is off: an admin sets the period and THEN
                turns it on, and a disabled field makes that order impossible. */}
            <div className={idle.active ? '' : 'opacity-60'}>
              <Field label="Idle timeout (minutes)">
                <input type="number" min={1} max={480} value={idle.minutes}
                  onChange={e => setIdle(v => ({ ...v, minutes: Number(e.target.value) }))}
                  className={INPUT} />
                <div className="flex flex-wrap gap-2 mt-2">
                  {[15, 30, 60, 120].map(m => (
                    <button key={m} type="button" onClick={() => setIdle(v => ({ ...v, minutes: m }))}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                        idle.minutes === m
                          ? 'text-white border-transparent'
                          : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}
                      style={idle.minutes === m ? { background: '#14254A' } : undefined}>
                      {m < 60 ? `${m}m` : `${m / 60}h`}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-brand-muted mt-1.5">1–480 minutes.</p>
              </Field>
            </div>

            {!idleLoaded && (
              <p className="text-xs text-amber-700">
                The current session timeout could not be read, so it is left untouched when you save.
              </p>
            )}
          </Section>
        </div>

        {/* One bar for the whole form, below all three: the sections are three
            subjects but one save, and a button per column would suggest they
            commit separately. */}
        <div className="flex justify-end gap-3">
          <Link to="/admin/clients" className="px-5 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50">
            Cancel
          </Link>
          <button type="submit" disabled={saving}
            className="px-7 py-2.5 rounded-xl font-semibold text-white text-sm disabled:opacity-60"
            style={{ background: '#14254A' }}>
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </form>
    </>
  )
}

const INPUT = 'w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm ' +
  'focus:outline-none focus:ring-2 focus:ring-blue-500'

/** A column of the form: what it is called, and what it decides. */
function Section({ title, hint, children }: {
  title: string; hint: string; children: React.ReactNode
}) {
  return (
    <section className="bg-white rounded-2xl shadow-card border border-gray-100 p-6 flex flex-col">
      <h2 className="font-bold text-[#14254A] text-[15px]">{title}</h2>
      <p className="text-xs text-brand-muted mt-1 mb-5 leading-relaxed">{hint}</p>
      <div className="space-y-4">{children}</div>
    </section>
  )
}

function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      {children}
    </div>
  )
}
