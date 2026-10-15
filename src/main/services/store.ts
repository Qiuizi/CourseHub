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

export type JsonObject = Record<string, unknown>

const MAX_LOG_BYTES = 20 * 1024 * 1024
const LOG_RETENTION_DAYS = 7

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

  private static readonly SENSITIVE_KEYS = [
    'apikey',
    'api_key',
    'authorization',
    'cookie',
    'token',
    'password',
    'secret'
  ]

  redact(value: unknown): unknown {
    if (value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map((v) => this.redact(v))
    const out: JsonObject = {}
    for (const [k, v] of Object.entries(value as JsonObject)) {
      const lower = k.toLowerCase()
      if (Store.SENSITIVE_KEYS.some((s) => lower.includes(s))) {
        out[k] = '[REDACTED]'
      } else if (typeof v === 'string' && v.length > 512) {
        out[k] = `${v.slice(0, 512)}...[TRUNCATED]`
      } else {
        out[k] = this.redact(v)
      }
    }
    return out
  }

  async log(level: 'info' | 'warn' | 'error', event: string, data: unknown = {}): Promise<void> {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      data: this.redact(data)
    })
    const file = this.file('logs', 'app.jsonl')
    try {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.appendFile(file, `${line}\n`, 'utf8')
      await this.trimLogs()
    } catch {
      /* 日志写失败不能打断主流程 */
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
