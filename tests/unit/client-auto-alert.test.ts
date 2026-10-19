import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { checkAndDispatchCompatibilityAlert } from '../../src/main/ipc/index'
import { getAdapter, ChaoxingAdapter, YuketangAdapter } from '../../src/main/adapters/index'
import type { Store } from '../../src/main/services/store'

describe('客户端平台兼容性自动预警端到端策略测试 (client-auto-alert)', () => {
  let mockStoreData: Map<string, unknown>
  let mockStore: Store
  let originalFetch: typeof globalThis.fetch
  let fetchCalls: Array<{ url: string; body: any; headers: any }>

  const getChaoxing = (): ChaoxingAdapter => getAdapter('chaoxing') as unknown as ChaoxingAdapter
  const getYuketang = (): YuketangAdapter => getAdapter('yuketang') as unknown as YuketangAdapter

  beforeEach(() => {
    mockStoreData = new Map()
    fetchCalls = []

    mockStore = {
      async readJson<T>(file: string, fallback: T): Promise<T> {
        if (mockStoreData.has(file)) {
          return mockStoreData.get(file) as T
        }
        return fallback
      },
      async writeJson(file: string, data: unknown): Promise<void> {
        mockStoreData.set(file, data)
      },
      async log(_level: string, _type: string, _data?: unknown): Promise<void> {
        // no-op
      }
    } as unknown as Store

    originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      let body: any = null
      try {
        body = init?.body ? JSON.parse(init.body as string) : null
      } catch {}
      fetchCalls.push({
        url: String(url),
        body,
        headers: init?.headers
      })
      return new Response(JSON.stringify({ success: true, feedbackId: 'ALERT-MOCK-001' }), { status: 200 })
    })

    // 复位适配器健康状态
    getChaoxing().recordSuccess()
    getYuketang().recordSuccess()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    getChaoxing().recordSuccess()
    getYuketang().recordSuccess()
  })

  it('1. 默认设置或用户关闭匿名诊断时 (anonymousDiagnostics !== true)，绝不向云端发送任何预警事件', async () => {
    const cx = getChaoxing()
    // 模拟连续两次解析失败，进入 suspected_api_change
    cx.recordFailure('parse_error', '课程列表缺少 data 字段', 'PARSE_MISSING_DATA')
    cx.recordFailure('parse_error', '课程列表缺少 data 字段', 'PARSE_MISSING_DATA')
    expect(cx.getHealthReport().state).toBe('suspected_api_change')

    // 用户未开启匿名诊断（默认 settings.json 中 anonymousDiagnostics 为 false 或缺省）
    mockStoreData.set('settings.json', { anonymousDiagnostics: false })

    const res = await checkAndDispatchCompatibilityAlert('chaoxing', { store: mockStore })
    expect(res.reported).toBe(false)
    expect(res.reason).toBe('user_opt_out')
    // 严格断言：fetch 一次都没有被调用，零网络外发
    expect(fetchCalls.length).toBe(0)
  })

  it('2. 用户登录过期 (expired) 属于正常凭证失效，绝不误报为接口改版', async () => {
    mockStoreData.set('settings.json', { anonymousDiagnostics: true })
    const cx = getChaoxing()
    cx.recordFailure('expired', '用户会话已过期，请重新登录', 'AUTH_EXPIRED')

    const res = await checkAndDispatchCompatibilityAlert('chaoxing', { store: mockStore })
    expect(res.reported).toBe(false)
    expect(res.reason).toBe('state_not_alertable:expired')
    expect(fetchCalls.length).toBe(0)
  })

  it('3. 单次网络抖动超时 (network_error) 绝不误报为接口改版', async () => {
    mockStoreData.set('settings.json', { anonymousDiagnostics: true })
    const cx = getChaoxing()
    cx.recordFailure('network_error', 'ETIMEDOUT 127.0.0.1:443', 'NET_TIMEOUT')

    const res = await checkAndDispatchCompatibilityAlert('chaoxing', { store: mockStore })
    expect(res.reported).toBe(false)
    expect(res.reason).toBe('state_not_alertable:network_error')
    expect(fetchCalls.length).toBe(0)
  })

  it('4. 单次结构解析失败 (parse_error) 仅作为待观察状态，不触发自动告警', async () => {
    mockStoreData.set('settings.json', { anonymousDiagnostics: true })
    const cx = getChaoxing()
    cx.recordFailure('parse_error', '初次解析失败', 'PARSE_FIRST')

    const res = await checkAndDispatchCompatibilityAlert('chaoxing', { store: mockStore })
    expect(res.reported).toBe(false)
    expect(res.reason).toBe('state_not_alertable:parse_error')
    expect(fetchCalls.length).toBe(0)
  })

  it('5. 用户同意匿名诊断且连续解析失败时，自动组装脱敏预警事件外发至反馈服务', async () => {
    mockStoreData.set('settings.json', { anonymousDiagnostics: true })
    const cx = getChaoxing()
    cx.recordFailure('parse_error', '课程 DOM 结构无法匹配', 'PARSE_DOM_MISMATCH')
    cx.recordFailure('parse_error', '课程 DOM 结构无法匹配', 'PARSE_DOM_MISMATCH')
    expect(cx.getHealthReport().state).toBe('suspected_api_change')

    const res = await checkAndDispatchCompatibilityAlert('chaoxing', { store: mockStore })
    expect(res.reported).toBe(true)

    // 验证网络请求内容
    expect(fetchCalls.length).toBe(1)
    const call = fetchCalls[0]
    expect(call.body.reportType).toBe('automated_compatibility_alert')
    expect(call.body.description).toContain('[平台自动预警]')
    expect(call.body.diagnosticsSummary.activePlatform).toBe('chaoxing')
    expect(call.body.diagnosticsSummary.totalErrors).toBe(2)
    expect(call.body.diagnosticsSummary.errorFingerprint).toMatch(/^FP-/)

    // 验证写入了本地冷却锁文件
    const lock = mockStoreData.get('cache/alert_lock_chaoxing.json') as { lastAlertAt: number; fingerprint: string }
    expect(lock).toBeDefined()
    expect(lock.fingerprint).toBe(call.body.diagnosticsSummary.errorFingerprint)
  })

  it('6. 6小时单机冷却锁有效阻止同错误指纹连续轰炸', async () => {
    mockStoreData.set('settings.json', { anonymousDiagnostics: true })
    const cx = getChaoxing()
    cx.recordFailure('parse_error', '课程 DOM 结构无法匹配', 'PARSE_DOM_MISMATCH')
    cx.recordFailure('parse_error', '课程 DOM 结构无法匹配', 'PARSE_DOM_MISMATCH')
    const fp = cx.getHealthReport().errorFingerprint

    // 预设冷却锁（30分钟前刚上报过相同指纹）
    mockStoreData.set('cache/alert_lock_chaoxing.json', {
      lastAlertAt: Date.now() - 30 * 60 * 1000,
      fingerprint: fp
    })

    const res = await checkAndDispatchCompatibilityAlert('chaoxing', { store: mockStore })
    expect(res.reported).toBe(false)
    expect(res.reason).toBe('throttled_by_local_lock')
    expect(fetchCalls.length).toBe(0)
  })

  it('7. 故障恢复：后续成功请求彻底复位健康状态，复位后不触发任何预警', async () => {
    mockStoreData.set('settings.json', { anonymousDiagnostics: true })
    const cx = getChaoxing()
    // 发生异常
    cx.recordFailure('parse_error', '一次错误', 'ERR_1')
    cx.recordFailure('parse_error', '两次错误', 'ERR_2')
    expect(cx.getHealthReport().state).toBe('suspected_api_change')

    // 随后请求成功，彻底复位
    cx.recordSuccess()
    expect(cx.getHealthReport().state).toBe('healthy')
    expect(cx.getHealthReport().consecutiveFailures).toBe(0)

    const res = await checkAndDispatchCompatibilityAlert('chaoxing', { store: mockStore })
    expect(res.reported).toBe(false)
    expect(res.reason).toBe('state_not_alertable:healthy')
    expect(fetchCalls.length).toBe(0)
  })

  it('8. 用户中途关闭匿名诊断：立即停止后续一切自动上报', async () => {
    const cx = getChaoxing()
    cx.recordFailure('parse_error', '解析失败 1', 'PARSE_FAIL')
    cx.recordFailure('parse_error', '解析失败 2', 'PARSE_FAIL')

    // 用户在设置界面关闭了开关
    mockStoreData.set('settings.json', { anonymousDiagnostics: false })

    const res = await checkAndDispatchCompatibilityAlert('chaoxing', { store: mockStore })
    expect(res.reported).toBe(false)
    expect(res.reason).toBe('user_opt_out')
    expect(fetchCalls.length).toBe(0)
  })
})
