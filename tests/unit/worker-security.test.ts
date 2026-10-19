import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import worker, { Env, D1DatabaseLike, D1PreparedStatementLike } from '../../services/feedback-worker/src/index'

describe('Cloudflare Worker + D1 免费方案安全与业务测试 (worker-security-d1)', () => {
  let originalFetch: typeof globalThis.fetch
  let mockFeedbackTable: Map<string, Record<string, unknown>>
  let mockFingerprintsTable: Map<string, Record<string, unknown>>
  let mockSyncJobsTable: Map<string, Record<string, unknown>>
  let mockRateLimitsTable: Map<string, { count: number; reset_at: number }>
  let mockD1: D1DatabaseLike
  let mockEnv: Env

  beforeEach(() => {
    originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ number: 99, html_url: 'https://github.com/mock/issue/99' }), { status: 200 })
    })
    mockFeedbackTable = new Map()
    mockFingerprintsTable = new Map()
    mockSyncJobsTable = new Map()
    mockRateLimitsTable = new Map()

    mockD1 = {
      prepare(query: string): D1PreparedStatementLike {
        let boundValues: unknown[] = []

        const stmt: D1PreparedStatementLike = {
          bind(...values: unknown[]) {
            boundValues = values
            return stmt
          },
          async first<T = unknown>(_colName?: string): Promise<T | null> {
            if (query.includes('FROM rate_limits WHERE key = ?')) {
              const key = boundValues[0] as string
              const row = mockRateLimitsTable.get(key)
              return (row || null) as unknown as T
            }
            if (query.includes('FROM error_fingerprints WHERE fingerprint = ? AND category = ?')) {
              const fp = boundValues[0] as string
              const cat = boundValues[1] as string
              const row = mockFingerprintsTable.get(`${fp}:${cat}`)
              return (row || null) as unknown as T
            }
            return null
          },
          async run<T = unknown>() {
            if (query.includes('INSERT OR REPLACE INTO rate_limits')) {
              const key = boundValues[0] as string
              const resetAt = boundValues[1] as number
              mockRateLimitsTable.set(key, { count: 1, reset_at: resetAt })
            } else if (query.includes('UPDATE rate_limits SET count = count + 1')) {
              const key = boundValues[0] as string
              const row = mockRateLimitsTable.get(key)
              if (row) row.count += 1
            } else if (query.includes('INSERT INTO feedback')) {
              const id = boundValues[0] as string
              mockFeedbackTable.set(id, {
                id,
                category: boundValues[1],
                description: boundValues[2],
                reproduction_steps: boundValues[3],
                contact: boundValues[4],
                app_version: boundValues[5],
                os_info: boundValues[6],
                error_fingerprint: boundValues[7],
                diagnostics_summary: boundValues[8],
                client_ip: boundValues[9],
                created_at: boundValues[10],
                created_timestamp: boundValues[11]
              })
            } else if (query.includes('INSERT OR REPLACE INTO error_fingerprints')) {
              const fp = boundValues[0] as string
              const cat = boundValues[1] as string
              mockFingerprintsTable.set(`${fp}:${cat}`, {
                fingerprint: fp,
                category: cat,
                issue_number: boundValues[2],
                issue_url: boundValues[3],
                report_count: 1,
                first_seen_at: boundValues[4],
                last_seen_at: boundValues[5]
              })
            } else if (query.includes('UPDATE error_fingerprints SET report_count = report_count + 1')) {
              const lastSeen = boundValues[0] as string
              const fp = boundValues[1] as string
              const cat = boundValues[2] as string
              const row = mockFingerprintsTable.get(`${fp}:${cat}`)
              if (row) {
                row.report_count = Number(row.report_count || 1) + 1
                row.last_seen_at = lastSeen
              }
            } else if (query.includes('INSERT OR REPLACE INTO github_sync_jobs')) {
              const fid = boundValues[0] as string
              mockSyncJobsTable.set(fid, {
                feedback_id: fid,
                action: boundValues[1],
                fingerprint: boundValues[2],
                status: 'pending',
                last_error: boundValues[3]
              })
            } else if (query.includes('UPDATE feedback SET status = ?')) {
              const fid = boundValues[3] as string
              const row = mockFeedbackTable.get(fid)
              if (row) {
                row.status = boundValues[0]
                row.github_issue_number = boundValues[1]
                row.github_issue_url = boundValues[2]
              }
            }
            return { success: true, results: [] as T[] }
          },
          async all<T = unknown>() {
            return { success: true, results: [] as T[] }
          }
        }
        return stmt
      },
      async batch() {
        return []
      },
      async exec() {
        return {}
      }
    }

    mockEnv = {
      ENVIRONMENT: 'staging',
      GITHUB_REPO_OWNER: 'Qiuizi',
      GITHUB_REPO_NAME: 'CourseHub-feedback-staging',
      GITHUB_TOKEN: 'mock_gh_pat_token',
      DB: mockD1
    }
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('1. 健康检查端点正常响应并标识 D1 Free 存储', async () => {
    const req = new Request('https://worker.local/health')
    const res = await worker.fetch(req, mockEnv)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { status: string; service: string; storage: string }
    expect(json.status).toBe('ok')
    expect(json.service).toBe('coursehub-feedback-worker')
    expect(json.storage).toBe('cloudflare-d1-free')
  })

  it('2. 拦截超出 256KB 的请求体，杜绝大二进制直接灌入 D1', async () => {
    const req = new Request('https://worker.local/api/feedback', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(300 * 1024)
      },
      body: JSON.stringify({ category: 'login', description: 'test' })
    })

    const res = await worker.fetch(req, mockEnv)
    expect(res.status).toBe(413)
    const json = (await res.json()) as { success: boolean; message: string }
    expect(json.success).toBe(false)
    expect(json.message).toContain('256KB')
  })

  it('3. 拦截缺少必要字段或字数过少的请求', async () => {
    const req = new Request('https://worker.local/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ category: 'login', description: '坏' })
    })

    const res = await worker.fetch(req, mockEnv)
    expect(res.status).toBe(400)
    const json = (await res.json()) as { success: boolean; message: string }
    expect(json.success).toBe(false)
    expect(json.message).toContain('不少于 5 字')
  })

  it('4. 未绑定 D1 数据库时返回 503 明确报错', async () => {
    const envWithoutDB: Env = {
      ...mockEnv,
      DB: undefined
    }

    const req = new Request('https://worker.local/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ category: 'login', description: '测试无数据库报错场景' })
    })

    const res = await worker.fetch(req, envWithoutDB)
    expect(res.status).toBe(503)
    const json = (await res.json()) as { success: boolean; message: string }
    expect(json.success).toBe(false)
    expect(json.message).toContain('数据库未绑定')
  })

  it('5. 开启 STAGING_ACCESS_KEY 时拦截未授权的访问请求', async () => {
    const envWithKey: Env = {
      ...mockEnv,
      STAGING_ACCESS_KEY: 'staging_secret_key_123'
    }

    // 缺少头部
    const req1 = new Request('https://worker.local/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ category: 'login', description: '测试未授权访问' })
    })
    const res1 = await worker.fetch(req1, envWithKey)
    expect(res1.status).toBe(401)

    // 携带合法头部
    const req2 = new Request('https://worker.local/api/feedback', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-coursehub-staging-key': 'staging_secret_key_123'
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

  it('6. 服务端对问题描述与复现步骤中的凭据进行二次脱敏', async () => {
    let capturedIssueBody = ''

    globalThis.fetch = vi.fn(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const urlStr = url.toString()
      if (urlStr.includes('/issues') && init?.method === 'POST') {
        const bodyObj = JSON.parse(init.body as string)
        capturedIssueBody = bodyObj.body
        return new Response(JSON.stringify({ number: 101, html_url: 'https://github.com/mock/issue/101' }), {
          status: 201
        })
      }
      return new Response(JSON.stringify({}), { status: 200 })
    })

    const req = new Request('https://worker.local/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        category: 'sync',
        description: '用户手打敏感信息: Bearer secret_token_xyz123, 密码 password=mysecret999, 手机 13800138000',
        reproductionSteps: '访问 URL: https://mooc1.chaoxing.com/test?token=abc888',
        systemInfo: { appVersion: '0.4.3', os: 'Windows 11', timestamp: Date.now() }
      })
    })

    const res = await worker.fetch(req, mockEnv)
    expect(res.status).toBe(200)

    // 验证 GitHub Issue 描述中敏感字段已被遮盖
    expect(capturedIssueBody).not.toContain('secret_token_xyz123')
    expect(capturedIssueBody).not.toContain('mysecret999')
    expect(capturedIssueBody).not.toContain('13800138000')
    expect(capturedIssueBody).not.toContain('abc888')
    expect(capturedIssueBody).toContain('[TOKEN_REDACTED]')
    expect(capturedIssueBody).toContain('[PHONE_REDACTED]')
    expect(capturedIssueBody).toContain('token=[REDACTED_PARAM]')

    // 验证 D1 feedback 表中存储的数据同样已经脱敏
    const insertedFeedback = Array.from(mockFeedbackTable.values())[0]
    expect(insertedFeedback.description).not.toContain('secret_token_xyz123')
    expect(insertedFeedback.description).toContain('[TOKEN_REDACTED]')
  })

  it('7. D1 错误指纹表聚合：同类问题追加评论 (+1) 且不重复创建 Issue', async () => {
    let createIssueCount = 0
    let commentCount = 0

    globalThis.fetch = vi.fn(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const urlStr = url.toString()
      if (urlStr.endsWith('/issues') && init?.method === 'POST') {
        createIssueCount++
        return new Response(JSON.stringify({ number: 88, html_url: 'https://github.com/mock/issue/88' }), {
          status: 201
        })
      }
      if (urlStr.includes('/issues/88/comments') && init?.method === 'POST') {
        commentCount++
        return new Response(JSON.stringify({ id: 999 }), { status: 201 })
      }
      return new Response(JSON.stringify({}), { status: 200 })
    })

    const fingerprint = 'FP-1234-ABCD'

    // 用户 A 首次上报：D1 无该指纹，调用 GitHub 创建 Issue #88，并写入 error_fingerprints 表
    const reqA = new Request('https://worker.local/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        category: 'sync',
        description: '用户 A 上报接口异常',
        systemInfo: { appVersion: '0.4.3', os: 'Windows 11', timestamp: Date.now() },
        diagnosticsSummary: {
          totalErrors: 1,
          recentCodes: ['PARSE_ERROR'],
          errorFingerprint: fingerprint
        }
      })
    })

    const resA = await worker.fetch(reqA, mockEnv)
    expect(resA.status).toBe(200)
    expect(createIssueCount).toBe(1)
    expect(commentCount).toBe(0)

    // 验证 D1 中已记录该指纹
    const cachedFp = mockFingerprintsTable.get(`${fingerprint}:sync`)
    expect(cachedFp).toBeDefined()
    expect(cachedFp?.issue_number).toBe(88)

    // 用户 B 随后上报相同指纹问题：命中 D1 指纹表，直接向 Issue #88 发送 +1 评论，绝不创建新 Issue
    const reqB = new Request('https://worker.local/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        category: 'sync',
        description: '用户 B 同样遇到该解析异常',
        systemInfo: { appVersion: '0.4.3', os: 'Windows 11', timestamp: Date.now() },
        diagnosticsSummary: {
          totalErrors: 1,
          recentCodes: ['PARSE_ERROR'],
          errorFingerprint: fingerprint
        }
      })
    })

    const resB = await worker.fetch(reqB, mockEnv)
    expect(resB.status).toBe(200)
    expect(createIssueCount).toBe(1) // 依然为 1，无重复建单
    expect(commentCount).toBe(1) // 成功追加评论

    // 验证指纹统计次数递增
    expect(cachedFp?.report_count).toBe(2)
  })

  it('8. GitHub 同步失败时安全记录待重试任务至 github_sync_jobs，且不假装 Issue 已创建', async () => {
    globalThis.fetch = vi.fn(async () => {
      // 模拟 GitHub API 500 宕机或网络中断
      return new Response(JSON.stringify({ message: 'GitHub Service Unavailable' }), { status: 503 })
    })

    const req = new Request('https://worker.local/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        category: 'activity',
        description: '测试 GitHub 同步失败容灾机制',
        systemInfo: { appVersion: '0.4.3', os: 'Windows 11', timestamp: Date.now() }
      })
    })

    const res = await worker.fetch(req, mockEnv)
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      success: boolean
      feedbackId: string
      issueUrl?: string
      syncedToGitHub: boolean
    }
    expect(json.success).toBe(true)
    expect(json.syncedToGitHub).toBe(false)
    expect(json.issueUrl).toBeUndefined() // 绝不伪造已同步

    // 验证 github_sync_jobs 表记录了该待重试任务
    const syncJob = mockSyncJobsTable.get(json.feedbackId)
    expect(syncJob).toBeDefined()
    expect(syncJob?.status).toBe('pending')
    expect(syncJob?.action).toBe('create_issue')
  })

  it('9. D1 持久化 IP 频控有效拦截频发滥用请求 (429 Too Many Requests)', async () => {
    const testIp = '198.51.100.22'

    // 连续提交 5 次
    for (let i = 0; i < 5; i++) {
      const req = new Request('https://worker.local/api/feedback', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': testIp
        },
        body: JSON.stringify({
          category: 'login',
          description: `第 ${i + 1} 次频控测试提交`,
          systemInfo: { appVersion: '0.4.3', os: 'Windows 11', timestamp: Date.now() }
        })
      })
      const res = await worker.fetch(req, mockEnv)
      expect(res.status).toBe(200)
    }

    // 第 6 次提交应被 D1 频控判定超限拦截
    const reqExceed = new Request('https://worker.local/api/feedback', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': testIp
      },
      body: JSON.stringify({
        category: 'login',
        description: '超出 5 次频控限制的第 6 次提交',
        systemInfo: { appVersion: '0.4.3', os: 'Windows 11', timestamp: Date.now() }
      })
    })

    const resExceed = await worker.fetch(reqExceed, mockEnv)
    expect(resExceed.status).toBe(429)
    const json = (await resExceed.json()) as { success: boolean; message: string }
    expect(json.success).toBe(false)
    expect(json.message).toContain('提交太频繁')
  })
})
