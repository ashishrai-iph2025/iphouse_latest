'use client'

/*
 * The password rules, as the forms that ask for a password need them.
 *
 * Every screen that sets a password used to hardcode "at least 8 characters" —
 * in the placeholder, in the minLength attribute, and in its own check before
 * submitting. The rules are configurable now (Configuration → Security Policy),
 * so a hardcoded 8 is a form that promises one thing and a server that enforces
 * another, and the person typing gets to discover the difference.
 *
 * This reads the live policy instead. It is deliberately tolerant: if the fetch
 * fails, the form falls back to the shipped defaults and the SERVER still has
 * the final say. Nothing here is access control — it exists so people are told
 * the rules before they guess, not to enforce them.
 */

import { useEffect, useState } from 'react'

export interface PasswordPolicy {
  requirements: string[]
  minLength: number
  minDigits: number
  minUpper: number
  minLower: number
  minSymbols: number
  history: number
}

/* What the server ships with, used until the real policy arrives and if it
   never does. Kept in step with DefaultSecurityPolicy in Go — a mismatch here
   only affects the hint text, never what is accepted. */
const FALLBACK: PasswordPolicy = {
  requirements: ['At least 8 characters', 'At least one number', 'Not one of your last 3 passwords'],
  minLength: 8, minDigits: 1, minUpper: 0, minLower: 0, minSymbols: 0, history: 3,
}

/* One in-flight request shared by every mounting form, and the answer kept for
   the life of the page. Several of these screens render two password fields and
   a banner at once, and each of them asking independently would be three
   identical requests for a value that cannot change while they are open. */
let cached: PasswordPolicy | null = null
let inFlight: Promise<PasswordPolicy> | null = null

function fetchPolicy(): Promise<PasswordPolicy> {
  if (cached) return Promise.resolve(cached)
  if (inFlight) return inFlight
  inFlight = fetch('/api/password-policy', { credentials: 'include' })
    .then(r => r.json())
    .then(j => {
      if (!j?.success) throw new Error('unavailable')
      const p: PasswordPolicy = {
        requirements: Array.isArray(j.requirements) ? j.requirements : FALLBACK.requirements,
        minLength:  Number(j.minLength)  || FALLBACK.minLength,
        minDigits:  Number(j.minDigits)  || 0,
        minUpper:   Number(j.minUpper)   || 0,
        minLower:   Number(j.minLower)   || 0,
        minSymbols: Number(j.minSymbols) || 0,
        history:    Number(j.history)    || 0,
      }
      cached = p
      return p
    })
    .catch(() => FALLBACK)
    .finally(() => { inFlight = null })
  return inFlight
}

/** The live password policy, or the shipped defaults until it arrives. */
export function usePasswordPolicy(): PasswordPolicy {
  const [policy, setPolicy] = useState<PasswordPolicy>(cached ?? FALLBACK)
  useEffect(() => {
    let alive = true
    fetchPolicy().then(p => { if (alive) setPolicy(p) })
    return () => { alive = false }
  }, [])
  return policy
}

/**
 * Check a password in the browser, wording the refusal the way the server does.
 *
 * A duplicate of the Go rule, and deliberately so — this one saves a round trip
 * and is allowed to be wrong; the Go one is the one that decides. The reuse
 * check has no counterpart here at all: it needs the stored hashes, which is
 * exactly the thing a browser must never be given.
 *
 * Returns '' when the password is acceptable.
 */
export function checkPassword(pw: string, p: PasswordPolicy): string {
  // Array.from, not pw.length: the server counts characters, and a string's
  // length property counts UTF-16 units, which disagree on anything outside
  // the basic plane — an emoji counts as two.
  const chars = Array.from(pw)
  const count = (re: RegExp) => chars.filter(c => re.test(c)).length

  const missing: string[] = []
  if (chars.length < p.minLength) missing.push(`${p.minLength} characters or more`)

  const rules: [number, number, string, string][] = [
    [count(/\d/),                          p.minDigits,  'a number',           'numbers'],
    [count(/\p{Lu}/u),                     p.minUpper,   'a capital letter',   'capital letters'],
    [count(/\p{Ll}/u),                     p.minLower,   'a lowercase letter', 'lowercase letters'],
    [count(/[^\p{L}\p{N}\s]/u),            p.minSymbols, 'a symbol',           'symbols'],
  ]
  for (const [got, want, one, many] of rules) {
    if (want <= 0 || got >= want) continue
    missing.push(want === 1 ? one : `at least ${want} ${many}`)
  }

  if (missing.length === 0) return ''
  const last = missing.pop() as string
  return `Password must contain ${missing.length ? `${missing.join(', ')} and ${last}` : last}`
}

/**
 * The rules as a checklist, ticking off what the current input already
 * satisfies.
 *
 * Live ticks rather than a static list because these forms have two fields and
 * a confirm step: showing which rule is still outstanding is the difference
 * between "why was that rejected" and knowing before pressing the button.
 */
export function PasswordRules({ policy, value = '' }: { policy: PasswordPolicy; value?: string }) {
  if (policy.requirements.length === 0) return null

  const chars = Array.from(value)
  const count = (re: RegExp) => chars.filter(c => re.test(c)).length
  const met = [
    chars.length >= policy.minLength,
    ...(policy.minDigits  > 0 ? [count(/\d/)               >= policy.minDigits]  : []),
    ...(policy.minUpper   > 0 ? [count(/\p{Lu}/u)          >= policy.minUpper]   : []),
    ...(policy.minLower   > 0 ? [count(/\p{Ll}/u)          >= policy.minLower]   : []),
    ...(policy.minSymbols > 0 ? [count(/[^\p{L}\p{N}\s]/u) >= policy.minSymbols] : []),
    // The history rule can only be judged by the server, so it never ticks —
    // it is listed to be known about, not to be checked off.
    ...(policy.history > 0 ? [false] : []),
  ]

  return (
    <ul className="mt-2 space-y-1">
      {policy.requirements.map((rq, i) => {
        const done = value.length > 0 && met[i]
        return (
          <li key={i} className={`text-[11px] flex gap-1.5 leading-relaxed ${
            done ? 'text-emerald-600' : 'text-gray-400'}`}>
            <span aria-hidden>{done ? '✓' : '•'}</span>
            <span>{rq}</span>
          </li>
        )
      })}
    </ul>
  )
}
