/**
 * 本地自有测试站点轻量 HTTP 服务。
 *
 * 核心目的：
 * 验证真正的客户端—服务端双向闭环（开发文档 §7、§9）：
 * 1. 服务端下发签到活动；
 * 2. 客户端页面读取定位并向服务端 POST /api/signin；
 * 3. 服务端在后端根据坐标与容差规则判定（Haversine）并持久化；
 * 4. 客户端再次 GET /api/signin/status 校验权威记录；
 * 5. 支持测试超出容差、重复提交、缺少定位等异常分支。
 *
 * 安全约束（开发文档 §9.3 & v0.3.3 安全审计）：
 * - 仅绑定 127.0.0.1，使用随机动态端口，不向公网开放；
 * - 每次启动生成随机 UUID 访问令牌（Token），所有 /api/* 端点严格鉴权；
 * - Origin 白名单校验：阻止外部网页跨站（CSRF）访问或触发测试状态；
 * - 请求方法与 Content-Type 严格检查，POST 必须携带 application/json；
 * - 请求体大小限制（64KB）与请求频率限流（60 req/s），防止内存放大或拒绝服务；
 * - 静态文件路径规范化与目录越界（Path Traversal）拦截；
 * - 退出时释放端口、销毁 Token 并清空打卡记录，完全隔离于生产 Session。
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { haversineMeters } from '@shared/geo'

export interface TestServerActivity {
  id: string
  title: string
  kind: 'normal' | 'location'
  targetLat?: number
  targetLon?: number
  allowedRadiusMeters?: number
  locationText?: string
  expiresAt: string
  status: 'open' | 'closed'
}

export interface TestServerSignInRecord {
  activityId: string
  signedAt: string
  coords?: { latitude: number; longitude: number; accuracy: number }
  distanceMeters?: number
  status: 'checked_in'
}

const INITIAL_ACTIVITIES: TestServerActivity[] = [
  {
    id: 'test-srv-sign-01',
    title: '本地服务 · 普通随堂打卡（服务端验证）',
    kind: 'normal',
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    status: 'open'
  },
  {
    id: 'test-srv-sign-02',
    title: '本地服务 · 定位考勤打卡（服务端容差判定）',
    kind: 'location',
    targetLat: 39.9042,
    targetLon: 116.4074,
    allowedRadiusMeters: 500,
    locationText: '北京市天安门（39.9042, 116.4074）半径500m',
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    status: 'open'
  }
]

export class TestbedServer {
  private server: http.Server | null = null
  private port = 0
  private token = ''
  private activities: TestServerActivity[] = JSON.parse(JSON.stringify(INITIAL_ACTIVITIES))
  private records = new Map<string, TestServerSignInRecord>()
  private feedbackList: Array<{ feedbackId: string; payload: unknown; receivedAt: string }> = []
  private mockR2Storage = new Map<string, { bytes: number; contentType: string }>()
  private mockIssues = new Map<string, { issueNumber: number; title: string; count: number; comments: string[] }>()
  private nextIssueNumber = 101
  private requestCountLastSec = 0
  private lastSecTimestamp = Date.now()

  constructor(private readonly fixturesDir: string) {}

  getPort(): number {
    return this.port
  }

  getUrl(): string {
    return `http://127.0.0.1:${this.port}`
  }

  getToken(): string {
    return this.token
  }

  async start(): Promise<number> {
    if (this.server && this.port > 0) return this.port
    this.token = crypto.randomUUID()

    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, code: 'INTERNAL_ERROR', error: String(err) }))
        })
      })

      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (addr && typeof addr === 'object') {
          this.port = addr.port
          this.server = server
          resolve(this.port)
        } else {
          reject(new Error('无法获取测试服务器端口'))
        }
      })

      server.on('error', reject)
    })
  }

  async stop(): Promise<void> {
    if (!this.server) return
    return new Promise((resolve) => {
      this.server?.close(() => {
        this.server = null
        this.port = 0
        this.token = ''
        this.records.clear()
        resolve()
      })
    })
  }

  reset(): void {
    this.records.clear()
    this.feedbackList = []
    this.mockR2Storage.clear()
    this.mockIssues.clear()
    this.activities = JSON.parse(JSON.stringify(INITIAL_ACTIVITIES))
  }

  getFeedbackList(): Array<{ feedbackId: string; payload: unknown; receivedAt: string }> {
    return [...this.feedbackList]
  }

  getMockR2Storage(): Map<string, { bytes: number; contentType: string }> {
    return new Map(this.mockR2Storage)
  }

  getMockIssues(): Array<{ issueNumber: number; title: string; count: number; comments: string[] }> {
    return Array.from(this.mockIssues.values())
  }

  private checkRateLimit(): boolean {
    const now = Date.now()
    if (now - this.lastSecTimestamp > 1000) {
      this.requestCountLastSec = 1
      this.lastSecTimestamp = now
      return true
    }
    this.requestCountLastSec++
    return this.requestCountLastSec <= 60
  }

  private async parseBody(req: http.IncomingMessage): Promise<{ body: unknown; error?: string }> {
    return new Promise((resolve) => {
      let body = ''
      let destroyed = false
      req.on('data', (chunk) => {
        body += chunk
        if (body.length > 64 * 1024) {
          destroyed = true
          req.destroy()
          resolve({ body: null, error: 'PAYLOAD_TOO_LARGE' })
        }
      })
      req.on('end', () => {
        if (destroyed) return
        try {
          resolve({ body: body ? JSON.parse(body) : {} })
        } catch {
          resolve({ body: {}, error: 'INVALID_JSON' })
        }
      })
    })
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // 0. 请求频率限制（防止死循环洪泛）
    if (!this.checkRateLimit()) {
      res.writeHead(429, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, code: 'TOO_MANY_REQUESTS', message: '请求过于频繁' }))
      return
    }

    // 1. 验证 Origin（来源白名单检查，拦截外部网站的跨站调用）
    const origin = req.headers.origin
    if (origin) {
      const isAllowedOrigin =
        origin === 'null' ||
        origin === `http://127.0.0.1:${this.port}` ||
        origin === `http://localhost:${this.port}` ||
        origin.startsWith('vscode-webview://')
      if (!isAllowedOrigin) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            ok: false,
            code: 'FORBIDDEN_ORIGIN',
            message: '安全拦截：禁止外部未授权跨站访问本地测试服务'
          })
        )
        return
      }
      res.setHeader('Access-Control-Allow-Origin', origin)
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*')
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CourseHub-Testbed-Token')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const parsedUrl = new URL(req.url || '/', `http://127.0.0.1:${this.port}`)
    const pathname = parsedUrl.pathname

    // 2. 校验请求方法：仅允许 GET 与 POST
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, code: 'METHOD_NOT_ALLOWED', message: '仅支持 GET 与 POST 方法' }))
      return
    }

    // 3. API 端点鉴权与 Content-Type 检查
    if (pathname.startsWith('/api/')) {
      const clientToken =
        (req.headers['x-coursehub-testbed-token'] as string) || parsedUrl.searchParams.get('token') || ''
      if (!this.token || clientToken !== this.token) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            ok: false,
            code: 'UNAUTHORIZED',
            message: '未授权：缺少或无效的测试服务访问令牌 (Token)'
          })
        )
        return
      }

      if (req.method === 'POST') {
        const ctype = req.headers['content-type'] || ''
        if (!ctype.toLowerCase().includes('application/json')) {
          res.writeHead(415, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              ok: false,
              code: 'UNSUPPORTED_MEDIA_TYPE',
              message: 'POST 请求需指定 Content-Type: application/json'
            })
          )
          return
        }
      }
    }

    // 4. GET /api/activities
    if (req.method === 'GET' && pathname === '/api/activities') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: true,
          activities: this.activities.map((act) => ({
            ...act,
            signed: this.records.has(act.id)
          }))
        })
      )
      return
    }

    // 5. GET /api/signin/status?activityId=...
    if (req.method === 'GET' && pathname === '/api/signin/status') {
      const activityId = parsedUrl.searchParams.get('activityId') || ''
      const record = this.records.get(activityId) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: true,
          activityId,
          status: record ? 'checked_in' : 'open',
          record
        })
      )
      return
    }

    // 6. POST /api/signin
    if (req.method === 'POST' && pathname === '/api/signin') {
      const parsed = await this.parseBody(req)
      if (parsed.error === 'PAYLOAD_TOO_LARGE') {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, code: 'PAYLOAD_TOO_LARGE', message: '请求体超出 64KB 限制' }))
        return
      }

      const payload = (parsed.body ?? {}) as {
        activityId?: string
        latitude?: number
        longitude?: number
        accuracy?: number
      }

      const activity = this.activities.find((a) => a.id === payload.activityId)
      if (!activity) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, code: 'NOT_FOUND', message: '活动不存在' }))
        return
      }

      if (this.records.has(activity.id)) {
        res.writeHead(409, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            ok: false,
            code: 'ALREADY_SIGNED',
            message: '请勿重复签到，服务端已存在签到记录'
          })
        )
        return
      }

      if (activity.kind === 'location') {
        const { latitude, longitude, accuracy = 30 } = payload
        if (typeof latitude !== 'number' || typeof longitude !== 'number') {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              ok: false,
              code: 'LOCATION_REQUIRED',
              message: '该活动为定位签到，缺少经纬度坐标'
            })
          )
          return
        }

        const dist = haversineMeters(
          { latitude, longitude },
          { latitude: activity.targetLat!, longitude: activity.targetLon! }
        )

        const radius = activity.allowedRadiusMeters || 500
        if (dist > radius) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              ok: false,
              code: 'OUT_OF_RANGE',
              distanceMeters: dist,
              allowedRadiusMeters: radius,
              message: `超出签到容差范围（当前距离 ${dist.toFixed(1)}m > 容差 ${radius}m）`
            })
          )
          return
        }

        const record: TestServerSignInRecord = {
          activityId: activity.id,
          signedAt: new Date().toISOString(),
          coords: { latitude, longitude, accuracy },
          distanceMeters: dist,
          status: 'checked_in'
        }
        this.records.set(activity.id, record)

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            ok: true,
            code: 'SUCCESS',
            message: '服务端定位验证通过，签到成功',
            record
          })
        )
        return
      }

      // 普通打卡
      const record: TestServerSignInRecord = {
        activityId: activity.id,
        signedAt: new Date().toISOString(),
        status: 'checked_in'
      }
      this.records.set(activity.id, record)

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: true,
          code: 'SUCCESS',
          message: '服务端确认出勤，普通签到成功',
          record
        })
      )
      return
    }

    // 7. POST /api/reset
    if (req.method === 'POST' && pathname === '/api/reset') {
      this.reset()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, message: '服务端测试状态已重置' }))
      return
    }

    // 8. POST /api/feedback (测试仿真反馈收集端点)
    if (req.method === 'POST' && pathname === '/api/feedback') {
      const parsed = await this.parseBody(req)
      if (parsed.error === 'PAYLOAD_TOO_LARGE') {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, code: 'PAYLOAD_TOO_LARGE', message: '请求体超出 64KB 限制' }))
        return
      }
      const payload = (parsed.body ?? {}) as {
        category?: string
        description?: string
        reproductionSteps?: string
        contact?: string
        diagnosticPackageBase64?: string
        screenshotBase64?: string
        diagnosticsSummary?: {
          errorFingerprint?: string
          totalErrors?: number
          recentCodes?: string[]
        }
      }
      if (!payload.category || !payload.description) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: false, message: '缺少类别或描述' }))
        return
      }
      const feedbackId = `FB-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`
      this.feedbackList.push({ feedbackId, payload, receivedAt: new Date().toISOString() })

      // 模拟 R2 存储
      let storedR2Zip = false
      let storedR2Shot = false
      if (payload.diagnosticPackageBase64) {
        const bin = Buffer.from(payload.diagnosticPackageBase64, 'base64')
        this.mockR2Storage.set(`diagnostics/${feedbackId}.zip`, { bytes: bin.length, contentType: 'application/zip' })
        storedR2Zip = true
      }
      if (payload.screenshotBase64) {
        const bin = Buffer.from(payload.screenshotBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64')
        this.mockR2Storage.set(`screenshots/${feedbackId}.png`, { bytes: bin.length, contentType: 'image/png' })
        storedR2Shot = true
      }

      // 模拟 GitHub Issue 聚合去重
      const fp = payload.diagnosticsSummary?.errorFingerprint
      let issueNumber = 100
      let issueCount = 1
      if (fp) {
        const existing = this.mockIssues.get(fp)
        if (existing) {
          existing.count++
          existing.comments.push(`+1 report from ${feedbackId}`)
          issueNumber = existing.issueNumber
          issueCount = existing.count
        } else {
          issueNumber = this.nextIssueNumber++
          this.mockIssues.set(fp, {
            issueNumber,
            title: `[用户反馈] [${payload.category}] ${payload.description.slice(0, 30)}`,
            count: 1,
            comments: []
          })
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          success: true,
          feedbackId,
          issueNumber,
          issueCount,
          message: '本地测试服务端已成功接收并记录反馈（仿真闭环）',
          mockStored: true,
          storedR2Zip,
          storedR2Shot,
          totalReceived: this.feedbackList.length
        })
      )
      return
    }

    // 9. GET /api/feedback/list (测试查询接收记录)
    if (req.method === 'GET' && pathname === '/api/feedback/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: true,
          feedbacks: this.feedbackList,
          r2Storage: Array.from(this.mockR2Storage.entries()),
          issues: Array.from(this.mockIssues.values())
        })
      )
      return
    }

    // 10. 模拟平台异常场景端点
    if (req.method === 'GET' && pathname === '/api/simulation/chaoxing-captcha') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<!DOCTYPE html><html><body><div id="captcha">请完成安全验证码 anti-spider verification</div></body></html>')
      return
    }

    if (req.method === 'GET' && pathname === '/api/simulation/yuketang-expired') {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: false, code: 401, message: '登录会话已失效，请重新登录' }))
      return
    }

    if (req.method === 'GET' && pathname === '/api/simulation/server-error') {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: false, code: 500, message: 'Internal Server Error' }))
      return
    }

    if (req.method === 'GET' && pathname === '/api/simulation/changed-structure') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 1, message: 'success', unexpectedPayloadKey: [{ unexpectedKey: 1 }] }))
      return
    }

    // 8. 静态文件安全托管（tests/fixtures/*，严格拦截目录越界）
    const cleanPath = pathname.replace(/^\/+/, '')
    const targetFile = path.resolve(this.fixturesDir, cleanPath)
    const normalizedTarget = path.normalize(targetFile)
    const normalizedFixtures = path.normalize(this.fixturesDir)

    if (normalizedTarget.startsWith(normalizedFixtures) && fs.existsSync(normalizedTarget)) {
      const stat = fs.statSync(normalizedTarget)
      if (stat.isFile()) {
        const ext = path.extname(normalizedTarget).toLowerCase()
        const mimeMap: Record<string, string> = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'application/javascript',
          '.css': 'text/css',
          '.json': 'application/json',
          '.mp4': 'video/mp4'
        }
        res.writeHead(200, {
          'Content-Type': mimeMap[ext] || 'application/octet-stream',
          'Content-Length': stat.size
        })
        fs.createReadStream(normalizedTarget).pipe(res)
        return
      }
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not Found')
  }
}
