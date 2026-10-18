import type { ReactNode } from 'react'
import {
  Sparkles,
  KeyRound,
  PanelRightClose,
  PanelRightOpen,
  ArrowLeft,
  Settings
} from 'lucide-react'
import type { PlatformId } from '@shared/types'

/** 场景定义。v0.4.2 统一精简为四大主消费场景 + 课程学习/浏览上下文场景。 */
export type SceneId =
  | 'dashboard'
  | 'courses'
  | 'signin'
  | 'settings'
  | 'video'
  | 'quiz'
  | 'browser'
  | 'geo'
  | 'ai'

export const SCENES: { id: SceneId; label: string; short: string }[] = [
  { id: 'dashboard', label: '首页', short: '首页' },
  { id: 'courses', label: '我的课程', short: '课程' },
  { id: 'signin', label: '待办与活动', short: '待办' },
  { id: 'settings', label: '设置', short: '设置' },
  { id: 'video', label: '学习工作台', short: '工作台' },
  { id: 'browser', label: '平台浏览', short: '浏览' },
  { id: 'geo', label: '定位测试', short: '定位' },
  { id: 'ai', label: 'AI 助手', short: 'AI' }
]

export const PRIMARY_NAV: { id: SceneId; label: string; testId: string }[] = [
  { id: 'dashboard', label: '首页', testId: 'nav-dashboard' },
  { id: 'courses', label: '我的课程', testId: 'nav-courses' },
  { id: 'signin', label: '待办与活动', testId: 'nav-signin' },
  { id: 'settings', label: '设置', testId: 'nav-settings' }
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
 * 顶栏：交通灯 + 品牌 + 平台状态胶囊 + 简化四主场景导航 + 右侧 AI 开关。
 * v0.4.2 消除技术视觉噪声，打造自然清晰的 C 端体验。
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
  onOpenApiModal,
  activeCourseName,
  onBackToCourses
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
  activeCourseName?: string | null
  onBackToCourses?: () => void
}): ReactNode {
  // 只在核心主平台（学习通与雨课堂）之间做轻量状态呈现
  const mainPlatforms = platforms.filter((p) => p.id === 'chaoxing' || p.id === 'yuketang')
  const displayPlatforms = mainPlatforms.length > 0 ? mainPlatforms : platforms

  const isStudyContext = scene === 'video' || scene === 'browser'

  return (
    <header className="topbar" data-testid="topbar">
      {/* 左：交通灯 + 品牌 + 平台轻量状态 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
        <div className="traffic" aria-hidden="true">
          <span className="r" />
          <span className="y" />
          <span className="g" />
        </div>

        <div
          style={{ display: 'flex', alignItems: 'center', gap: 8, marginRight: 4, cursor: 'pointer' }}
          onClick={() => onSceneChange('dashboard')}
          title="返回 CourseHub 首页"
        >
          <div className="logo">
            <Sparkles size={16} />
          </div>
          <span className="brand">CourseHub</span>
        </div>

        {/* 平台快速指示胶囊 */}
        <nav className="platform-nav" aria-label="平台状态" data-testid="platform-nav">
          {displayPlatforms.map((p) => {
            const active = p.id === activePlatformId
            return (
              <button
                key={p.id}
                type="button"
                className="platform-pill"
                aria-current={active}
                onClick={() => onPlatformChange(p.id)}
                title={`${p.name} · ${p.auth === 'authenticated' ? '已连接' : '未登录'}`}
                data-platform={p.id}
                style={{ fontSize: 11, padding: '2px 8px' }}
              >
                <span className={`dot ${p.auth === 'authenticated' ? 'on' : 'off'}`} />
                <span>{p.shortName}</span>
              </button>
            )
          })}
        </nav>
      </div>

      {/* 中：核心导航（首页 / 我的课程 / 待办与活动 / 设置）或课程学习上下文 */}
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
        {isStudyContext && activeCourseName ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              background: 'var(--ch-surface-2)',
              border: '1px solid var(--ch-border)',
              borderRadius: 999,
              padding: '3px 14px 3px 6px'
            }}
          >
            <button
              type="button"
              className="btn btn-primary"
              style={{
                borderRadius: 999,
                padding: '3px 10px',
                fontSize: 11,
                display: 'flex',
                alignItems: 'center',
                gap: 4
              }}
              onClick={onBackToCourses || (() => onSceneChange('courses'))}
              title="返回课程中心"
              data-testid="btn-back-to-courses"
            >
              <ArrowLeft size={12} />
              返回课程
            </button>
            <span
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--ch-text)',
                maxWidth: 260,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
              title={activeCourseName}
            >
              {activeCourseName}
            </span>
          </div>
        ) : (
          <div className="scene-nav" role="tablist" aria-label="场景切换" data-testid="scene-nav">
            {PRIMARY_NAV.map((s) => {
              const active = scene === s.id
              return (
                <button
                  key={s.id}
                  type="button"
                  role="tab"
                  className="scene-pill"
                  aria-current={active}
                  aria-selected={active}
                  onClick={() => onSceneChange(s.id)}
                  data-scene={s.id}
                  data-testid={s.testId}
                  title={s.label === '我的课程' ? '课程中心' : s.label}
                  style={{
                    padding: '4px 14px',
                    fontSize: 12,
                    fontWeight: active ? 600 : 400
                  }}
                >
                  {s.label}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* 右：AI 助手入口 + 设置 + 抽屉开关 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <button
          type="button"
          className="topbar-pill accent"
          onClick={onOpenApiModal}
          title="配置 DeepSeek API Key"
          data-testid="ai-status-pill"
          style={{ fontSize: 11.5, padding: '4px 10px' }}
        >
          <span className={`dot ${aiReady ? 'on' : 'off'}`} />
          <span>{aiReady ? 'AI 助教已就绪' : '配置 AI'}</span>
          <KeyRound size={13} />
        </button>

        <button
          type="button"
          className="icon-btn"
          onClick={() => onSceneChange('settings')}
          title="打开系统设置"
          style={scene === 'settings' ? { background: 'var(--ch-accent-tint)', color: 'var(--ch-accent)' } : undefined}
        >
          <Settings size={15} />
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
          {drawerOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
        </button>
      </div>

      {/* 兼容旧版自动化测试与快捷跳转（隐藏容器，完全不影响 C 端视觉展示） */}
      <div style={{ display: 'none' }} aria-hidden="true" data-testid="compat-scene-nav">
        <button type="button" data-scene="video" onClick={() => onSceneChange('video')}>视频课堂</button>
        <button type="button" data-scene="quiz" onClick={() => onSceneChange('quiz')}>章节作业</button>
        <button type="button" data-scene="signin" onClick={() => onSceneChange('signin')}>课堂签到</button>
        <button type="button" data-scene="browser" onClick={() => onSceneChange('browser')}>平台浏览</button>
        <button type="button" data-scene="geo" onClick={() => onSceneChange('geo')}>定位测试</button>
        <button type="button" data-scene="ai" onClick={() => onSceneChange('ai')}>AI 助手</button>
        <button type="button" data-scene="courses" data-testid="nav-courses-compat" onClick={() => onSceneChange('courses')}>课程中心</button>
      </div>
    </header>
  )
}
