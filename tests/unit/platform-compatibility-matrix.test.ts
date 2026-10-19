import { describe, it, expect, beforeEach } from 'vitest'
import { ChaoxingAdapter, YuketangAdapter } from '../../src/main/adapters/index'
import { Sanitizer } from '../../src/shared/sanitizer'

describe('平台接口兼容性检测与异常预警矩阵测试 (Section 四)', () => {
  let cx: ChaoxingAdapter
  let ykt: YuketangAdapter

  beforeEach(() => {
    cx = new ChaoxingAdapter()
    ykt = new YuketangAdapter()
  })

  it('场景 1: 学习通触发验证码 (need_captcha) 不误报为平台改版', () => {
    cx.recordFailure('need_captcha', '触发平台滑块/短信验证码', 'ANTISPIDER_CAPTCHA')
    const report = cx.getHealthReport()

    expect(report.state).toBe('need_captcha')
    expect(report.label).toBe('需安全验证码')
    expect(report.consecutiveFailures).toBe(0)
    expect(report.state).not.toBe('suspected_api_change')
  })

  it('场景 2: 雨课堂登录过期 (expired) 不误报为平台改版', () => {
    ykt.recordFailure('expired', '会话过期，请重新登录', 'AUTH_EXPIRED')
    const report = ykt.getHealthReport()

    expect(report.state).toBe('expired')
    expect(report.label).toBe('登录已过期')
    expect(report.consecutiveFailures).toBe(0)
    expect(report.state).not.toBe('suspected_api_change')
  })

  it('场景 3: 单次网络超时 (network_error) 不误报为平台改版', () => {
    cx.recordFailure('network_error', 'fetch failed: ETIMEDOUT 127.0.0.1', 'NETWORK_TIMEOUT')
    const report = cx.getHealthReport()

    expect(report.state).toBe('network_error')
    expect(report.consecutiveFailures).toBe(0)
    expect(report.state).not.toBe('suspected_api_change')
  })

  it('场景 4: 平台服务端故障 500 (server_error) 不误报为平台改版', () => {
    cx.recordFailure('server_error', 'HTTP 500 Internal Server Error', 'SERVER_ERROR_500')
    const report = cx.getHealthReport()

    expect(report.state).toBe('server_error')
    expect(report.consecutiveFailures).toBe(0)
    expect(report.state).not.toBe('suspected_api_change')
  })

  it('场景 5: HTTP 200 但结构改变 (单次 parse_error) 仅标记为待观察，不触发报警', () => {
    cx.recordFailure('parse_error', '接口缺少必要字段: list 节点未找到', 'PARSER_STRUCTURE_MISMATCH')
    const report = cx.getHealthReport()

    expect(report.state).toBe('parse_error')
    expect(report.label).toBe('数据解析异常')
    expect(report.consecutiveFailures).toBe(1)
    expect(report.state).not.toBe('suspected_api_change')
    expect(report.errorFingerprint).toMatch(/^FP-[0-9A-F]{4}-[0-9A-F]{4}$/)
  })

  it('场景 6: 连续多次结构解析失败，自动升级为疑似接口改版 (suspected_api_change)', () => {
    cx.recordFailure('parse_error', '第 1 次章节列表解析异常', 'PARSER_STRUCTURE_MISMATCH')
    expect(cx.getHealthReport().state).toBe('parse_error')

    cx.recordFailure('parse_error', '第 2 次课程列表解析异常', 'PARSER_STRUCTURE_MISMATCH')
    const report = cx.getHealthReport()

    expect(report.state).toBe('suspected_api_change')
    expect(report.label).toBe('疑似接口改版')
    expect(report.consecutiveFailures).toBe(2)
  })

  it('场景 7: 多位独立用户遇到同一结构错误，产生相同确定性错误指纹', () => {
    const errorMsg = 'MOOC2 API 返回缺少 courseList 字段'
    const fpUserA = Sanitizer.generateFingerprint({
      platform: 'chaoxing',
      module: 'courses',
      code: 'PARSER_STRUCTURE_MISMATCH',
      summary: errorMsg
    })
    const fpUserB = Sanitizer.generateFingerprint({
      platform: 'chaoxing',
      module: 'courses',
      code: 'PARSER_STRUCTURE_MISMATCH',
      summary: errorMsg
    })

    expect(fpUserA).toBe(fpUserB)
    expect(fpUserA).toMatch(/^FP-[0-9A-F]{4}-[0-9A-F]{4}$/)
  })

  it('场景 8: 跨软件版本产生稳定指纹，保证历史缺陷能够聚合', () => {
    const fpV041 = Sanitizer.generateFingerprint({
      platform: 'yuketang',
      module: 'courses',
      code: 'JSON_SCHEMA_MISMATCH',
      summary: 'data.list is not iterable'
    })
    const fpV043 = Sanitizer.generateFingerprint({
      platform: 'yuketang',
      module: 'courses',
      code: 'JSON_SCHEMA_MISMATCH',
      summary: 'data.list is not iterable'
    })

    expect(fpV041).toBe(fpV043)
  })

  it('场景 9: 故障恢复：后续成功请求彻底复位健康状态与失败计数', () => {
    // 先连续失败
    cx.recordFailure('parse_error', '解析错误 1')
    cx.recordFailure('parse_error', '解析错误 2')
    expect(cx.getHealthReport().state).toBe('suspected_api_change')
    expect(cx.getHealthReport().consecutiveFailures).toBe(2)

    // 成功同步
    cx.recordSuccess()
    const report = cx.getHealthReport()

    expect(report.state).toBe('healthy')
    expect(report.label).toBe('运行正常')
    expect(report.consecutiveFailures).toBe(0)
    expect(report.errorFingerprint).toBeNull()
    expect(report.lastSuccessAt).toBeDefined()
  })
})
