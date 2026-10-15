import type { ReactNode } from 'react'

/* ------------------------------ 能力徽标 ------------------------------ */

const CAP_TEXT: Record<string, string> = {
  supported: '已验证',
  partial: '部分支持',
  unsupported: '不支持',
  unverified: '待验证'
}

/**
 * 能力状态徽标。四态必须视觉可区分——
 * unverified 与 supported 长得一样会让人误以为已支持。
 */
export function CapChip({
  state,
  reason,
  compact = false
}: {
  state: string
  reason?: string | null
  compact?: boolean
}): ReactNode {
  return (
    <span
      className={`chip cap-${state}`}
      title={reason ?? undefined}
      data-cap={state}
      style={compact ? { fontSize: 10, padding: '2px 7px' } : undefined}
    >
      {CAP_TEXT[state] ?? state}
    </span>
  )
}

/* -------------------------------- 卡片 -------------------------------- */

export function Card({
  title,
  action,
  children,
  style
}: {
  title?: string
  action?: ReactNode
  children: ReactNode
  style?: React.CSSProperties
}): ReactNode {
  return (
    <section className="card" style={style}>
      {(title || action) && (
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            marginBottom: title ? 12 : 0
          }}
        >
          {title && <h3 className="card-title">{title}</h3>}
          {action}
        </header>
      )}
      {children}
    </section>
  )
}

/* -------------------------------- 空态 -------------------------------- */

export function Empty({
  text,
  icon,
  tone = 'neutral'
}: {
  text: string
  icon?: ReactNode
  tone?: 'neutral' | 'warn' | 'error'
}): ReactNode {
  const color =
    tone === 'error' ? '#b91c1c' : tone === 'warn' ? '#92400e' : 'var(--ch-text-3)'
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        padding: '28px 12px',
        textAlign: 'center'
      }}
    >
      {icon && <span style={{ color, opacity: 0.7 }}>{icon}</span>}
      <p style={{ fontSize: 12, color, margin: 0, lineHeight: 1.7, maxWidth: 420 }}>{text}</p>
    </div>
  )
}

/* -------------------------------- 开关 -------------------------------- */

export function Switch({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="switch"
      onClick={() => onChange(!checked)}
    />
  )
}

/* ------------------------------ 分段切换 ------------------------------ */

export function Seg<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: { id: T; label: string }[]
  onChange: (v: T) => void
}): ReactNode {
  return (
    <div className="seg" style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-current={value === o.id}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/* ------------------------------ 键值行 ------------------------------ */

export function Rows({
  items
}: {
  items: { k: string; v: ReactNode; mono?: boolean }[]
}): ReactNode {
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 16px', margin: 0 }}>
      {items.map((it) => (
        <div key={it.k} style={{ display: 'contents' }}>
          <dt style={{ fontSize: 11, color: 'var(--ch-text-2)', margin: 0 }}>{it.k}</dt>
          <dd
            style={{
              fontSize: 12,
              color: 'var(--ch-text)',
              margin: 0,
              fontFamily: it.mono ? 'ui-monospace, Consolas, monospace' : undefined
            }}
          >
            {it.v}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/* ------------------------------ 提示条 ------------------------------ */

export function Notice({
  tone = 'info',
  children
}: {
  tone?: 'info' | 'warn' | 'error' | 'ok'
  children: ReactNode
}): ReactNode {
  const map = {
    info: { bg: 'var(--ch-accent-tint)', fg: 'var(--ch-accent)' },
    warn: { bg: '#fef3c7', fg: '#92400e' },
    error: { bg: '#fee2e2', fg: '#b91c1c' },
    ok: { bg: 'var(--ch-emerald-50)', fg: 'var(--ch-emerald-700)' }
  } as const
  const c = map[tone]
  return (
    <div
      style={{
        background: c.bg,
        color: c.fg,
        borderRadius: 'var(--r-block)',
        padding: '10px 14px',
        fontSize: 11.5,
        lineHeight: 1.7
      }}
    >
      {children}
    </div>
  )
}
