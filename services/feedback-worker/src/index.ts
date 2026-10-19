/**
 * CourseHub Feedback & Diagnostic Collector Cloudflare Worker
 *
 * 安全强化规范（v0.4.3 RC 审计）：
 * 1. 严格限制请求体大小（总包 <= 5MB，ZIP <= 3MB，截图 <= 2MB）。
 * 2. 真实文件 Magic Bytes 校验（ZIP 必须为 PK\x03\x04，图片必须为 PNG/JPEG/WebP）。
 * 3. IP 速率限制（10 分钟最多 5 次）与 60s 相同内容防重放。
 * 4. 诊断包与截图仅存入私有 R2（禁止公开 Read 权限）。
 * 5. GitHub Token 仅存储在 Worker 环境变量中，GitHub API 异常降级防雪崩。
 * 6. 错误指纹跨分类防碰撞校验（分类 + 指纹双重锁定）。
 */

export interface R2BucketLike {
  put(key: string, value: unknown, options?: Record<string, unknown>): Promise<unknown>
  get(key: string): Promise<{ json(): Promise<unknown>; text(): Promise<string> } | null>
}

export interface Env {
  ENVIRONMENT: string
  GITHUB_REPO_OWNER: string
  GITHUB_REPO_NAME: string
  GITHUB_TOKEN?: string
  FEEDBACK_STORAGE?: R2BucketLike
  STAGING_ACCESS_KEY?: string
}

interface FeedbackPayload {
  category: string
  description: string
  reproductionSteps?: string
  contact?: string
  systemInfo: {
    appVersion: string
    os: string
    arch?: string
    timestamp: number
  }
  diagnosticsSummary?: {
    totalErrors: number
    recentCodes: string[]
    activePlatform?: string
    errorFingerprint?: string
  }
  diagnosticPackageBase64?: string
  screenshotBase64?: string
}

// 内存 IP 频控与防重放
const ipRateMap = new Map<string, { count: number; resetAt: number }>()
const recentSubmissionMap = new Map<string, number>()

function isRateLimited(ip: string, limit = 5, windowMs = 10 * 60 * 1000): boolean {
  const now = Date.now()
  const entry = ipRateMap.get(ip)
  if (!entry || now > entry.resetAt) {
    ipRateMap.set(ip, { count: 1, resetAt: now + windowMs })
    return false
  }
  if (entry.count >= limit) {
    return true
  }
  entry.count += 1
  return false
}

function isDuplicateSubmission(key: string, cooldownMs = 60 * 1000): boolean {
  const now = Date.now()
  const last = recentSubmissionMap.get(key)
  if (last && now - last < cooldownMs) {
    return true
  }
  recentSubmissionMap.set(key, now)
  // 定期淘汰过期 key
  if (recentSubmissionMap.size > 200) {
    for (const [k, t] of recentSubmissionMap.entries()) {
      if (now - t > cooldownMs) recentSubmissionMap.delete(k)
    }
  }
  return false
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  'Access-Control-Max-Age': '86400'
}

/** 校验 ZIP 首部 4 字节魔数: 0x50 0x4B 0x03 0x04 (PK\x03\x04) */
function isValidZip(bytes: Uint8Array): boolean {
  if (bytes.length < 22) return false
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
}

/** 校验图片魔数 (PNG, JPEG, WebP) */
function isValidImage(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true
  // WebP: RIFF....WEBP
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return true
  }
  return false
}

/**
 * 服务端轻量正则脱敏防御，避免客户端漏脱敏或恶意直接 curl 写入 Issue
 */
function sanitizeText(input: string): string {
  if (!input) return ''
  return input
    .replace(/Bearer\s+[a-zA-Z0-9\-._~+/]+=*/gi, 'Bearer [TOKEN_REDACTED]')
    .replace(/sk-[a-zA-Z0-9]{20,}/g, 'sk-[REDACTED_KEY]')
    .replace(/eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, '[JWT_REDACTED]')
    .replace(/(?<!\d)(1[3-9]\d{9})(?!\d)/g, '[PHONE_REDACTED]')
    .replace(/(?<!\d)([1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx])(?!\d)/g, '[IDCARD_REDACTED]')
    .replace(/[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g, '[EMAIL_REDACTED]')
    .replace(/([a-zA-Z]:\\Users\\)[^\\]+(\\.*)/gi, '$1[USER_HOME]$2')
    .replace(/(?<=[?&\s,;:]|^)(cpi|enc|token|ticket|password|passwd|pwd|sessionid|jsessionid|phpsessid|uid|studentno|studentid|clazzid|courseid|access_token|refresh_token|auth|secret|apikey|api_key)\s*=\s*[^&#\s,;]+/gi, '$1=[REDACTED_PARAM]')
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    const url = new URL(request.url)

    // 健康检查
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(
        JSON.stringify({
          status: 'ok',
          service: 'coursehub-feedback-worker',
          version: '0.4.3-rc',
          time: new Date().toISOString()
        }),
        {
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        }
      )
    }

    // 反馈提交接口
    if (url.pathname === '/api/feedback' && request.method === 'POST') {
      // 0. Staging 独立访问控制校验（若环境变量配置了 STAGING_ACCESS_KEY）
      if (env.STAGING_ACCESS_KEY) {
        const clientKey = request.headers.get('x-coursehub-staging-key')
        if (clientKey !== env.STAGING_ACCESS_KEY) {
          return new Response(
            JSON.stringify({ success: false, message: '未授权的 Staging 测试请求 (Invalid Staging Key)' }),
            { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          )
        }
      }

      const clientIp = request.headers.get('cf-connecting-ip') || 'unknown'
      if (isRateLimited(clientIp)) {
        return new Response(
          JSON.stringify({
            success: false,
            message: '提交太频繁，请稍候再试（10 分钟内最多提交 5 次）'
          }),
          { status: 429, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        )
      }

      // 请求大小防御 (最大 5MB) - 先核验 Content-Length 头部快速拦截
      const contentLengthHeader = request.headers.get('content-length')
      if (contentLengthHeader) {
        const cl = Number(contentLengthHeader)
        if (Number.isFinite(cl) && cl > 5 * 1024 * 1024) {
          return new Response(
            JSON.stringify({ success: false, message: '请求体超出限制（最大 5MB）' }),
            { status: 413, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          )
        }
      }

      // 读取原始请求体，拦截隐蔽的 Chunked 大载荷传输
      let rawText: string
      try {
        rawText = await request.text()
        if (rawText.length > 5 * 1024 * 1024) {
          return new Response(
            JSON.stringify({ success: false, message: '请求体超出限制（最大 5MB）' }),
            { status: 413, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          )
        }
      } catch {
        return new Response(
          JSON.stringify({ success: false, message: '读取请求体失败' }),
          { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        )
      }

      let payload: FeedbackPayload
      try {
        payload = JSON.parse(rawText)
      } catch {
        return new Response(
          JSON.stringify({ success: false, message: '无效的 JSON 请求体' }),
          { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        )
      }

      // 验证必要字段
      if (!payload.category || !payload.description || payload.description.trim().length < 5) {
        return new Response(
          JSON.stringify({ success: false, message: '请填写有效的问题类型和描述（不少于 5 字）' }),
          { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        )
      }

      // 60秒重复提交防御
      const dupKey = `${clientIp}:${payload.category}:${payload.description.trim()}`
      if (isDuplicateSubmission(dupKey)) {
        return new Response(
          JSON.stringify({ success: false, message: '请勿在 1 分钟内重复提交相同的反馈内容' }),
          { status: 429, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        )
      }

      // 检查存储绑定：当附带诊断包或截图时，若未绑定 R2 存储桶，严谨报错拒绝而非假装成功
      if ((payload.diagnosticPackageBase64 || payload.screenshotBase64) && !env.FEEDBACK_STORAGE) {
        return new Response(
          JSON.stringify({
            success: false,
            message: '服务器存储服务未就绪 (R2 Bucket 未绑定)，无法安全保存诊断附件'
          }),
          { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        )
      }

      // 生成唯一反馈流水号：FB-YYYYMMDD-XXXXXX
      const now = new Date()
      const yyyy = now.getUTCFullYear()
      const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
      const dd = String(now.getUTCDate()).padStart(2, '0')
      const rand = Math.random().toString(36).substring(2, 8).toUpperCase()
      const feedbackId = `FB-${yyyy}${mm}${dd}-${rand}`

      let storedZip = false
      let storedScreenshot = false

      // 1. 若配置了 R2 存储桶，严格校验文件类型与体积后安全存入私有空间
      if (env.FEEDBACK_STORAGE) {
        if (payload.diagnosticPackageBase64) {
          // 体积限制：3MB
          if (payload.diagnosticPackageBase64.length * 0.75 > 3 * 1024 * 1024) {
            return new Response(
              JSON.stringify({ success: false, message: '诊断压缩包超出 3MB 限制' }),
              { status: 413, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
            )
          }

          let binary: Uint8Array
          try {
            binary = Uint8Array.from(atob(payload.diagnosticPackageBase64), (c) => c.charCodeAt(0))
          } catch {
            return new Response(
              JSON.stringify({ success: false, message: '诊断附件 Base64 编码损坏' }),
              { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
            )
          }

          if (!isValidZip(binary)) {
            return new Response(
              JSON.stringify({ success: false, message: '诊断附件格式非法（必须为标准 ZIP 文件）' }),
              { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
            )
          }

          try {
            await env.FEEDBACK_STORAGE.put(`diagnostics/${feedbackId}.zip`, binary, {
              customMetadata: {
                feedbackId,
                category: payload.category,
                appVersion: payload.systemInfo?.appVersion || 'unknown',
                submittedAt: now.toISOString()
              },
              httpMetadata: { contentType: 'application/zip' }
            })
            storedZip = true
          } catch (e) {
            console.error('Failed to store diagnostic zip in R2:', e)
          }
        }

        if (payload.screenshotBase64) {
          // 体积限制：2MB
          if (payload.screenshotBase64.length * 0.75 > 2 * 1024 * 1024) {
            return new Response(
              JSON.stringify({ success: false, message: '截图超出 2MB 限制' }),
              { status: 413, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
            )
          }

          const cleanBase64 = payload.screenshotBase64.replace(/^data:image\/\w+;base64,/, '')
          let binary: Uint8Array
          try {
            binary = Uint8Array.from(atob(cleanBase64), (c) => c.charCodeAt(0))
          } catch {
            return new Response(
              JSON.stringify({ success: false, message: '截图 Base64 编码损坏' }),
              { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
            )
          }

          if (!isValidImage(binary)) {
            return new Response(
              JSON.stringify({ success: false, message: '截图文件格式非法（仅支持 PNG/JPEG/WebP）' }),
              { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
            )
          }

          try {
            await env.FEEDBACK_STORAGE.put(`screenshots/${feedbackId}.png`, binary, {
              customMetadata: { feedbackId },
              httpMetadata: { contentType: 'image/png' }
            })
            storedScreenshot = true
          } catch (e) {
            console.error('Failed to store screenshot in R2:', e)
          }
        }
      }

      // 2. 若配置了 GITHUB_TOKEN，向 GitHub Issues 同步脱敏摘要并聚合去重
      let issueUrl: string | undefined
      if (env.GITHUB_TOKEN) {
        try {
          const owner = env.GITHUB_REPO_OWNER || 'Qiuizi'
          const repo = env.GITHUB_REPO_NAME || 'CourseHub'
          const fingerprint = payload.diagnosticsSummary?.errorFingerprint

          let existingIssueNumber: number | null = null

          // 第一道防线：优先从 R2 缓存读取指纹对应 Issue（强一致性，解决 GitHub Search 索引延迟引发的重复创建）
          if (fingerprint && fingerprint.startsWith('FP-') && env.FEEDBACK_STORAGE) {
            try {
              const fpCacheObj = await env.FEEDBACK_STORAGE.get(`fingerprints/${fingerprint}.json`)
              if (fpCacheObj) {
                const fpData = (await fpCacheObj.json()) as { issueNumber: number; htmlUrl: string; category?: string }
                if (fpData.category === payload.category) {
                  existingIssueNumber = fpData.issueNumber
                  issueUrl = fpData.htmlUrl
                }
              }
            } catch (err) {
              console.warn('Failed to read fingerprint cache from R2:', err)
            }
          }

          // 第二道防线：若 R2 无缓存，再走 GitHub Search API
          if (!existingIssueNumber && fingerprint && fingerprint.startsWith('FP-')) {
            const query = `repo:${owner}/${repo} is:issue is:open label:user-feedback label:feedback:${payload.category} "${fingerprint}"`
            const searchRes = await fetch(
              `https://api.github.com/search/issues?q=${encodeURIComponent(query)}`,
              {
                headers: {
                  Authorization: `Bearer ${env.GITHUB_TOKEN}`,
                  'User-Agent': 'CourseHub-Feedback-Worker',
                  Accept: 'application/vnd.github.v3+json'
                }
              }
            )
            if (searchRes.ok) {
              const searchData = (await searchRes.json()) as { items?: { number: number; html_url: string; comments?: number }[] }
              if (searchData.items && searchData.items.length > 0) {
                const target = searchData.items[0]
                existingIssueNumber = target.number
                issueUrl = target.html_url

                // 立即同步到 R2 缓存加速后续聚合
                if (env.FEEDBACK_STORAGE) {
                  try {
                    await env.FEEDBACK_STORAGE.put(
                      `fingerprints/${fingerprint}.json`,
                      JSON.stringify({
                        issueNumber: target.number,
                        htmlUrl: target.html_url,
                        category: payload.category,
                        updatedAt: now.toISOString()
                      }),
                      { httpMetadata: { contentType: 'application/json' } }
                    )
                  } catch (e) {
                    console.warn('Failed to cache fingerprint in R2:', e)
                  }
                }
              }
            }
          }

          // 服务端二次安全脱敏，确保 Issue 内容绝不含凭证
          const safeDescription = sanitizeText(payload.description)
          const safeReproSteps = payload.reproductionSteps ? sanitizeText(payload.reproductionSteps) : ''

          if (existingIssueNumber) {
            // 已有相同指纹的 Issue：追加评论并聚合计数，不刷屏建新 Issue
            const commentBody = [
              `### 📥 用户反馈补充 (+1)`,
              `- **反馈编号**: \`${feedbackId}\``,
              `- **软件版本**: \`${payload.systemInfo.appVersion}\``,
              `- **操作系统**: \`${payload.systemInfo.os}\``,
              `- **问题描述**: ${safeDescription}`,
              safeReproSteps ? `- **复现步骤**: ${safeReproSteps}` : null,
              `- **私有诊断包**: ${storedZip ? `\`diagnostics/${feedbackId}.zip\`` : '未附带'}`,
              `- **私有截图**: ${storedScreenshot ? `\`screenshots/${feedbackId}.png\`` : '未附带'}`,
              `*提交时间: ${now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}*`
            ]
              .filter(Boolean)
              .join('\n')

            await fetch(
              `https://api.github.com/repos/${owner}/${repo}/issues/${existingIssueNumber}/comments`,
              {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${env.GITHUB_TOKEN}`,
                  'User-Agent': 'CourseHub-Feedback-Worker',
                  'Content-Type': 'application/json',
                  Accept: 'application/vnd.github.v3+json'
                },
                body: JSON.stringify({ body: commentBody })
              }
            )
          } else {
            // 新问题：创建新 Issue
            const shortDesc = safeDescription.slice(0, 40).replace(/[\r\n]+/g, ' ')
            const title = `[用户反馈] [${payload.category}] ${shortDesc}${safeDescription.length > 40 ? '...' : ''}`
            const labels = ['user-feedback', `feedback:${payload.category}`]
            if (fingerprint) labels.push(`fingerprint:${fingerprint}`)

            const issueBody = [
              `## 📋 用户反馈 (${feedbackId})`,
              ``,
              `| 项目 | 内容 |`,
              `| :--- | :--- |`,
              `| **反馈编号** | \`${feedbackId}\` |`,
              `| **问题分类** | \`${payload.category}\` |`,
              `| **关联平台** | \`${payload.diagnosticsSummary?.activePlatform || '通用/未指定'}\` |`,
              `| **软件版本** | \`${payload.systemInfo.appVersion}\` |`,
              `| **系统架构** | \`${payload.systemInfo.os} (${payload.systemInfo.arch || 'unknown'})\` |`,
              `| **错误指纹** | \`${fingerprint || 'N/A'}\` |`,
              `| **关联诊断包** | ${storedZip ? `已存入私有 R2 (\`diagnostics/${feedbackId}.zip\`)` : '未附带'} |`,
              `| **关联截图** | ${storedScreenshot ? `已存入私有 R2 (\`screenshots/${feedbackId}.png\`)` : '未附带'} |`,
              ``,
              `### 📝 问题描述`,
              safeDescription,
              ``,
              safeReproSteps ? `### 🔁 复现步骤\n${safeReproSteps}\n` : '',
              payload.diagnosticsSummary?.recentCodes?.length
                ? `### ⚠️ 最近错误代码\n\`${payload.diagnosticsSummary.recentCodes.join(', ')}\`\n`
                : '',
              `---`,
              `*本反馈由 CourseHub 客户端脱敏后提交。原始 Cookies、Authorization、API Key、截图及个人数据均存放在私有受限空间，绝不向公开 Issue 发布。*`
            ].join('\n')

            const createRes = await fetch(
              `https://api.github.com/repos/${owner}/${repo}/issues`,
              {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${env.GITHUB_TOKEN}`,
                  'User-Agent': 'CourseHub-Feedback-Worker',
                  'Content-Type': 'application/json',
                  Accept: 'application/vnd.github.v3+json'
                },
                body: JSON.stringify({
                  title,
                  body: issueBody,
                  labels
                })
              }
            )

            if (createRes.ok) {
              const created = (await createRes.json()) as { number: number; html_url: string }
              issueUrl = created.html_url

              // 立即缓存新建的 Issue 到 R2，使后续同指纹请求立刻命中，绝不重复创建
              if (fingerprint && env.FEEDBACK_STORAGE) {
                try {
                  await env.FEEDBACK_STORAGE.put(
                    `fingerprints/${fingerprint}.json`,
                    JSON.stringify({
                      issueNumber: created.number,
                      htmlUrl: created.html_url,
                      category: payload.category,
                      createdAt: now.toISOString()
                    }),
                    { httpMetadata: { contentType: 'application/json' } }
                  )
                } catch (e) {
                  console.warn('Failed to cache new fingerprint in R2:', e)
                }
              }
            }
          }
        } catch (ghErr) {
          console.error('Failed to create/update GitHub Issue:', ghErr)
        }
      }

      return new Response(
        JSON.stringify({
          success: true,
          feedbackId,
          message: '反馈已成功提交！感谢您的宝贵建议与支持。',
          issueUrl,
          storedDiagnostics: storedZip
        }),
        {
          status: 200,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        }
      )
    }

    return new Response(JSON.stringify({ error: 'Not Found' }), {
      status: 404,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    })
  }
}
