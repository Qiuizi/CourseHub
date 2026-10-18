import { describe, it, expect, beforeEach } from 'vitest'
import { ChaoxingAdapter, YuketangAdapter, getAllPlatformHealth, HEALTH_LABELS } from '../../src/main/adapters/index'

describe('平台兼容性健康状态机与多平台状态聚合', () => {
  let cx: ChaoxingAdapter
  let ykt: YuketangAdapter

  beforeEach(() => {
    cx = new ChaoxingAdapter()
    ykt = new YuketangAdapter()
  })

  it('初始状态为 healthy 且 label 对应正确', () => {
    const report = cx.getHealthReport()
    expect(report.platformId).toBe('chaoxing')
    expect(report.state).toBe('healthy')
    expect(report.label).toBe(HEALTH_LABELS.healthy)
    expect(report.consecutiveFailures).toBe(0)
    expect(report.errorFingerprint).toBeNull()
  })

  it('登录过期 (expired) 准确分类，不误报为接口变更', () => {
    cx.recordFailure('expired', 'Cookie 已过期')
    const report = cx.getHealthReport()

    expect(report.state).toBe('expired')
    expect(report.label).toBe('登录已过期')
    expect(report.consecutiveFailures).toBe(0)
    expect(report.state).not.toBe('suspected_api_change')
  })

  it('安全验证码 (need_captcha) 准确分类，不误报为接口变更', () => {
    ykt.recordFailure('need_captcha', '触发平台滑块/短信验证码', 'NEED_CAPTCHA')
    const report = ykt.getHealthReport()

    expect(report.state).toBe('need_captcha')
    expect(report.label).toBe('需安全验证码')
    expect(report.consecutiveFailures).toBe(0)
  })

  it('网络异常与请求频控准确分类', () => {
    cx.recordFailure('network_error', 'ETIMEDOUT 连接超时')
    expect(cx.getHealthReport().state).toBe('network_error')

    cx.recordFailure('rate_limited', 'HTTP 429 访问过于频繁')
    expect(cx.getHealthReport().state).toBe('rate_limited')
  })

  it('单次解析失败标记为 parse_error (待观察)，不立即上升为 suspected_api_change', () => {
    cx.recordFailure('parse_error', '课程列表 JSON 解析缺少 list 字段', 'PARSER_STRUCTURE_MISMATCH')
    const report = cx.getHealthReport()

    expect(report.state).toBe('parse_error')
    expect(report.label).toBe('数据解析异常')
    expect(report.consecutiveFailures).toBe(1)
    expect(report.errorFingerprint).toMatch(/^FP-[0-9A-F]{4}-[0-9A-F]{4}$/)
  })

  it('连续 2 次及以上解析失败，自动升级为 suspected_api_change (疑似接口改版)', () => {
    cx.recordFailure('parse_error', '第一次解析异常', 'PARSER_ERROR_1')
    expect(cx.getHealthReport().state).toBe('parse_error')

    cx.recordFailure('parse_error', '第二次解析异常', 'PARSER_ERROR_2')
    const report = cx.getHealthReport()

    expect(report.state).toBe('suspected_api_change')
    expect(report.label).toBe('疑似接口改版')
    expect(report.consecutiveFailures).toBe(2)
  })

  it('成功操作后彻底复位健康状态与失败计数', () => {
    cx.recordFailure('parse_error', '解析异常 1')
    cx.recordFailure('parse_error', '解析异常 2')
    expect(cx.getHealthReport().state).toBe('suspected_api_change')

    // 成功同步或探测
    cx.recordSuccess()
    const report = cx.getHealthReport()

    expect(report.state).toBe('healthy')
    expect(report.consecutiveFailures).toBe(0)
    expect(report.errorFingerprint).toBeNull()
    expect(report.lastSuccessAt).toBeDefined()
  })

  it('getAllPlatformHealth() 正确聚合全部支持的平台健康快照', () => {
    const all = getAllPlatformHealth()

    expect(all).toHaveProperty('chaoxing')
    expect(all).toHaveProperty('yuketang')
    expect(all).toHaveProperty('testbed')
    expect(all).toHaveProperty('zhihuishu')

    expect(all.chaoxing.platformId).toBe('chaoxing')
    expect(all.yuketang.platformId).toBe('yuketang')
  })
})
