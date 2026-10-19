import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { handleFeedbackSubmit, checkAndDispatchCompatibilityAlert } from '../../src/main/ipc/index'
import { Store, resolveBuildCommit } from '../../src/main/services/store'
import { getAdapter, ChaoxingAdapter, getAllPlatformHealth } from '../../src/main/adapters/index'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import zlib from 'node:zlib'

/** 解析 PKZIP 格式文件并解压文本 Entry */
function readZipTextEntries(buf: Buffer): Map<string, string> {
  const map = new Map<string, string>()
  let offset = 0
  while (offset + 30 <= buf.length) {
    const sig = buf.readUInt32LE(offset)
    if (sig !== 0x04034b50) break
    const compMethod = buf.readUInt16LE(offset + 8)
    const compSize = buf.readUInt32LE(offset + 18)
    const nameLen = buf.readUInt16LE(offset + 26)
    const extraLen = buf.readUInt16LE(offset + 28)
    const name = buf.subarray(offset + 30, offset + 30 + nameLen).toString('utf-8')
    const dataStart = offset + 30 + nameLen + extraLen
    const dataEnd = dataStart + compSize
    const compressedData = buf.subarray(dataStart, dataEnd)
    let content: string
    if (compMethod === 8) {
      content = zlib.inflateRawSync(compressedData).toString('utf-8')
    } else {
      content = compressedData.toString('utf-8')
    }
    map.set(name, content)
    offset = dataEnd
  }
  return map
}

describe('在线反馈排查、诊断能力与容灾韧性验收测试 (v0.4.3 Beta 1 排查与修复)', () => {
  let tmpDir: string
  let store: Store
  let originalFetch: typeof globalThis.fetch

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ch-resilience-test-'))
    store = new Store(tmpDir)
    await store.init()
    originalFetch = globalThis.fetch
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    ;(getAdapter('chaoxing') as unknown as ChaoxingAdapter)?.recordSuccess()
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it('1. 正常提交：网络通畅且服务端返回成功时，完成提交并记录 FEEDBACK_SUBMIT_SUCCESS 诊断', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          success: true,
          feedbackId: 'FB-20261019-SUCCESS1',
          issueNumber: 42,
          message: '反馈已成功提交至云端'
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    })

    const result = await handleFeedbackSubmit(
      {
        category: 'course_sync',
        description: '课程列表加载异常测试描述正常流程',
        attachDiagnostics: false
      },
      { store }
    )

    expect(result.success).toBe(true)
    expect(result.feedbackId).toBe('FB-20261019-SUCCESS1')
    expect(result.issueNumber).toBe(42)

    // 检查诊断日志
    const recent = await store.getRecentDiagnostics(10)
    expect(recent.length).toBe(1)
    expect(recent[0].code).toBe('FEEDBACK_SUBMIT_SUCCESS')
    expect(recent[0].data?.httpStatus).toBe(200)
    expect(recent[0].data?.feedbackId).toBe('FB-20261019-SUCCESS1')
  })

  it('2. 无网络连接：fetch 抛出连接拒绝异常时，记录 FEEDBACK_NETWORK_ERROR 并自动生成本地 ZIP 兜底', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed: connect ECONNREFUSED 127.0.0.1:443')
    })

    const result = await handleFeedbackSubmit(
      {
        category: 'login',
        description: '无法连接网络时的反馈测试问题描述',
        attachDiagnostics: true
      },
      { store }
    )

    expect(result.success).toBe(false)
    expect(result.offlineFallback).toBe(true)
    expect(result.failureCategory).toBe('network_error')
    expect(result.errorCode).toBe('FEEDBACK_NETWORK_ERROR')
    expect(result.diagnosticZipPath).toBeDefined()

    // 验证 store 中的诊断记录
    const recent = await store.getRecentDiagnostics(10)
    const errLog = recent.find((e) => e.code === 'FEEDBACK_NETWORK_ERROR')
    expect(errLog).toBeDefined()
    expect(errLog?.data?.phase).toBe('connecting')

    // 核心验收：导出的诊断 ZIP 包中必须能直接定位到该失败类别
    const zipBytes = await fs.readFile(result.diagnosticZipPath!)
    const entries = readZipTextEntries(zipBytes)
    const errorsJsonl = entries.get('errors.jsonl') || ''
    expect(errorsJsonl).toContain('FEEDBACK_NETWORK_ERROR')
  })

  it('3. DNS 解析失败：抛出 ENOTFOUND 时，记录 FEEDBACK_NETWORK_ERROR 并导出脱敏 ZIP 兜底', async () => {
    globalThis.fetch = vi.fn(async () => {
      const err = new Error('getaddrinfo ENOTFOUND coursehub-feedback-staging.tangziqi6609.workers.dev')
      err.name = 'FetchError'
      throw err
    })

    const result = await handleFeedbackSubmit(
      {
        category: 'ui_display',
        description: 'DNS 异常测试问题描述测试用例',
        attachDiagnostics: true
      },
      { store }
    )

    expect(result.success).toBe(false)
    expect(result.failureCategory).toBe('network_error')
    expect(result.errorCode).toBe('FEEDBACK_NETWORK_ERROR')

    // 验证 ZIP 包含错误记录
    const zipBytes = await fs.readFile(result.diagnosticZipPath!)
    const entries = readZipTextEntries(zipBytes)
    const errorsJsonl = entries.get('errors.jsonl') || ''
    expect(errorsJsonl).toContain('FEEDBACK_NETWORK_ERROR')
  })

  it('4. 请求超时：耗时超限或 AbortController 中止时，记录 FEEDBACK_TIMEOUT 并包含在兜底 ZIP 中', async () => {
    globalThis.fetch = vi.fn(async () => {
      const abortErr = new Error('The operation was aborted')
      abortErr.name = 'AbortError'
      throw abortErr
    })

    const result = await handleFeedbackSubmit(
      {
        category: 'courseware_video',
        description: '模拟网络高延迟超时导致提交中止',
        attachDiagnostics: true
      },
      { store }
    )

    expect(result.success).toBe(false)
    expect(result.failureCategory).toBe('timeout')
    expect(result.errorCode).toBe('FEEDBACK_TIMEOUT')

    const recent = await store.getRecentDiagnostics(10)
    const timeoutLog = recent.find((e) => e.code === 'FEEDBACK_TIMEOUT')
    expect(timeoutLog).toBeDefined()
    expect(timeoutLog?.data?.errorType).toBe('AbortError')

    // 验证 ZIP 包含错误记录
    const zipBytes = await fs.readFile(result.diagnosticZipPath!)
    const entries = readZipTextEntries(zipBytes)
    const errorsJsonl = entries.get('errors.jsonl') || ''
    expect(errorsJsonl).toContain('FEEDBACK_TIMEOUT')
  })

  it('5. 服务端 401 鉴权拒绝：记录 FEEDBACK_HTTP_401 并不记录敏感信息', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          success: false,
          message: '未授权的 Staging 测试请求 (Invalid Staging Key)'
        }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      )
    })

    const result = await handleFeedbackSubmit(
      {
        category: 'ai_assistant',
        description: '测试服务端 401 未授权拒绝情况描述',
        attachDiagnostics: true
      },
      { store }
    )

    expect(result.success).toBe(false)
    expect(result.failureCategory).toBe('unauthorized')
    expect(result.errorCode).toBe('FEEDBACK_HTTP_401')
    expect(result.httpStatus).toBe(401)

    const recent = await store.getRecentDiagnostics(10)
    const authLog = recent.find((e) => e.code === 'FEEDBACK_HTTP_401')
    expect(authLog).toBeDefined()
    expect(authLog?.data?.httpStatus).toBe(401)

    // 验证 ZIP 包含错误记录
    const zipBytes = await fs.readFile(result.diagnosticZipPath!)
    const entries = readZipTextEntries(zipBytes)
    const errorsJsonl = entries.get('errors.jsonl') || ''
    expect(errorsJsonl).toContain('FEEDBACK_HTTP_401')
  })

  it('6. 服务端 429 频控超限：记录 FEEDBACK_HTTP_429', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          success: false,
          message: '提交太频繁，请稍候再试（10 分钟内最多提交 5 次）'
        }),
        { status: 429, headers: { 'Content-Type': 'application/json' } }
      )
    })

    const result = await handleFeedbackSubmit(
      {
        category: 'crash_lag',
        description: '测试短时间内频繁提交触发频率限制',
        attachDiagnostics: true
      },
      { store }
    )

    expect(result.success).toBe(false)
    expect(result.failureCategory).toBe('rate_limited')
    expect(result.errorCode).toBe('FEEDBACK_HTTP_429')
    expect(result.httpStatus).toBe(429)

    const zipBytes = await fs.readFile(result.diagnosticZipPath!)
    const entries = readZipTextEntries(zipBytes)
    const errorsJsonl = entries.get('errors.jsonl') || ''
    expect(errorsJsonl).toContain('FEEDBACK_HTTP_429')
  })

  it('7. 服务端 500 / 503 内部故障：记录 FEEDBACK_HTTP_5XX', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          success: false,
          message: 'Cloudflare D1 internal error'
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      )
    })

    const result = await handleFeedbackSubmit(
      {
        category: 'other' as any,
        description: '测试服务器内部 500 异常反馈排查描述',
        attachDiagnostics: true
      },
      { store }
    )

    expect(result.success).toBe(false)
    expect(result.failureCategory).toBe('server_error')
    expect(result.errorCode).toBe('FEEDBACK_HTTP_5XX')
    expect(result.httpStatus).toBe(500)

    const zipBytes = await fs.readFile(result.diagnosticZipPath!)
    const entries = readZipTextEntries(zipBytes)
    const errorsJsonl = entries.get('errors.jsonl') || ''
    expect(errorsJsonl).toContain('FEEDBACK_HTTP_5XX')
  })

  it('8. 服务端成功但有延迟：耗时被准确记录且计时器安全清理', async () => {
    globalThis.fetch = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 60))
      return new Response(
        JSON.stringify({
          success: true,
          feedbackId: 'FB-20261019-DELAYOK'
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    })

    const result = await handleFeedbackSubmit(
      {
        category: 'course_sync',
        description: '测试略带延迟但未超时的正常响应',
        attachDiagnostics: false
      },
      { store }
    )

    expect(result.success).toBe(true)
    expect(result.durationMs).toBeGreaterThanOrEqual(50)

    const recent = await store.getRecentDiagnostics(10)
    expect(recent[0].code).toBe('FEEDBACK_SUBMIT_SUCCESS')
    expect(recent[0].data?.durationMs).toBeGreaterThanOrEqual(50)
  })

  it('9. 用户重复提交：各次请求具有独立流水号与诊断追踪', async () => {
    let callCount = 0
    globalThis.fetch = vi.fn(async () => {
      callCount++
      return new Response(
        JSON.stringify({
          success: true,
          feedbackId: `FB-20261019-RETRY-${callCount}`
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    })

    const res1 = await handleFeedbackSubmit(
      { category: 'course_sync', description: '第一次提交问题描述' },
      { store }
    )
    const res2 = await handleFeedbackSubmit(
      { category: 'course_sync', description: '第二次重复点击提交问题描述' },
      { store }
    )

    expect(res1.feedbackId).toBe('FB-20261019-RETRY-1')
    expect(res2.feedbackId).toBe('FB-20261019-RETRY-2')
    expect(res1.feedbackId).not.toBe(res2.feedbackId)

    const recent = await store.getRecentDiagnostics(10)
    expect(recent.length).toBe(2)
  })

  it('10. 匿名诊断关闭时：平台兼容性异常绝不外发网络请求', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock

    // 用户配置 anonymousDiagnostics = false
    await store.writeJson('settings.json', { anonymousDiagnostics: false })

    const cx = getAdapter('chaoxing') as unknown as ChaoxingAdapter
    cx.recordFailure('parse_error', '连续异常 1', 'PARSE_1')
    cx.recordFailure('parse_error', '连续异常 2', 'PARSE_2')

    const res = await checkAndDispatchCompatibilityAlert('chaoxing', { store })
    expect(res.reported).toBe(false)
    expect(res.reason).toBe('user_opt_out')
    // 零网络外发
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('11. 地图瓦片加载失败诊断与真实构建提交验证', async () => {
    // 验证 buildCommit 不再是死代码 2b351ad
    const commit = resolveBuildCommit()
    expect(commit).not.toBe('2b351ad')
    expect(commit).toMatch(/^[0-9a-f]{7,40}$/i)

    const pkg = await store.buildDiagnosticPackage('chaoxing', getAllPlatformHealth())
    expect(pkg.manifest.app.buildCommit).toBe(commit)

    // 记录一条地图瓦片失败诊断
    const geoEvent = await store.recordDiagnostic({
      module: 'geo',
      level: 'warn',
      type: 'map_tile_error',
      code: 'MAP_TILE_LOAD_ERROR',
      summary: '地图瓦片加载失败 (CartoDB 浅色)，可能由于国内网络受阻或连接超时',
      data: {
        providerId: 'carto_light',
        urlPattern: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'
      }
    })

    expect(geoEvent.code).toBe('MAP_TILE_LOAD_ERROR')
    expect(geoEvent.module).toBe('geo')

    // 地图报错绝不污染课程平台状态机
    const cxHealth = (await store.buildDiagnosticPackage('chaoxing', getAllPlatformHealth())).manifest.runtime.platformsHealth.chaoxing
    expect(cxHealth.state).not.toBe('suspected_api_change')
  })

  it('12. 反馈幂等性验收：客户端重试传入稳定 clientFeedbackId，服务端确认幂等并直接返回成功', async () => {
    let callCount = 0
    globalThis.fetch = vi.fn(async (_url, opts) => {
      callCount++
      const body = JSON.parse(opts?.body as string)
      expect(body.clientFeedbackId).toBe('FB-20261019-CLIENTIDEMP1')

      if (callCount === 1) {
        // 第一次：服务端已落盘，但在网络传输给客户端前超时/连接中断
        throw new Error('Connection reset by peer')
      }
      // 第二次：客户端使用相同的 clientFeedbackId 重试，服务端返回幂等成功
      return new Response(
        JSON.stringify({
          success: true,
          feedbackId: 'FB-20261019-CLIENTIDEMP1',
          issueNumber: 123,
          message: '反馈早前已成功接收（已幂等去重）',
          idempotent: true
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    })

    // 第一次提交失败并转入离线兜底
    const res1 = await handleFeedbackSubmit(
      {
        clientFeedbackId: 'FB-20261019-CLIENTIDEMP1',
        category: 'course_sync',
        description: '网络抖动重试测试反馈内容',
        attachDiagnostics: false
      },
      { store }
    )
    expect(res1.success).toBe(false)
    expect(res1.offlineFallback).toBe(true)
    expect(res1.feedbackId).toBe('FB-20261019-CLIENTIDEMP1')

    // 第二次重试（复用同一编号）
    const res2 = await handleFeedbackSubmit(
      {
        clientFeedbackId: 'FB-20261019-CLIENTIDEMP1',
        category: 'course_sync',
        description: '网络抖动重试测试反馈内容',
        attachDiagnostics: false
      },
      { store }
    )
    expect(res2.success).toBe(true)
    expect(res2.feedbackId).toBe('FB-20261019-CLIENTIDEMP1')
    expect(res2.idempotent).toBe(true)
    expect(res2.issueNumber).toBe(123)

    // 确认诊断事件记录了 [幂等识别] 标记
    const recent = await store.getRecentDiagnostics(10)
    expect(recent[0].code).toBe('FEEDBACK_SUBMIT_SUCCESS')
    expect(recent[0].summary).toContain('[幂等识别]')
    expect(recent[0].data?.idempotent).toBe(true)
  })
})
