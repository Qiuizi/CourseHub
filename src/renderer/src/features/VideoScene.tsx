import type { ReactNode } from 'react'
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  CheckCircle2,
  Clock,
  SkipForward,
  Square,
  Loader2,
  Film,
  AlertTriangle
} from 'lucide-react'
import type { PlaybackObservation } from '@shared/types'
import { observedProgressPercent, ALLOWED_PLAYBACK_RATES } from '@shared/video'
import { Card, CapChip, Notice, Rows } from '../components/ui'

/** 章节任务。order 为 null 表示平台未提供顺序，不臆造。 */
export interface ChapterTask {
  id: string
  title: string
  order: number | null
  durationSeconds: number | null
  platformStatus: 'unknown' | 'not_started' | 'in_progress' | 'completed'
  sourceUrl?: string
  taskType?: string
}

function fmtDuration(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec) || sec <= 0) return '—'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * 视频课堂场景。
 *
 * 布局对齐原型：左侧深色播放器（8/12）+ 右侧章节连播目录（4/12）。
 * 播放器区域是真实 WebContentsView（原生视图由主进程设置 bounds），
 * 控制条放在原生视图**下方**——原生视图会覆盖 React 层，
 * 所以不能把控件浮在播放器上面。
 */
export function VideoScene({
  platformName,
  observation,
  courseName,
  chapterName,
  tasks,
  activeTaskId,
  continuous,
  autoMute,
  volume,
  rate,
  busy,
  message,
  viewportRef,
  onSelectTask,
  onCommand,
  onVolumeChange,
  onRateChange,
  onLoadFixture,
  onSimulateLifecycle
}: {
  platformName: string
  observation: PlaybackObservation | null
  courseName: string | null
  chapterName: string | null
  tasks: ChapterTask[]
  activeTaskId: string | null
  continuous: boolean
  autoMute: boolean
  volume: number
  rate: number
  busy: string | null
  message: string | null
  viewportRef: React.RefObject<HTMLDivElement>
  onSelectTask: (id: string) => void
  onCommand: (action: string, value?: number) => void
  onVolumeChange: (v: number) => void
  onRateChange: (v: number) => void
  onLoadFixture: () => void
  onSimulateLifecycle?: (input: { visibility?: 'visible' | 'hidden'; focus?: 'focus' | 'blur' }) => void
}): ReactNode {
  const pct = observedProgressPercent(observation)
  const isPlaying = observation?.playerState === 'playing'

  return (
    <div style={{ maxWidth: 1120, margin: '0 auto' }}>
      {message && (
        <div style={{ marginBottom: 14 }}>
          <Notice tone={message.startsWith('失败') ? 'error' : 'info'}>{message}</Notice>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 20, alignItems: 'start' }}>
        {/* ---------------- 左：播放器 + 控制条 ---------------- */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          <div className="player-stage" style={{ padding: 0 }}>
            {/* 原生 WebContentsView 渲染区 */}
            <div ref={viewportRef} className="viewport" data-testid="video-viewport" />

            {/* 顶部信息条：放在原生视图外（上方），避免被覆盖 */}
            <div
              style={{
                position: 'absolute',
                top: 16,
                left: 16,
                right: 16,
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                gap: 12,
                pointerEvents: 'none',
                zIndex: 5
              }}
            >
              <div style={{ minWidth: 0 }}>
                <span
                  style={{
                    padding: '4px 12px',
                    borderRadius: 999,
                    background: 'rgb(255 255 255 / 0.15)',
                    backdropFilter: 'blur(12px)',
                    fontSize: 11,
                    fontWeight: 500
                  }}
                >
                  {courseName ?? `${platformName} · 未选择课程`}
                </span>
                <h3
                  style={{
                    fontSize: 14,
                    fontWeight: 500,
                    margin: '8px 0 0',
                    color: 'rgb(255 255 255 / 0.95)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {chapterName ?? '尚未打开视频任务'}
                </h3>
              </div>
            </div>

            {/* 底部进度与状态：同样在原生视图外 */}
            <div
              style={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                padding: 16,
                background: 'linear-gradient(to top, rgb(2 6 23 / 0.85), transparent)',
                pointerEvents: 'none',
                zIndex: 5
              }}
            >
              <div className="progress-track">
                <div
                  className="progress-fill"
                  style={{ width: `${pct ?? 0}%` }}
                  data-testid="player-progress"
                />
              </div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginTop: 8,
                  fontSize: 11
                }}
              >
                <span style={{ color: 'rgb(255 255 255 / 0.8)' }}>
                  {observation
                    ? `${fmtDuration(observation.currentTimeSeconds)} / ${fmtDuration(observation.durationSeconds)}`
                    : '播放器未观测'}
                </span>
                <span style={{ color: 'rgb(255 255 255 / 0.8)' }}>
                  本地观测进度 {pct === null ? '—' : `${pct.toFixed(1)}%`}
                </span>
              </div>
            </div>
          </div>

          {/* 控制条（原生视图之外） */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              flexWrap: 'wrap',
              padding: '10px 14px',
              borderRadius: 'var(--r-block)',
              background: 'var(--ch-surface)',
              border: '1px solid var(--ch-border)'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                type="button"
                className="btn btn-primary"
                style={{ width: 40, height: 40, padding: 0, borderRadius: 999 }}
                onClick={() => onCommand(isPlaying ? 'pause' : 'play')}
                disabled={busy !== null}
                title={isPlaying ? '暂停' : '播放'}
                data-testid="btn-play"
              >
                {busy === 'play' || busy === 'pause' ? (
                  <Loader2 size={16} className="spin" />
                ) : isPlaying ? (
                  <Pause size={16} />
                ) : (
                  <Play size={16} style={{ marginLeft: 2 }} />
                )}
              </button>

              <button
                type="button"
                className="icon-btn plain"
                onClick={() => onCommand(autoMute ? 'unmute' : 'mute')}
                disabled={busy !== null}
                title={autoMute ? '取消静音' : '静音'}
              >
                {autoMute ? <VolumeX size={15} /> : <Volume2 size={15} />}
              </button>

              <span style={{ fontSize: 11, color: 'var(--ch-text-2)', minWidth: 52 }}>
                {autoMute ? '已静音' : '声音开启'}
              </span>
            </div>

            {/* 音量 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ fontSize: 11, color: 'var(--ch-text-2)' }}>音量</label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={volume}
                onChange={(e) => onVolumeChange(Number(e.target.value))}
                style={{ width: 90, accentColor: 'var(--ch-accent)' }}
                aria-label="音量"
              />
              <button
                type="button"
                className="btn"
                onClick={() => onCommand('setVolume', volume)}
                disabled={busy !== null}
              >
                应用
              </button>
            </div>

            {/* 倍速：平台白名单 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 11, color: 'var(--ch-text-2)', marginRight: 2 }}>倍速</span>
              <div className="scene-nav" style={{ background: 'var(--ch-page)' }}>
                {ALLOWED_PLAYBACK_RATES.map((r) => (
                  <button
                    key={r}
                    type="button"
                    className="scene-pill"
                    aria-current={rate === r}
                    onClick={() => onRateChange(r)}
                    style={rate === r ? { background: 'var(--ch-accent)', color: 'var(--ch-on-accent)' } : undefined}
                  >
                    {r}x
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* 双状态对照 */}
          <Card title="播放器状态 / 平台任务状态（互相独立）">
            <Rows
              items={[
                {
                  k: '播放器状态',
                  v: (
                    <span data-testid="player-state">
                      {observation?.playerState ?? '未观测'}
                      {observation && (
                        <span className="chip chip-neutral" style={{ marginLeft: 8 }}>
                          {observation.origin}
                        </span>
                      )}
                    </span>
                  )
                },
                {
                  k: '平台任务状态',
                  v: <CapChip state="unverified" reason="平台接口未在真实账号验证，故不显示任何完成状态" />
                },
                {
                  k: '观测时间',
                  v: observation ? new Date(observation.observedAt).toLocaleTimeString() : '—',
                  mono: true
                }
              ]}
            />
            <div style={{ marginTop: 12 }}>
              <Notice tone="warn">
                播放器 <code>ended</code> 只代表本机媒体播完，<strong>不会</strong>
                把平台任务状态改成「已完成」。平台状态只能由平台接口返回。
              </Notice>
            </div>
          </Card>
        </div>

        {/* ---------------- 右：章节目录 ---------------- */}
        <Card>
          <header style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <div>
                <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>章节目录</h3>
                <p style={{ fontSize: 11, color: 'var(--ch-text-2)', margin: '3px 0 0' }}>
                  {continuous ? '播完本集自动切下一集' : '连续播放已关闭'}
                </p>
              </div>
              <span className="chip chip-tint">
                {tasks.filter((t) => t.platformStatus === 'completed').length}/{tasks.length || '—'}
              </span>
            </div>
          </header>

          {tasks.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div
                style={{
                  padding: 20,
                  borderRadius: 'var(--r-block)',
                  background: 'var(--ch-subtle)',
                  textAlign: 'center'
                }}
              >
                <Film size={22} style={{ color: 'var(--ch-text-3)', opacity: 0.6 }} />
                <p style={{ fontSize: 11.5, color: 'var(--ch-text-2)', margin: '10px 0 0', lineHeight: 1.7 }}>
                  当前平台没有已验证的视频任务来源。
                  <br />
                  可加载测试台 fixture 验证播放器观测能力。
                </p>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ marginTop: 14 }}
                  onClick={onLoadFixture}
                  data-testid="btn-load-fixture"
                >
                  <Play size={14} />
                  加载测试视频任务
                </button>
              </div>
              <Notice tone="info">
                测试台使用随包分发的本地 fixture（真实 8 秒 MP4），
                用于验证播放/暂停/进度观测，不产生任何平台学习记录。
              </Notice>
            </div>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {tasks.map((t) => {
                const active = t.id === activeTaskId
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      className="chapter-item"
                      style={{
                        width: '100%',
                        border: 'none',
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                        textAlign: 'left'
                      }}
                      aria-current={active}
                      onClick={() => onSelectTask(t.id)}
                      data-task={t.id}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                        {t.platformStatus === 'completed' ? (
                          <CheckCircle2 size={16} style={{ color: 'var(--ch-emerald-600)', flexShrink: 0 }} />
                        ) : active ? (
                          <Play size={16} style={{ flexShrink: 0, fill: 'currentColor' }} />
                        ) : (
                          <Clock size={16} style={{ color: 'var(--ch-text-3)', flexShrink: 0 }} />
                        )}
                        <span style={{ minWidth: 0 }}>
                          <span
                            style={{
                              display: 'block',
                              fontSize: 12,
                              fontWeight: 500,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap'
                            }}
                          >
                            {t.order !== null ? `${t.order}. ` : ''}
                            {t.title}
                          </span>
                        </span>
                      </span>
                      <span style={{ fontSize: 10.5, flexShrink: 0, opacity: 0.75 }}>
                        {fmtDuration(t.durationSeconds)}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

          {/* 下一任务 / 停止 */}
          {tasks.length > 0 && (
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button
                type="button"
                className="btn"
                style={{ flex: 1 }}
                onClick={() => onCommand('stop')}
                disabled={busy !== null}
                title="停止当前播放并复位"
              >
                <Square size={13} />
                停止
              </button>
              <button
                type="button"
                className="btn btn-primary"
                style={{ flex: 1 }}
                onClick={() => {
                  const idx = tasks.findIndex((t) => t.id === activeTaskId)
                  const next = tasks[idx + 1]
                  if (next) onSelectTask(next.id)
                }}
                disabled={!tasks.some((_, i) => i === tasks.findIndex((t) => t.id === activeTaskId) + 1)}
                title="打开下一任务"
                data-testid="btn-next"
              >
                <SkipForward size={13} />
                下一任务
              </button>
            </div>
          )}

          {!continuous && tasks.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <Notice tone="warn">
                <AlertTriangle size={12} style={{ display: 'inline', marginRight: 4, verticalAlign: -1 }} />
                连续播放已关闭，播完不会自动切换。
              </Notice>
            </div>
          )}

          {/* 页面生命周期与失焦测试 */}
          <div style={{ marginTop: 14 }}>
            <Card title="生命周期与失焦测试（测试台）">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn"
                    style={{ fontSize: 11, flex: 1 }}
                    onClick={() => onSimulateLifecycle?.({ focus: 'blur' })}
                  >
                    模拟失焦 (Blur)
                  </button>
                  <button
                    type="button"
                    className="btn"
                    style={{ fontSize: 11, flex: 1 }}
                    onClick={() => onSimulateLifecycle?.({ visibility: 'hidden' })}
                  >
                    切入后台 (Hidden)
                  </button>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn"
                    style={{ fontSize: 11, flex: 1 }}
                    onClick={() => onSimulateLifecycle?.({ visibility: 'visible', focus: 'focus' })}
                  >
                    恢复前台 (Visible)
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ fontSize: 11, flex: 1 }}
                    onClick={() => onCommand('seek', 7.5)}
                    title="跳转到 7.5s 快速验证自然 ended 连播"
                  >
                    快进至 7.5s
                  </button>
                </div>
              </div>
            </Card>
          </div>
        </Card>
      </div>
    </div>
  )
}
