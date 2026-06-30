export default function Footer() {
  return (
    <footer className="w-full bg-white/85 dark:bg-[#0e1d3a]/85 border-t border-gray-100 dark:border-white/10 py-2 sm:py-3 text-xs text-gray-500 dark:text-gray-400 mt-auto px-3 sm:px-6 flex flex-col sm:flex-row items-center sm:items-center justify-between gap-1 sm:gap-0">
      <p className="text-gray-400 dark:text-gray-500 text-center sm:text-left">Confidential &amp; Proprietary</p>
      <div className="text-center sm:text-right flex-shrink-0">
        <p className="dark:text-gray-300">© {new Date().getFullYear()} <strong>IP House</strong>.</p>
        <p className="text-gray-400 dark:text-gray-500">All rights reserved.</p>
      </div>
    </footer>
  )
}
