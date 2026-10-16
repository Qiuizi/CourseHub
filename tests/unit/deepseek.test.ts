/**
 * DeepSeek 模型解析、脱敏与 JSON 容错测试。
 *
 * 模型 ID 用例基于 2026-10-15 官方文档核对结果：
 * deepseek-flash（支持图片）/ deepseek-v4-pro；
 * deepseek-v4-flash 等为已退役 legacy 别名。
 */

import { describe, it, expect } from 'vitest'
import {
  parseModelsResponse,
  modelSupportsImage,
  pickVisionModel,
  pickTextModel,
  isRetiredAlias,
  redactForOutbound,
  extractJson,
  RETIRED_MODEL_ALIASES,
  KNOWN_MODELS
} from '@shared/deepseek'

describe('parseModelsResponse', () => {
  it('解析官方 schema 字段', () => {
    const json = {
      object: 'list',
      data: [
        {
          id: 'deepseek-flash',
          object: 'model',
          owned_by: 'deepseek',
          name: 'DeepSeek Flash',
          context_window: 128000,
          max_output_tokens: 8192,
          input_modalities: ['text', 'image'],
          output_modalities: ['text']
        }
      ]
    }
    const models = parseModelsResponse(json)
    expect(models).toHaveLength(1)
    expect(models[0]!.id).toBe('deepseek-flash')
    expect(models[0]!.inputModalities).toEqual(['text', 'image'])
    expect(models[0]!.contextWindow).toBe(128000)
    expect(models[0]!.displayName).toBe('DeepSeek Flash')
  })

  it('缺失字段填 null 而非默认值', () => {
    const models = parseModelsResponse({ data: [{ id: 'x' }] })
    expect(models[0]!.contextWindow).toBeNull()
    expect(models[0]!.maxOutputTokens).toBeNull()
    expect(models[0]!.displayName).toBeNull()
    expect(models[0]!.inputModalities).toEqual([])
  })

  it('未声明 input_modalities 时不假定支持图片', () => {
    const models = parseModelsResponse({ data: [{ id: 'unknown-modality-model' }] })
    expect(modelSupportsImage(models[0])).toBe(false)
  })

  it('过滤非法模态值', () => {
    const models = parseModelsResponse({ data: [{ id: 'm', input_modalities: ['text', 'audio', 'image'] }] })
    expect(models[0]!.inputModalities).toEqual(['text', 'image'])
  })

  it('异常响应返回空数组', () => {
    expect(parseModelsResponse(null)).toEqual([])
    expect(parseModelsResponse({})).toEqual([])
    expect(parseModelsResponse({ data: 'not-array' })).toEqual([])
    expect(parseModelsResponse({ data: [null, 123, { noId: true }] })).toEqual([])
  })
})

describe('模型能力选择', () => {
  it('deepseek-chat 与 deepseek-reasoner 为官方纯文本模型，不假定图片能力', () => {
    const chat = KNOWN_MODELS.find((m) => m.id === 'deepseek-chat')!
    const reasoner = KNOWN_MODELS.find((m) => m.id === 'deepseek-reasoner')!
    expect(modelSupportsImage(chat)).toBe(false)
    expect(modelSupportsImage(reasoner)).toBe(false)
  })

  it('官方 DeepSeek 模型列表无图片模型时 pickVisionModel 返回 null，不静默降级', () => {
    expect(pickVisionModel(KNOWN_MODELS)).toBeNull()
  })

  it('具有 image 模态的非 deepseek 专属模型可被正常识别', () => {
    const customVision = {
      id: 'custom-vision-model',
      displayName: 'Custom Vision',
      contextWindow: 128000,
      maxOutputTokens: 8192,
      inputModalities: ['text', 'image'] as const,
      raw: null
    }
    expect(modelSupportsImage(customVision)).toBe(true)
    expect(pickVisionModel([customVision])?.id).toBe('custom-vision-model')
  })

  it('选出文本模型', () => {
    expect(pickTextModel(KNOWN_MODELS)).not.toBeNull()
  })

  it('空列表安全', () => {
    expect(pickVisionModel([])).toBeNull()
    expect(pickTextModel([])).toBeNull()
    expect(modelSupportsImage(null)).toBe(false)
    expect(modelSupportsImage(undefined)).toBe(false)
  })
})

describe('legacy 别名识别', () => {
  it('识别已退役别名', () => {
    for (const m of RETIRED_MODEL_ALIASES) expect(isRetiredAlias(m)).toBe(true)
  })

  it('当前模型不算别名', () => {
    expect(isRetiredAlias('deepseek-chat')).toBe(false)
    expect(isRetiredAlias('deepseek-reasoner')).toBe(false)
  })
})

describe('外发脱敏', () => {
  it('屏蔽 API Key', () => {
    const r = redactForOutbound('my key is sk-abcdefghijklmnopqrstuvwxyz123456')
    expect(r.text).not.toContain('sk-abcdefghijklmnopqrstuvwxyz')
    expect(r.text).toContain('[REDACTED_API_KEY]')
    expect(r.redactions).toContain('[REDACTED_API_KEY]')
  })

  it('屏蔽 Bearer token', () => {
    const r = redactForOutbound('Authorization: Bearer abcdefghijklmnopqrst')
    expect(r.text).not.toContain('abcdefghijklmnopqrst')
  })

  it('屏蔽手机号与邮箱', () => {
    expect(redactForOutbound('call 13812345678').text).toContain('[REDACTED_PHONE]')
    expect(redactForOutbound('mail me at a.b@c.com').text).toContain('[REDACTED_EMAIL]')
  })

  it('无敏感信息时原样返回且不标记', () => {
    const r = redactForOutbound('这是一道普通题目：TCP 与 UDP 的区别')
    expect(r.text).toBe('这是一道普通题目：TCP 与 UDP 的区别')
    expect(r.redactions).toHaveLength(0)
  })

  it('题干主体内容被保留', () => {
    const r = redactForOutbound('题干：以下哪个是操作系统？ 邮箱 x@y.com')
    expect(r.text).toContain('以下哪个是操作系统')
  })
})

describe('extractJson 三级容错', () => {
  it('直接 JSON', () => {
    expect(extractJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 })
  })

  it('markdown 围栏', () => {
    expect(extractJson<{ a: number }>('```json\n{"a":2}\n```')).toEqual({ a: 2 })
  })

  it('无围栏标记的围栏内容', () => {
    expect(extractJson<{ a: number }>('```\n{"a":3}\n```')).toEqual({ a: 3 })
  })

  it('前后夹带散文时提取对象', () => {
    expect(extractJson<{ a: number }>('好的，答案是：{"a":4} 希望有帮助')).toEqual({ a: 4 })
  })

  it('数组', () => {
    expect(extractJson<number[]>('[1,2,3]')).toEqual([1, 2, 3])
  })

  it('完全无 JSON 时返回 null', () => {
    expect(extractJson('这不是 JSON')).toBeNull()
    expect(extractJson('')).toBeNull()
  })
})
