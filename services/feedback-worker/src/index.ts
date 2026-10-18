/**
 * CourseHub Feedback & Diagnostic Collector Cloudflare Worker
 *
 * 功能：
 * 1. 接收客户端脱敏反馈与诊断数据
 * 2. 验证输入合法性与 IP 速率限制
 * 3. 将诊断 ZIP 与截图保存至私有 R2 存储桶（不向公众暴露）
 * 4. 自动检索同类错误指纹，去重聚合至 GitHub Issues
 * 5. 全程保证零密钥外泄（Client 不包含任何 Token；Serverless 端仅使用环境变量配置的最小权限 PAT）
 */

export interface Env {
  ENVIRONMENT: string
  GITHUB_REPO_OWNER: string
  GITHUB_REPO_NAME: string
  GITHUB_TOKEN?: string
  FEEDBACK_STORAGE?: R2Bucket
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

// 简单内存 IP 频控（防刷）
const ipRateMap = new Map<string, { count: number; resetAt: number }>()

function isRateLimited(ip: string, limit = 10, windowMs = 5 * 60 * 1000): boolean {
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

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  'Access-Control-Max-Age': '86400'
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
          version: '0.4.3',
          time: new Date().toISOString()
        }),
        {
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        }
      )
    }

    // 反馈提交接口
    if (url.pathname === '/api/feedback' && request.method === 'POST') {
      const clientIp = request.headers.get('cf-connecting-ip') || 'unknown'
      if (isRateLimited(clientIp)) {
        return new Response(
          JSON.stringify({
            success: false,
            message: '提交太频繁，请稍候再试（5 分钟内最多提交 10 次）'
          }),
          { status: 429, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        )
      }

      let payload: FeedbackPayload
      try {
        payload = await request.json()
      } catch {
        return new Response(
          JSON.stringify({ success: false, message: '无效的 JSON 请求体' }),
          { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        )
      }

      // 验证必要字段
      if (!payload.category || !payload.description || payload.description.trim().length < 3) {
        return new Response(
          JSON.stringify({ success: false, message: '请填写有效的问题类型和描述（不少于 3 字）' }),
          { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
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

      // 1. 若配置了 R2 存储桶，将诊断包与截图安全存储（私有空间，公开不可查）
      if (env.FEEDBACK_STORAGE) {
        if (payload.diagnosticPackageBase64) {
          try {
            const binary = Uint8Array.from(atob(payload.diagnosticPackageBase64), (c) => c.charCodeAt(0))
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
          try {
            const cleanBase64 = payload.screenshotBase64.replace(/^data:image\/\w+;base64,/, '')
            const binary = Uint8Array.from(atob(cleanBase64), (c) => c.charCodeAt(0))
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

          // 如果有错误指纹，先检索是否已有相同指纹的开放 Issue
          if (fingerprint && fingerprint.startsWith('FP-')) {
            const query = `repo:${owner}/${repo} is:issue is:open "${fingerprint}"`
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
              const searchData = (await searchRes.json()) as { items?: { number: number; html_url: string }[] }
              if (searchData.items && searchData.items.length > 0) {
                existingIssueNumber = searchData.items[0].number
                issueUrl = searchData.items[0].html_url
              }
            }
          }

          if (existingIssueNumber) {
            // 已有相同指纹的 Issue：追加评论并聚合计数，不刷屏建新 Issue
            const commentBody = [
              `### 📥 用户反馈补充 (+1)`,
              `- **反馈编号**: \`${feedbackId}\``,
              `- **软件版本**: \`${payload.systemInfo.appVersion}\``,
              `- **操作系统**: \`${payload.systemInfo.os}\``,
              `- **问题描述**: ${payload.description}`,
              payload.reproductionSteps ? `- **复现步骤**: ${payload.reproductionSteps}` : null,
              `- **私有诊断包**: ${storedZip ? `\`diagnostics/${feedbackId}.zip\`` : '无'}`,
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
            const shortDesc = payload.description.slice(0, 40).replace(/[\r\n]+/g, ' ')
            const title = `[用户反馈] [${payload.category}] ${shortDesc}${payload.description.length > 40 ? '...' : ''}`
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
              payload.description,
              ``,
              payload.reproductionSteps ? `### 🔁 复现步骤\n${payload.reproductionSteps}\n` : '',
              payload.diagnosticsSummary?.recentCodes?.length
                ? `### ⚠️ 最近错误代码\n\`${payload.diagnosticsSummary.recentCodes.join(', ')}\`\n`
                : '',
              `---`,
              `*本反馈由 CourseHub 客户端脱敏后自动提交，原始 Cookies、Authorization 及个人身份已严格剔除。*`
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
              const created = (await createRes.json()) as { html_url: string }
              issueUrl = created.html_url
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
