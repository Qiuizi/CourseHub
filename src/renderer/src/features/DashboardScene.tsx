import type { ReactNode } from 'react'
import {
  CalendarCheck,
  Radio,
  Film,
  BookOpen,
  ShieldAlert,
  ChevronRight,
  Inbox
} from 'lucide-react'

import { Card, CapChip, Empty, Notice } from '../components/ui'

export interface DashboardSceneProps {
  platformName: string
  authLabel: string
  authState: 'unknown' | 'authenticated' | 'expired' | 'error'
  onOpenScene: (scene: 'signin' | 'video' | 'quiz' | 'geo' | 'ai' | 'browser') => void
  onOpenPlatform: () => void
}

/**
 * 工作台首页。
 *
 * 展示四类真实状态入口。未读到真实数据时明确给出空态/未支持/检测失败，
 * 不生成假签到、假课程、假成功日志。
 */
export function DashboardScene({
  platformName,
  authLabel,
  authState,
  onOpenScene,
  onOpenPlatform
}: DashboardSceneProps): ReactNode {
  const authed = authState === 'authenticated'

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* 平台与登录状态 */}
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: 16,
                background: 'var(--ch-accent-tint)',
                color: 'var(--ch-accent)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0
              }}
            >
              <BookOpen size={22} />
            </div>
            <div style={{ minWidth: 0 }}>
              <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>{platformName}</h2>
              <p style={{ fontSize: 11.5, color: 'var(--ch-text-2)', margin: '3px 0 0' }}>
                独立持久化会话 · 权限默认全拒 · 未读取任何平台数据前不显示状态
              </p>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className={`chip ${authed ? 'chip-emerald' : 'chip-neutral'}`} data-testid="dash-auth">
              <span className={`dot ${authed ? 'on' : 'off'}`} />
              {authLabel}
            </span>
            <button type="button" className="btn btn-primary" onClick={onOpenPlatform}>
              打开平台页面
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      </Card>

      {/* 四类入口 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
        <EntryCard
          icon={<CalendarCheck size={20} />}
          title="今日签到"
          desc="检测当天签到活动的类型、时间与真实状态"
          state="unverified"
          stateText="平台数据源未验证"
          onClick={() => onOpenScene('signin')}
        />
        <EntryCard
          icon={<Radio size={20} />}
          title="课堂事件"
          desc="进行中的随堂练习与限时题目提醒"
          state="unverified"
          stateText="事件推送未验证"
          onClick={() => onOpenScene('quiz')}
        />
        <EntryCard
          icon={<Film size={20} />}
          title="视频任务"
          desc="章节任务列表、播放控制与真实进度观测"
          state="unverified"
          stateText="任务来源未验证"
          onClick={() => onOpenScene('video')}
        />
        <EntryCard
          icon={<ShieldAlert size={20} />}
          title="定位测试"
          desc="独立测试会话的地理位置覆盖与读回验证"
          state="supported"
          stateText="fixture 可重复验证"
          onClick={() => onOpenScene('geo')}
        />
      </div>

      {/* 空态说明 */}
      <Card title="为什么首页是空的">
        <Empty
          icon={<Inbox size={22} />}
          text="当前没有已验证的真实平台数据源。适配器能力为 unverified 时不展示任何签到、课程或事件条目——用占位数据填充首页会让未验证状态看起来像事实。"
        />
        <div style={{ marginTop: 4 }}>
          <Notice tone="info">
            已可立即使用的部分：定位测试（fixture 验证）、测试台视频播放器观测、
            受控表单交互、DeepSeek 助手（配置 Key 后）。
          </Notice>
        </div>
      </Card>
    </div>
  )
}

function EntryCard({
  icon,
  title,
  desc,
  state,
  stateText,
  onClick
}: {
  icon: ReactNode
  title: string
  desc: string
  state: string
  stateText: string
  onClick: () => void
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'block',
        textAlign: 'left',
        background: 'var(--ch-surface)',
        border: '1px solid var(--ch-border)',
        borderRadius: 'var(--r-card)',
        boxShadow: 'var(--sh-card)',
        padding: 20,
        cursor: 'pointer',
        fontFamily: 'inherit',
        transition: 'border-color 0.15s ease, transform 0.15s ease'
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--ch-accent)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--ch-border)'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 16,
            background: 'var(--ch-accent-tint)',
            color: 'var(--ch-accent)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0
          }}
        >
          {icon}
        </div>
        <CapChip state={state} compact />
      </div>
      <h3 style={{ fontSize: 14, fontWeight: 600, margin: '14px 0 4px' }}>{title}</h3>
      <p style={{ fontSize: 11.5, color: 'var(--ch-text-2)', margin: 0, lineHeight: 1.6 }}>{desc}</p>
      <p style={{ fontSize: 10.5, color: 'var(--ch-text-3)', margin: '8px 0 0' }}>{stateText}</p>
    </button>
  )
}
