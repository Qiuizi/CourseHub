/**
 * CourseHub Feedback & Diagnostic Collector Cloudflare Worker (Zero-Cost Free Tier)
 *
 * 架构规范（完全免费无卡方案）：
 * 1. 采用 Cloudflare Workers Free + Cloudflare D1 Free + GitHub Issues。
 * 2. 彻底移除 R2 依赖，严禁存储大型二进制文件至云端。
 * 3. 在线反馈仅接收脱敏文本、环境元数据、错误码与错误指纹。
 * 4. 基于 D1 实现持久化全局 IP 频控与 30 天数据自动淘汰。
 * 5. 基于 D1 强一致错误指纹表实现 GitHub Issue 聚合去重与幂等建单（原子占位防并发竞争）。
 * 6. 支持区分用户手动反馈（user_manual_feedback）与平台兼容性自动预警（automated_compatibility_alert）。
 * 7. 支持 Cron Trigger 定时清理过期记录并自动重试待同步的 GitHub Issue。
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

export interface FeedbackPayload {
  clientFeedbackId?: string
  category: string
  reportType?: 'user_manual_feedback' | 'automated_compatibility_alert'
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
    .replace(/(?<=[?&\s,;:]|^)(cpi|enc|token|ticket|password|passwd|pwd|sessionid|jsessionid|phpsessid|uid|studentno|studentid|clazzid|courseid|access_token|refresh_token|auth|secret|apikey|api_key|key)\s*=\s*[^&#\s,;]+/gi, '$1=[REDACTED_PARAM]')
}

/**
 * 构造统一且向后兼容的反馈响应，明确区分“D1 已落库排队同步”与“GitHub Issue 已完成创建”
 */
export function buildFeedbackResponse(
  fb: {
    id: string
    status: string
    github_issue_number?: number | null
    github_issue_url?: string | null
    created_at?: string
  },
  isIdempotent = false
): Response {
  const hasIssue = typeof fb.github_issue_number === 'number' && fb.github_issue_number > 0
  const isAutoAlert = fb.id.startsWith('ALERT-')

  let message: string
  if (isIdempotent) {
    if (hasIssue) {
      message = `${isAutoAlert ? '预警' : '反馈'}早前已成功接收并已关联 GitHub Issue #${fb.github_issue_number}（已幂等去重）`
    } else {
      message = `${isAutoAlert ? '预警' : '反馈'}早前已于云端数据库成功落库，后台正在排队同步至问题追踪库（已幂等去重）`
    }
  } else {
    if (hasIssue) {
      message = `${isAutoAlert ? '兼容性预警' : '反馈'}已成功提交并同步至 GitHub Issue #${fb.github_issue_number}！感谢支持。`
    } else {
      message = `${isAutoAlert ? '兼容性预警' : '反馈'}已成功记录至数据库，后台排队同步中！维护者将尽快排查处理。`
    }
  }

  return new Response(
    JSON.stringify({
      success: true,
      feedbackId: fb.id,
      reportType: isAutoAlert ? 'automated_compatibility_alert' : 'user_manual_feedback',
      message,
      issueNumber: hasIssue ? fb.github_issue_number : undefined,
      issueUrl: hasIssue ? fb.github_issue_url || undefined : undefined,
      syncedToGitHub: hasIssue,
      syncState: hasIssue ? 'completed' : 'pending',
      idempotent: isIdempotent
    }),
    {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    }
  )
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
export async function autoCleanup30Days(db: D1DatabaseLike | undefined): Promise<number> {
  if (!db) return 0
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000
  try {
    await db.prepare('DELETE FROM feedback WHERE created_timestamp < ?').bind(thirtyDaysAgo).run()
    await db.prepare('DELETE FROM rate_limits WHERE reset_at < ?').bind(Date.now()).run()
    return 1
  } catch (e) {
    console.warn('D1 auto-cleanup warning:', e)
    return 0
  }
}

/**
 * 失败同步任务异步重试队列 (由 Cron Trigger 或手动端点触发)
 */
export async function processPendingGitHubSyncJobs(env: Env): Promise<number> {
  if (!env.DB || !env.GITHUB_TOKEN) return 0
  const owner = env.GITHUB_REPO_OWNER || 'Qiuizi'
  const repo = env.GITHUB_REPO_NAME || 'CourseHub-feedback-staging'

  try {
    const jobs = await env.DB.prepare(`
      SELECT id, feedback_id, action, fingerprint, retry_count
      FROM github_sync_jobs
      WHERE status = 'pending' AND retry_count < 5
      ORDER BY id ASC LIMIT 10
    `).all<{ id: number; feedback_id: string; action: string; fingerprint: string | null; retry_count: number }>()

    if (!jobs.results || jobs.results.length === 0) return 0

    let processed = 0
    for (const job of jobs.results) {
      try {
        const fb = await env.DB.prepare(`
          SELECT id, category, description, reproduction_steps, app_version, os_info, error_fingerprint, diagnostics_summary
          FROM feedback WHERE id = ?
        `).bind(job.feedback_id).first<{
          id: string
          category: string
          description: string
          reproduction_steps: string | null
          app_version: string
          os_info: string
          error_fingerprint: string | null
          diagnostics_summary: string | null
        }>()

        if (!fb) {
          await env.DB.prepare('UPDATE github_sync_jobs SET status = "abandoned" WHERE id = ?').bind(job.id).run()
          continue
        }

        const now = new Date()
        let issueNumber: number | undefined
        let issueUrl: string | undefined

        const fp = fb.error_fingerprint
        let existingIssue: { issue_number: number; issue_url: string; report_count: number } | null = null
        if (fp) {
          existingIssue = await env.DB.prepare(
            'SELECT issue_number, issue_url, report_count FROM error_fingerprints WHERE fingerprint = ? AND category = ?'
          ).bind(fp, fb.category).first<{ issue_number: number; issue_url: string; report_count: number }>()
        }

        if (existingIssue && existingIssue.issue_number > 0) {
          // 追加评论
          const commentBody = [
            `### 📥 反馈同步补充 (+1) [定时队列补传]`,
            `- **反馈编号**: \`${fb.id}\``,
            `- **软件版本**: \`${fb.app_version}\``,
            `- **操作系统**: \`${fb.os_info}\``,
            `- **问题描述**: ${fb.description}`,
            fb.reproduction_steps ? `- **复现步骤**: ${fb.reproduction_steps}` : null,
            `- **累计上报次数**: \`${existingIssue.report_count + 1}\``,
            `*同步重试时间: ${now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}*`
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
            await env.DB.prepare(
              'UPDATE error_fingerprints SET report_count = report_count + 1, last_seen_at = ? WHERE fingerprint = ? AND category = ?'
            ).bind(now.toISOString(), fp, fb.category).run()
          } else {
            throw new Error(`Comment failed with status ${commentRes.status}`)
          }
        } else {
          // 创建新 Issue
          const shortDesc = fb.description.slice(0, 40).replace(/[\r\n]+/g, ' ')
          const title = `[用户反馈] [${fb.category}] ${shortDesc}${fb.description.length > 40 ? '...' : ''}`
          const labels = ['user-feedback', `feedback:${fb.category}`]
          if (fp) labels.push(`fingerprint:${fp}`)

          const issueBody = [
            `## 📋 用户反馈 (${fb.id}) [定时队列补传]`,
            ``,
            `| 项目 | 内容 |`,
            `| :--- | :--- |`,
            `| **反馈编号** | \`${fb.id}\` |`,
            `| **问题分类** | \`${fb.category}\` |`,
            `| **软件版本** | \`${fb.app_version}\` |`,
            `| **系统架构** | \`${fb.os_info}\` |`,
            `| **错误指纹** | \`${fp || 'N/A'}\` |`,
            ``,
            `### 📝 问题描述`,
            fb.description,
            ``,
            fb.reproduction_steps ? `### 🔁 复现步骤\n${fb.reproduction_steps}\n` : '',
            `---`,
            `*本反馈此前因网络抖动暂存于 D1 数据库，现已由 Worker 定时任务队列自动重试同步至 GitHub。*`
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
            if (fp) {
              await env.DB.prepare(`
                INSERT OR REPLACE INTO error_fingerprints (
                  fingerprint, category, issue_number, issue_url, report_count, first_seen_at, last_seen_at
                ) VALUES (?, ?, ?, ?, 1, ?, ?)
              `).bind(fp, fb.category, created.number, created.html_url, now.toISOString(), now.toISOString()).run()
            }
          } else {
            throw new Error(`Create issue failed with status ${createRes.status}`)
          }
        }

        await env.DB.prepare('UPDATE github_sync_jobs SET status = "completed", updated_at = ? WHERE id = ?')
          .bind(now.toISOString(), job.id).run()
        await env.DB.prepare('UPDATE feedback SET status = "synced_gh", github_issue_number = ?, github_issue_url = ? WHERE id = ?')
          .bind(issueNumber || null, issueUrl || null, fb.id).run()
        processed++
      } catch (jobErr) {
        console.error(`Retry job ${job.id} failed:`, jobErr)
        await env.DB.prepare('UPDATE github_sync_jobs SET retry_count = retry_count + 1, last_error = ?, updated_at = ? WHERE id = ?')
          .bind(String(jobErr), new Date().toISOString(), job.id).run()
      }
    }
    return processed
  } catch (err) {
    console.error('Failed to process pending sync jobs:', err)
    return 0
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

    // 反馈与自动预警提交接口
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

      // 1. 载荷大小限制 (纯文本 JSON 上限 256KB，杜绝二进制大附件直接灌入 D1)
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

      // 区分类型：自动预警 vs 用户手动反馈
      const isAutoAlert = payload.reportType === 'automated_compatibility_alert'

      // 提取客户端候选流水号并验证格式规范
      const clientCandidate = typeof payload.clientFeedbackId === 'string' ? payload.clientFeedbackId.trim() : ''
      const isWellFormedId = /^(FB|ALERT)-\d{8}-[A-Z0-9]{4,16}$/.test(clientCandidate)

      // 2. 幂等优先安全检查：对已经存在、合法且与原请求匹配的 clientFeedbackId，允许安全返回已有状态
      // 避免同一公网 IP 达到限额后，已落库的反馈重试被 429 误伤拦截
      if (isWellFormedId) {
        try {
          const existingFb = await env.DB.prepare(
            'SELECT id, category, client_ip, status, github_issue_number, github_issue_url, created_at FROM feedback WHERE id = ?'
          )
            .bind(clientCandidate)
            .first<{
              id: string
              category: string
              client_ip: string | null
              status: string
              github_issue_number: number | null
              github_issue_url: string | null
              created_at: string
            }>()

          if (existingFb) {
            // 反枚举与反滥用防护：必须与原记录分类一致，且来源 IP 匹配（或原记录为 unknown）
            const ipMatches = !existingFb.client_ip || existingFb.client_ip === 'unknown' || existingFb.client_ip === clientIp
            const categoryMatches = existingFb.category === payload.category

            if (ipMatches && categoryMatches) {
              return buildFeedbackResponse(existingFb, true)
            }
          }
        } catch (idempErr) {
          console.warn('Idempotency query warning:', idempErr)
        }
      }

      // 3. 新反馈提交或未匹配记录：严格执行 D1 持久化 IP 频控防御 (10 分钟最多 5 次)
      if (await checkD1RateLimit(env.DB, clientIp, 5, 10 * 60 * 1000)) {
        return new Response(
          JSON.stringify({
            success: false,
            message: '提交太频繁，请稍候再试（10 分钟内最多提交 5 次）'
          }),
          { status: 429, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        )
      }

      // 生成唯一反馈流水号：若客户端已提供合法流水号则采用，否则服务端兜底生成
      const now = new Date()
      const yyyy = now.getUTCFullYear()
      const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
      const dd = String(now.getUTCDate()).padStart(2, '0')
      const rand = Math.random().toString(36).substring(2, 8).toUpperCase()
      const defaultFeedbackId = `${isAutoAlert ? 'ALERT' : 'FB'}-${yyyy}${mm}${dd}-${rand}`
      const feedbackId = isWellFormedId ? clientCandidate : defaultFeedbackId

      // 服务端二次安全脱敏
      const safeDescription = sanitizeText(payload.description.trim())
      const safeReproSteps = payload.reproductionSteps ? sanitizeText(payload.reproductionSteps.trim()) : null
      const safeContact = payload.contact ? sanitizeText(payload.contact.trim()) : null
      const fingerprint = payload.diagnosticsSummary?.errorFingerprint

      // 4. 写入 D1 反馈记录表 (事务性保证，捕获并发唯一键冲突)
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
      } catch (dbErr: unknown) {
        const errStr = String((dbErr as { message?: string })?.message || dbErr)
        // 捕获并发冲突 (UNIQUE constraint failed: feedback.id)
        if (errStr.includes('UNIQUE constraint failed') || errStr.includes('constraint')) {
          console.warn(`Concurrent race detected for feedbackId ${feedbackId}, resolving existing record`)
          const concurrentFb = await env.DB.prepare(
            'SELECT id, status, github_issue_number, github_issue_url, created_at FROM feedback WHERE id = ?'
          ).bind(feedbackId).first<{
            id: string
            status: string
            github_issue_number: number | null
            github_issue_url: string | null
            created_at: string
          }>()
          if (concurrentFb) {
            return buildFeedbackResponse(concurrentFb, true)
          }
        }
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
        let isDesignatedCreator = false

        try {
          // 4.1 检查 D1 中的指纹表是否存在已有 Issue
          if (fingerprint && fingerprint.startsWith('FP-')) {
            existingIssue = await env.DB.prepare(
              'SELECT issue_number, issue_url, report_count FROM error_fingerprints WHERE fingerprint = ? AND category = ?'
            ).bind(fingerprint, payload.category).first<{ issue_number: number; issue_url: string; report_count: number }>()
          }

          // 4.2 并发安全：若无现有 Issue，尝试原子占位建单锁，防止高并发请求同时创建重复 Issue
          if (!existingIssue && fingerprint && fingerprint.startsWith('FP-')) {
            try {
              const claimRes = await env.DB.prepare(`
                INSERT INTO error_fingerprints (
                  fingerprint, category, issue_number, issue_url, report_count, first_seen_at, last_seen_at
                ) VALUES (?, ?, 0, 'pending', 1, ?, ?)
              `).bind(fingerprint, payload.category, now.toISOString(), now.toISOString()).run()
              if (claimRes.success) {
                isDesignatedCreator = true
              }
            } catch {
              // 捕获唯一约束冲突：说明另一并发请求正在抢先建单
              isDesignatedCreator = false
              // 重新查询获取最新状态
              existingIssue = await env.DB.prepare(
                'SELECT issue_number, issue_url, report_count FROM error_fingerprints WHERE fingerprint = ? AND category = ?'
              ).bind(fingerprint, payload.category).first<{ issue_number: number; issue_url: string; report_count: number }>()
            }
          }

          if (existingIssue && existingIssue.issue_number > 0) {
            // 已有相同指纹 Issue：追加评论并增加计数 (+1 聚合)
            const commentBody = [
              `### 📥 ${isAutoAlert ? '平台兼容性预警累积 (+1)' : '用户反馈补充 (+1)'}`,
              `- **${isAutoAlert ? '预警编号' : '反馈编号'}**: \`${feedbackId}\``,
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
          } else if (isDesignatedCreator || !fingerprint) {
            // 新问题：创建新 Issue
            const shortDesc = safeDescription.slice(0, 40).replace(/[\r\n]+/g, ' ')
            const title = isAutoAlert
              ? `[平台预警] [${payload.category}] 疑似接口改版: ${shortDesc}${safeDescription.length > 40 ? '...' : ''}`
              : `[用户反馈] [${payload.category}] ${shortDesc}${safeDescription.length > 40 ? '...' : ''}`

            const labels = isAutoAlert
              ? ['compatibility-alert', 'automated', `feedback:${payload.category}`]
              : ['user-feedback', `feedback:${payload.category}`]
            if (fingerprint) labels.push(`fingerprint:${fingerprint}`)

            const issueBody = [
              isAutoAlert
                ? `## 🚨 平台兼容性自动预警 (${feedbackId})\n> 本预警由用户授权的匿名诊断机制在检测到连续结构解析异常时自动触发。`
                : `## 📋 用户反馈 (${feedbackId})`,
              ``,
              `| 项目 | 内容 |`,
              `| :--- | :--- |`,
              `| **${isAutoAlert ? '预警编号' : '反馈编号'}** | \`${feedbackId}\` |`,
              `| **问题分类** | \`${payload.category}\` |`,
              `| **关联平台** | \`${payload.diagnosticsSummary?.activePlatform || '通用/未指定'}\` |`,
              `| **软件版本** | \`${payload.systemInfo?.appVersion || 'unknown'}\` |`,
              `| **系统架构** | \`${payload.systemInfo?.os || 'unknown'} (${payload.systemInfo?.arch || 'unknown'})\` |`,
              `| **错误指纹** | \`${fingerprint || 'N/A'}\` |`,
              `| **诊断事件** | ${payload.diagnosticsSummary?.totalErrors ? `已记录 ${payload.diagnosticsSummary.totalErrors} 项异常` : '未附带错误日志'} |`,
              ``,
              `### 📝 ${isAutoAlert ? '预警详情' : '问题描述'}`,
              safeDescription,
              ``,
              safeReproSteps ? `### 🔁 复现步骤\n${safeReproSteps}\n` : '',
              payload.diagnosticsSummary?.recentCodes?.length
                ? `### ⚠️ 最近错误代码\n\`${payload.diagnosticsSummary.recentCodes.join(', ')}\`\n`
                : '',
              `---`,
              `*本记录由 CourseHub 客户端脱敏后提交至 D1 数据库并同步至 GitHub。绝不包含 Cookies、Authorization 或 API Key。*`
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

              // 更新占位状态为真实的 Issue 编号
              if (fingerprint) {
                await env.DB.prepare(`
                  UPDATE error_fingerprints SET issue_number = ?, issue_url = ?, last_seen_at = ?
                  WHERE fingerprint = ? AND category = ?
                `).bind(created.number, created.html_url, now.toISOString(), fingerprint, payload.category).run()
              }
            } else {
              throw new Error(`GitHub create issue returned ${createRes.status}`)
            }
          } else {
            // 并发占位未完成状态：安全加入重试队列
            syncStatus = 'pending'
            await env.DB.prepare(`
              INSERT OR REPLACE INTO github_sync_jobs (
                feedback_id, action, fingerprint, status, last_error, created_at, updated_at
              ) VALUES (?, 'append_comment', ?, 'pending', 'Concurrent lock wait', ?, ?)
            `).bind(feedbackId, fingerprint, now.toISOString(), now.toISOString()).run()
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

      return buildFeedbackResponse(
        {
          id: feedbackId,
          status: syncStatus,
          github_issue_number: issueNumber,
          github_issue_url: issueUrl
        },
        false
      )
    }

    return new Response(JSON.stringify({ error: 'Not Found' }), {
      status: 404,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    })
  },

  async scheduled(_event: unknown, env: Env): Promise<void> {
    if (env.DB) {
      await autoCleanup30Days(env.DB)
      await processPendingGitHubSyncJobs(env)
    }
  }
}
