/**
 * CourseHub Feedback & Diagnostic Collector Cloudflare Worker (Zero-Cost Free Tier)
 *
 * 架构规范（完全免费无卡方案）：
 * 1. 采用 Cloudflare Workers Free + Cloudflare D1 Free + GitHub Issues。
 * 2. 彻底移除 R2 依赖，严禁存储大型二进制文件至云端。
 * 3. 在线反馈仅接收脱敏文本、环境元数据、错误码与错误指纹。
 * 4. 基于 D1 实现持久化全局 IP 频控与 30 天数据自动淘汰。
 * 5. 基于 D1 强一致错误指纹表实现 GitHub Issue 聚合去重与幂等建单。
 * 6. 若 GitHub API 暂不可用，记录 D1 同步任务队列，绝不假装 Issue 已创建。
 */

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike
  first<T = unknown>(colName?: string): Promise<T | null>
  run<T = unknown>(): Promise<{ success: boolean; error?: string; results?: T[] }>
  all<T = unknown>(): Promise<{ success: boolean; error?: string; results: T[] }>
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike
  batch(statements: D1PreparedStatementLike[]): Promise<unknown[]>
  exec(query: string): Promise<unknown>
}

export interface Env {
  ENVIRONMENT: string
  GITHUB_REPO_OWNER: string
  GITHUB_REPO_NAME: string
  GITHUB_TOKEN?: string
  DB?: D1DatabaseLike
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
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, X-CourseHub-Staging-Key',
  'Access-Control-Max-Age': '86400'
}

/**
 * 服务端轻量正则脱敏防御，避免客户端漏脱敏或恶意直接 curl 写入 Issue
 */
export function sanitizeText(input: string): string {
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

/**
 * D1 持久化全局 IP 限流 (替代单节点易失内存 Map)
 */
async function checkD1RateLimit(
  db: D1DatabaseLike | undefined,
  ip: string,
  limit = 5,
  windowMs = 10 * 60 * 1000
): Promise<boolean> {
  if (!db) return false
  const now = Date.now()
  try {
    const row = await db
      .prepare('SELECT count, reset_at FROM rate_limits WHERE key = ?')
      .bind(ip)
      .first<{ count: number; reset_at: number }>()

    if (!row || now > row.reset_at) {
      await db
        .prepare('INSERT OR REPLACE INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)')
        .bind(ip, now + windowMs)
        .run()
      return false
    }

    if (row.count >= limit) {
      return true
    }

    await db
      .prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?')
      .bind(ip)
      .run()
    return false
  } catch (err) {
    console.warn('D1 rate limit query failed:', err)
    return false
  }
}

/**
 * 自动清理 30 天以前的过期反馈和历史限流记录
 */
async function autoCleanup30Days(db: D1DatabaseLike): Promise<void> {
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000
  try {
    await db.prepare('DELETE FROM feedback WHERE created_timestamp < ?').bind(thirtyDaysAgo).run()
    await db.prepare('DELETE FROM rate_limits WHERE reset_at < ?').bind(Date.now()).run()
  } catch (e) {
    console.warn('D1 auto-cleanup warning:', e)
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    const url = new URL(request.url)

    // 健康检查与状态端点
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(
        JSON.stringify({
          status: 'ok',
          service: 'coursehub-feedback-worker',
          storage: 'cloudflare-d1-free',
          version: '0.4.3-d1-free',
          time: new Date().toISOString()
        }),
        {
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        }
      )
    }

    // 反馈提交接口
    if (url.pathname === '/api/feedback' && request.method === 'POST') {
      // 0. Staging 授权凭证校验 (若环境变量配置了 STAGING_ACCESS_KEY)
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

      // 1. D1 持久化 IP 频控防御 (10 分钟最多 5 次)
      if (await checkD1RateLimit(env.DB, clientIp, 5, 10 * 60 * 1000)) {
        return new Response(
          JSON.stringify({
            success: false,
            message: '提交太频繁，请稍候再试（10 分钟内最多提交 5 次）'
          }),
          { status: 429, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        )
      }

      // 2. 载荷大小限制 (纯文本 JSON 上限 256KB，杜绝二进制大附件直接传入 D1)
      const contentLengthHeader = request.headers.get('content-length')
      if (contentLengthHeader) {
        const cl = Number(contentLengthHeader)
        if (Number.isFinite(cl) && cl > 256 * 1024) {
          return new Response(
            JSON.stringify({ success: false, message: '请求体超出限制（最大 256KB，大诊断包请使用本地导出）' }),
            { status: 413, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          )
        }
      }

      let rawText: string
      try {
        rawText = await request.text()
        if (rawText.length > 256 * 1024) {
          return new Response(
            JSON.stringify({ success: false, message: '请求体超出限制（最大 256KB）' }),
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

      // 验证 D1 数据库可用性
      if (!env.DB) {
        return new Response(
          JSON.stringify({
            success: false,
            message: '服务器数据库未绑定 (D1 Database not configured)'
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

      // 服务端二次安全脱敏
      const safeDescription = sanitizeText(payload.description.trim())
      const safeReproSteps = payload.reproductionSteps ? sanitizeText(payload.reproductionSteps.trim()) : null
      const safeContact = payload.contact ? sanitizeText(payload.contact.trim()) : null
      const fingerprint = payload.diagnosticsSummary?.errorFingerprint

      // 3. 写入 D1 反馈记录表 (事务性保证)
      try {
        await env.DB.prepare(`
          INSERT INTO feedback (
            id, category, description, reproduction_steps, contact,
            app_version, os_info, error_fingerprint, diagnostics_summary,
            status, client_ip, created_at, created_timestamp
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
        `).bind(
          feedbackId,
          payload.category,
          safeDescription,
          safeReproSteps,
          safeContact,
          payload.systemInfo?.appVersion || 'unknown',
          `${payload.systemInfo?.os || 'unknown'} (${payload.systemInfo?.arch || 'unknown'})`,
          fingerprint || null,
          payload.diagnosticsSummary ? JSON.stringify(payload.diagnosticsSummary) : null,
          clientIp,
          now.toISOString(),
          now.getTime()
        ).run()
      } catch (dbErr) {
        console.error('Failed to insert feedback into D1:', dbErr)
        return new Response(
          JSON.stringify({ success: false, message: '写入数据库失败，请稍后重试' }),
          { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        )
      }

      // 4. 同步至 GitHub Issues (若配置了 GITHUB_TOKEN)
      let issueNumber: number | undefined
      let issueUrl: string | undefined
      let syncStatus: 'synced_gh' | 'gh_error' | 'pending' = 'pending'

      if (env.GITHUB_TOKEN) {
        const owner = env.GITHUB_REPO_OWNER || 'Qiuizi'
        const repo = env.GITHUB_REPO_NAME || 'CourseHub-feedback-staging'

        let existingIssue: { issue_number: number; issue_url: string; report_count: number } | null = null

        try {
          // 4.1 检查 D1 中的指纹表是否存在已有 Issue
          if (fingerprint && fingerprint.startsWith('FP-')) {
            existingIssue = await env.DB.prepare(
              'SELECT issue_number, issue_url, report_count FROM error_fingerprints WHERE fingerprint = ? AND category = ?'
            ).bind(fingerprint, payload.category).first<{ issue_number: number; issue_url: string; report_count: number }>()
          }

          if (existingIssue) {
            // 已有相同指纹 Issue：追加评论并增加计数 (+1 聚合)
            const commentBody = [
              `### 📥 用户反馈补充 (+1)`,
              `- **反馈编号**: \`${feedbackId}\``,
              `- **软件版本**: \`${payload.systemInfo?.appVersion || 'unknown'}\``,
              `- **操作系统**: \`${payload.systemInfo?.os || 'unknown'}\``,
              `- **问题描述**: ${safeDescription}`,
              safeReproSteps ? `- **复现步骤**: ${safeReproSteps}` : null,
              `- **累计上报次数**: \`${existingIssue.report_count + 1}\``,
              `*提交时间: ${now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}*`
            ].filter(Boolean).join('\n')

            const commentRes = await fetch(
              `https://api.github.com/repos/${owner}/${repo}/issues/${existingIssue.issue_number}/comments`,
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

            if (commentRes.ok) {
              issueNumber = existingIssue.issue_number
              issueUrl = existingIssue.issue_url
              syncStatus = 'synced_gh'

              // 更新 D1 指纹表计数
              await env.DB.prepare(
                'UPDATE error_fingerprints SET report_count = report_count + 1, last_seen_at = ? WHERE fingerprint = ? AND category = ?'
              ).bind(now.toISOString(), fingerprint, payload.category).run()
            } else {
              throw new Error(`GitHub comment returned ${commentRes.status}`)
            }
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
              `| **软件版本** | \`${payload.systemInfo?.appVersion || 'unknown'}\` |`,
              `| **系统架构** | \`${payload.systemInfo?.os || 'unknown'} (${payload.systemInfo?.arch || 'unknown'})\` |`,
              `| **错误指纹** | \`${fingerprint || 'N/A'}\` |`,
              `| **诊断事件** | ${payload.diagnosticsSummary?.totalErrors ? `已记录 ${payload.diagnosticsSummary.totalErrors} 项异常` : '未附带错误日志'} |`,
              ``,
              `### 📝 问题描述`,
              safeDescription,
              ``,
              safeReproSteps ? `### 🔁 复现步骤\n${safeReproSteps}\n` : '',
              payload.diagnosticsSummary?.recentCodes?.length
                ? `### ⚠️ 最近错误代码\n\`${payload.diagnosticsSummary.recentCodes.join(', ')}\`\n`
                : '',
              `---`,
              `*本反馈由 CourseHub 客户端脱敏后提交至 D1 数据库并同步至 GitHub。绝不包含 Cookies、Authorization 或 API Key。*`
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
                body: JSON.stringify({ title, body: issueBody, labels })
              }
            )

            if (createRes.ok) {
              const created = (await createRes.json()) as { number: number; html_url: string }
              issueNumber = created.number
              issueUrl = created.html_url
              syncStatus = 'synced_gh'

              // 若包含指纹，持久化至 D1 指纹表，保证后续请求直接命中
              if (fingerprint) {
                await env.DB.prepare(`
                  INSERT OR REPLACE INTO error_fingerprints (
                    fingerprint, category, issue_number, issue_url, report_count, first_seen_at, last_seen_at
                  ) VALUES (?, ?, ?, ?, 1, ?, ?)
                `).bind(fingerprint, payload.category, created.number, created.html_url, now.toISOString(), now.toISOString()).run()
              }
            } else {
              throw new Error(`GitHub create issue returned ${createRes.status}`)
            }
          }
        } catch (ghErr) {
          console.error('GitHub sync failed:', ghErr)
          syncStatus = 'gh_error'

          // 记录待重试任务至 D1 队列，绝不向客户端假装已同步
          try {
            await env.DB.prepare(`
              INSERT OR REPLACE INTO github_sync_jobs (
                feedback_id, action, fingerprint, status, last_error, created_at, updated_at
              ) VALUES (?, ?, ?, 'pending', ?, ?, ?)
            `).bind(
              feedbackId,
              existingIssue ? 'append_comment' : 'create_issue',
              fingerprint || null,
              String(ghErr),
              now.toISOString(),
              now.toISOString()
            ).run()
          } catch (jobErr) {
            console.error('Failed to log github_sync_jobs in D1:', jobErr)
          }
        }
      }

      // 更新 feedback 表中的 GitHub 同步状态与 Issue 链接
      try {
        await env.DB.prepare(`
          UPDATE feedback SET status = ?, github_issue_number = ?, github_issue_url = ? WHERE id = ?
        `).bind(syncStatus, issueNumber || null, issueUrl || null, feedbackId).run()
      } catch (updateErr) {
        console.warn('Failed to update feedback sync status in D1:', updateErr)
      }

      // 触发 30 天数据自动清理（不阻塞主请求返回）
      autoCleanup30Days(env.DB).catch(() => {})

      return new Response(
        JSON.stringify({
          success: true,
          feedbackId,
          message: issueUrl
            ? '反馈已成功提交并同步至问题跟踪系统！感谢您的支持。'
            : '反馈已成功记录至数据库！维护者将尽快排查处理。',
          issueNumber,
          issueUrl,
          syncedToGitHub: syncStatus === 'synced_gh'
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
