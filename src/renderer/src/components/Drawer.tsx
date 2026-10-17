import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  Zap,
  MapPin,
  Sparkles,
  Activity,
  Send,
  Square,
  Camera,
  Copy,
  Check,
  RefreshCw,
  Trash2,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Image as ImageIcon,
  Layers,
  Info
} from 'lucide-react'
import { Card, Seg, Switch, Empty, CapChip, Notice } from '../components/ui'
import { observedProgressPercent } from '@shared/video'
import type { PlaybackObservation, AIModelInfo, AIResult, ActiveQuestionContext } from '@shared/types'
import { modelSupportsImage } from '@shared/deepseek'

/** 提交模式。confirm 之外不提供无人值守自动提交。 */
export type SubmitMode = 'confirm' | 'manual'

export interface DrawerAiProps {
  models: AIModelInfo[]
  modelError: string | null
  selectedModelId: string
  onSelectModelId: (id: string) => void
  busy: boolean
  promptText: string
  onChangePromptText: (text: string) => void
  imagePreview: string | null
  imageInfo?: { width: number; height: number; mode: string } | null
  captureNotice?: string | null
  onClearImage: () => void
  onPickImageFile: (file: File) => void
  onExtractFromPage: () => void
  onCaptureFromPage: (mode?: 'viewport' | 'full-question') => void
  onUseEmbeddedImage?: (url: string) => void
  onSubmit: () => void
  onCancel: () => void
  onRegenerate: () => void
  onClearAll: () => void
  streamingText: string
  result: AIResult | null
  error: string | null
  courseName?: string | null
  questionContext?: ActiveQuestionContext | null
  onPrevQuestion?: () => void
  onNextQuestion?: () => void
}

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
  drawerOpen,
  drawerTab = 'ai',
  onDrawerTabChange,
  aiProps
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
  drawerTab?: 'ai' | 'controls'
  onDrawerTabChange?: (tab: 'ai' | 'controls') => void
  aiProps?: DrawerAiProps
}): ReactNode {
  if (!drawerOpen) return null

  const [copied, setCopied] = useState(false)
  const pct = observedProgressPercent(observation)
  const activeTab = drawerTab ?? 'ai'

  const handleCopy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    })
  }

  return (
    <aside className="drawer" data-testid="drawer" aria-label="智能助手侧边栏">
      {/* 选项卡切换：AI 助教 vs 播放与设置 */}
      <div style={{ marginBottom: 12 }}>
        <Seg
          value={activeTab}
          onChange={(t) => onDrawerTabChange?.(t as 'ai' | 'controls')}
          options={[
            { id: 'ai', label: 'AI 课堂助教' },
            { id: 'controls', label: '播放与设置' }
          ]}
        />
      </div>

      {activeTab === 'ai' && aiProps && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* 1. 模型状态卡片 */}
          <Card>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Sparkles size={15} style={{ color: 'var(--ch-accent)' }} />
                <span style={{ fontSize: 12, fontWeight: 600 }}>DeepSeek 助手</span>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {aiProps.modelError ? (
                  <span className="chip chip-neutral" style={{ fontSize: 10 }}>离线参考</span>
                ) : (
                  <span className="chip chip-emerald" style={{ fontSize: 10 }}>在线已验证</span>
                )}
                {aiProps.courseName && (
                  <span className="chip chip-tint" style={{ fontSize: 10 }} title={`当前关联课程：${aiProps.courseName}`}>
                    <BookOpen size={10} style={{ display: 'inline', marginRight: 3 }} />
                    {aiProps.courseName.slice(0, 8)}
                  </span>
                )}
              </div>
            </div>

            {/* 模型选择 */}
            <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11, color: 'var(--ch-text-2)', flexShrink: 0 }}>模型：</span>
              <select
                className="field"
                style={{ padding: '2px 8px', fontSize: 11.5, height: 28, flex: 1 }}
                value={aiProps.selectedModelId}
                onChange={(e) => aiProps.onSelectModelId(e.target.value)}
                data-testid="drawer-model-select"
              >
                {aiProps.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName ? `${m.displayName} (${m.id})` : m.id} {modelSupportsImage(m) ? '📸' : '📝'}
                  </option>
                ))}
              </select>
            </div>

            {/* 一键快捷操作 */}
            <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6 }}>
              <button
                type="button"
                className="btn btn-primary"
                style={{ fontSize: 11, padding: '6px 6px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}
                onClick={aiProps.onExtractFromPage}
                disabled={aiProps.busy}
                data-testid="drawer-extract-btn"
                title="从当前课堂网页中提取可见题目与选项"
              >
                <Sparkles size={12} />
                提取当前题
              </button>
              <button
                type="button"
                className="btn"
                style={{ fontSize: 11, padding: '6px 6px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}
                onClick={() => aiProps.onCaptureFromPage('viewport')}
                disabled={aiProps.busy}
                data-testid="drawer-capture-btn"
                title="截取当前课堂或视频画面（可见视口区域）"
              >
                <Camera size={12} />
                截当前视口
              </button>
              <button
                type="button"
                className="btn"
                style={{ fontSize: 11, padding: '6px 6px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}
                onClick={() => aiProps.onCaptureFromPage('full-question')}
                disabled={aiProps.busy}
                data-testid="drawer-capture-full-btn"
                title="定位并完整截取当前题目区域（含跨视口下半部分与选项）"
              >
                <Layers size={12} />
                完整长题截图
              </button>
              {aiProps.questionContext?.images && aiProps.questionContext.images.length > 0 ? (
                <button
                  type="button"
                  className="btn"
                  style={{ fontSize: 11, padding: '6px 6px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}
                  onClick={() => aiProps.onUseEmbeddedImage?.(aiProps.questionContext!.images![0])}
                  disabled={aiProps.busy}
                  data-testid="drawer-embedded-img-btn"
                  title="使用题目 DOM 中嵌入的原图（公式、示意图或高清原图）"
                >
                  <ImageIcon size={12} />
                  使用内嵌原图
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ fontSize: 11, padding: '6px 6px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}
                  onClick={() => aiProps.onCaptureFromPage('viewport')}
                  disabled={aiProps.busy}
                  title="重新截取可见画面"
                >
                  <RefreshCw size={12} />
                  重新截图
                </button>
              )}
            </div>
          </Card>

          {/* 1.5 绑定题目上下文元数据卡片 */}
          {aiProps.questionContext && (
            <Card>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span className="chip chip-tint" style={{ fontSize: 10 }}>
                    第 {aiProps.questionContext.questionIndex + 1} / {aiProps.questionContext.totalQuestions} 题
                  </span>
                  <span className="chip" style={{ fontSize: 10 }}>
                    {aiProps.questionContext.questionType === 'single'
                      ? '单选题'
                      : aiProps.questionContext.questionType === 'multiple'
                        ? '多选题'
                        : aiProps.questionContext.questionType === 'judgement'
                          ? '判断题'
                          : '主观/填空题'}
                  </span>
                </div>
                {aiProps.questionContext.totalQuestions > 1 && (
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{ padding: '2px 6px', fontSize: 11 }}
                      disabled={aiProps.busy || aiProps.questionContext.questionIndex === 0}
                      onClick={aiProps.onPrevQuestion}
                      data-testid="drawer-prev-question"
                      title="切换上一题"
                    >
                      <ChevronLeft size={12} />
                      上一题
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{ padding: '2px 6px', fontSize: 11 }}
                      disabled={aiProps.busy || aiProps.questionContext.questionIndex >= aiProps.questionContext.totalQuestions - 1}
                      onClick={aiProps.onNextQuestion}
                      data-testid="drawer-next-question"
                      title="切换下一题"
                    >
                      下一题
                      <ChevronRight size={12} />
                    </button>
                  </div>
                )}
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--ch-text-2)', marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
                {aiProps.questionContext.chapterTitle && (
                  <div>当前章节：{aiProps.questionContext.chapterTitle}</div>
                )}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <span>题目ID: {aiProps.questionContext.questionId}</span>
                  <span>提取时间: {new Date(aiProps.questionContext.extractedAt).toLocaleTimeString()}</span>
                </div>
              </div>
            </Card>
          )}

          {/* 2. 待分析题目与图片预览区 */}
          <Card>
            {aiProps.imagePreview && (
              <div
                style={{
                  marginBottom: 10,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  padding: 8,
                  borderRadius: 'var(--r-block)',
                  background: 'var(--ch-subtle)',
                  border: '1px solid var(--ch-border)'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <img
                    src={aiProps.imagePreview}
                    alt="待分析画面预览"
                    style={{ width: 68, height: 48, objectFit: 'cover', borderRadius: 6 }}
                    data-testid="drawer-image-preview"
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 4 }}>
                      已附带截图
                      {aiProps.imageInfo && (
                        <span className="chip" style={{ fontSize: 9.5 }}>
                          {aiProps.imageInfo.width}×{aiProps.imageInfo.height} ({aiProps.imageInfo.mode === 'full-question' ? '长截屏' : '视口'})
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--ch-text-2)' }}>发送前可编辑下方问题与选项</div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ padding: '4px 6px', fontSize: 11 }}
                    onClick={aiProps.onClearImage}
                    disabled={aiProps.busy}
                  >
                    移除
                  </button>
                </div>

                {/* 截图过高或长截屏提示 */}
                {(aiProps.captureNotice || (aiProps.imageInfo && aiProps.imageInfo.height > 1000)) && (
                  <div
                    style={{
                      fontSize: 10.5,
                      color: 'var(--ch-text-1)',
                      background: 'rgba(234, 179, 8, 0.1)',
                      border: '1px solid rgba(234, 179, 8, 0.3)',
                      borderRadius: 4,
                      padding: '4px 6px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4
                    }}
                    data-testid="drawer-capture-notice"
                  >
                    <Info size={11} style={{ color: '#eab308', flexShrink: 0 }} />
                    <span>
                      {aiProps.captureNotice || `长截图已捕获完整题干与选项（${aiProps.imageInfo?.height}px），题干已提取至编辑框。`}
                    </span>
                  </div>
                )}
              </div>
            )}

            <textarea
              className="field"
              rows={3}
              placeholder="输入题目、选项或疑问，支持 Ctrl+V 粘贴截图，Enter 发送"
              value={aiProps.promptText}
              onChange={(e) => aiProps.onChangePromptText(e.target.value)}
              onPaste={(e) => {
                const items = e.clipboardData?.items
                if (!items) return
                for (let i = 0; i < items.length; i++) {
                  const item = items[i]
                  if (item?.type.startsWith('image/')) {
                    const file = item.getAsFile()
                    if (file) {
                      e.preventDefault()
                      aiProps.onPickImageFile(file)
                      break
                    }
                  }
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  if (!aiProps.busy && (aiProps.promptText.trim() || aiProps.imagePreview)) {
                    aiProps.onSubmit()
                  }
                }
              }}
              disabled={aiProps.busy}
              data-testid="drawer-ai-input"
              style={{ resize: 'none', fontSize: 12 }}
            />

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ fontSize: 11, padding: '4px 8px' }}
                onClick={aiProps.onClearAll}
                disabled={aiProps.busy || (!aiProps.promptText && !aiProps.imagePreview && !aiProps.result)}
              >
                <Trash2 size={12} />
                清空
              </button>

              {aiProps.busy ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ fontSize: 11.5, padding: '5px 12px' }}
                  onClick={aiProps.onCancel}
                  data-testid="drawer-ai-cancel"
                >
                  <Square size={13} />
                  停止
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ fontSize: 11.5, padding: '5px 14px' }}
                  onClick={aiProps.onSubmit}
                  disabled={!aiProps.promptText.trim() && !aiProps.imagePreview}
                  data-testid="drawer-ai-send"
                >
                  <Send size={13} />
                  发送分析
                </button>
              )}
            </div>
          </Card>

          {/* 3. 分析结果卡片 */}
          {(aiProps.busy || aiProps.streamingText || aiProps.result || aiProps.error) && (
            <Card title="分析结果与推导">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
                <span
                  className={`chip ${aiProps.result?.isMock ? 'chip-neutral' : 'chip-emerald'}`}
                  style={{ fontSize: 10 }}
                  data-testid="drawer-ai-badge"
                >
                  {aiProps.result?.isMock ? 'Mock 模拟' : 'DeepSeek 实时分析'}
                </span>
                {aiProps.result?.usage && (
                  <span className="chip" style={{ fontSize: 9.5 }}>
                    Token: {aiProps.result.usage.promptTokens ?? 0} in / {aiProps.result.usage.completionTokens ?? 0} out
                  </span>
                )}
              </div>

              {aiProps.error && (
                <div style={{ marginBottom: 8 }}>
                  <Notice tone="error">{aiProps.error}</Notice>
                </div>
              )}

              <div
                style={{
                  fontSize: 12,
                  lineHeight: 1.7,
                  whiteSpace: 'pre-wrap',
                  background: 'var(--ch-subtle)',
                  padding: 10,
                  borderRadius: 'var(--r-block)',
                  border: '1px solid var(--ch-border)',
                  maxHeight: 280,
                  overflowY: 'auto'
                }}
                data-testid="drawer-ai-content"
              >
                {aiProps.streamingText || aiProps.result?.explanation || '等待响应中...'}
                {aiProps.busy && <span className="pulse" style={{ marginLeft: 3 }}>▍</span>}
              </div>

              {aiProps.result?.suggestedAnswer && (
                <div style={{ marginTop: 8, fontSize: 12, fontWeight: 500, color: 'var(--ch-accent)' }}>
                  建议答案：{aiProps.result.suggestedAnswer}
                </div>
              )}

              {!aiProps.busy && (aiProps.result || aiProps.streamingText) && (
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ fontSize: 11 }}
                    onClick={() => handleCopy(aiProps.result?.explanation || aiProps.streamingText)}
                    data-testid="drawer-copy-btn"
                  >
                    {copied ? <Check size={12} /> : <Copy size={12} />}
                    {copied ? '已复制' : '复制解析'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ fontSize: 11 }}
                    onClick={aiProps.onRegenerate}
                    data-testid="drawer-regen-btn"
                  >
                    <RefreshCw size={12} />
                    重新生成
                  </button>
                </div>
              )}
            </Card>
          )}
        </div>
      )}

      {activeTab === 'controls' && (
        <>
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
        </>
      )}
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
