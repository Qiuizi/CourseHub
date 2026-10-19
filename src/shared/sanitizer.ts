/**
 * 诊断日志多层数据脱敏与白名单安全过滤引擎。
 *
 * 核心安全设计：
 * 1. 结构化数据采用白名单优先，阻断黑名单键名强制遮盖为 [REDACTED]。
 * 2. 对字符串内部特征进行正则扫描，消除 Windows 真实路径、URL Query 鉴权凭证、手机号、身份证、邮箱、JWT 与 API Key。
 * 3. 避免大体积内容（HTML / 巨型 JSON）进入诊断日志，统一截断为最长 512 字符。
 * 4. 纯函数设计，不依赖 Electron / Node 专有 API，可在 Main、Renderer 与 Worker 之间通用。
 * 5. 安全免责声明：本模块通过规则过滤最大程度降低敏感数据泄露风险，但不构成绝对“零泄露”数学证明，客户端在提交前应向用户提供脱敏预览。
 */

export class Sanitizer {
  /** 敏感键名黑名单（小写匹配） */
  private static readonly BLOCKED_KEYS: readonly string[] = [
    'apikey',
    'api_key',
    'authorization',
    'auth',
    'bearer',
    'cookie',
    'cookies',
    'token',
    'ticket',
    'accesstoken',
    'access_token',
    'refreshtoken',
    'refresh_token',
    'enc',
    'cpi',
    'secret',
    'secretkey',
    'secret_key',
    'privatekey',
    'private_key',
    'password',
    'passwd',
    'pwd',
    'sessionid',
    'jsessionid',
    'phpsessid',
    'studentname',
    'studentno',
    'studentid',
    'student_id',
    'realname',
    'phone',
    'mobile',
    'idcard',
    'id_card',
    'creditcard',
    'bankcard',
    'answers',
    'score',
    'grade',
    'exam',
    'set-cookie'
  ]

  /** 正则替换规则序列 */
  private static readonly STRING_RULES: readonly { reg: RegExp; rep: string }[] = [
    // 1. DeepSeek / OpenAI API Key (sk-...)
    { reg: /sk-[a-zA-Z0-9]{20,}/g, rep: 'sk-[REDACTED_KEY]' },
    // 2. HTTP Bearer Token
    { reg: /Bearer\s+[a-zA-Z0-9\-._~+/]+=*/gi, rep: 'Bearer [TOKEN_REDACTED]' },
    // 3. JWT 标准格式 (eyJ...)
    { reg: /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, rep: '[JWT_REDACTED]' },
    // 4. 常见中国大陆手机号码 (11位)
    { reg: /(?<!\d)(1[3-9]\d{9})(?!\d)/g, rep: '[PHONE_REDACTED]' },
    // 5. 常见中国大陆居民身份证号码 (18位)
    { reg: /(?<!\d)([1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx])(?!\d)/g, rep: '[IDCARD_REDACTED]' },
    // 6. 电子邮箱
    { reg: /[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g, rep: '[EMAIL_REDACTED]' },
    // 7. Windows 绝对路径中的个人用户名 (C:\Users\张三\... -> C:\Users\[USER_HOME]\...)
    { reg: /([a-zA-Z]:\\Users\\)[^\\]+(\\.*)/gi, rep: '$1[USER_HOME]$2' },
    // 8. 常见个人敏感、身份与凭据参数 (如 ?cpi=123, &token=abc, token=xyz, password=123)
    {
      reg: /(?<=[?&\s,;:]|^)(cpi|enc|token|ticket|password|passwd|pwd|sessionid|jsessionid|phpsessid|uid|studentno|studentid|clazzid|courseid|access_token|refresh_token|auth|secret|apikey|api_key)\s*=\s*[^&#\s,;]+/gi,
      rep: '$1=[REDACTED_PARAM]'
    }
  ]

  /**
   * 白名单过滤：仅保留显式允许的字段键名。
   */
  static filterByWhitelist<T extends Record<string, unknown>>(
    obj: T,
    allowedKeys: readonly string[]
  ): Record<string, unknown> {
    if (!obj || typeof obj !== 'object') return {}
    const result: Record<string, unknown> = {}
    for (const key of allowedKeys) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        result[key] = this.redact(obj[key])
      }
    }
    return result
  }

  /**
   * 递归脱敏任意对象、数组或基础类型。
   */
  static redact<T>(value: T, maxDepth = 6): T {
    if (value === null || value === undefined) return value
    if (typeof value === 'boolean' || typeof value === 'number') return value

    if (typeof value === 'string') {
      return this.redactString(value) as unknown as T
    }

    if (maxDepth <= 0) return '[MAX_DEPTH_REACHED]' as unknown as T

    if (Array.isArray(value)) {
      return value.map((item) => this.redact(item, maxDepth - 1)) as unknown as T
    }

    if (typeof value === 'object') {
      const result: Record<string, unknown> = {}
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        const lowerKey = key.toLowerCase()
        if (this.BLOCKED_KEYS.some((b) => lowerKey.includes(b))) {
          result[key] = '[REDACTED]'
        } else if (typeof val === 'string' && val.length > 512) {
          result[key] = `${this.redactString(val.slice(0, 512))}...[TRUNCATED]`
        } else {
          result[key] = this.redact(val, maxDepth - 1)
        }
      }
      return result as unknown as T
    }

    return String(value) as unknown as T
  }

  /**
   * 清理与脱敏单条字符串（堆栈、错误信息或 URL）。
   */
  static redactString(str: string, maxLength = 512): string {
    if (!str) return str
    let current = str
    if (maxLength > 0 && current.length > maxLength) {
      current = `${current.slice(0, maxLength)}...[TRUNCATED]`
    }
    for (const rule of this.STRING_RULES) {
      current = current.replace(rule.reg, rule.rep)
    }
    return current
  }

  /**
   * 生成稳定、确定性的错误指纹（12位 Hex 字符串）。
   * 格式: FP-[HASH8]
   */
  static generateFingerprint(input: {
    platform?: string
    module?: string
    code?: string
    summary?: string
  }): string {
    const raw = [
      input.platform || 'any',
      input.module || 'core',
      input.code || 'UNKNOWN',
      (input.summary || '').toLowerCase().replace(/[\d\s]/g, '').slice(0, 80)
    ].join(':')

    // FNV-1a 32-bit hash x 2 rounds
    let h1 = 0x811c9dc5
    let h2 = 0x9e3779b9
    for (let i = 0; i < raw.length; i++) {
      const c = raw.charCodeAt(i)
      h1 ^= c
      h1 = Math.imul(h1, 0x01000193)
      h2 ^= (c << 1)
      h2 = Math.imul(h2, 0x01000193)
    }
    const hex1 = (h1 >>> 0).toString(16).padStart(8, '0')
    const hex2 = (h2 >>> 0).toString(16).padStart(8, '0')
    return `FP-${hex1.slice(0, 4)}-${hex2.slice(0, 4)}`.toUpperCase()
  }

  /** 别名，保持与 redact 一致 */
  static sanitize<T>(value: T, maxDepth = 6): T {
    return this.redact(value, maxDepth)
  }
}

export function generateErrorFingerprint(
  platform?: string,
  code?: string,
  summary?: string,
  module?: string
): string {
  return Sanitizer.generateFingerprint({ platform, code, summary, module })
}
