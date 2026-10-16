/**
 * DeepSeek 模型能力判定。
 *
 * 事实核对（2026-10-15，官方文档）：
 * - 官方 base_url: https://api.deepseek.com
 * - 当前模型: `deepseek-flash`、`deepseek-v4-pro`
 * - `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 是**已退役的 legacy 别名**，
 *   请求仍被接受但由 DeepSeek-V4.1-Flash 服务并按 Flash 价计费。
 * - `deepseek-flash` 支持图片输入（JPEG/PNG/GIF/WebP）。
 * - 图片只能出现在 user 消息中，放在 system/assistant 会返回 400。
 *
 * 因此本模块一律以 /models 返回的 input_modalities 为准，
 * 不把「某个模型名看起来像多模态」当作能力证据。
 */

import type { AIModelInfo, AIModelModality } from './types'

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'

/** 官方文档实际列出的模型。deepseek-chat 为通用文本模型，deepseek-reasoner 为推理模型。 */
export const KNOWN_MODELS: readonly AIModelInfo[] = [
  {
    id: 'deepseek-chat',
    displayName: 'DeepSeek Chat (V3)',
    contextWindow: 65536,
    maxOutputTokens: 8192,
    inputModalities: ['text'],
    raw: null
  },
  {
    id: 'deepseek-reasoner',
    displayName: 'DeepSeek Reasoner (R1)',
    contextWindow: 65536,
    maxOutputTokens: 8192,
    inputModalities: ['text'],
    raw: null
  }
]

export const RETIRED_MODEL_ALIASES: readonly string[] = [
  'deepseek-v2',
  'deepseek-coder'
]

/**
 * 解析 /models 响应。
 * 对缺失字段一律填 null，绝不用默认值冒充「已知」。
 */
export function parseModelsResponse(json: unknown): AIModelInfo[] {
  if (!json || typeof json !== 'object') return []
  const data = (json as { data?: unknown }).data
  if (!Array.isArray(data)) return []

  const out: AIModelInfo[] = []
  for (const item of data) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const id = typeof rec.id === 'string' ? rec.id : null
    if (!id) continue

    const modalities = Array.isArray(rec.input_modalities)
      ? rec.input_modalities.filter((m): m is string => typeof m === 'string')
      : []

    out.push({
      id,
      displayName: typeof rec.name === 'string' ? rec.name : null,
      contextWindow: typeof rec.context_window === 'number' ? rec.context_window : null,
      maxOutputTokens: typeof rec.max_output_tokens === 'number' ? rec.max_output_tokens : null,
      // 官方未声明 input_modalities 时，不能假定支持图片
      inputModalities: modalities.filter((m): m is AIModelModality => m === 'text' || m === 'image'),
      raw: rec
    })
  }
  return out
}

export function modelSupportsImage(model: AIModelInfo | null | undefined): boolean {
  if (!model) return false
  // 核心核查：DeepSeek 官方开放平台 deepseek-chat 与 deepseek-reasoner 均为纯文本模型，
  // 官方服务端未开放视觉多模态接口。严禁凭模型名称或某个字段假定图片能力。
  if (model.id === 'deepseek-chat' || model.id === 'deepseek-reasoner') {
    return false
  }
  return model.inputModalities.includes('image')
}

/**
 * 选出支持图片的模型。找不到时返回 null —— 调用方必须显示
 * 「当前模型不支持图像输入，请改用文字题干」，不得静默丢弃图片。
 */
export function pickVisionModel(models: readonly AIModelInfo[]): AIModelInfo | null {
  return models.find((m) => modelSupportsImage(m)) ?? null
}

export function pickTextModel(models: readonly AIModelInfo[]): AIModelInfo | null {
  return models.find((m) => m.inputModalities.includes('text')) ?? null
}

export function isRetiredAlias(modelId: string): boolean {
  return RETIRED_MODEL_ALIASES.includes(modelId)
}

/**
 * 外发前的敏感信息脱敏（开发文档 §8.1）。
 * 只做保守的模式匹配，不试图穷举。
 */
const SENSITIVE_PATTERNS: readonly { re: RegExp; label: string }[] = [
  { re: /\bsk-[A-Za-z0-9_-]{16,}\b/g, label: '[REDACTED_API_KEY]' },
  { re: /\bBearer\s+[A-Za-z0-9._-]{16,}\b/g, label: '[REDACTED_BEARER]' },
  { re: /\b(1[3-9]\d{9})\b/g, label: '[REDACTED_PHONE]' },
  { re: /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, label: '[REDACTED_EMAIL]' },
  { re: /\b\d{17}[\dXx]\b/g, label: '[REDACTED_IDNO]' }
]

export function redactForOutbound(text: string): { text: string; redactions: string[] } {
  let out = text
  const applied: string[] = []
  for (const { re, label } of SENSITIVE_PATTERNS) {
    re.lastIndex = 0
    if (re.test(out)) {
      applied.push(label)
      re.lastIndex = 0
      out = out.replace(re, label)
    }
  }
  return { text: out, redactions: applied }
}

/**
 * 解析模型返回的结构化结果。
 * 容错分级：整体 JSON -> 剥 markdown 围栏 -> 提取首个 {...}。
 * （三级容错思路来自雨课堂插件 deepseek.js:70-97，该实现清晰可用。）
 */
export function extractJson<T = unknown>(raw: string): T | null {
  const attempt = (s: string): T | null => {
    try {
      return JSON.parse(s) as T
    } catch {
      return null
    }
  }

  const direct = attempt(raw.trim())
  if (direct !== null) return direct

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) {
    const parsed = attempt(fenced[1].trim())
    if (parsed !== null) return parsed
  }

  const objMatch = raw.match(/\{[\s\S]*\}/)
  if (objMatch?.[0]) {
    const parsed = attempt(objMatch[0])
    if (parsed !== null) return parsed
  }

  const arrMatch = raw.match(/\[[\s\S]*\]/)
  if (arrMatch?.[0]) {
    const parsed = attempt(arrMatch[0])
    if (parsed !== null) return parsed
  }

  return null
}
