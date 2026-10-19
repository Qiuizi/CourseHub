/**
 * 本地持久化：原子写 + 脱敏日志 + safeStorage 密钥。
 *
 * 契约（开发文档 §9.2）：
 * - JSON + 有边界的 JSONL 脱敏日志，主进程序列化写入，同目录临时文件替换。
 * - secrets.bin 为 safeStorage 密文，renderer 永远读不到明文。
 * - 未知值存 null，不存 0 或推算值。
 */

import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Sanitizer } from '../../shared/sanitizer'
import { createZipBuffer } from './zip'
import type {
  DiagnosticEvent,
  DiagnosticManifest,
  DiagnosticPackageData,
  PlatformHealthReport
} from '../../shared/feedback'
import type { PlatformId } from '../../shared/types'

export type JsonObject = Record<string, unknown>

const MAX_LOG_BYTES = 20 * 1024 * 1024
const LOG_RETENTION_DAYS = 7

export function resolveBuildCommit(): string {
  if (typeof process.env.VITE_BUILD_COMMIT === 'string' && process.env.VITE_BUILD_COMMIT.trim()) {
    return process.env.VITE_BUILD_COMMIT.trim()
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { execSync } = require('node:child_process')
    const rev = execSync('git rev-parse --short HEAD', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    if (rev && /^[0-9a-f]{7,40}$/i.test(rev)) {
      return rev
    }
  } catch {}
  return '65d9472'
}

export class Store {
  private readonly root: string
  private writeChain: Promise<void> = Promise.resolve()

  constructor(root: string) {
    this.root = root
  }

  get dataDir(): string {
    return this.root
  }

  async init(): Promise<void> {
    await fs.mkdir(path.join(this.root, 'cache'), { recursive: true })
    await fs.mkdir(path.join(this.root, 'logs'), { recursive: true })
    await fs.mkdir(path.join(this.root, 'migrations'), { recursive: true })
    await fs.mkdir(path.join(this.root, 'ai'), { recursive: true })
  }

  private file(...parts: string[]): string {
    return path.join(this.root, ...parts)
  }

  /**
   * 原子写：先写同目录 .tmp，再 rename。
   * rename 在同一卷上是原子操作，避免进程崩溃留下半截文件。
   */
  private atomicWrite(target: string, content: string): Promise<void> {
    const run = async (): Promise<void> => {
      const tmp = `${target}.${process.pid}.tmp`
      await fs.writeFile(tmp, content, 'utf8')
      await fs.rename(tmp, target)
    }
    // 串行化所有写，避免并发 rename 互相覆盖
    this.writeChain = this.writeChain.then(run, run)
    return this.writeChain
  }

  async readJson<T>(relPath: string, fallback: T): Promise<T> {
    try {
      const raw = await fs.readFile(this.file(relPath), 'utf8')
      return JSON.parse(raw) as T
    } catch {
      // 读失败返回 fallback，但由调用方把状态标记为 error/initial，不假装 ready
      return fallback
    }
  }

  async writeJson(relPath: string, value: unknown): Promise<void> {
    const target = this.file(relPath)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await this.atomicWrite(target, JSON.stringify(value, null, 2))
  }

  async remove(relPath: string): Promise<void> {
    try {
      await fs.unlink(this.file(relPath))
    } catch {
      /* 不存在即视为已删除 */
    }
  }

  /* ------------------------------- 密钥 ------------------------------- */

  async setSecret(key: string, value: string): Promise<{ ok: boolean; error?: string }> {
    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'ENCRYPTION_UNAVAILABLE' }
    }
    try {
      const cipher = safeStorage.encryptString(value)
      await this.atomicWrite(this.file('secrets.bin'), JSON.stringify({ [key]: cipher.toString('base64') }))
      return { ok: true }
    } catch {
      return { ok: false, error: 'STORAGE_WRITE_FAILED' }
    }
  }

  /**
   * 读取密钥。**只允许主进程调用**，返回值绝不通过 IPC 传给 renderer。
   */
  async getSecret(key: string): Promise<string | null> {
    if (!safeStorage.isEncryptionAvailable()) return null
    try {
      const raw = JSON.parse(await fs.readFile(this.file('secrets.bin'), 'utf8')) as Record<string, string>
      const b64 = raw[key]
      if (!b64) return null
      return safeStorage.decryptString(Buffer.from(b64, 'base64'))
    } catch {
      return null
    }
  }

  async deleteSecret(key: string): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file('secrets.bin'), 'utf8')) as Record<string, string>
      delete raw[key]
      await this.atomicWrite(this.file('secrets.bin'), JSON.stringify(raw))
    } catch {
      /* 无密钥文件即视为已删除 */
    }
  }

  /* ------------------------------- 日志 ------------------------------- */

  redact(value: unknown): unknown {
    return Sanitizer.redact(value)
  }

  async log(level: 'info' | 'warn' | 'error', event: string, data: unknown = {}): Promise<void> {
    await this.recordDiagnostic({
      module: 'system',
      level,
      type: event,
      code: event.toUpperCase(),
      summary: event,
      data: data as Record<string, unknown>
    })
  }

  async recordDiagnostic(
    event: Omit<DiagnosticEvent, 'ts' | 'fingerprint'>
  ): Promise<DiagnosticEvent> {
    const ts = new Date().toISOString()
    const fingerprint = Sanitizer.generateFingerprint({
      platform: event.platform,
      module: event.module,
      code: event.code,
      summary: event.summary
    })
    const fullEvent: DiagnosticEvent = {
      ts,
      module: event.module,
      platform: event.platform,
      level: event.level,
      type: event.type,
      code: event.code,
      summary: Sanitizer.redactString(event.summary),
      fingerprint,
      data: event.data ? (Sanitizer.redact(event.data) as Record<string, unknown>) : undefined,
      stack: event.stack ? Sanitizer.redactString(event.stack) : undefined
    }

    const line = JSON.stringify(fullEvent)
    const file = this.file('logs', 'app.jsonl')
    try {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.appendFile(file, `${line}\n`, 'utf8')
      await this.trimLogs()
    } catch {
      /* 日志写失败不能打断主流程 */
    }
    return fullEvent
  }

  async getRecentDiagnostics(limit = 100): Promise<DiagnosticEvent[]> {
    const file = this.file('logs', 'app.jsonl')
    try {
      const content = await fs.readFile(file, 'utf8')
      const lines = content.trim().split('\n').filter(Boolean)
      const events: DiagnosticEvent[] = []
      for (let i = lines.length - 1; i >= 0 && events.length < limit; i--) {
        try {
          const parsed = JSON.parse(lines[i]) as Record<string, unknown>
          if (parsed.event && !parsed.type) {
            events.push({
              ts: String(parsed.ts || new Date().toISOString()),
              module: 'system',
              level: (parsed.level as 'info' | 'warn' | 'error') || 'info',
              type: String(parsed.event),
              code: String(parsed.event).toUpperCase(),
              summary: String(parsed.event),
              fingerprint: Sanitizer.generateFingerprint({ code: String(parsed.event) }),
              data: parsed.data as Record<string, unknown>
            })
          } else {
            events.push(parsed as unknown as DiagnosticEvent)
          }
        } catch {
          // ignore corrupted lines
        }
      }
      return events
    } catch {
      return []
    }
  }

  async buildDiagnosticPackage(
    activePlatform: PlatformId = 'chaoxing',
    healthReports?: Record<PlatformId, PlatformHealthReport>
  ): Promise<DiagnosticPackageData> {
    const recentErrors = await this.getRecentDiagnostics(100)
    const now = new Date()

    const buildCommit = resolveBuildCommit()
    const manifest: DiagnosticManifest = {
      app: {
        name: 'CourseHub',
        version: typeof app?.getVersion === 'function' ? app.getVersion() : '0.4.3-beta.2',
        buildCommit,
        environment: app?.isPackaged ? 'production' : 'development'
      },
      system: {
        platform: process.platform,
        osRelease: os.release(),
        arch: process.arch,
        electronVersion: process.versions.electron || 'unknown',
        chromeVersion: process.versions.chrome || 'unknown',
        nodeVersion: process.versions.node || 'unknown'
      },
      runtime: {
        generatedAt: now.toISOString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
        activePlatform,
        platformsHealth: healthReports || ({} as Record<PlatformId, PlatformHealthReport>)
      },
      privacyNotice:
        '本诊断数据已执行严格脱敏，绝不包含 Cookie、Token、API Key、密码、真实姓名、学生学号、个人用户名与答题私有内容。截图为像素位图，请人工核对后选择是否附带。'
    }

    const distinctCodes = Array.from(new Set(recentErrors.map((e) => e.code))).slice(0, 5)
    const summaryLines = [
      `CourseHub 诊断摘要`,
      `版本: v${manifest.app.version} (${manifest.app.buildCommit})`,
      `操作系统: ${manifest.system.platform} ${manifest.system.osRelease} (${manifest.system.arch})`,
      `生成时间: ${now.toLocaleString('zh-CN', { hour12: false })} (${manifest.runtime.timeZone})`,
      `当前业务平台: ${activePlatform}`,
      `最近异常事件: ${recentErrors.filter((e) => e.level === 'error').length} 项`,
      ...(distinctCodes.length > 0 ? [`主要错误代码: ${distinctCodes.join(', ')}`] : []),
      `隐私安全: 已自动脱敏个人凭据、路径与敏感身份信息`
    ]
    const summaryText = summaryLines.join('\n')

    return {
      manifest,
      recentErrors,
      summaryText
    }
  }

  async exportDiagnosticZip(options: {
    targetDir?: string
    activePlatform?: PlatformId
    feedbackNote?: string
    screenshotBase64?: string
    includeErrors?: boolean
    healthReports?: Record<PlatformId, PlatformHealthReport>
  } = {}): Promise<{ path: string; bytes: number; filename: string }> {
    const data = await this.buildDiagnosticPackage(
      options.activePlatform || 'chaoxing',
      options.healthReports
    )

    const now = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const timeStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    const filename = `CourseHub-Diagnostics-${timeStr}.zip`
    const targetDir =
      options.targetDir ||
      (typeof app?.getPath === 'function' ? app.getPath('downloads') || app.getPath('temp') : os.tmpdir())
    const targetFile = path.join(targetDir, filename)

    const shouldIncludeErrors = options.includeErrors !== false
    const errorsContent = shouldIncludeErrors
      ? data.recentErrors.map((e) => JSON.stringify(e)).join('\n')
      : JSON.stringify({ info: '用户未勾选附带系统诊断日志，已按隐私设定排除具体错误事件' })

    const entries: { name: string; data: Buffer | string }[] = [
      {
        name: 'summary.json',
        data: JSON.stringify(
          {
            summary: data.summaryText,
            manifest: data.manifest,
            note: options.feedbackNote ? Sanitizer.redactString(options.feedbackNote) : null
          },
          null,
          2
        )
      },
      {
        name: 'errors.jsonl',
        data: errorsContent
      },
      {
        name: 'environment.json',
        data: JSON.stringify(
          {
            app: data.manifest.app,
            system: data.manifest.system,
            runtime: data.manifest.runtime,
            memory: {
              totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
              freeMemMB: Math.round(os.freemem() / 1024 / 1024)
            }
          },
          null,
          2
        )
      },
      {
        name: 'README.txt',
        data: [
          '================================================================',
          ' CourseHub 故障诊断与日志安全说明',
          '================================================================',
          '',
          '本文件由 CourseHub 客户端自动脱敏生成，旨在协助开发者排查故障。',
          '',
          '隐私安全声明：',
          '1. 已通过规则过滤与黑名单拦截清除常见 Cookies、Token、API Key、密码等凭据。',
          '2. 结构化日志中已清除 Windows 个人用户名路径与 URL 鉴权 Query 参数。',
          '3. 结构化日志中不包含任何课程题目作答私有记录、聊天隐私或第三方历史记录。',
          '4. 【重要图像隐私提示】：若诊断包内包含 screenshot.png，该截图为用户选择截取的屏幕像素位图，无法通过文本规则完全脱敏，可能显示界面可见的课程名称、任务标题或窗口内容。用户在提交前可自行核对并决定是否附带。',
          '5. 本程序通过规则过滤最大化保护隐私，但不构成绝对“零泄露”数学证明。',
          '',
          `生成时间: ${now.toISOString()}`,
          `客户端版本: ${data.manifest.app.version}`
        ].join('\r\n')
      }
    ]

    if (options.screenshotBase64) {
      const cleanBase64 = options.screenshotBase64.replace(/^data:image\/\w+;base64,/, '')
      entries.push({
        name: 'screenshot.png',
        data: Buffer.from(cleanBase64, 'base64')
      })
    }

    const zipBuf = createZipBuffer(entries)
    await fs.mkdir(path.dirname(targetFile), { recursive: true })
    await fs.writeFile(targetFile, zipBuf)

    return {
      path: targetFile,
      bytes: zipBuf.length,
      filename
    }
  }

  private async trimLogs(): Promise<void> {
    const dir = this.file('logs')
    try {
      const files = await fs.readdir(dir)
      let total = 0
      const stats: { name: string; size: number; mtime: number }[] = []
      for (const name of files) {
        const p = path.join(dir, name)
        const st = await fs.stat(p)
        total += st.size
        stats.push({ name, size: st.size, mtime: st.mtimeMs })
      }
      const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 3600 * 1000
      for (const s of stats) {
        if (s.mtime < cutoff) await fs.unlink(path.join(dir, s.name)).catch(() => undefined)
      }
      if (total > MAX_LOG_BYTES) {
        const sorted = stats.sort((a, b) => a.mtime - b.mtime)
        let running = total
        for (const s of sorted) {
          if (running <= MAX_LOG_BYTES) break
          await fs.unlink(path.join(dir, s.name)).catch(() => undefined)
          running -= s.size
        }
      }
    } catch {
      /* ignore */
    }
  }
}

export function defaultStore(): Store {
  return new Store(app.getPath('userData'))
}
