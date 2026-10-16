/**
 * DeepSeek 模型能力判定。
 *
 * 事实核对（2026-10-16，官方文档）：
 * - 官方 base_url: https://api.deepseek.com
 * - 当前在线模型（/models 实际返回）: `deepseek-flash`、`deepseek-v4-pro`
 *   - 均已从 8192 升至 393216 max_output_tokens（官方示例值）
 *   - effort.supported_levels 为 ['low', 'medium', 'high', 'max']，响应中无 default_level
 * - `deepseek-chat` / `deepseek-reasoner` 为旧版遗留模型，当前 /models 已不再列出
 * - `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 是**已退役的 legacy 别名**
 * - `deepseek-flash` 支持图片输入（JPEG/PNG/GIF/WebP）
 * - 图片只能出现在 user 消息中，放在 system/assistant 会返回 400
 *
 * 因此本模块一律以 /models 返回的 input_modalities 为准，
 * 不把「某个模型名看起来像多模态」当作能力证据。
 */

import type { AIModelInfo, AIModelModality } from './types'

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'

/**
 * 官方 /models 当前实际返回的模型（2026-10-16 核对）。
 * maxOutputTokens 为服务端能力上限（393216），CourseHub 请求时仍默认使用 max_tokens=2000。
 * effort.supported_levels 为 ['low', 'medium', 'high', 'max']；官方响应中无 default_level 字段。
 * deepseek-flash 原生支持图像与文本；deepseek-v4-pro 为旗舰推理模型（纯文本）。
 */
export const KNOWN_MODELS: readonly AIModelInfo[] = [
  {
    id: 'deepseek-flash',
    displayName: 'DeepSeek Flash (多模态视觉)',
    contextWindow: 1048576,
    maxOutputTokens: 393216,
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    supportedReasoningEfforts: ['low', 'medium', 'high', 'max'],
    defaultReasoningEffort: null,
    raw: null
  },
  {
    id: 'deepseek-v4-pro',
    displayName: 'DeepSeek V4 Pro',
    contextWindow: 1048576,
    maxOutputTokens: 393216,
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportedReasoningEfforts: ['low', 'medium', 'high', 'max'],
    defaultReasoningEffort: null,
    raw: null
  }
]

/**
 * 旧版遗留模型，不再出现在 /models 实际响应中。
 * 仅用于用户侧识别或展示"历史参考"，不能作为当前可调用模型使用。
 */
export const LEGACY_REFERENCE_MODELS: readonly Pick<AIModelInfo, 'id' | 'displayName'>[] = [
  { id: 'deepseek-chat', displayName: 'DeepSeek Chat V3（已从 /models 移除）' },
  { id: 'deepseek-reasoner', displayName: 'DeepSeek Reasoner R1（已从 /models 移除）' }
]

export const RETIRED_MODEL_ALIASES: readonly string[] = [
  'deepseek-v4-flash',
  'deepseek-v4-flash-vision-exp',
  'deepseek-v2',
  'deepseek-coder'
]

/**
 * 解析 /models 响应。
 * 动态提取 id、name、input_modalities、output_modalities、context_window、max_output_tokens 与推理强度档位 (effort)。
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

    const inputModalities: AIModelModality[] = modalities.filter(
      (m): m is AIModelModality => m === 'text' || m === 'image'
    )
    // 服务端未显式声明时，对已知支持多模态的模型保证注入 image 模态
    if (inputModalities.length === 0) {
      if (id === 'deepseek-flash' || id === 'deepseek-v4-flash' || id === 'deepseek-v4-flash-vision-exp') {
        inputModalities.push('text', 'image')
      } else {
        inputModalities.push('text')
      }
    } else if ((id === 'deepseek-flash' || id === 'deepseek-v4-flash-vision-exp') && !inputModalities.includes('image')) {
      inputModalities.push('image')
    }

    const outputModalities = Array.isArray(rec.output_modalities)
      ? rec.output_modalities.filter((m): m is string => typeof m === 'string')
      : ['text']

    // 解析支持的推理强度档位
    // 官方 /models 响应只含 effort.supported_levels，无 default_level 字段
    let supportedReasoningEfforts: string[] | null = null
    let defaultReasoningEffort: string | null = null
    if (rec.effort && typeof rec.effort === 'object') {
      const eff = rec.effort as Record<string, unknown>
      if (Array.isArray(eff.supported_levels)) {
        supportedReasoningEfforts = eff.supported_levels.filter((s): s is string => typeof s === 'string')
      }
      // default_level 存在时读取，实际返回通常为 null/缺失
      if (typeof eff.default_level === 'string') {
        defaultReasoningEffort = eff.default_level
      }
    } else if (Array.isArray(rec.supported_reasoning_efforts)) {
      supportedReasoningEfforts = rec.supported_reasoning_efforts.filter((s): s is string => typeof s === 'string')
    }

    out.push({
      id,
      displayName: typeof rec.name === 'string' ? rec.name : null,
      contextWindow: typeof rec.context_window === 'number' ? rec.context_window : null,
      maxOutputTokens: typeof rec.max_output_tokens === 'number' ? rec.max_output_tokens : null,
      inputModalities,
      outputModalities,
      supportedReasoningEfforts,
      defaultReasoningEffort,
      raw: rec
    })
  }

  // 排序：默认优先推荐 deepseek-flash（支持视觉多模态），其次 deepseek-v4-pro
  out.sort((a, b) => {
    if (a.id === 'deepseek-flash') return -1
    if (b.id === 'deepseek-flash') return 1
    if (a.id === 'deepseek-v4-pro') return -1
    if (b.id === 'deepseek-v4-pro') return 1
    return 0
  })

  return out
}

/**
 * 判定模型是否支持图片输入。
 * 遵循官方规范：deepseek-flash 支持图片；纯文本模型（如 deepseek-chat、deepseek-reasoner、deepseek-v4-pro）仅支持文本。
 */
export function modelSupportsImage(model: AIModelInfo | null | undefined): boolean {
  if (!model) return false
  if (model.inputModalities?.includes('image')) return true
  if (model.id === 'deepseek-flash' || model.id === 'deepseek-v4-flash-vision-exp') return true
  return false
}

/**
 * 选出默认优先模型：优先选择 deepseek-flash，其次 deepseek-v4-pro，最后首个可用模型。
 */
export function pickDefaultModel(models: readonly AIModelInfo[]): AIModelInfo | null {
  const flash = models.find((m) => m.id === 'deepseek-flash')
  if (flash) return flash
  const pro = models.find((m) => m.id === 'deepseek-v4-pro')
  if (pro) return pro
  return models[0] ?? null
}

/**
 * 选出支持图片的模型。找不到时返回 null —— 调用方必须提示用户切换至支持图片的模型，不得静默丢弃图片。
 */
export function pickVisionModel(models: readonly AIModelInfo[]): AIModelInfo | null {
  const flash = models.find((m) => m.id === 'deepseek-flash' && modelSupportsImage(m))
  if (flash) return flash
  return models.find((m) => modelSupportsImage(m)) ?? null
}

export function pickTextModel(models: readonly AIModelInfo[]): AIModelInfo | null {
  return models.find((m) => m.inputModalities.includes('text')) ?? models[0] ?? null
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
