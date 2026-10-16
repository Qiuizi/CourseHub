import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  KeyRound,
  Eye,
  EyeOff,
  RefreshCw,
  Check,
  Trash2,
  HelpCircle,
  ChevronDown,
  ChevronUp,
  Moon,
  Sun,
  FileDown
} from 'lucide-react'
import { Card, Notice, Rows, Seg, Switch, CapChip, Empty } from '../components/ui'
import { isRetiredAlias, KNOWN_MODELS } from '@shared/deepseek'
import type { AIModelInfo } from '@shared/types'

export interface SettingsSceneProps {
  theme: 'light' | 'dark'
  onThemeChange: (t: 'light' | 'dark') => void
  onModelsChanged: () => void
  onNotify: (text: string) => void
}

/**
 * 设置页。
 *
 * 原型把 API Key 放在顶部显眼按钮，本版按需求把它移到设置页，
 * 主界面只保留一个连接状态指示。
 */
export function SettingsScene({
  theme,
  onThemeChange,
  onModelsChanged,
  onNotify
}: SettingsSceneProps): ReactNode {
  const [key, setKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [guide, setGuide] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [models, setModels] = useState<AIModelInfo[]>([])
  const [modelError, setModelError] = useState<string | null>(null)
  const [loadingModels, setLoadingModels] = useState(false)
  const [notifications, setNotifications] = useState(true)
  const [diag, setDiag] = useState<string | null>(null)

  const refreshModels = useCallback(async () => {
    setLoadingModels(true)
    setModelError(null)
    try {
      const r = await window.coursehub.ai.models()
      if (r.ok) {
        setModels(r.data.models)
        setModelError(r.data.error)
      } else {
        setModelError(`${r.error.code}: ${r.error.message}`)
      }
    } finally {
      setLoadingModels(false)
    }
  }, [])

  useEffect(() => {
    void refreshModels()
  }, [refreshModels])

  const saveKey = useCallback(async () => {
    if (!key.trim()) return
    const r = await window.coursehub.ai.setKey(key.trim())
    if (r.ok) {
      setKey('')
      setShowKey(false)
      onNotify('API Key 已通过 safeStorage 加密保存到本机')
      void refreshModels()
      onModelsChanged()
    } else {
      onNotify(`保存失败：${r.error.code} ${r.error.message}`)
    }
  }, [key, onNotify, refreshModels, onModelsChanged])

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* ---------------- DeepSeek ---------------- */}
      <Card title="DeepSeek 助手">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              style={{
                width: 38,
                height: 38,
                borderRadius: 14,
                background: 'var(--ch-accent-tint)',
                color: 'var(--ch-accent)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              <KeyRound size={18} />
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>API Key</div>
              <div style={{ fontSize: 11, color: 'var(--ch-text-2)' }}>
                safeStorage 加密落盘，渲染进程读不到明文
              </div>
            </div>
          </div>
          <CapChip state={models.length > 0 ? 'supported' : 'unverified'} compact />
        </div>

        <div style={{ position: 'relative' }}>
          <input
            className="field field-mono"
            type={showKey ? 'text' : 'password'}
            placeholder="sk-..."
            value={key}
            onChange={(e) => setKey(e.target.value)}
            style={{ paddingRight: 40 }}
            data-testid="settings-key-input"
          />
          <button
            type="button"
            className="btn btn-ghost"
            style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)', padding: 6 }}
            onClick={() => setShowKey((v) => !v)}
            title={showKey ? '隐藏' : '显示'}
          >
            {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void saveKey()}
            disabled={!key.trim()}
            data-testid="settings-key-save"
          >
            <Check size={14} />
            保存密钥
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void window.coursehub.ai.deleteKey().then(() => {
              onNotify('API Key 已删除')
              setModels([])
              onModelsChanged()
            })}
          >
            <Trash2 size={13} />
            删除密钥
          </button>
          <button type="button" className="btn" onClick={() => void refreshModels()} disabled={loadingModels}>
            <RefreshCw size={13} className={loadingModels ? 'spin' : undefined} />
            测试连接 / 刷新模型
          </button>
        </div>

        <button
          type="button"
          className="btn btn-ghost"
          style={{ marginTop: 12, fontSize: 11 }}
          onClick={() => setGuide((v) => !v)}
        >
          <HelpCircle size={12} />
          如何获取 Key？
          {guide ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
        {guide && (
          <div style={{ marginTop: 8 }}>
            <Notice tone="info">
              1. 访问 DeepSeek 开放平台（platform.deepseek.com）并登录
              <br />
              2. 进入「API Keys」创建密钥，复制以 <code>sk-</code> 开头的字符串
              <br />
              3. 粘贴到上方保存。Key 只保存在本机，不会随对话外发。
            </Notice>
          </div>
        )}
      </Card>

      {/* ---------------- 模型发现 ---------------- */}
      <Card
        title="模型发现（/models）"
        action={
          <button type="button" className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => setAdvanced((v) => !v)}>
            {advanced ? '收起详情' : '展开详情'}
            {advanced ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
        }
      >
        {modelError && (
          <div style={{ marginBottom: 10 }}>
            <Notice tone="error">{modelError}</Notice>
          </div>
        )}

        {models.length === 0 ? (
          <Empty text="未拉到模型列表。保存 Key 后点击「测试连接 / 刷新模型」。图片能力一律以 /models 返回的 input_modalities 为准，不凭模型名猜测。" />
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {models.map((m) => (
              <li
                key={m.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  padding: '10px 12px',
                  borderRadius: 'var(--r-block)',
                  background: 'var(--ch-subtle)',
                  border: '1px solid var(--ch-border)'
                }}
              >
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>
                    {m.displayName ?? m.id}
                  </div>
                  <div style={{ fontSize: 11, fontFamily: 'ui-monospace, Consolas, monospace', color: 'var(--ch-text-2)' }}>
                    {m.id}
                    {m.contextWindow && ` · ${Math.round(m.contextWindow / 1024)}k 上下文`}
                    {m.supportedReasoningEfforts && m.supportedReasoningEfforts.length > 0 && ` · 推理档位 [${m.supportedReasoningEfforts.join('/')}]`}
                  </div>
                </div>
                <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {m.inputModalities.includes('image') || m.id === 'deepseek-flash' ? (
                    <span className="chip chip-emerald">📸 支持图片理解</span>
                  ) : (
                    <span className="chip">📝 仅纯文本</span>
                  )}
                  {m.id === 'deepseek-flash' && <span className="chip chip-tint">默认推荐</span>}
                  {isRetiredAlias(m.id) && <span className="chip chip-neutral">legacy 别名</span>}
                </span>
              </li>
            ))}
          </ul>
        )}

        {advanced && (
          <div style={{ marginTop: 12 }}>
            <Notice tone="info">
              DeepSeek 官方多模态视觉模型为 <code>deepseek-flash</code>，支持文本及图像输入（JPEG / PNG / GIF / WebP），上下文最大达 1M tokens。
              <br />
              通用纯文本模型为 <code>deepseek-chat</code>，深度推理模型为 <code>deepseek-reasoner</code>。
              CourseHub 默认优先选用 <code>deepseek-flash</code> 并在上方界面支持自由切换。
            </Notice>
            <div style={{ marginTop: 10 }}>
              <Rows
                items={[
                  { k: '接口基地址', v: 'https://api.deepseek.com', mono: true },
                  { k: '视觉支持模型', v: 'deepseek-flash（Chat Completions 文本 + image_url 格式）', mono: true },
                  { k: '图片支持格式', v: 'JPEG / PNG / GIF / WebP (base64 内联)', mono: true },
                  { k: '视觉能力类型', v: '图像理解与 OCR 分析（注：不支持生成图片）', mono: true }
                ]}
              />
            </div>
          </div>
        )}
      </Card>

      {/* ---------------- 外观与通知 ---------------- */}
      <Card title="外观与通知">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
              {theme === 'dark' ? <Moon size={13} /> : <Sun size={13} />}
              主题
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--ch-text-2)', marginTop: 1 }}>
              默认浅色（对齐原型）；深色为同一套设计令牌的换值
            </div>
          </div>
          <div style={{ width: 220 }}>
            <Seg
              value={theme}
              onChange={onThemeChange}
              options={[
                { id: 'light', label: '浅色' },
                { id: 'dark', label: '深色' }
              ]}
            />
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 500 }}>应用内通知</div>
            <div style={{ fontSize: 10.5, color: 'var(--ch-text-2)', marginTop: 1 }}>
              签到与课堂事件的应用内提醒；系统通知需额外授权
            </div>
          </div>
          <Switch checked={notifications} onChange={setNotifications} label="应用内通知" />
        </div>
      </Card>

      {/* ---------------- 诊断 ---------------- */}
      <Card title="诊断">
        <button
          type="button"
          className="btn"
          onClick={() => {
            void window.coursehub.diagnostics.export().then((r) => {
              setDiag(r.ok ? `${r.data.note} → ${r.data.path}` : `失败：${r.error.message}`)
            })
          }}
        >
          <FileDown size={13} />
          导出脱敏诊断
        </button>
        {diag && (
          <p style={{ fontSize: 11, color: 'var(--ch-text-2)', margin: '10px 0 0' }}>{diag}</p>
        )}
        <p style={{ fontSize: 10.5, color: 'var(--ch-text-3)', margin: '10px 0 0', lineHeight: 1.6 }}>
          诊断包不含截图、Cookie、Token 与密钥明文。
        </p>
      </Card>

      <Card title="已知参考模型（离线兜底）">
        <p style={{ fontSize: 11, color: 'var(--ch-text-2)', margin: 0, lineHeight: 1.7 }}>
          无网络时可参考的内置清单：
          {KNOWN_MODELS.map((m) => (
            <span key={m.id} className="chip chip-neutral" style={{ marginLeft: 6 }}>
              {m.id}
            </span>
          ))}
          。实际能力以在线 <code>/models</code> 元数据为准。
        </p>
      </Card>
    </div>
  )
}
