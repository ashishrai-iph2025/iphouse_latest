'use client'

import { useState } from 'react'

export interface MasterUser {
  userId: number
  name: string
}

// Searchable multi-select checkbox list of dcp_user client companies. Shared
// by the shared-logins editor and the direct Add User flow so both assign
// clients to a login the same way.
export default function UserPicker({
  users, selected, onChange,
}: { users: MasterUser[]; selected: number[]; onChange: (ids: number[]) => void }) {
  const [search, setSearch] = useState('')
  const q = search.toLowerCase()
  const matched = users.filter(u => u.name.toLowerCase().includes(q))
  // Selected users always float to top, then unselected
  const filtered = [
    ...matched.filter(u =>  selected.includes(u.userId)),
    ...matched.filter(u => !selected.includes(u.userId)),
  ]

  function toggle(id: number) {
    onChange(selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id])
  }

  return (
    <div>
      <input
        type="text"
        placeholder="Search users…"
        value={search}
        onChange={e => setSearch(e.target.value)}
        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mb-2 focus:outline-none focus:ring-2 focus:ring-blue-400"
      />
      <div className="modal-checkbox-list border border-gray-200 rounded-lg overflow-y-auto" style={{ maxHeight: 180 }}>
        {filtered.length === 0 ? (
          <p className="text-xs text-gray-400 p-3 text-center">No users found</p>
        ) : filtered.map(u => (
          <label key={u.userId}
            className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 cursor-pointer text-sm">
            <input
              type="checkbox"
              checked={selected.includes(u.userId)}
              onChange={() => toggle(u.userId)}
              className="rounded accent-[#14254A]"
            />
            <span className="text-gray-800">{u.name}</span>
          </label>
        ))}
      </div>
      {selected.length > 0 && (
        <p className="text-xs text-brand-muted mt-1">{selected.length} user(s) selected</p>
      )}
    </div>
  )
}
