import type { ReactNode } from 'react'

/** 能力状态标签。unverified 与 supported 必须视觉可区分，避免误读为已支持。 */
export function CapabilityChip({ state, reason }: { state: string; reason?: string | null }): ReactNode {
  const map: Record<string, string> = {
    supported: '已验证',
    partial: '部分支持',
    unsupported: '不支持',
    unverified: '待验证'
  }
  return (
    <span className={`chip chip-${state}`} title={reason ?? undefined}>
      {map[state] ?? state}
    </span>
  )
}

export function Panel({
  title,
  children,
  right
}: {
  title: string
  children: ReactNode
  right?: ReactNode
}): ReactNode {
  return (
    <section className="card" style={{ marginBottom: 12 }}>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 10
        }}
      >
        <h2 style={{ fontSize: 13, margin: 0, fontWeight: 600 }}>{title}</h2>
        {right}
      </header>
      {children}
    </section>
  )
}

export function Empty({ text }: { text: string }): ReactNode {
  return (
    <div style={{ fontSize: 12, color: '#64748b', padding: '10px 0', lineHeight: 1.6 }}>
      {text}
    </div>
  )
}
