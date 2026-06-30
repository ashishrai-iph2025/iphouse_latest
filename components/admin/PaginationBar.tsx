'use client'

interface Props {
  page: number
  total: number
  perPage?: number
  onChange: (p: number) => void
}

export const PER_PAGE = 10

function range(cur: number, total: number): (number | '…')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  if (cur <= 4)          return [1, 2, 3, 4, 5, '…', total]
  if (cur >= total - 3)  return [1, '…', total - 4, total - 3, total - 2, total - 1, total]
  return [1, '…', cur - 1, cur, cur + 1, '…', total]
}

export default function PaginationBar({ page, total, perPage = PER_PAGE, onChange }: Props) {
  const totalPages = Math.max(1, Math.ceil(total / perPage))
  const from = (page - 1) * perPage + 1
  const to   = Math.min(page * perPage, total)

  if (total === 0) return null

  return (
    <div className="flex items-center justify-between px-5 py-3 border-t border-gray-100 bg-gray-50/60 text-xs">
      <span className="text-gray-500">
        Showing <strong className="text-[#14254A]">{from}–{to}</strong> of <strong className="text-[#14254A]">{total}</strong> records
      </span>
      <div className="flex items-center gap-1">
        <PgBtn onClick={() => onChange(1)}           disabled={page === 1}>«</PgBtn>
        <PgBtn onClick={() => onChange(page - 1)}    disabled={page === 1}>‹</PgBtn>
        {range(page, totalPages).map((p, i) =>
          p === '…'
            ? <span key={i} className="w-7 text-center text-gray-400 select-none">…</span>
            : <PgBtn key={p} active={p === page} onClick={() => onChange(p as number)}>{p}</PgBtn>
        )}
        <PgBtn onClick={() => onChange(page + 1)}    disabled={page === totalPages}>›</PgBtn>
        <PgBtn onClick={() => onChange(totalPages)}  disabled={page === totalPages}>»</PgBtn>
      </div>
    </div>
  )
}

function PgBtn({ children, onClick, disabled, active }: {
  children: React.ReactNode; onClick: () => void; disabled?: boolean; active?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="min-w-[28px] h-7 px-1.5 rounded-lg text-xs font-semibold transition-all disabled:opacity-30 disabled:cursor-not-allowed"
      style={{
        background: active ? '#14254A' : '#fff',
        color: active ? '#FFC82B' : '#14254A',
        border: active ? '1.5px solid #14254A' : '1.5px solid #e2e8f0',
      }}
    >
      {children}
    </button>
  )
}
