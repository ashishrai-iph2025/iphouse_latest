/**
 * The page-level waiting state, kept as its own name because two dozen screens
 * import it — but it is now just ReportLoader, which is the single loader for
 * the whole app. It used to be a gradient ring spinning around a pulsing logo.
 *
 * New code can import ReportLoader directly; this stays so those call sites do
 * not all have to change to get the new one.
 *
 * It CENTRES itself in whatever it is dropped into. `flex-1` fills the height
 * when the parent is the shell's flex-column main (the full-width pages), and the
 * `min-h` floor centres it in the viewport for the full-page cases — the Suspense
 * fallback, the auth and maintenance guards — where there is no flex parent to
 * stretch into. Either way the mark lands in the middle rather than pinned to the
 * top, which is the single loader this app now shows while a route settles.
 */
import ReportLoader from '@/components/shared/ReportLoader'

export default function PageLoader({ label }: { label?: string | null } = {}) {
  return (
    <div className="flex-1 flex items-center justify-center w-full min-h-[70vh]">
      <ReportLoader label={label ?? 'Loading'} size={190} />
    </div>
  )
}
