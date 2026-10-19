import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { TestbedServer } from '../../src/main/testbed/testbed-server'
import path from 'node:path'

describe('真实反馈闭环仿真测试 (Section 三)', () => {
  let testbed: TestbedServer
  let serverUrl: string
  let token: string

  beforeAll(async () => {
    const fixturesDir = path.join(__dirname, '../fixtures')
    testbed = new TestbedServer(fixturesDir)
    await testbed.start()
    serverUrl = testbed.getUrl()
    token = testbed.getToken()
  })

  afterAll(async () => {
    await testbed.stop()
  })

  beforeEach(() => {
    testbed.reset()
  })

  it('场景 1: 普通用户提交完整反馈 (含脱敏诊断与截图) 成功闭环并入库', async () => {
    const fakeZipBase64 = Buffer.from('PK\x03\x04' + 'fake_zip_binary_data').toString('base64')
    const fakeShotBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

    const payload = {
      category: 'course_sync',
      description: '点击超星课程刷新后一直加载，没有显示课程封面',
      reproductionSteps: '1. 进入超星 2. 点击刷新',
      contact: 'student_tester@school.edu',
      systemInfo: {
        appVersion: '0.4.3-rc',
        os: 'win32 10.0.26100',
        arch: 'x64',
        timestamp: Date.now()
      },
      diagnosticsSummary: {
        totalErrors: 1,
        recentCodes: ['SYNC_TIMEOUT'],
        activePlatform: 'chaoxing',
        errorFingerprint: 'FP-A1B2-C3D4'
      },
      diagnosticPackageBase64: fakeZipBase64,
      screenshotBase64: fakeShotBase64
    }

    const res = await fetch(`${serverUrl}/api/feedback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CourseHub-Testbed-Token': token
      },
      body: JSON.stringify(payload)
    })

    expect(res.status).toBe(200)
    const result = (await res.json()) as any
    expect(result.success).toBe(true)
    expect(result.feedbackId).toMatch(/^FB-\d{8}-[0-9A-Z]{6}$/)
    expect(result.mockStored).toBe(true)
    expect(result.storedR2Zip).toBe(true)
    expect(result.storedR2Shot).toBe(true)

    // 验证私有存储中能找到对应附件
    const r2 = testbed.getMockR2Storage()
    expect(r2.has(`diagnostics/${result.feedbackId}.zip`)).toBe(true)
    expect(r2.has(`screenshots/${result.feedbackId}.png`)).toBe(true)
    expect(r2.get(`diagnostics/${result.feedbackId}.zip`)?.contentType).toBe('application/zip')

    // 验证生成了对应的 GitHub Issue
    const issues = testbed.getMockIssues()
    expect(issues.length).toBe(1)
    expect(issues[0].count).toBe(1)
    expect(issues[0].title).toContain('course_sync')
  })

  it('场景 2: 用户不附加诊断与截图时：私有存储严格不保存附件', async () => {
    const payload = {
      category: 'suggestion_other',
      description: '希望能增加更多快捷键支持',
      systemInfo: {
        appVersion: '0.4.3-rc',
        os: 'win32',
        timestamp: Date.now()
      }
    }

    const res = await fetch(`${serverUrl}/api/feedback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CourseHub-Testbed-Token': token
      },
      body: JSON.stringify(payload)
    })

    const result = (await res.json()) as any
    expect(result.success).toBe(true)
    expect(result.storedR2Zip).toBe(false)
    expect(result.storedR2Shot).toBe(false)

    // 私有存储严格为空
    const r2 = testbed.getMockR2Storage()
    expect(r2.size).toBe(0)
  })

  it('场景 3: 相同错误指纹多次反馈，自动聚合 (+1) 而不创建冗余 Issue', async () => {
    const fp = 'FP-E5F6-7890'
    const payload1 = {
      category: 'course_sync',
      description: '用户 A: 课程列表解析失败',
      systemInfo: { appVersion: '0.4.3-rc', os: 'win32', timestamp: Date.now() },
      diagnosticsSummary: { errorFingerprint: fp, totalErrors: 1, recentCodes: ['ERR_PARSE'] }
    }
    const payload2 = {
      category: 'course_sync',
      description: '用户 B: 同一错误再次上报',
      systemInfo: { appVersion: '0.4.3-rc', os: 'win32', timestamp: Date.now() },
      diagnosticsSummary: { errorFingerprint: fp, totalErrors: 1, recentCodes: ['ERR_PARSE'] }
    }

    const res1 = await fetch(`${serverUrl}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CourseHub-Testbed-Token': token },
      body: JSON.stringify(payload1)
    })
    const data1 = (await res1.json()) as any

    const res2 = await fetch(`${serverUrl}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CourseHub-Testbed-Token': token },
      body: JSON.stringify(payload2)
    })
    const data2 = (await res2.json()) as any

    expect(data1.issueNumber).toBe(data2.issueNumber)
    expect(data2.issueCount).toBe(2)

    // 维护者视图核对：Issue 列表仅存在 1 条，但包含 2 次上报聚合记录
    const issues = testbed.getMockIssues()
    expect(issues.length).toBe(1)
    expect(issues[0].count).toBe(2)
    expect(issues[0].comments.length).toBe(1)
    expect(issues[0].comments[0]).toContain(data2.feedbackId)
  })

  it('场景 4: 不同错误指纹独立创建 Issue，互不混淆', async () => {
    const payload1 = {
      category: 'course_sync',
      description: '解析失败 A',
      systemInfo: { appVersion: '0.4.3-rc', os: 'win32', timestamp: Date.now() },
      diagnosticsSummary: { errorFingerprint: 'FP-1111-2222', totalErrors: 1, recentCodes: ['ERR_A'] }
    }
    const payload2 = {
      category: 'courseware_video',
      description: '视频错误 B',
      systemInfo: { appVersion: '0.4.3-rc', os: 'win32', timestamp: Date.now() },
      diagnosticsSummary: { errorFingerprint: 'FP-3333-4444', totalErrors: 1, recentCodes: ['ERR_B'] }
    }

    const res1 = await fetch(`${serverUrl}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CourseHub-Testbed-Token': token },
      body: JSON.stringify(payload1)
    })
    const res2 = await fetch(`${serverUrl}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CourseHub-Testbed-Token': token },
      body: JSON.stringify(payload2)
    })

    const data1 = (await res1.json()) as any
    const data2 = (await res2.json()) as any

    expect(data1.issueNumber).not.toBe(data2.issueNumber)
    const issues = testbed.getMockIssues()
    expect(issues.length).toBe(2)
  })

  it('场景 5: 全程零 GitHub 账户依赖', async () => {
    // 验证请求中无需携带任何个人 GitHub Token 或登录 Cookie
    const payload = {
      category: 'ui_display',
      description: '深色模式下图标对比度略低',
      systemInfo: { appVersion: '0.4.3-rc', os: 'win32', timestamp: Date.now() }
    }

    const res = await fetch(`${serverUrl}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CourseHub-Testbed-Token': token },
      body: JSON.stringify(payload)
    })

    expect(res.status).toBe(200)
    const data = (await res.json()) as any
    expect(data.success).toBe(true)
    expect(data.feedbackId).toBeDefined()
  })
})
