/**
 * DeepSeek 客户端：Key 管理、模型发现、流式生成、取消、错误映射。
 *
 * 事实核对（2026-10-15 官方文档）：
 * - base_url https://api.deepseek.com
 * - 当前模型 deepseek-flash（支持图片）/ deepseek-v4-pro
 * - 图片仅支持 JPEG/PNG/GIF/WebP，且只能出现在 user 消息
 *
 * 设计约束（开发文档 §8.1）：
 * - Key 只经 safeStorage 落盘，绝不返回 renderer。
 * - 单会话一个活动生成请求；取消/超时/限流/额度都有专门状态。
 * - 无无限重试，不静默扣费。
 */

import { DEEPSEEK_BASE_URL, parseModelsResponse, modelSupportsImage, KNOWN_MODELS } from '@shared/deepseek'
import type { AIModelInfo, AIResult } from '@shared/types'
import type { Store } from '../services/store'

const REQUEST_TIMEOUT_MS = 60_000

export class DeepSeekClient {
  private activeAbort: AbortController | null = null

  constructor(private readonly store: Store) {}

  private async apiKey(): Promise<string | null> {
    const fromStore = await this.store.getSecret('deepseek_api_key')
    if (fromStore && fromStore.trim()) return fromStore.trim()
    const fromEnv = process.env.DEEPSEEK_API_KEY
    if (fromEnv && fromEnv.trim()) return fromEnv.trim()
    return null
  }

  async listModels(): Promise<{ models: AIModelInfo[]; error: string | null }> {
    const key = await this.apiKey()
    if (!key) return { models: [...KNOWN_MODELS], error: 'AI_KEY_INVALID: 未配置 API Key' }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20_000)
    try {
      const resp = await fetch(`${DEEPSEEK_BASE_URL}/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: controller.signal
      })
      if (!resp.ok) {
        return { models: [...KNOWN_MODELS], error: `HTTP_${resp.status}: ${await safeText(resp)}` }
      }
      const json = (await resp.json()) as unknown
      const parsed = parseModelsResponse(json)
      return { models: parsed.length > 0 ? parsed : [...KNOWN_MODELS], error: null }
    } catch (e) {
      const msg = e instanceof Error ? e.name === 'AbortError' ? 'NETWORK_TIMEOUT' : e.message : String(e)
      return { models: [...KNOWN_MODELS], error: String(msg) }
    } finally {
      clearTimeout(timer)
    }
  }

  cancel(): void {
    if (this.activeAbort) {
      this.activeAbort.abort()
      this.activeAbort = null
    }
  }

  /**
   * 流式生成。onDelta 逐段回调，返回完整结果。
   * 支持纯文本与文本 + image_url 官方多模态格式。
   * 仅当所选模型不含 image 模态时，明确报错提示切换至 deepseek-flash。
   */
  async generate(input: {
    model: string
    systemPrompt: string
    userText: string
    /** base64 data URL；仅在用户预览确认后传入 */
    imageDataUrl?: string | null
    modelsHint?: readonly AIModelInfo[]
    onDelta: (chunk: string) => void
  }): Promise<{ result: AIResult | null; error: string | null; cancelled: boolean }> {
    // 图片能力按模型精准校验：deepseek-flash 支持图片；仅不支持图片的模型被拦截
    if (input.imageDataUrl) {
      const hint =
        input.modelsHint?.find((m) => m.id === input.model) ||
        KNOWN_MODELS.find((m) => m.id === input.model)
      const isVision = hint ? modelSupportsImage(hint) : input.model === 'deepseek-flash'
      if (!isVision) {
        return {
          result: null,
          error: `UNSUPPORTED: 当前所选模型 ${input.model} 不支持图片输入（input_modalities 未包含 image）。请切换至支持图片的 deepseek-flash 模型，或以纯文本输入。`,
          cancelled: false
        }
      }
      if (!/^data:image\/(jpeg|png|gif|webp);base64,/i.test(input.imageDataUrl)) {
        return {
          result: null,
          error: 'UNSUPPORTED: 图片格式必须是 JPEG/PNG/GIF/WebP 的 base64 data URL',
          cancelled: false
        }
      }
    }

    const key = await this.apiKey()
    if (!key) return { result: null, error: 'AI_KEY_INVALID: 未配置 API Key', cancelled: false }

    this.cancel()
    const controller = new AbortController()
    this.activeAbort = controller
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

    const promptText = input.userText.trim() || '请识别并分析图片中的内容。'
    const userContent: unknown = input.imageDataUrl
      ? [
          { type: 'text', text: promptText },
          // 官方规范：图片只放在 user 消息中，格式为 { type: "image_url", image_url: { url: ... } }
          { type: 'image_url', image_url: { url: input.imageDataUrl } }
        ]
      : input.userText

    const body = {
      model: input.model,
      temperature: 0.2,
      max_tokens: 2000,
      stream: true,
      messages: [
        { role: 'system', content: input.systemPrompt },
        { role: 'user', content: userContent }
      ]
    }

    let full = ''
    let usage: { promptTokens: number | null; completionTokens: number | null } | null = null

    try {
      const resp = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      })

      if (!resp.ok) {
        const text = await safeText(resp)
        const code =
          resp.status === 401 || resp.status === 403
            ? 'AI_KEY_INVALID'
            : resp.status === 429
              ? 'AI_QUOTA_EXCEEDED'
              : resp.status === 402
                ? 'AI_QUOTA_EXCEEDED'
                : 'INVALID_REQUEST'
        return { result: null, error: `${code}: HTTP ${resp.status} ${text}`, cancelled: false }
      }
      if (!resp.body) {
        return { result: null, error: 'INVALID_REQUEST: 响应无 body', cancelled: false }
      }

      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (data === '[DONE]') continue
          try {
            const evt = JSON.parse(data) as {
              choices?: { delta?: { content?: string } }[]
              usage?: { prompt_tokens?: number; completion_tokens?: number }
            }
            const delta = evt.choices?.[0]?.delta?.content
            if (typeof delta === 'string' && delta.length > 0) {
              full += delta
              input.onDelta(delta)
            }
            if (evt.usage) {
              usage = {
                promptTokens: evt.usage.prompt_tokens ?? null,
                completionTokens: evt.usage.completion_tokens ?? null
              }
            }
          } catch {
            /* 跳过无法解析的分片 */
          }
        }
      }

      if (full.trim().length === 0) {
        return { result: null, error: 'INVALID_REQUEST: 模型返回空内容', cancelled: false }
      }

      return {
        result: {
          explanation: full,
          suggestedAnswer: null,
          optionsMapping: null,
          uncertainty: null,
          model: input.model,
          contextSource: input.imageDataUrl
            ? input.userText.trim()
              ? 'text+screenshot'
              : 'screenshot'
            : 'text',
          usage,
          isMock: false
        },
        error: null,
        cancelled: false
      }
    } catch (e) {
      if (controller.signal.aborted) {
        return { result: null, error: null, cancelled: true }
      }
      return {
        result: null,
        error: `NETWORK_TIMEOUT: ${e instanceof Error ? e.message : String(e)}`,
        cancelled: false
      }
    } finally {
      clearTimeout(timer)
      if (this.activeAbort === controller) this.activeAbort = null
    }
  }
}

async function safeText(resp: Response): Promise<string> {
  try {
    const t = await resp.text()
    return t.slice(0, 500)
  } catch {
    return '<unreadable>'
  }
}
