import type { ReactNode } from 'react'
import {
  Sparkles,
  KeyRound,
  PanelRightClose,
  PanelRightOpen,
  ShieldCheck
} from 'lucide-react'
import type { PlatformId } from '@shared/types'

/** 场景定义。原型为「视频课堂 / 章节作业 / 课堂签到」，此处补齐浏览与测试入口。 */
export type SceneId =
  | 'courses'
  | 'video'
  | 'quiz'
  | 'signin'
  | 'browser'
  | 'geo'
  | 'ai'
  | 'settings'

export const SCENES: { id: SceneId; label: string; short: string }[] = [
  { id: 'courses', label: '课程中心', short: '课程' },
  { id: 'video', label: '视频课堂', short: '视频' },
  { id: 'quiz', label: '章节作业', short: '作业' },
  { id: 'signin', label: '课堂签到', short: '签到' },
  { id: 'browser', label: '平台浏览', short: '浏览' },
  { id: 'geo', label: '定位测试', short: '定位' },
  { id: 'ai', label: 'AI 助手', short: 'AI' }
]

export interface PlatformEntry {
  id: PlatformId
  name: string
  shortName: string
  homeUrl: string
  /** 登录态。unknown 显示琥珀点，不代表已登录。 */
  auth: 'unknown' | 'authenticated' | 'expired' | 'error'
}

/**
 * 顶栏：交通灯 + 品牌 + 平台胶囊 + 中央场景胶囊 + 右侧状态与抽屉开关。
 * 布局与原型一致（h-14 → 56px），但宽度用 CSS 控制而非 Tailwind 断点类。
 */
export function TopBar({
  platforms,
  activePlatformId,
  onPlatformChange,
  scene,
  onSceneChange,
  aiReady,
  drawerOpen,
  onToggleDrawer,
  onOpenApiModal
}: {
  platforms: PlatformEntry[]
  activePlatformId: PlatformId
  onPlatformChange: (id: PlatformId) => void
  scene: SceneId
  onSceneChange: (s: SceneId) => void
  aiReady: boolean
  drawerOpen: boolean
  onToggleDrawer: () => void
  onOpenApiModal: () => void
}): ReactNode {
  const current = platforms.find((p) => p.id === activePlatformId)

  return (
    <header className="topbar" data-testid="topbar">
      {/* 左：交通灯 + 品牌 + 平台导航 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
        <div className="traffic" aria-hidden="true">
          <span className="r" />
          <span className="y" />
          <span className="g" />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginRight: 4 }}>
          <div className="logo">
            <Sparkles size={16} />
          </div>
          <span className="brand">CourseHub</span>
        </div>

        <nav className="platform-nav" aria-label="平台切换" data-testid="platform-nav">
          {platforms.map((p) => {
            const active = p.id === activePlatformId
            return (
              <button
                key={p.id}
                type="button"
                className="platform-pill"
                aria-current={active}
                onClick={() => onPlatformChange(p.id)}
                title={`${p.name} · ${p.homeUrl}`}
                data-platform={p.id}
              >
                <span className={`dot ${p.auth === 'authenticated' ? 'on' : 'off'}`} />
                <span>{p.shortName}</span>
              </button>
            )
          })}
        </nav>
      </div>

      {/* 中：课程上下文 + 场景切换 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flex: 1,
          minWidth: 0,
          justifyContent: 'center'
        }}
      >
        <div
          className="topbar-pill"
          style={{ maxWidth: 320, overflow: 'hidden' }}
          title={current?.name}
        >
          <ShieldCheck size={14} style={{ color: 'var(--ch-accent)', flexShrink: 0 }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {current?.name ?? '未选择平台'}
          </span>
        </div>

        <div className="scene-nav" role="tablist" aria-label="场景切换" data-testid="scene-nav">
          {SCENES.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              className="scene-pill"
              aria-current={scene === s.id}
              aria-selected={scene === s.id}
              onClick={() => onSceneChange(s.id)}
              data-scene={s.id}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* 右：AI 状态 + 设置 + 抽屉开关 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <button
          type="button"
          className="topbar-pill accent"
          onClick={onOpenApiModal}
          title="配置 DeepSeek API Key"
          data-testid="ai-status-pill"
        >
          <span className={`dot ${aiReady ? 'on' : 'off'}`} />
          <span>{aiReady ? 'DeepSeek 已连接' : 'DeepSeek 未配置'}</span>
          <KeyRound size={14} />
        </button>

        <button
          type="button"
          className="icon-btn"
          onClick={onToggleDrawer}
          title={drawerOpen ? '收起智能助手侧边栏' : '展开智能助手侧边栏'}
          aria-expanded={drawerOpen}
          data-testid="drawer-toggle"
          style={
            drawerOpen
              ? { background: 'var(--ch-accent)', color: 'var(--ch-on-accent)', borderColor: 'var(--ch-accent)' }
              : undefined
          }
        >
          {drawerOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
        </button>
      </div>
    </header>
  )
}
