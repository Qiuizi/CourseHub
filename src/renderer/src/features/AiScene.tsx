import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Send,
  Square,
  Sparkles,
  Image as ImageIcon,

  Copy,
  Check,
  Trash2,
  AlertTriangle,
  ClipboardList
} from 'lucide-react'
import type { AIResult, ClassroomQuestion } from '@shared/types'
import { Card, Notice, CapChip, Empty } from '../components/ui'
import { buildTestPlan, validatePlanAgainstQuestion, isTestableType } from '@shared/question'

type Role = 'user' | 'ai' | 'system'

interface Turn {
  id: string
  role: Role
  text: string
  model?: string
  at: string
  streaming?: boolean
  /** 附带截图时的预览 data URL（不落盘） */
  imagePreview?: string | null
}

export interface AiSceneProps {
  models: { id: string; inputModalities: readonly string[] }[]
  modelError: string | null
  onRefreshModels: () => void
  onGenerate: (input: {
    model: string
    systemPrompt: string
    userText: string
    imageDataUrl?: string | null
  }) => Promise<{ ok: boolean; data?: { cancelled: boolean; result: AIResult | null; error?: string }; error?: { code: string; message: string } }>
  onCancel: () => void
  /** 从当前平台页提取题目（仅隔离测试页可用） */
  onExtractQuestions: () => Promise<ClassroomQuestion[]>
  onOpenSettings: () => void
}

const SYSTEM_PROMPT = `你是 CourseHub 课堂助手。规则：
1. 只依据用户提供的题干与选项作答，不引入外部假设。
2. 给出建议选项、简要解析，并明确说明不确定性。
3. 若题干信息不足或图片不清晰，直接说"无法确定"，不要猜。
4. 用简体中文回答，控制在 300 字以内。`

/**
 * DeepSeek 课堂助手。
 *
 * 形态对齐成熟 AI 助手：多轮对话、流式输出、可取消。
 * API Key / 模型发现 / 连通性测试移到设置页，不占据主界面。
 */
export function AiScene({
  models,
  modelError,
  onRefreshModels,
  onGenerate,
  onCancel,
  onExtractQuestions,
  onOpenSettings
}: AiSceneProps): ReactNode {
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [image, setImage] = useState<string | null>(null)
  const [imageName, setImageName] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [questions, setQuestions] = useState<ClassroomQuestion[]>([])
  const [extractMsg, setExtractMsg] = useState<string | null>(null)
  const [previewPlan, setPreviewPlan] = useState<{ question: ClassroomQuestion; keys: string[] } | null>(null)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const activeAiId = useRef<string | null>(null)

  const visionModel = models.find((m) => m.inputModalities.includes('image'))
  const textModel = models.find((m) => m.inputModalities.includes('text')) ?? models[0] ?? null

  // 流式增量
  useEffect(() => {
    const off = window.coursehub.events.onAiDelta((chunk) => {
      const id = activeAiId.current
      if (!id) return
      setTurns((prev) =>
        prev.map((t) => (t.id === id ? { ...t, text: t.text + chunk } : t))
      )
    })
    return off
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [turns])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text && !image) return
    if (!textModel) {
      setTurns((p) => [
        ...p,
        {
          id: `s-${Date.now()}`,
          role: 'system',
          text: '尚未发现可用模型。请先在设置页配置 DeepSeek API Key 并拉取模型列表。',
          at: new Date().toISOString()
        }
      ])
      return
    }
    if (image && !visionModel) {
      setTurns((p) => [
        ...p,
        {
          id: `s-${Date.now()}`,
          role: 'system',
          text: `当前模型 ${textModel.id} 未声明支持图片输入（/models 的 input_modalities 不含 image）。请改用文字题干，或在设置页选择支持图片的模型。`,
          at: new Date().toISOString()
        }
      ])
      return
    }

    const userId = `u-${Date.now()}`
    const aiId = `a-${Date.now()}`
    activeAiId.current = aiId

    setTurns((p) => [
      ...p,
      { id: userId, role: 'user', text: text || '（仅截图提问）', at: new Date().toISOString(), imagePreview: image },
      { id: aiId, role: 'ai', text: '', model: textModel.id, at: new Date().toISOString(), streaming: true }
    ])
    setInput('')
    setImage(null)
    setImageName(null)
    setBusy(true)

    try {
      const res = await onGenerate({
        model: image ? (visionModel?.id ?? textModel.id) : textModel.id,
        systemPrompt: SYSTEM_PROMPT,
        userText: text || '请读取截图中的题目与选项，给出建议答案与解析。',
        imageDataUrl: image
      })
      if (!res.ok) {
        const code = res.error?.code ?? 'UNKNOWN'
        const msg = res.error?.message ?? '未知错误'
        setTurns((p) =>
          p.map((t) => (t.id === aiId ? { ...t, text: `请求失败：${code} ${msg}`, streaming: false } : t))
        )
        return
      }
      if (res.data?.cancelled) {
        setTurns((p) =>
          p.map((t) =>
            t.id === aiId ? { ...t, text: t.text || '（已取消生成）', streaming: false } : t
          )
        )
        return
      }
      if (res.data?.error) {
        const errText = res.data.error
        setTurns((p) =>
          p.map((t) => (t.id === aiId ? { ...t, text: `失败：${errText}`, streaming: false } : t))
        )
        return
      }
      const r = res.data?.result
      setTurns((p) =>
        p.map((t) =>
          t.id === aiId
            ? {
                ...t,
                text: r ? formatResult(r) : '模型未返回内容',
                streaming: false,
                model: r?.model ?? t.model
              }
            : t
        )
      )
    } finally {
      setBusy(false)
      activeAiId.current = null
    }
  }, [input, image, textModel, visionModel, onGenerate])

  const onPickImage = useCallback((file: File | undefined) => {
    if (!file) return
    // 只接受官方支持的四种格式
    if (!/^image\/(jpeg|png|gif|webp)$/i.test(file.type)) {
      setExtractMsg('仅支持 JPEG / PNG / GIF / WebP 格式的图片')
      return
    }
    if (file.size > 8 * 1024 * 1024) {
      setExtractMsg('图片过大（上限 8 MB），请裁剪后重试')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      setImage(String(reader.result))
      setImageName(file.name)
      setExtractMsg(null)
    }
    reader.readAsDataURL(file)
  }, [])

  const extract = useCallback(async () => {
    setExtractMsg(null)
    try {
      const qs = await onExtractQuestions()
      setQuestions(qs)
      if (qs.length === 0) {
        setExtractMsg('未在页面提取到题目。请先切到「平台浏览」并打开授权测试页（测试台 fixture）。')
      } else {
        setExtractMsg(`已提取 ${qs.length} 道题目`)
      }
    } catch {
      setExtractMsg('题目提取失败：页面可能不是授权的测试页')
    }
  }, [onExtractQuestions])

  const copyAll = useCallback(() => {
    const text = turns
      .filter((t) => t.role !== 'system')
      .map((t) => `${t.role === 'user' ? '我' : 'AI'}：${t.text}`)
      .join('\n\n')
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    })
  }, [turns])

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16, height: '100%' }}>
      <Card
        title="课堂助手"
        action={
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="btn" onClick={onRefreshModels} title="重新拉取 /models">
              刷新模型
            </button>
            <button type="button" className="btn btn-ghost" onClick={onOpenSettings}>
              密钥与模型设置
            </button>
          </div>
        }
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: 'var(--ch-text-2)' }}>当前模型</span>
          {textModel ? (
            <span className="chip chip-tint" data-testid="ai-current-model">
              {textModel.id}
              {textModel.inputModalities.includes('image') ? ' · 支持图片' : ' · 仅文本'}
            </span>
          ) : (
            <CapChip state="unsupported" compact />
          )}
          {modelError && (
            <span style={{ fontSize: 11, color: '#b91c1c' }}>{modelError}</span>
          )}
        </div>
      </Card>

      {/* 对话区 */}
      <Card style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 320, padding: 16 }}>
        <div
          ref={scrollRef}
          data-testid="ai-turns"
          style={{
            flex: 1,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            paddingRight: 4
          }}
        >
          {turns.length === 0 ? (
            <Empty
              icon={<Sparkles size={22} />}
              text="把课堂题目粘贴进来，或截图后发送。助手会给出建议选项、解析与不确定性说明。模型建议不等于标准答案。"
            />
          ) : (
            turns.map((t) => (
              <div key={t.id} style={{ display: 'flex', flexDirection: 'column', alignItems: t.role === 'user' ? 'flex-end' : 'flex-start' }}>
                {t.imagePreview && (
                  <img
                    src={t.imagePreview}
                    alt="用户发送的截图"
                    style={{
                      maxWidth: 240,
                      maxHeight: 160,
                      borderRadius: 'var(--r-block)',
                      marginBottom: 6,
                      border: '1px solid var(--ch-border)'
                    }}
                  />
                )}
                <div className={`bubble ${t.role}`}>
                  {t.text}
                  {t.streaming && <span className="pulse" style={{ marginLeft: 4 }}>▍</span>}
                </div>
                {t.model && (
                  <span style={{ fontSize: 10, color: 'var(--ch-text-3)', marginTop: 3 }}>
                    {t.model} · {new Date(t.at).toLocaleTimeString()}
                  </span>
                )}
              </div>
            ))
          )}
        </div>

        {/* 截图预览 */}
        {image && (
          <div
            style={{
              marginTop: 10,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: 10,
              borderRadius: 'var(--r-block)',
              background: 'var(--ch-subtle)',
              border: '1px solid var(--ch-border)'
            }}
          >
            <img
              src={image}
              alt="待发送截图预览"
              style={{ width: 64, height: 48, objectFit: 'cover', borderRadius: 8 }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 500 }}>{imageName ?? '截图'}</div>
              <div style={{ fontSize: 10, color: 'var(--ch-text-2)' }}>
                发送前预览 · 不会自动上传，需你点击发送
              </div>
            </div>
            <button type="button" className="btn" onClick={() => { setImage(null); setImageName(null) }}>
              移除
            </button>
          </div>
        )}

        {/* 输入区 */}
        <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            style={{ display: 'none' }}
            onChange={(e) => onPickImage(e.target.files?.[0])}
            data-testid="ai-image-input"
          />
          <button
            type="button"
            className="icon-btn"
            title="附加截图（JPEG/PNG/GIF/WebP）"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
          >
            <ImageIcon size={16} />
          </button>

          <textarea
            className="field"
            rows={2}
            placeholder="输入题目或问题，Enter 发送，Shift+Enter 换行"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
            disabled={busy}
            data-testid="ai-input"
            style={{ resize: 'none' }}
          />

          {busy ? (
            <button type="button" className="btn btn-primary" onClick={onCancel} data-testid="ai-cancel">
              <Square size={14} />
              停止
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void send()}
              disabled={!input.trim() && !image}
              data-testid="ai-send"
            >
              <Send size={14} />
              发送
            </button>
          )}
        </div>

        {turns.length > 0 && (
          <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
            <button type="button" className="btn btn-ghost" style={{ fontSize: 11 }} onClick={copyAll}>
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {copied ? '已复制' : '复制对话'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ fontSize: 11 }}
              onClick={() => { setTurns([]); setQuestions([]); setPreviewPlan(null) }}
            >
              <Trash2 size={12} />
              清空
            </button>
          </div>
        )}
      </Card>

      {/* 题目提取与受控测试 */}
      <Card
        title="课堂题目与受控表单测试"
        action={
          <button type="button" className="btn" onClick={() => void extract()} data-testid="ai-extract">
            <ClipboardList size={13} />
            提取当前页题目
          </button>
        }
      >
        {extractMsg && (
          <div style={{ marginBottom: 10 }}>
            <Notice tone={extractMsg.includes('失败') || extractMsg.includes('未') ? 'warn' : 'ok'}>
              {extractMsg}
            </Notice>
          </div>
        )}

        {questions.length === 0 ? (
          <p style={{ fontSize: 11.5, color: 'var(--ch-text-2)', margin: 0, lineHeight: 1.7 }}>
            切换到「平台浏览 → 测试台」打开授权测试页后，可在此提取题目并做受控表单交互验证。
            真实独立计分作业与考试<strong>不接入</strong>自动提交。
          </p>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {questions.map((q) => {
              const testable = isTestableType(q.questionType)
              return (
                <li
                  key={q.id}
                  style={{
                    padding: 12,
                    borderRadius: 'var(--r-block)',
                    background: 'var(--ch-subtle)',
                    border: '1px solid var(--ch-border)'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span className="chip chip-neutral">{q.id}</span>
                    <span className="chip chip-tint">{q.questionType}</span>
                    {!testable && <CapChip state="unsupported" compact reason="题型不在测试白名单" />}
                  </div>
                  <p style={{ fontSize: 12, margin: '0 0 8px', lineHeight: 1.6 }}>
                    {q.extractedText ?? '（无可提取题干文本）'}
                  </p>
                  {q.options.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {q.options.map((o) => (
                        <span key={o.key} className="chip">
                          {o.key}. {o.label.trim()}
                        </span>
                      ))}
                    </div>
                  )}
                  {testable && (
                    <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {q.options.slice(0, 4).map((o) => (
                        <button
                          key={o.key}
                          type="button"
                          className="btn"
                          style={{ fontSize: 11 }}
                          onClick={() => setPreviewPlan({ question: q, keys: [o.key] })}
                        >
                          预览选 {o.key}
                        </button>
                      ))}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        {previewPlan && <PlanPreview plan={previewPlan} onClose={() => setPreviewPlan(null)} />}
      </Card>
    </div>
  )
}

/** 受控动作预览：先给用户看将要做什么，确认后才允许执行。 */
function PlanPreview({
  plan,
  onClose
}: {
  plan: { question: ClassroomQuestion; keys: string[] }
  onClose: () => void
}): ReactNode {
  const actionPlan = buildTestPlan({
    question: plan.question,
    optionKeys: plan.keys,
    textValue: null,
    kind: 'preview_fill'
  })
  const check = validatePlanAgainstQuestion(actionPlan, plan.question)

  return (
    <div style={{ marginTop: 12 }}>
      <Notice tone={check.valid ? 'warn' : 'error'}>
        <AlertTriangle size={12} style={{ display: 'inline', marginRight: 4, verticalAlign: -1 }} />
        <strong>预览（未修改页面）</strong>
        <br />
        目标题目：{plan.question.id} · 拟选 {plan.keys.join(', ')}
        <br />
        {check.valid
          ? '计划合法。执行需要在测试页上二次确认，且只会在隔离测试页生效。'
          : `计划不合法：${check.reason}`}
      </Notice>
      <button type="button" className="btn btn-ghost" style={{ marginTop: 8, fontSize: 11 }} onClick={onClose}>
        关闭预览
      </button>
    </div>
  )
}

function formatResult(r: AIResult): string {
  const parts: string[] = []
  if (r.isMock) {
    parts.push('【Mock 模拟分析】（离线模拟数据，未扣除真实 API 配额）')
  }
  if (r.explanation.trim()) parts.push(r.explanation.trim())
  if (r.suggestedAnswer) parts.push(`\n建议答案：${r.suggestedAnswer}`)
  if (r.uncertainty) parts.push(`\n不确定性：${r.uncertainty}`)
  if (r.usage && (r.usage.promptTokens !== null || r.usage.completionTokens !== null)) {
    parts.push(`\nToken 消耗：输入 ${r.usage.promptTokens ?? '—'} / 输出 ${r.usage.completionTokens ?? '—'}`)
  }
  return parts.join('\n')
}

