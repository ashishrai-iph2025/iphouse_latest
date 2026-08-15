import EmailTemplatesClient from '@/components/admin/EmailTemplatesClient'

// p-6 is the admin page gutter — every other page under /admin uses it, and the
// wider `py-6 px-4 sm:px-6 lg:px-8` this page had pushed its content out of line
// with the rest of the section.
export default function EmailTemplatesPage() {
  return (
    <div className="p-6 fade-in">
      <EmailTemplatesClient />
    </div>
  )
}
