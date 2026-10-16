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
  pickDefaultModel,
  isRetiredAlias,
  redactForOutbound,
  extractJson,
  RETIRED_MODEL_ALIASES,
  KNOWN_MODELS
} from '@shared/deepseek'
import { DeepSeekClient } from '../../src/main/ai/deepseek-client'

describe('parseModelsResponse', () => {
  it('解析官方 schema 字段（含多模态与推理强度）', () => {
    const json = {
      object: 'list',
      data: [
        {
          id: 'deepseek-flash',
          object: 'model',
          owned_by: 'deepseek',
          name: 'DeepSeek Flash',
          context_window: 1048576,
          max_output_tokens: 8192,
          input_modalities: ['text', 'image'],
          output_modalities: ['text'],
          effort: {
            supported_levels: ['low', 'medium', 'high'],
            default_level: 'medium'
          }
        },
        {
          id: 'deepseek-v4-pro',
          object: 'model',
          name: 'DeepSeek V4 Pro',
          context_window: 1048576,
          max_output_tokens: 8192,
          input_modalities: ['text'],
          output_modalities: ['text']
        }
      ]
    }
    const models = parseModelsResponse(json)
    expect(models).toHaveLength(2)
    // 优先推荐 deepseek-flash 置顶
    expect(models[0]!.id).toBe('deepseek-flash')
    expect(models[0]!.inputModalities).toEqual(['text', 'image'])
    expect(models[0]!.contextWindow).toBe(1048576)
    expect(models[0]!.displayName).toBe('DeepSeek Flash')
    expect(models[0]!.supportedReasoningEfforts).toEqual(['low', 'medium', 'high'])
    expect(models[0]!.defaultReasoningEffort).toBe('medium')

    expect(models[1]!.id).toBe('deepseek-v4-pro')
    expect(models[1]!.inputModalities).toEqual(['text'])
  })

  it('缺失字段填 null 而非默认值（常规非 flash 模型）', () => {
    const models = parseModelsResponse({ data: [{ id: 'custom-model' }] })
    expect(models[0]!.contextWindow).toBeNull()
    expect(models[0]!.maxOutputTokens).toBeNull()
    expect(models[0]!.displayName).toBeNull()
    expect(models[0]!.inputModalities).toEqual(['text'])
  })

  it('未声明 input_modalities 时常规模型不假定支持图片', () => {
    const models = parseModelsResponse({ data: [{ id: 'unknown-modality-model' }] })
    expect(modelSupportsImage(models[0])).toBe(false)
  })

  it('对 deepseek-flash 保证具备 image 模态', () => {
    const models = parseModelsResponse({ data: [{ id: 'deepseek-flash' }] })
    expect(models[0]!.inputModalities).toContain('image')
    expect(modelSupportsImage(models[0])).toBe(true)
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

describe('模型能力选择与视觉判断', () => {
  it('deepseek-flash 默认支持图片输入（Vision）', () => {
    const flash = KNOWN_MODELS.find((m) => m.id === 'deepseek-flash')!
    expect(flash).toBeDefined()
    expect(modelSupportsImage(flash)).toBe(true)
    expect(pickVisionModel(KNOWN_MODELS)?.id).toBe('deepseek-flash')
    expect(pickDefaultModel(KNOWN_MODELS)?.id).toBe('deepseek-flash')
  })

  it('deepseek-chat 与 deepseek-reasoner 为官方纯文本模型，不假定图片能力', () => {
    const chat = KNOWN_MODELS.find((m) => m.id === 'deepseek-chat')!
    const reasoner = KNOWN_MODELS.find((m) => m.id === 'deepseek-reasoner')!
    expect(modelSupportsImage(chat)).toBe(false)
    expect(modelSupportsImage(reasoner)).toBe(false)
  })

  it('具有 image 模态的模型均能被识别为视觉模型', () => {
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

  it('纯文本模型列表无图片模型时 pickVisionModel 返回 null', () => {
    const textOnly = [
      { id: 't1', displayName: 'T1', contextWindow: null, maxOutputTokens: null, inputModalities: ['text'] as const, raw: null }
    ]
    expect(pickVisionModel(textOnly)).toBeNull()
  })

  it('选出文本模型', () => {
    expect(pickTextModel(KNOWN_MODELS)).not.toBeNull()
  })

  it('空列表安全', () => {
    expect(pickVisionModel([])).toBeNull()
    expect(pickTextModel([])).toBeNull()
    expect(pickDefaultModel([])).toBeNull()
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

describe('DeepSeekClient 视觉输入校验与多模态格式测试', () => {
  const dummyStore: any = {
    getSecret: () => Promise.resolve('sk-test-mock-key-12345678')
  }

  const client = new DeepSeekClient(dummyStore)

  it('deepseek-flash 支持 JPEG / PNG / GIF / WebP 截图或图片', async () => {
    const pngUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    const jpegUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA='
    const webpUrl = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA=='

    for (const imgUrl of [pngUrl, jpegUrl, webpUrl]) {
      // 触发生成，由于使用 mock key，网络请求会因 mock 地址报错，但应顺利通过前端与客户端视觉格式校验
      const res = await client.generate({
        model: 'deepseek-flash',
        systemPrompt: '助教模式',
        userText: '解析试卷图表',
        imageDataUrl: imgUrl,
        onDelta: () => {}
      })
      // 不应当报告 UNSUPPORTED 图片错误
      expect(res.error).not.toContain('不支持图片输入')
      expect(res.error).not.toContain('图片格式必须是')
    }
  })

  it('非法图片格式（如 BMP/SVG）被客户端及时拦截', async () => {
    const bmpUrl = 'data:image/bmp;base64,Qk0AAAAAAAAAAAAAAA='
    const res = await client.generate({
      model: 'deepseek-flash',
      systemPrompt: '助教模式',
      userText: '分析题目',
      imageDataUrl: bmpUrl,
      onDelta: () => {}
    })
    expect(res.error).toContain('UNSUPPORTED: 图片格式必须是 JPEG/PNG/GIF/WebP')
  })

  it('所选纯文本模型（如 deepseek-chat）遇图片输入时精准拦截并提示切换 flash', async () => {
    const pngUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    const res = await client.generate({
      model: 'deepseek-chat',
      systemPrompt: '助教模式',
      userText: '分析题目',
      imageDataUrl: pngUrl,
      onDelta: () => {}
    })
    expect(res.error).toContain('UNSUPPORTED: 当前所选模型 deepseek-chat 不支持图片输入')
    expect(res.error).toContain('deepseek-flash')
  })

  it('无图片的纯文本输入正常通过校验', async () => {
    const res = await client.generate({
      model: 'deepseek-chat',
      systemPrompt: '助教模式',
      userText: '操作系统中进程与线程的区别',
      imageDataUrl: null,
      onDelta: () => {}
    })
    // 纯文本输入不应触发任何视觉错误
    expect(res.error).not.toContain('UNSUPPORTED')
  })
})
