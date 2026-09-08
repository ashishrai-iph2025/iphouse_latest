'use client'

/*
 * Who may open the Asset Register.
 *
 * ── Not the same screen as Asset Based Access ────────────────────────────────
 *
 * /admin/asset-access answers WHICH assets a login sees in its reports. This one
 * answers whether they get the register screen on their profile and may raise
 * protection requests at all. Two questions, two grants, two screens — the note
 * at the top of the page says so, because the names are close enough that an
 * operator could reasonably open the wrong one.
 *
 * ── The shape of the screen ──────────────────────────────────────────────────
 *
 * Client first, then its people. That is how the question actually arrives —
 * "give Netflix's team the register" — and it makes the multi-select meaningful:
 * ticking three of a client's five users is one action, not three.
 *
 * Default deny, so an empty table means nobody has it, which is the state this
 * starts in and the one it should be easy to read.
 */

import { useEffect, useMemo, useState } from 'react'
import PageLoader from '@/components/ui/PageLoader'

type UserRow = {
  userId: number
  clientName: string
  clientEmail: string | null
  loginId: number
  personName: string
  username: string
  enabled: number
  granted_by: string | null
}

export default function AssetRegisterAccessClient() {
  const [users, setUsers] = useState<UserRow[] | null>(null)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const [clientQ, setClientQ] = useState('')
  const [openClient, setOpenClient] = useState<number | null>(null)
  /* The selection is per LOGIN and spans clients, so an operator can open one
     client, tick three people, open another and tick two more, then apply once. */
  const [picked, setPicked] = useState<Set<number>>(new Set())

  async function load() {
    try {
      const r = await fetch('/api/admin/asset-register', { credentials: 'include' })
      const d = await r.json()
      if (d?.success !== true) throw new Error(d?.error || 'Could not load accounts')
      setUsers(d.users || [])
      setErr('')
    } catch (e: any) {
      setErr(e?.message || 'Could not load accounts')
      setUsers([])
    }
  }
  useEffect(() => { load() }, [])

  const clients = useMemo(() => {
    const m = new Map<number, { userId: number; name: string; email: string; users: UserRow[] }>()
    for (const u of users || []) {
      let e = m.get(u.userId)
      if (!e) {
        e = { userId: u.userId, name: u.clientName || '(unnamed client)', email: u.clientEmail || '', users: [] }
        m.set(u.userId, e)
      }
      e.users.push(u)
    }
    const needle = clientQ.trim().toLowerCase()
    return Array.from(m.values())
      .filter(c => !needle || c.name.toLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [users, clientQ])

  const enabledTotal = (users || []).filter(u => u.enabled === 1).length

  function toggle(loginId: number) {
    setPicked(cur => {
      const next = new Set(cur)
      if (next.has(loginId)) next.delete(loginId); else next.add(loginId)
      return next
    })
  }

  async function apply(enabled: boolean) {
    if (picked.size === 0) return
    setBusy(true); setMsg(''); setErr('')
    try {
      const r = await fetch('/api/admin/asset-register', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginIds: Array.from(picked), enabled }),
      })
      const d = await r.json()
      if (d?.success !== true) throw new Error(d?.error || 'The change could not be saved')
      setMsg((enabled ? 'Enabled' : 'Disabled') + ' for ' + d.changed + ' account' + (d.changed === 1 ? '' : 's'))
      setPicked(new Set())
      await load()
    } catch (e: any) {
      setErr(e?.message || 'The change could not be saved')
    } finally {
      setBusy(false)
    }
  }

  if (users === null) return <PageLoader label="Loading accounts" />

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-gray-100 dark:border-white/10
        bg-white dark:bg-[#1a2d55] p-5">
        <h1 className="text-lg font-extrabold text-[#14254A] dark:text-white">Asset Register Access</h1>
        <p className="text-[13px] text-gray-500 dark:text-white/55 mt-1.5 leading-relaxed max-w-3xl">
          Who may open the <b className="text-[#14254A] dark:text-white">Asset Register</b> on their
          profile — the full title list for their company, with every field the asset API returns —
          and raise a request to start or stop protection on a title.
          {' '}A request sends an email to the client contact and to the person who asked; it does
          not change protection by itself.
        </p>
        <p className="text-[12px] text-gray-400 dark:text-white/40 mt-2.5 max-w-3xl">
          Not to be confused with <b>Asset Based Access</b>, which controls <i>which</i> assets a
          login sees in its reports. This page controls whether they get the register at all.
        </p>
        <p className="text-[12px] mt-3">
          <b className="text-[#14254A] dark:text-white">{enabledTotal}</b>
          <span className="text-gray-400 dark:text-white/40"> account{enabledTotal === 1 ? '' : 's'} currently enabled</span>
        </p>
      </div>

      {err && (
        <div className="rounded-xl border border-red-200 dark:border-red-400/25 bg-red-50
          dark:bg-red-500/10 px-4 py-2.5 text-[13px] text-red-700 dark:text-red-300">{err}</div>
      )}
      {msg && (
        <div className="rounded-xl border border-emerald-200 dark:border-emerald-400/25 bg-emerald-50
          dark:bg-emerald-500/10 px-4 py-2.5 text-[13px] text-emerald-700 dark:text-emerald-300">{msg}</div>
      )}

      {/* The action bar is STICKY, because the selection can span several
          expanded clients and the buttons must not scroll away from it. */}
      <div className="sticky top-2 z-10 flex flex-wrap items-center gap-2 rounded-2xl
        border border-gray-100 dark:border-white/10 bg-white dark:bg-[#1a2d55] px-4 py-3">
        <input value={clientQ} onChange={e => setClientQ(e.target.value)} placeholder="Search clients…"
          className="h-9 w-[220px] rounded-lg border border-gray-200 dark:border-white/15
            bg-transparent px-3 text-[13px] text-[#14254A] dark:text-white
            placeholder:text-gray-400 outline-none focus:border-[#FC934C]" />
        <span className="text-[12.5px] text-gray-400 dark:text-white/40">
          {picked.size} selected
        </span>
        <span className="ml-auto flex items-center gap-2">
          <button onClick={() => setPicked(new Set())} disabled={picked.size === 0 || busy}
            className="px-3 py-2 rounded-lg text-[12.5px] font-bold text-gray-500 dark:text-white/55
              hover:bg-gray-50 dark:hover:bg-white/5 disabled:opacity-40">Clear</button>
          <button onClick={() => apply(false)} disabled={picked.size === 0 || busy}
            className="px-3.5 py-2 rounded-lg text-[12.5px] font-bold border border-gray-200
              dark:border-white/15 text-[#14254A] dark:text-white hover:border-red-300
              hover:text-red-600 disabled:opacity-40">Disable</button>
          <button onClick={() => apply(true)} disabled={picked.size === 0 || busy}
            className="px-3.5 py-2 rounded-lg text-[12.5px] font-bold text-white bg-[#14254A]
              hover:opacity-90 disabled:opacity-40">
            {busy ? 'Saving…' : 'Enable'}
          </button>
        </span>
      </div>

      {clients.length === 0 && (
        <div className="rounded-2xl border border-gray-100 dark:border-white/10
          bg-white dark:bg-[#1a2d55] px-5 py-12 text-center text-gray-400 dark:text-white/40">
          No client accounts match that search.
        </div>
      )}

      {clients.map(c => {
        const on = c.users.filter(u => u.enabled === 1).length
        const isOpen = openClient === c.userId
        const allPicked = c.users.length > 0 && c.users.every(u => picked.has(u.loginId))
        return (
          <div key={c.userId} className="rounded-2xl border border-gray-100 dark:border-white/10
            bg-white dark:bg-[#1a2d55] overflow-hidden">
            <button onClick={() => setOpenClient(isOpen ? null : c.userId)}
              className="w-full flex items-center gap-3 px-5 py-3.5 text-left
                hover:bg-gray-50/70 dark:hover:bg-white/5 transition-colors">
              <span className="text-gray-400 dark:text-white/30 text-[11px] w-3">{isOpen ? '▾' : '▸'}</span>
              <span className="min-w-0 flex-1">
                <span className="block font-bold text-[14px] text-[#14254A] dark:text-white truncate">
                  {c.name}
                </span>
                <span className="block text-[11.5px] text-gray-400 dark:text-white/40 truncate">
                  {c.users.length} login{c.users.length === 1 ? '' : 's'}
                  {/* The client's address, shown because it is where half of
                      every request from this company will be sent. A blank one
                      is worth seeing BEFORE the grant is made, not after a
                      request goes nowhere. */}
                  {c.email
                    ? <> · {c.email}</>
                    : <span className="text-amber-600 dark:text-amber-400"> · no email on the client record</span>}
                </span>
              </span>
              <span className={`text-[10px] font-extrabold uppercase tracking-wider px-2 py-1 rounded ${
                on > 0
                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
                  : 'bg-gray-100 text-gray-400 dark:bg-white/10 dark:text-white/40'}`}>
                {on} of {c.users.length} enabled
              </span>
            </button>

            {isOpen && (
              <div className="border-t border-gray-100 dark:border-white/10">
                <div className="px-5 py-2 border-b border-gray-50 dark:border-white/[0.06]">
                  <label className="flex items-center gap-2 text-[12px] font-bold
                    text-gray-500 dark:text-white/55 cursor-pointer">
                    <input type="checkbox" checked={allPicked}
                      onChange={() => setPicked(cur => {
                        const next = new Set(cur)
                        if (allPicked) c.users.forEach(u => next.delete(u.loginId))
                        else c.users.forEach(u => next.add(u.loginId))
                        return next
                      })} />
                    Select every login for {c.name}
                  </label>
                </div>
                {c.users.map(u => (
                  <label key={u.loginId}
                    className="flex items-center gap-3 px-5 py-2.5 border-b border-gray-50
                      dark:border-white/[0.05] hover:bg-[#FC934C]/[0.05] cursor-pointer">
                    <input type="checkbox" checked={picked.has(u.loginId)}
                      onChange={() => toggle(u.loginId)} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-bold text-[#14254A] dark:text-white truncate">
                        {u.personName || u.username}
                      </span>
                      <span className="block text-[11px] text-gray-400 dark:text-white/40 truncate">
                        {u.username}
                        {u.enabled === 1 && u.granted_by ? <> · granted by {u.granted_by}</> : null}
                      </span>
                    </span>
                    <span className={`text-[10px] font-extrabold uppercase tracking-wider px-2 py-1 rounded ${
                      u.enabled === 1
                        ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
                        : 'bg-gray-100 text-gray-400 dark:bg-white/10 dark:text-white/35'}`}>
                      {u.enabled === 1 ? 'Enabled' : 'Off'}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
