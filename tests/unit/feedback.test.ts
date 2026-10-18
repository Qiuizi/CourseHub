import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Store } from '../../src/main/services/store'
import { TestbedServer } from '../../src/main/testbed/testbed-server'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'

describe('用户反馈与诊断系统全流程测试', () => {
  let tmpDir: string
  let store: Store

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coursehub-feedback-test-'))
    store = new Store(tmpDir)
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it('recordDiagnostic() 能够自动捕获错误、脱敏敏感信息并写入环形缓冲区', async () => {
    const event = await store.recordDiagnostic({
      module: 'chaoxing',
      platform: 'chaoxing',
      level: 'error',
      type: 'parse_error',
      code: 'PARSER_STRUCTURE_MISMATCH',
      summary: 'API 返回格式不匹配: token=secret_token_123',
      data: {
        rawCookie: 'UID=123456',
        url: 'https://mooc2.chaoxing.com/api?enc=secret_enc_val'
      }
    })

    expect(event.ts).toBeDefined()
    expect(event.fingerprint).toMatch(/^FP-[0-9A-F]{4}-[0-9A-F]{4}$/)
    expect(event.summary).not.toContain('secret_token_123')
    expect(event.data).toBeDefined()
    const data = event.data as Record<string, unknown>
    expect(data.rawCookie).toBe('[REDACTED]')
    expect(data.url).toContain('enc=[REDACTED_PARAM]')

    const recent = await store.getRecentDiagnostics(10)
    expect(recent.length).toBe(1)
    expect(recent[0].fingerprint).toBe(event.fingerprint)
  })

  it('buildDiagnosticPackage() 正确构建脱敏清单与摘要', async () => {
    await store.recordDiagnostic({
      module: 'yuketang',
      platform: 'yuketang',
      level: 'error',
      type: 'auth_failure',
      code: 'AUTH_EXPIRED',
      summary: '用户会话已过期'
    })

    const pkg = await store.buildDiagnosticPackage('yuketang')

    expect(pkg.manifest.app.name).toBe('CourseHub')
    expect(pkg.manifest.runtime.activePlatform).toBe('yuketang')
    expect(pkg.summaryText).toContain('CourseHub 诊断摘要')
    expect(pkg.summaryText).toContain('AUTH_EXPIRED')
    expect(pkg.recentErrors.length).toBe(1)
  })

  it('exportDiagnosticZip() 成功生成包含诊断清单、日志与说明文档的 ZIP 包', async () => {
    await store.recordDiagnostic({
      module: 'video',
      platform: 'chaoxing',
      level: 'error',
      type: 'video_error',
      code: 'PLAYBACK_FAIL',
      summary: '视频加载失败'
    })

    const exportResult = await store.exportDiagnosticZip({
      activePlatform: 'chaoxing',
      feedbackNote: '用户留言：无法播放第三章视频',
      targetDir: tmpDir,
      screenshotBase64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    })

    expect(exportResult.filename).toMatch(/^CourseHub-Diagnostics-.*\.zip$/)
    expect(exportResult.bytes).toBeGreaterThan(100)

    const fileStat = await fs.stat(exportResult.path)
    expect(fileStat.size).toBe(exportResult.bytes)

    const zipContent = await fs.readFile(exportResult.path)
    const contentStr = zipContent.toString('utf-8')
    expect(contentStr).toContain('summary.json')
    expect(contentStr).toContain('errors.jsonl')
    expect(contentStr).toContain('environment.json')
    expect(contentStr).toContain('README.txt')
    expect(contentStr).toContain('screenshot.png')
  })

  it('TestbedServer 仿真接收并记录客户端提交的反馈', async () => {
    const fixturesDir = path.join(__dirname, '../fixtures')
    const testbed = new TestbedServer(fixturesDir)
    await testbed.start()
    const port = testbed.getPort()
    const token = testbed.getToken()

    try {
      const payload = {
        category: 'course_sync',
        description: '课程列表加载缓慢，缺少封面',
        systemInfo: {
          appVersion: '0.4.3-beta',
          os: 'win32'
        }
      }

      const res = await fetch(`http://127.0.0.1:${port}/api/feedback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CourseHub-Testbed-Token': token
        },
        body: JSON.stringify(payload)
      })

      expect(res.status).toBe(200)
      const data = (await res.json()) as any
      expect(data.success).toBe(true)
      expect(data.feedbackId).toMatch(/^FB-\d{8}-[0-9A-Z]{6}$/)
      expect(data.mockStored).toBe(true)

      const list = testbed.getFeedbackList()
      expect(list.length).toBe(1)
      expect(list[0].feedbackId).toBe(data.feedbackId)
    } finally {
      await testbed.stop()
    }
  })
})
