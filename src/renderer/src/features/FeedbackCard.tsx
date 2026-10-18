import { useState, useCallback, useRef } from 'react'
import type { ReactNode, ChangeEvent } from 'react'
import {
  MessageSquarePlus,
  Send,
  FileDown,
  Copy,
  Check,
  Eye,
  X,
  ShieldCheck,
  AlertCircle,
  Upload,
  Camera,
  Globe,
  FolderSync,
  KeyRound,
  PlaySquare,
  BellRing,
  Sparkles,
  ZapOff,
  Layout,
  Loader2
} from 'lucide-react'
import { Card, Notice, Switch } from '../components/ui'
import {
  type FeedbackCategory,
  FEEDBACK_CATEGORIES,
  type DiagnosticPackageData,
  type FeedbackSubmissionResult
} from '@shared/feedback'
import type { PlatformId } from '@shared/types'

export interface FeedbackCardProps {
  activePlatform?: PlatformId
  onNotify: (text: string) => void
  initialCategory?: FeedbackCategory
  initialDescription?: string
}

export function FeedbackCard({
  activePlatform = 'chaoxing',
  onNotify,
  initialCategory = 'course_sync',
  initialDescription = ''
}: FeedbackCardProps): ReactNode {
  const [category, setCategory] = useState<FeedbackCategory>(initialCategory)
  const [description, setDescription] = useState(initialDescription)
  const [reproductionSteps, setReproductionSteps] = useState('')
  const [contact, setContact] = useState('')
  const [attachDiagnostics, setAttachDiagnostics] = useState(false)
  const [anonymousTelemetry, setAnonymousTelemetry] = useState<boolean>(() => {
    try {
      return localStorage.getItem('coursehub_opt_in_anonymous_telemetry') === 'true'
    } catch {
      return false
    }
  })

  const [screenshotBase64, setScreenshotBase64] = useState<string | null>(null)
  const [screenshotSource, setScreenshotSource] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitResult, setSubmitResult] = useState<FeedbackSubmissionResult | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const [showPreview, setShowPreview] = useState(false)
  const [previewData, setPreviewData] = useState<DiagnosticPackageData | null>(null)
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [copiedSummary, setCopiedSummary] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleTelemetryChange = useCallback((val: boolean) => {
    setAnonymousTelemetry(val)
    try {
      localStorage.setItem('coursehub_opt_in_anonymous_telemetry', String(val))
    } catch {}
    onNotify(val ? '已开启匿名平台兼容性反馈' : '已关闭匿名平台兼容性反馈')
  }, [onNotify])

  // 截取客户端应用窗口
  const captureAppWindow = useCallback(async () => {
    try {
      const res = await window.coursehub.diagnostics.captureWindow('feedback')
      if (res.ok && res.data.base64) {
        setScreenshotBase64(res.data.base64)
        setScreenshotSource('应用界面截图')
        onNotify('已成功截取当前软件界面')
      } else {
        onNotify('截图失败')
      }
    } catch {
      onNotify('截图功能发生异常')
    }
  }, [onNotify])

  // 截取内置平台视图
  const capturePlatformView = useCallback(async () => {
    try {
      const res = await window.coursehub.browser.captureView({
        platformId: activePlatform,
        mode: 'viewport'
      })
      if (res.ok && res.data.dataUrl) {
        setScreenshotBase64(res.data.dataUrl)
        setScreenshotSource(`平台(${activePlatform})网页视图`)
        onNotify('已成功截取平台网页视图')
      } else {
        onNotify('未能截取到平台网页视图，请确认平台页面已加载')
      }
    } catch {
      onNotify('平台视图截图失败')
    }
  }, [activePlatform, onNotify])

  // 本地上传图片
  const handleFileUpload = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) {
      onNotify('请选择有效的图片文件（PNG / JPG / WebP）')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setScreenshotBase64(reader.result)
        setScreenshotSource(`本地图片: ${file.name}`)
        onNotify(`已附加图片: ${file.name}`)
      }
    }
    reader.readAsDataURL(file)
  }, [onNotify])

  // 预览脱敏诊断
  const handleOpenPreview = useCallback(async () => {
    setShowPreview(true)
    setLoadingPreview(true)
    try {
      const res = await window.coursehub.diagnostics.getSummary({ activePlatform })
      if (res.ok) {
        setPreviewData(res.data)
      }
    } finally {
      setLoadingPreview(false)
    }
  }, [activePlatform])

  // 提交反馈
  const handleSubmit = useCallback(async () => {
    if (!description.trim() || description.trim().length < 5) {
      setSubmitError('请详细描述你遇到的问题（至少 5 个字）')
      return
    }

    setSubmitting(true)
    setSubmitError(null)
    setSubmitResult(null)

    try {
      const res = await window.coursehub.feedback.submit({
        category,
        description: description.trim(),
        reproductionSteps: reproductionSteps.trim() || undefined,
        contact: contact.trim() || undefined,
        attachDiagnostics,
        screenshotBase64: screenshotBase64 || undefined
      })

      if (res.ok) {
        setSubmitResult(res.data)
        if (res.data.success) {
          onNotify(`反馈提交成功，编号：${res.data.feedbackId}`)
        } else {
          onNotify('在线服务不可用，已导出本地诊断包')
        }
      } else {
        setSubmitError(`${res.error.code}: ${res.error.message}`)
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }, [category, description, reproductionSteps, contact, attachDiagnostics, screenshotBase64, onNotify])

  // 直接导出离线 ZIP
  const handleExportZip = useCallback(async () => {
    try {
      const note = [
        `[分类] ${category}`,
        `[描述] ${description || '（无描述）'}`,
        reproductionSteps ? `[步骤] ${reproductionSteps}` : null,
        contact ? `[联系方式] ${contact}` : null
      ]
        .filter(Boolean)
        .join('\n')

      const res = await window.coursehub.diagnostics.exportZip({
        activePlatform,
        feedbackNote: note,
        screenshotBase64: screenshotBase64 || undefined
      })

      if (res.ok) {
        onNotify(`脱敏诊断包已导出至：${res.data.path}`)
      } else {
        onNotify(`导出失败：${res.error.message}`)
      }
    } catch {
      onNotify('导出诊断包失败')
    }
  }, [activePlatform, category, description, reproductionSteps, contact, screenshotBase64, onNotify])

  // 复制结构化摘要到剪贴板
  const handleCopySummary = useCallback(() => {
    const lines = [
      '【CourseHub 用户反馈】',
      `- 问题分类: ${FEEDBACK_CATEGORIES.find((c) => c.id === category)?.label || category}`,
      `- 问题描述: ${description || '（未填写）'}`,
      reproductionSteps ? `- 复现步骤: ${reproductionSteps}` : null,
      contact ? `- 联系方式: ${contact}` : null,
      `- 当前平台: ${activePlatform}`,
      `- 附带诊断: ${attachDiagnostics ? '是（已脱敏）' : '否'}`
    ]
      .filter(Boolean)
      .join('\n')

    void navigator.clipboard.writeText(lines).then(() => {
      setCopiedSummary(true)
      onNotify('已复制问题摘要到剪贴板')
      setTimeout(() => setCopiedSummary(false), 2500)
    })
  }, [category, description, reproductionSteps, contact, activePlatform, attachDiagnostics, onNotify])

  const renderCategoryIcon = (id: FeedbackCategory) => {
    switch (id) {
      case 'login':
        return <KeyRound size={13} />
      case 'course_sync':
        return <FolderSync size={13} />
      case 'courseware_video':
        return <PlaySquare size={13} />
      case 'activity_signin':
        return <BellRing size={13} />
      case 'ai_assistant':
        return <Sparkles size={13} />
      case 'crash_lag':
        return <ZapOff size={13} />
      case 'ui_display':
        return <Layout size={13} />
      default:
        return <MessageSquarePlus size={13} />
    }
  }

  return (
    <Card title="遇到问题？告诉我们">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* 说明副标题 */}
        <p style={{ fontSize: 11.5, color: 'var(--ch-text-2)', margin: '0 0 4px', lineHeight: 1.6 }}>
          无论是课程无法同步、视频异常还是操作体验问题，均可随时提交。无需注册任何账号，你的建议将帮助 CourseHub 持续完善。
        </p>

        {/* 1. 问题分类药丸组 */}
        <div>
          <label className="label" style={{ fontWeight: 600, marginBottom: 6 }}>
            问题分类 <span style={{ color: '#b91c1c' }}>*</span>
          </label>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8
            }}
          >
            {FEEDBACK_CATEGORIES.map((cat) => {
              const selected = category === cat.id
              return (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => setCategory(cat.id)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '6px 12px',
                    borderRadius: 999,
                    fontSize: 11.5,
                    fontWeight: selected ? 600 : 500,
                    cursor: 'pointer',
                    border: '1px solid',
                    borderColor: selected ? 'var(--ch-accent)' : 'var(--ch-border)',
                    background: selected ? 'var(--ch-accent-tint)' : 'var(--ch-surface)',
                    color: selected ? 'var(--ch-accent)' : 'var(--ch-text)',
                    transition: 'all 0.15s ease'
                  }}
                  title={cat.desc}
                >
                  {renderCategoryIcon(cat.id)}
                  {cat.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* 2. 问题描述 */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <label className="label" style={{ fontWeight: 600, margin: 0 }}>
              问题描述 <span style={{ color: '#b91c1c' }}>*</span>
            </label>
            <span style={{ fontSize: 10.5, color: 'var(--ch-text-3)' }}>
              {description.length} / 500 字
            </span>
          </div>
          <textarea
            className="field"
            rows={3}
            maxLength={500}
            placeholder="请详细描述遇到的具体情况，例如：点击超星课程刷新一直卡在转圈，提示网络解析异常..."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            style={{ resize: 'vertical', lineHeight: 1.6 }}
          />
        </div>

        {/* 3. 复现步骤 (选填) */}
        <div>
          <label className="label" style={{ fontWeight: 600, marginBottom: 4 }}>
            复现步骤 <span style={{ fontSize: 10.5, color: 'var(--ch-text-3)', fontWeight: 400 }}>(选填)</span>
          </label>
          <textarea
            className="field"
            rows={2}
            maxLength={300}
            placeholder="1. 登录超星账号； 2. 进入课程列表点击刷新； 3. 出现红色异常提示"
            value={reproductionSteps}
            onChange={(e) => setReproductionSteps(e.target.value)}
            style={{ resize: 'vertical', lineHeight: 1.6 }}
          />
        </div>

        {/* 4. 附加截图 */}
        <div>
          <label className="label" style={{ fontWeight: 600, marginBottom: 6 }}>
            附加截图 <span style={{ fontSize: 10.5, color: 'var(--ch-text-3)', fontWeight: 400 }}>(选填，有助于快速定位)</span>
          </label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button type="button" className="btn" onClick={() => void captureAppWindow()} style={{ fontSize: 11 }}>
              <Camera size={13} />
              截取软件界面
            </button>
            <button type="button" className="btn" onClick={() => void capturePlatformView()} style={{ fontSize: 11 }}>
              <Globe size={13} />
              截取平台网页
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => fileInputRef.current?.click()}
              style={{ fontSize: 11 }}
            >
              <Upload size={13} />
              选择本地图片
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              style={{ display: 'none' }}
              onChange={handleFileUpload}
            />
          </div>

          {screenshotBase64 && (
            <div
              style={{
                marginTop: 10,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 10,
                padding: '6px 12px',
                borderRadius: 'var(--r-block)',
                background: 'var(--ch-subtle)',
                border: '1px solid var(--ch-border)'
              }}
            >
              <img
                src={screenshotBase64}
                alt="截图预览"
                style={{ width: 44, height: 28, objectFit: 'cover', borderRadius: 4, border: '1px solid var(--ch-border)' }}
              />
              <span style={{ fontSize: 11, color: 'var(--ch-text-2)' }}>
                {screenshotSource || '已附带截图'}
              </span>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ padding: 4 }}
                onClick={() => {
                  setScreenshotBase64(null)
                  setScreenshotSource(null)
                }}
                title="移除截图"
              >
                <X size={13} />
              </button>
            </div>
          )}
        </div>

        {/* 5. 诊断日志与隐私说明 */}
        <div
          style={{
            padding: '12px 14px',
            borderRadius: 'var(--r-block)',
            background: 'var(--ch-subtle)',
            border: '1px solid var(--ch-border)',
            display: 'flex',
            flexDirection: 'column',
            gap: 10
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 11.5,
                color: 'var(--ch-text)',
                cursor: 'pointer',
                userSelect: 'none'
              }}
            >
              <input
                type="checkbox"
                checked={attachDiagnostics}
                onChange={(e) => setAttachDiagnostics(e.target.checked)}
                style={{ accentColor: 'var(--ch-accent)', cursor: 'pointer' }}
              />
              <span style={{ fontWeight: 500 }}>附加已脱敏的系统诊断信息</span>
              <span style={{ fontSize: 10.5, color: 'var(--ch-text-3)' }}>
                （包含系统环境与最近异常，自动抹除个人凭据）
              </span>
            </label>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ fontSize: 11, padding: '2px 8px' }}
              onClick={() => void handleOpenPreview()}
            >
              <Eye size={12} />
              预览诊断内容
            </button>
          </div>

          {/* 独立开关：匿名平台兼容性反馈 */}
          <div
            style={{
              paddingTop: 8,
              borderTop: '1px dashed var(--ch-border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12
            }}
          >
            <div>
              <div style={{ fontSize: 11.5, fontWeight: 500 }}>匿名帮助改进平台兼容性</div>
              <div style={{ fontSize: 10.5, color: 'var(--ch-text-3)', marginTop: 2 }}>
                默认关闭。开启后仅在学习通/雨课堂发生结构异常时上报脱敏错误特征码，绝不包含个人账号或日志。
              </div>
            </div>
            <Switch
              checked={anonymousTelemetry}
              onChange={handleTelemetryChange}
              label="匿名平台兼容性改进"
            />
          </div>
        </div>

        {/* 6. 联系方式 */}
        <div>
          <label className="label" style={{ fontWeight: 600, marginBottom: 4 }}>
            联系方式 <span style={{ fontSize: 10.5, color: 'var(--ch-text-3)', fontWeight: 400 }}>(选填，便于开发者跟进反馈)</span>
          </label>
          <input
            className="field"
            type="text"
            placeholder="QQ / 微信 / 邮箱 (可选)"
            value={contact}
            onChange={(e) => setContact(e.target.value)}
          />
        </div>

        {/* 错误提示 */}
        {submitError && (
          <Notice tone="error">
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <AlertCircle size={14} />
              <span>{submitError}</span>
            </div>
          </Notice>
        )}

        {/* 提交成功或离线兜底状态卡片 */}
        {submitResult && (
          <div style={{ marginTop: 4 }}>
            {submitResult.success ? (
              <Notice tone="ok">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ fontWeight: 600, fontSize: 12 }}>
                    ✓ 反馈已成功提交！反馈编号：<code>{submitResult.feedbackId}</code>
                  </div>
                  <div style={{ fontSize: 11 }}>
                    感谢你的反馈与支持。维护者将在第一时间跟进排查，修复进展将同步到版本更新日志。
                  </div>
                </div>
              </Notice>
            ) : (
              <Notice tone="warn">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ fontWeight: 600, fontSize: 12 }}>
                    ⚠️ 在线反馈服务暂未接通或网络连接受阻
                  </div>
                  <div style={{ fontSize: 11, lineHeight: 1.6 }}>
                    已自动为你保全填写内容并在本地生成脱敏诊断包：
                    <br />
                    <code style={{ wordBreak: 'break-all', fontSize: 10.5 }}>
                      {submitResult.diagnosticZipPath}
                    </code>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--ch-text-2)' }}>
                    你可直接将此 ZIP 文件或点击下方「复制问题摘要」通过微信、QQ、GitHub Issue 或邮件发送给开发者。
                  </div>
                </div>
              </Notice>
            )}
          </div>
        )}

        {/* 底部按钮栏 */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 4 }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void handleSubmit()}
            disabled={submitting || description.trim().length < 5}
          >
            {submitting ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
            提交反馈
          </button>

          <button type="button" className="btn" onClick={() => void handleExportZip()}>
            <FileDown size={14} />
            导出脱敏诊断包 (ZIP)
          </button>

          <button type="button" className="btn" onClick={handleCopySummary}>
            {copiedSummary ? <Check size={14} style={{ color: 'var(--ch-emerald-600)' }} /> : <Copy size={14} />}
            {copiedSummary ? '已复制摘要' : '复制问题摘要'}
          </button>
        </div>
      </div>

      {/* 诊断数据预览模态弹窗 */}
      {showPreview && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: 20
          }}
          onClick={() => setShowPreview(false)}
        >
          <div
            style={{
              width: '100%',
              maxWidth: 620,
              maxHeight: '85vh',
              background: 'var(--ch-surface)',
              borderRadius: 'var(--r-modal)',
              border: '1px solid var(--ch-border)',
              boxShadow: 'var(--sh-modal)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                padding: '16px 20px',
                borderBottom: '1px solid var(--ch-hairline)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <ShieldCheck size={18} style={{ color: 'var(--ch-emerald-600)' }} />
                <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>脱敏诊断信息预览</h3>
              </div>
              <button
                type="button"
                className="icon-btn plain"
                onClick={() => setShowPreview(false)}
                title="关闭"
              >
                <X size={16} />
              </button>
            </div>

            <div style={{ padding: 20, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* 隐私承诺标签 */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <span className="chip chip-emerald" style={{ fontSize: 10 }}>✓ 无 Cookies / 会话</span>
                <span className="chip chip-emerald" style={{ fontSize: 10 }}>✓ 无 API Key / 密码</span>
                <span className="chip chip-emerald" style={{ fontSize: 10 }}>✓ 无真实姓名与学号</span>
                <span className="chip chip-emerald" style={{ fontSize: 10 }}>✓ 无作业与答题内容</span>
                <span className="chip chip-emerald" style={{ fontSize: 10 }}>✓ 用户名路径已替换</span>
              </div>

              {loadingPreview ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '24px 0', justifyContent: 'center' }}>
                  <Loader2 size={16} className="spin" />
                  <span style={{ fontSize: 12, color: 'var(--ch-text-2)' }}>正在构建脱敏诊断快照...</span>
                </div>
              ) : previewData ? (
                <>
                  <Notice tone="info">
                    {previewData.summaryText.split('\n').map((line, i) => (
                      <div key={i}>{line}</div>
                    ))}
                  </Notice>

                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                      最近错误事件 ({previewData.recentErrors.length} 条)
                    </div>
                    {previewData.recentErrors.length === 0 ? (
                      <div style={{ fontSize: 11, color: 'var(--ch-text-3)', padding: '12px 0' }}>
                        当前未记录到任何未处理错误，系统运行正常。
                      </div>
                    ) : (
                      <pre
                        style={{
                          background: 'var(--ch-subtle)',
                          border: '1px solid var(--ch-border)',
                          borderRadius: 'var(--r-block)',
                          padding: 12,
                          fontSize: 10.5,
                          fontFamily: 'ui-monospace, monospace',
                          color: 'var(--ch-text)',
                          maxHeight: 220,
                          overflowY: 'auto',
                          margin: 0,
                          whiteSpace: 'pre-wrap'
                        }}
                      >
                        {previewData.recentErrors
                          .map((e) => `[${e.ts.slice(11, 19)}] [${e.level.toUpperCase()}] [${e.code}] ${e.summary}`)
                          .join('\n')}
                      </pre>
                    )}
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 12, color: 'var(--ch-text-3)' }}>未能加载诊断预览</div>
              )}
            </div>

            <div
              style={{
                padding: '12px 20px',
                borderTop: '1px solid var(--ch-hairline)',
                display: 'flex',
                justifyContent: 'flex-end',
                background: 'var(--ch-subtle)'
              }}
            >
              <button type="button" className="btn btn-primary" onClick={() => setShowPreview(false)}>
                确认并关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </Card>
  )
}
