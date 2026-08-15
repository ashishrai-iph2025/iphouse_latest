import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { SessionProvider } from '@/lib/auth-client'
import { TimeZoneProvider } from '@/lib/timezone'
import App from './App'
import '@/app/globals.css'

// TimeZoneProvider sits above everything: the API answers in UTC and every
// surface that shows a timestamp — client pages, admin pages, notifications —
// reads the same preference to render it. See lib/timezone.tsx.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <TimeZoneProvider>
          <App />
        </TimeZoneProvider>
      </SessionProvider>
    </BrowserRouter>
  </React.StrictMode>
)
