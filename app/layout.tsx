import type { Metadata } from 'next'
import './globals.css'
import { Providers } from './providers'

export const metadata: Metadata = {
  title:       'IP House | Reports',
  description: 'Anti-piracy reporting, enforcement tools, and business intelligence.',
  icons:       { icon: '/logo1.png' },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="bg-brand-bg min-h-screen">
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
