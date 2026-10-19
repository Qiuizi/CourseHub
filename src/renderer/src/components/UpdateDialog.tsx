/**
 * CourseHub 软件更新提示对话框 (UpdateDialog)。
 *
 * 遵循设计规范：
 * - 圆角 28px (var(--r-modal)), 阴影 (var(--sh-modal)), 严格适配浅色/深色主题。
 * - 覆盖更新各阶段：发现新版本、下载中（进度与速度）、下载完成（立即重启/下次启动安装）、更新失败（官方 Release 兜底链接）。
 * - 默认不强制升级，支持稍后提醒与后台静默下载。
 */

import { type ReactNode } from 'react'
import {
  Sparkles,
  Download,
  RotateCw,
  Clock,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
  X
} from 'lucide-react'
import type { UpdateState } from '@shared/updater'
import { formatBytes, formatSpeed } from '@shared/updater'
import { Notice } from './ui'

export interface UpdateDialogProps {
  state: UpdateState
  open: boolean
  onClose: () => void
  onStartDownload: () => void
  onInstallNow: () => void
  onToggleInstallOnQuit: (val: boolean) => void
  onOpenReleasePage: () => void
  busyWarning?: string | null
}

export function UpdateDialog({
  state,
  open,
  onClose,
  onStartDownload,
  onInstallNow,
  onToggleInstallOnQuit,
  onOpenReleasePage,
  busyWarning
}: UpdateDialogProps): ReactNode {
  if (!open) return null

  const isDownloading = state.status === 'downloading'
  const isDownloaded = state.status === 'downloaded'
  const isError = state.status === 'error'
  const isAvailable = state.status === 'available'

  const progress = state.progress || { percent: 0, bytesPerSecond: 0, transferred: 0, total: 0 }
  const info = state.info

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        backgroundColor: 'rgba(15, 23, 42, 0.45)',
        backdropFilter: 'blur(3px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20
      }}
      data-testid="update-dialog"
    >
      <div
        style={{
          width: '100%',
          maxWidth: 520,
          backgroundColor: 'var(--ch-surface)',
          borderRadius: 'var(--r-modal)',
          border: '1px solid var(--ch-border)',
          boxShadow: 'var(--sh-modal)',
          padding: 24,
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          gap: 16
        }}
      >
        {/* 关闭按钮（稍后提醒） */}
        <button
          type="button"
          className="btn btn-ghost"
          style={{
            position: 'absolute',
            top: 16,
            right: 16,
            padding: 6,
            borderRadius: '999px',
            color: 'var(--ch-text-3)'
          }}
          onClick={onClose}
          title="关闭 / 稍后提醒"
          data-testid="update-dialog-close"
        >
          <X size={16} />
        </button>

        {/* 头部：图标与主标题 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 'var(--r-block)',
              backgroundColor: isDownloaded
                ? 'var(--ch-emerald-50)'
                : isError
                  ? '#fee2e2'
                  : 'var(--ch-accent-tint)',
              color: isDownloaded
                ? 'var(--ch-emerald-700)'
                : isError
                  ? '#b91c1c'
                  : 'var(--ch-accent)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            {isDownloaded ? (
              <CheckCircle2 size={22} />
            ) : isError ? (
              <AlertCircle size={22} />
            ) : isDownloading ? (
              <Download size={22} className="spin" />
            ) : (
              <Sparkles size={22} />
            )}
          </div>

          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <h3 style={{ fontSize: 16, fontWeight: 600, margin: 0, color: 'var(--ch-text)' }}>
                {isDownloaded
                  ? '新版本已就绪'
                  : isDownloading
                    ? '正在下载更新'
                    : isError
                      ? '更新检查遇到问题'
                      : '发现 CourseHub 新版本'}
              </h3>
              <span className="chip chip-tint" style={{ fontSize: 10 }}>
                {state.channel === 'beta' ? 'Beta 公测渠道' : '正式版'}
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--ch-text-2)' }}>
                当前版本: <code>v{state.currentVersion}</code>
              </span>
              {info?.version && (
                <>
                  <span style={{ color: 'var(--ch-text-3)', fontSize: 11 }}>➔</span>
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: 'var(--ch-accent)'
                    }}
                  >
                    最新: <code>v{info.version}</code>
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* 任务互斥告警（连续播放、AI 生成、课堂定位中） */}
        {busyWarning && (
          <Notice tone="warn">
            <strong>暂缓提醒：</strong>
            {busyWarning}
          </Notice>
        )}

        {/* 状态 1: 发现新版本，待下载 */}
        {isAvailable && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--ch-text-2)' }}>
              更新说明 (Release Notes)：
            </div>
            <div
              style={{
                backgroundColor: 'var(--ch-content)',
                border: '1px solid var(--ch-border)',
                borderRadius: 'var(--r-block)',
                padding: '12px 14px',
                fontSize: 11.5,
                lineHeight: 1.7,
                maxHeight: 180,
                overflowY: 'auto',
                whiteSpace: 'pre-wrap',
                color: 'var(--ch-text)',
                fontFamily: 'inherit'
              }}
              data-testid="update-release-notes"
            >
              {info?.releaseNotes || '包含常规功能优化、稳定性提升与缺陷修复。'}
            </div>
          </div>
        )}

        {/* 状态 2: 正在下载 */}
        {isDownloading && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
              <span style={{ color: 'var(--ch-text-2)' }}>下载进度</span>
              <span style={{ fontWeight: 600, color: 'var(--ch-accent)' }}>
                {progress.percent.toFixed(1)}%
              </span>
            </div>

            {/* 进度条 */}
            <div
              style={{
                width: '100%',
                height: 8,
                borderRadius: 999,
                backgroundColor: 'var(--ch-subtle)',
                border: '1px solid var(--ch-border)',
                overflow: 'hidden'
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${Math.min(100, Math.max(0, progress.percent))}%`,
                  backgroundColor: 'var(--ch-progress)',
                  borderRadius: 999,
                  transition: 'width 0.2s ease'
                }}
              />
            </div>

            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: 11,
                color: 'var(--ch-text-3)'
              }}
            >
              <span>速度: {formatSpeed(progress.bytesPerSecond)}</span>
              <span>
                {formatBytes(progress.transferred)} / {formatBytes(progress.total)}
              </span>
            </div>

            <div style={{ fontSize: 11, color: 'var(--ch-text-3)' }}>
              下载在后台进行，你可以关闭此弹窗继续使用 CourseHub，下载完成后会再次提醒。
            </div>
          </div>
        )}

        {/* 状态 3: 下载完成已就绪 */}
        {isDownloaded && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <p style={{ fontSize: 12, color: 'var(--ch-text)', lineHeight: 1.7, margin: 0 }}>
              新版本安装包已成功下载并完成 SHA-512 校验。更新将直接覆盖当前安装目录，
              <strong>你的平台登录状态、Session Cookies 与 DeepSeek 加密配置将完整保留</strong>。
            </p>

            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 12,
                color: 'var(--ch-text-2)',
                cursor: 'pointer',
                marginTop: 4
              }}
            >
              <input
                type="checkbox"
                checked={state.isInstallOnQuit}
                onChange={(e) => onToggleInstallOnQuit(e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              下次完全退出软件时自动安装（不立即重启）
            </label>
          </div>
        )}

        {/* 状态 4: 出错 */}
        {isError && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Notice tone="error">
              <strong>{state.error?.code || 'UPDATE_ERROR'}</strong>: {state.error?.message}
            </Notice>
            <p style={{ fontSize: 11, color: 'var(--ch-text-3)', margin: 0, lineHeight: 1.6 }}>
              受网络环境或代理影响，可能无法直连 GitHub Releases API。你可以前往 Releases 页面直接下载最新安装包手动覆盖安装。
            </p>
          </div>
        )}

        {/* 底部操作按钮 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 10,
            marginTop: 8
          }}
        >
          {isAvailable && (
            <>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={onClose}
                data-testid="update-remind-later"
              >
                <Clock size={13} />
                稍后提醒
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={onStartDownload}
                data-testid="update-start-download"
              >
                <Download size={14} />
                立即更新
              </button>
            </>
          )}

          {isDownloading && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              data-testid="update-minimize-download"
            >
              后台下载
            </button>
          )}

          {isDownloaded && (
            <>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  onToggleInstallOnQuit(true)
                  onClose()
                }}
                data-testid="update-install-later"
              >
                下次启动再安装
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={onInstallNow}
                disabled={Boolean(busyWarning)}
                title={busyWarning || '立即重启安装'}
                data-testid="update-install-now"
              >
                <RotateCw size={14} />
                立即重启安装
              </button>
            </>
          )}

          {isError && (
            <>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={onClose}
                data-testid="update-dismiss-error"
              >
                关闭
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={onOpenReleasePage}
                data-testid="update-open-release-page"
              >
                <ExternalLink size={14} />
                前往 GitHub 网页下载
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
