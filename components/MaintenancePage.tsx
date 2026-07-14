'use client'

// Full-screen page shown to non-admin visitors while maintenance mode is on
// (toggled from Super Admin → Maintenance Mode).
export default function MaintenancePage({ message }: { message?: string }) {
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(160deg,#f6f8fb 0%,#eef2f8 100%)',
      fontFamily: 'Inter, system-ui, sans-serif', padding: 24,
    }}>
      <div style={{
        maxWidth: 520, width: '100%', background: '#fff', borderRadius: 20,
        border: '1px solid #e8ebf0', boxShadow: '0 12px 40px rgba(13,36,75,0.10)',
        padding: '48px 40px', textAlign: 'center',
      }}>
        {/* wrench / gear icon */}
        <div style={{
          width: 84, height: 84, borderRadius: 24,
          background: 'linear-gradient(135deg,#FC934C22,#14254A14)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          margin: '0 auto 24px', fontSize: 40,
        }}>
          🛠️
        </div>

        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, color: '#14254A' }}>
          We&apos;ll be back soon
        </h1>
        <p style={{ margin: '12px 0 6px', fontSize: 14.5, color: '#5b6678', lineHeight: 1.65 }}>
          {message?.trim()
            ? message
            : 'The IP House platform is undergoing scheduled maintenance. We are working to bring it back online as quickly as possible.'}
        </p>
        <p style={{ margin: '0 0 30px', fontSize: 13, color: '#8a96a8' }}>
          Thank you for your patience.
        </p>

        <div style={{ borderTop: '1px solid #f0f2f5', margin: '0 0 26px' }} />

        <button onClick={() => window.location.reload()}
          style={{
            padding: '11px 32px', borderRadius: 12, border: 'none',
            background: 'linear-gradient(135deg,#14254A,#1e3a6e)', color: '#fff',
            fontSize: 14, fontWeight: 700, cursor: 'pointer',
          }}>
          ↻ Check Again
        </button>

        <p style={{ marginTop: 26, fontSize: 11, color: '#adb5bd' }}>
          IP House Anti-Piracy Platform — need urgent help? Contact{' '}
          <a href="mailto:India-itsupport@ip-house.com" style={{ color: '#FC934C', textDecoration: 'none', fontWeight: 600 }}>
            India-itsupport@ip-house.com
          </a>
        </p>
      </div>
    </div>
  )
}
