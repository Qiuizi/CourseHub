import type { ReactNode } from 'react'
import { Zap, MapPin, Sparkles, Activity } from 'lucide-react'
import { Card, Seg, Switch, Empty, CapChip } from '../components/ui'
import { observedProgressPercent } from '@shared/video'
import type { PlaybackObservation } from '@shared/types'

/** 提交模式。confirm 之外不提供无人值守自动提交。 */
export type SubmitMode = 'confirm' | 'manual'

/**
 * 右侧抽屉。
 *
 * 视觉结构对齐原型（托管卡片 / 听课设置 / AI与位置守护 / 今日动态），
 * 但每个控件都接真实状态：
 * - 自动化执行需遵循受控交互与用户确认原则，保障数据准确性；
 * - 没有编造统计；
 * - 「今日动态」读主进程脱敏日志，无数据即空态。
 */
export function Drawer({
  observation,
  continuous,
  onContinuousChange,
  autoMute,
  onAutoMuteChange,
  submitMode,
  onSubmitModeChange,
  testLocation,
  onChangeTestLocation,
  activity,
  drawerOpen
}: {
  observation: PlaybackObservation | null
  continuous: boolean
  onContinuousChange: (v: boolean) => void
  autoMute: boolean
  onAutoMuteChange: (v: boolean) => void
  submitMode: SubmitMode
  onSubmitModeChange: (v: SubmitMode) => void
  testLocation: string
  onChangeTestLocation: () => void
  activity: { id: string; time: string; title: string }[]
  drawerOpen: boolean
}): ReactNode {
  if (!drawerOpen) return null

  const pct = observedProgressPercent(observation)

  return (
    <aside className="drawer" data-testid="drawer" aria-label="智能助手侧边栏">
      {/* 1. 播放观测（原型位：一键全自动托管） */}
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 16,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                background: continuous ? 'var(--ch-accent)' : 'var(--ch-page)',
                color: continuous ? 'var(--ch-on-accent)' : 'var(--ch-text-2)'
              }}
            >
              <Zap size={20} />
            </div>
            <div style={{ minWidth: 0 }}>
              <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>连续播放</h3>
              <p style={{ fontSize: 11, color: 'var(--ch-text-2)', margin: '2px 0 0' }}>
                {continuous ? '播完自动切下一任务' : '已暂停，需手动切换'}
              </p>
            </div>
          </div>
          <Switch checked={continuous} onChange={onContinuousChange} label="连续播放下一任务" />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginTop: 14 }}>
          <Stat label="播放器" value={observation?.playerState ?? '未观测'} accent={false} />
          <Stat
            label="本地进度"
            value={pct === null ? '—' : `${pct.toFixed(0)}%`}
            accent={true}
          />
          <Stat
            label="倍速"
            value={observation?.playbackRate ? `${observation.playbackRate}x` : '—'}
            accent={false}
          />
        </div>
      </Card>

      {/* 2. 听课设置（原型位：智能听课设置） */}
      <Card>
        <h3 className="card-title">播放设置</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <SettingRow
            title="静音托管"
            desc="播放时自动静音，避免课堂外放"
            checked={autoMute}
            onChange={onAutoMuteChange}
          />
          <SettingRow
            title="连续播放下一任务"
            desc="仅在真实观测到 ended 且平台允许时推进"
            checked={continuous}
            onChange={onContinuousChange}
          />
        </div>
      </Card>

      {/* 3. AI 与位置守护（原型位：AI 答题与位置守护） */}
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 className="card-title" style={{ margin: 0 }}>
            AI 与测试位置
          </h3>
          <Sparkles size={14} style={{ color: 'var(--ch-accent)' }} />
        </div>

        <div style={{ marginTop: 12 }}>
          <p className="label">受控表单交互策略</p>
          <Seg
            value={submitMode}
            onChange={onSubmitModeChange}
            options={[
              { id: 'confirm', label: '每次等我确认' },
              { id: 'manual', label: '仅预览不执行' }
            ]}
          />
          <p style={{ fontSize: 10.5, color: 'var(--ch-text-3)', margin: '8px 0 0', lineHeight: 1.6 }}>
            真实独立计分作业与考试不接入自动提交，此策略仅作用于授权测试页。
          </p>
        </div>

        <div
          style={{
            marginTop: 12,
            padding: 12,
            borderRadius: 'var(--r-block)',
            background: 'var(--ch-subtle)',
            border: '1px solid var(--ch-border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 10.5, color: 'var(--ch-text-2)' }}>测试目标位置</div>
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                marginTop: 2,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
            >
              <MapPin size={12} style={{ display: 'inline', marginRight: 4, verticalAlign: -1 }} />
              {testLocation}
            </div>
          </div>
          <button type="button" className="btn" style={{ flexShrink: 0 }} onClick={onChangeTestLocation}>
            更改
          </button>
        </div>
      </Card>

      {/* 4. 今日动态（真实日志，无数据即空态） */}
      <Card style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Activity size={13} style={{ color: 'var(--ch-text-2)' }} />
          <h3 className="card-title" style={{ margin: 0 }}>
            最近动态
          </h3>
        </div>

        {activity.length === 0 ? (
          <Empty text="暂无记录。应用内的真实操作（登录、播放、定位测试）会显示在这里，不会生成演示日志。" />
        ) : (
          <ul style={{ listStyle: 'none', margin: '12px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {activity.map((a) => (
              <li key={a.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: 'var(--ch-accent)',
                    marginTop: 5,
                    flexShrink: 0
                  }}
                />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 11.5, color: 'var(--ch-text)' }}>{a.title}</div>
                  <div style={{ fontSize: 10.5, color: 'var(--ch-text-3)' }}>{a.time}</div>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div
          style={{
            marginTop: 'auto',
            paddingTop: 12,
            borderTop: '1px solid var(--ch-hairline)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: 10.5,
            color: 'var(--ch-text-3)'
          }}
        >
          <span>纯本机运行 · 密钥 safeStorage 加密</span>
          <CapChip state="supported" compact />
        </div>
      </Card>
    </aside>
  )
}

function Stat({
  label,
  value,
  accent
}: {
  label: string
  value: string
  accent: boolean
}): ReactNode {
  return (
    <div
      style={{
        padding: '10px 8px',
        borderRadius: 'var(--r-block)',
        background: 'var(--ch-subtle)',
        textAlign: 'center'
      }}
    >
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: accent ? 'var(--ch-accent)' : 'var(--ch-text)',
          fontVariantNumeric: 'tabular-nums'
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--ch-text-2)', marginTop: 2 }}>{label}</div>
    </div>
  )
}

function SettingRow({
  title,
  desc,
  checked,
  onChange
}: {
  title: string
  desc: string
  checked: boolean
  onChange: (v: boolean) => void
}): ReactNode {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 500 }}>{title}</div>
        <div style={{ fontSize: 10.5, color: 'var(--ch-text-2)', marginTop: 1 }}>{desc}</div>
      </div>
      <Switch checked={checked} onChange={onChange} label={title} />
    </div>
  )
}
