import { describe, it, expect, vi, beforeEach } from 'vitest'
import worker, { Env } from '../../services/feedback-worker/src/index'

describe('Cloudflare Worker 安全审计与防护测试 (worker-security)', () => {
  let mockR2Storage: Map<string, { body: Uint8Array; metadata?: Record<string, unknown> }>
  let mockEnv: Env

  beforeEach(() => {
    mockR2Storage = new Map()

    const mockBucket = {
      async put(key: string, value: Uint8Array | string, options?: Record<string, unknown>) {
        const buf = typeof value === 'string' ? new TextEncoder().encode(value) : value
        mockR2Storage.set(key, { body: buf, metadata: options?.customMetadata as Record<string, unknown> })
        return {}
      },
      async get(key: string) {
        const item = mockR2Storage.get(key)
        if (!item) return null
        return {
          async json() {
            return JSON.parse(new TextDecoder().decode(item.body))
          },
          async text() {
            return new TextDecoder().decode(item.body)
          }
        }
      }
    }

    mockEnv = {
      ENVIRONMENT: 'staging',
      GITHUB_REPO_OWNER: 'Qiuizi',
      GITHUB_REPO_NAME: 'CourseHub-feedback-staging',
      GITHUB_TOKEN: 'mock_gh_token_12345',
      FEEDBACK_STORAGE: mockBucket
    }
  })

  it('1. 健康检查端点正常响应', async () => {
    const req = new Request('https://worker.local/health')
    const res = await worker.fetch(req, mockEnv)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { status: string; service: string }
    expect(json.status).toBe('ok')
    expect(json.service).toBe('coursehub-feedback-worker')
  })

  it('2. 拦截超出 5MB 的大请求体 (Content-Length 头部超限)', async () => {
    const req = new Request('https://worker.local/api/feedback', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(6 * 1024 * 1024)
      },
      body: JSON.stringify({ category: 'login', description: 'test' })
    })

    const res = await worker.fetch(req, mockEnv)
    expect(res.status).toBe(413)
    const json = (await res.json()) as { success: boolean; message: string }
    expect(json.success).toBe(false)
    expect(json.message).toContain('5MB')
  })

  it('3. 拦截 Chunked 隐蔽传输的大请求体 (Body 长度超 5MB)', async () => {
    const hugeDescription = 'A'.repeat(5.2 * 1024 * 1024)
    const req = new Request('https://worker.local/api/feedback', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({ category: 'login', description: hugeDescription })
    })

    const res = await worker.fetch(req, mockEnv)
    expect(res.status).toBe(413)
    const json = (await res.json()) as { success: boolean; message: string }
    expect(json.success).toBe(false)
    expect(json.message).toContain('5MB')
  })

  it('4. 拦截缺少必填字段或描述过短的非法请求', async () => {
    const req = new Request('https://worker.local/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ category: 'login', description: '短' })
    })

    const res = await worker.fetch(req, mockEnv)
    expect(res.status).toBe(400)
    const json = (await res.json()) as { success: boolean; message: string }
    expect(json.success).toBe(false)
    expect(json.message).toContain('不少于 5 字')
  })

  it('5. 严格拦截伪造或损坏的诊断 ZIP 附件 (二进制 Magic Bytes 校验)', async () => {
    // 伪造非 ZIP 数据 (例如纯文本 "THIS_IS_NOT_A_ZIP")
    const fakeZipBase64 = Buffer.from('THIS_IS_NOT_A_ZIP_HEADER').toString('base64')

    const req = new Request('https://worker.local/api/feedback', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': '192.168.1.50'
      },
      body: JSON.stringify({
        category: 'sync',
        description: '测试上传非法伪造压缩文件',
        systemInfo: { appVersion: '0.4.3', os: 'Windows 11', timestamp: Date.now() },
        diagnosticPackageBase64: fakeZipBase64
      })
    })

    const res = await worker.fetch(req, mockEnv)
    expect(res.status).toBe(400)
    const json = (await res.json()) as { success: boolean; message: string }
    expect(json.success).toBe(false)
    expect(json.message).toContain('必须为标准 ZIP 文件')
  })

  it('6. 严格拦截伪造或损坏的截图附件 (图片 Magic Bytes 校验)', async () => {
    // 伪造非 PNG/JPEG 图片 (例如 EXE 标识 "MZ...")
    const fakeImageBase64 = Buffer.from('MZ_FAKE_EXECUTABLE_HEADER_BYTES').toString('base64')

    const req = new Request('https://worker.local/api/feedback', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': '192.168.1.51'
      },
      body: JSON.stringify({
        category: 'sync',
        description: '测试上传非法伪造图片格式',
        systemInfo: { appVersion: '0.4.3', os: 'Windows 11', timestamp: Date.now() },
        screenshotBase64: fakeImageBase64
      })
    })

    const res = await worker.fetch(req, mockEnv)
    expect(res.status).toBe(400)
    const json = (await res.json()) as { success: boolean; message: string }
    expect(json.success).toBe(false)
    expect(json.message).toContain('截图文件格式非法')
  })

  it('7. 未绑定 R2 存储桶时，若请求包含附件应返回 503 明确报错而非假装成功', async () => {
    const envWithoutR2: Env = {
      ...mockEnv,
      FEEDBACK_STORAGE: undefined
    }

    const validZipBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, ...new Array(20).fill(0)])
    const validZipBase64 = validZipBytes.toString('base64')

    const req = new Request('https://worker.local/api/feedback', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': '192.168.1.52'
      },
      body: JSON.stringify({
        category: 'sync',
        description: '附带诊断包但服务器未绑定 R2',
        systemInfo: { appVersion: '0.4.3', os: 'Windows 11', timestamp: Date.now() },
        diagnosticPackageBase64: validZipBase64
      })
    })

    const res = await worker.fetch(req, envWithoutR2)
    expect(res.status).toBe(503)
    const json = (await res.json()) as { success: boolean; message: string }
    expect(json.success).toBe(false)
    expect(json.message).toContain('R2 Bucket 未绑定')
  })

  it('8. 开启 STAGING_ACCESS_KEY 时拦截未授权的访问请求', async () => {
    const envWithKey: Env = {
      ...mockEnv,
      STAGING_ACCESS_KEY: 'test_staging_secret_key_999'
    }

    // 缺少头部
    const req1 = new Request('https://worker.local/api/feedback', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': '192.168.1.53'
      },
      body: JSON.stringify({ category: 'login', description: '测试未授权的请求' })
    })

    const res1 = await worker.fetch(req1, envWithKey)
    expect(res1.status).toBe(401)
    const json1 = (await res1.json()) as { success: boolean }
    expect(json1.success).toBe(false)

    // 携带合法头部
    const req2 = new Request('https://worker.local/api/feedback', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': '192.168.1.53',
        'x-coursehub-staging-key': 'test_staging_secret_key_999'
      },
      body: JSON.stringify({
        category: 'login',
        description: '测试合法携带 Key 的请求',
        systemInfo: { appVersion: '0.4.3', os: 'Windows 11', timestamp: Date.now() }
      })
    })

    const res2 = await worker.fetch(req2, envWithKey)
    expect(res2.status).toBe(200)
    const json2 = (await res2.json()) as { success: boolean; feedbackId: string }
    expect(json2.success).toBe(true)
    expect(json2.feedbackId).toMatch(/^FB-\d{8}-[A-Z0-9]{6}$/)
  })

  it('9. 服务端对问题描述与复现步骤中的敏感凭证进行二次脱敏', async () => {
    let postedIssueBody = ''

    // 模拟 fetch 拦截 GitHub API
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const urlStr = url.toString()
      if (urlStr.includes('api.github.com/repos') && init?.method === 'POST') {
        const bodyObj = JSON.parse(init.body as string)
        postedIssueBody = bodyObj.body
        return new Response(JSON.stringify({ number: 105, html_url: 'https://github.com/mock/issue/105' }), {
          status: 201
        })
      }
      return new Response(JSON.stringify({}), { status: 200 })
    })

    try {
      const sensitiveDescription =
        '用户在描述中手打了凭据: Bearer secret_raw_jwt_token_123, 密码 passwd=admin123456, 手机 13912345678'
      const req = new Request('https://worker.local/api/feedback', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '192.168.1.54'
        },
        body: JSON.stringify({
          category: 'sync',
          description: sensitiveDescription,
          systemInfo: { appVersion: '0.4.3', os: 'Windows 11', timestamp: Date.now() }
        })
      })

      const res = await worker.fetch(req, mockEnv)
      expect(res.status).toBe(200)

      // 验证 GitHub Issue 描述中敏感内容被二次遮盖
      expect(postedIssueBody).not.toContain('secret_raw_jwt_token_123')
      expect(postedIssueBody).not.toContain('admin123456')
      expect(postedIssueBody).not.toContain('13912345678')
      expect(postedIssueBody).toContain('[TOKEN_REDACTED]')
      expect(postedIssueBody).toContain('[PHONE_REDACTED]')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('10. R2 持久化指纹缓存彻底避免连续提交导致重复创建 Issue', async () => {
    let searchCallCount = 0
    let createCallCount = 0
    let commentCallCount = 0

    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const urlStr = url.toString()
      if (urlStr.includes('api.github.com/search/issues')) {
        searchCallCount++
        return new Response(JSON.stringify({ items: [] }), { status: 200 })
      }
      if (urlStr.includes('/issues/') && urlStr.includes('/comments') && init?.method === 'POST') {
        commentCallCount++
        return new Response(JSON.stringify({ id: 2001 }), { status: 201 })
      }
      if (urlStr.includes('/issues') && init?.method === 'POST') {
        createCallCount++
        return new Response(JSON.stringify({ number: 88, html_url: 'https://github.com/mock/issue/88' }), {
          status: 201
        })
      }
      return new Response(JSON.stringify({}), { status: 200 })
    })

    try {
      const fingerprint = 'FP-ABCD-1234'

      // 第一次提交：R2 中无指纹，搜索 GitHub 无果，创建 Issue #88，并立即写入 R2 指纹缓存
      const req1 = new Request('https://worker.local/api/feedback', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '192.168.1.60'
        },
        body: JSON.stringify({
          category: 'sync',
          description: '用户 A 提交的接口解析失败故障',
          systemInfo: { appVersion: '0.4.3', os: 'Windows 11', timestamp: Date.now() },
          diagnosticsSummary: {
            totalErrors: 1,
            recentCodes: ['PARSE_ERROR'],
            errorFingerprint: fingerprint
          }
        })
      })

      const res1 = await worker.fetch(req1, mockEnv)
      expect(res1.status).toBe(200)
      expect(createCallCount).toBe(1)
      expect(commentCallCount).toBe(0)

      // 验证 R2 中已写入指纹缓存
      const cachedFp = mockR2Storage.get(`fingerprints/${fingerprint}.json`)
      expect(cachedFp).toBeDefined()

      // 第二位用户在 3 秒后提交相同指纹的问题（此时 GitHub Search 索引往往还未更新）：
      // 此时 Worker 直接命中 R2 强一致指纹缓存，直接向 Issue #88 追加评论，绝不调用 Search 也绝不创建新 Issue！
      const req2 = new Request('https://worker.local/api/feedback', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '192.168.1.61'
        },
        body: JSON.stringify({
          category: 'sync',
          description: '用户 B 遇到同样的接口解析失败故障（不同描述）',
          systemInfo: { appVersion: '0.4.3', os: 'Windows 11', timestamp: Date.now() },
          diagnosticsSummary: {
            totalErrors: 1,
            recentCodes: ['PARSE_ERROR'],
            errorFingerprint: fingerprint
          }
        })
      })

      const res2 = await worker.fetch(req2, mockEnv)
      expect(res2.status).toBe(200)
      // 验证：未创建第二个 Issue，而是追加评论
      expect(createCallCount).toBe(1)
      expect(commentCallCount).toBe(1)
      // 验证：未消耗第二轮 GitHub Search API 请求（直接命中 R2 缓存）
      expect(searchCallCount).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
