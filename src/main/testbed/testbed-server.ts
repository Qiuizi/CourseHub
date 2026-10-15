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
 * 约束：
 * - 仅绑定 127.0.0.1，使用随机动态端口，不向公网开放；
 * - 静态托管 tests/fixtures/ 目录；
 * - 0 额外大型依赖，仅基于 Node 内置 http 模块。
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
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
  private activities: TestServerActivity[] = JSON.parse(JSON.stringify(INITIAL_ACTIVITIES))
  private records = new Map<string, TestServerSignInRecord>()

  constructor(private readonly fixturesDir: string) {}

  getPort(): number {
    return this.port
  }

  getUrl(): string {
    return `http://127.0.0.1:${this.port}`
  }

  async start(): Promise<number> {
    if (this.server && this.port > 0) return this.port

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
        resolve()
      })
    })
  }

  reset(): void {
    this.records.clear()
    this.activities = JSON.parse(JSON.stringify(INITIAL_ACTIVITIES))
  }

  private async parseBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
        if (body.length > 1024 * 1024) req.destroy()
      })
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {})
        } catch {
          resolve({})
        }
      })
    })
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // CORS 允许测试页面跨域或同源请求
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const parsedUrl = new URL(req.url || '/', `http://127.0.0.1:${this.port}`)
    const pathname = parsedUrl.pathname

    // 1. GET /api/activities
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

    // 2. GET /api/signin/status?activityId=...
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

    // 3. POST /api/signin
    if (req.method === 'POST' && pathname === '/api/signin') {
      const payload = (await this.parseBody(req)) as {
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

    // 4. POST /api/reset
    if (req.method === 'POST' && pathname === '/api/reset') {
      this.reset()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, message: '服务端测试状态已重置' }))
      return
    }

    // 5. 静态文件托管（tests/fixtures/*）
    const cleanPath = pathname.replace(/^\/+/, '')
    const targetFile = path.resolve(this.fixturesDir, cleanPath)
    if (targetFile.startsWith(this.fixturesDir) && fs.existsSync(targetFile)) {
      const stat = fs.statSync(targetFile)
      if (stat.isFile()) {
        const ext = path.extname(targetFile).toLowerCase()
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
        fs.createReadStream(targetFile).pipe(res)
        return
      }
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not Found')
  }
}
