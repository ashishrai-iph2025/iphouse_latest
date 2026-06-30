export default function PageLoader() {
  return (
    <div className="flex flex-col items-center justify-center py-24">
      <div className="relative flex items-center justify-center" style={{ width: 100, height: 100 }}>
        <div style={{
          position: 'absolute', inset: 0, borderRadius: '50%',
          border: '3px solid transparent',
          borderTopColor: '#FFC82B', borderRightColor: '#FC934C',
          animation: 'spin 1.4s linear infinite',
        }} />
        <div style={{
          position: 'absolute', inset: 12, borderRadius: '50%',
          border: '2px solid transparent',
          borderTopColor: 'rgba(255,200,43,0.35)',
          borderLeftColor: 'rgba(252,147,76,0.35)',
          animation: 'spin 0.8s linear infinite reverse',
        }} />
        <div style={{
          position: 'relative', width: 60, height: 60,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          animation: 'ipPulse 1.6s ease-in-out infinite',
        }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/newlogo.png" alt="Loading"
            style={{ width: 56, objectFit: 'contain', filter: 'brightness(0) saturate(100%) invert(14%) sepia(53%) saturate(847%) hue-rotate(185deg) brightness(90%) contrast(100%)' }} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 7, marginTop: 20 }}>
        {[0, 1, 2].map(i => (
          <div key={i} style={{
            width: 6, height: 6, borderRadius: '50%',
            background: 'linear-gradient(135deg,#FFC82B,#FC934C)',
            animation: `ipBounce 1s ease-in-out ${i * 0.18}s infinite`,
          }} />
        ))}
      </div>
      <style>{`
        @keyframes ipPulse {
          0%,100% { opacity:1; transform:scale(1); }
          50%      { opacity:.6; transform:scale(0.9); }
        }
        @keyframes ipBounce {
          0%,100% { transform:translateY(0); opacity:.4; }
          50%      { transform:translateY(-7px); opacity:1; }
        }
      `}</style>
    </div>
  )
}
