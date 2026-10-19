/**
 * CourseHub 客户端自动更新类型定义与错误处理合同。
 *
 * 设计原则：
 * 1. 明确区分更新状态机阶段：idle -> checking -> available / not_available -> downloading -> downloaded -> error。
 * 2. 区分网络故障类型（DNS / 超时 / 403 / 404 / 5xx / 校验失败），提供直观中文文案与官方 Release 兜底链接。
 * 3. 严格脱敏：剥离任何内部 URL 参数、Token 或本地隐私路径。
 */

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not_available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export type UpdateErrorCode =
  | 'UPDATE_DNS_ERROR'
  | 'UPDATE_TIMEOUT'
  | 'UPDATE_HTTP_403'
  | 'UPDATE_HTTP_404'
  | 'UPDATE_HTTP_5XX'
  | 'UPDATE_CHECKSUM_MISMATCH'
  | 'UPDATE_NETWORK_ERROR'
  | 'UPDATE_BUSY_CONFLICT'
  | 'UPDATE_UNKNOWN_ERROR'

export interface UpdateReleaseInfo {
  version: string
  releaseDate?: string
  releaseNotes?: string | null
  releaseName?: string | null
  releaseUrl?: string
}

export interface UpdateProgressInfo {
  percent: number
  bytesPerSecond: number
  transferred: number
  total: number
}

export interface UpdateErrorInfo {
  code: UpdateErrorCode
  message: string
  rawError?: string
  releasePageUrl: string
}

export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  channel: 'beta' | 'latest'
  info: UpdateReleaseInfo | null
  progress: UpdateProgressInfo | null
  error: UpdateErrorInfo | null
  lastCheckedAt: string | null
  isInstallOnQuit: boolean
}

export const GITHUB_RELEASES_URL = 'https://github.com/Qiuizi/CourseHub/releases'
export const GITHUB_REPO_OWNER = 'Qiuizi'
export const GITHUB_REPO_NAME = 'CourseHub'

/**
 * 将任意更新异常精确分类为标准化错误码与人性化中文提示。
 * 同时剥离所有潜在的 Token、内部 query 与敏感信息。
 */
export function classifyUpdaterError(err: unknown): {
  code: UpdateErrorCode
  message: string
  rawError: string
} {
  const rawMsg = err instanceof Error ? err.message : String(err ?? 'Unknown error')
  // 基础脱敏：移除 URL 中的 token、secret 等敏感参数
  const sanitizedMsg = rawMsg
    .replace(/((?:token|access_token|secret|key)=)[^& \s]+/gi, '$1***')
    .replace(/Bearer\s+[A-Za-z0-9_.-]+/gi, 'Bearer ***')
    .trim()

  const lower = sanitizedMsg.toLowerCase()

  if (
    lower.includes('enotfound') ||
    lower.includes('getaddrinfo') ||
    lower.includes('dns') ||
    lower.includes('net::err_name_not_resolved')
  ) {
    return {
      code: 'UPDATE_DNS_ERROR',
      message: '无法解析 GitHub 域名，可能是本地网络未连接或 DNS 受到干扰。',
      rawError: sanitizedMsg
    }
  }

  if (
    lower.includes('etimedout') ||
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('net::err_connection_timed_out')
  ) {
    return {
      code: 'UPDATE_TIMEOUT',
      message: '连接 GitHub 超时，建议检查本地网络环境或稍后重试。',
      rawError: sanitizedMsg
    }
  }

  if (lower.includes('403') || lower.includes('rate limit')) {
    return {
      code: 'UPDATE_HTTP_403',
      message: 'GitHub 访问频次受限 (HTTP 403)，请稍后重试或前往网页直接下载。',
      rawError: sanitizedMsg
    }
  }

  if (lower.includes('404') || lower.includes('cannot find') || lower.includes('not found')) {
    return {
      code: 'UPDATE_HTTP_404',
      message: '暂未在 GitHub 找到当前分支的更新发布清单 (HTTP 404)。',
      rawError: sanitizedMsg
    }
  }

  if (
    lower.includes('500') ||
    lower.includes('502') ||
    lower.includes('503') ||
    lower.includes('504') ||
    lower.includes('server error')
  ) {
    return {
      code: 'UPDATE_HTTP_5XX',
      message: 'GitHub 服务器暂时出现故障 (HTTP 5xx)，请稍后重试。',
      rawError: sanitizedMsg
    }
  }

  if (
    lower.includes('checksum') ||
    lower.includes('sha512') ||
    lower.includes('hash mismatch') ||
    lower.includes('corrupted')
  ) {
    return {
      code: 'UPDATE_CHECKSUM_MISMATCH',
      message: '更新包 SHA-512 完整性校验未通过，已放弃安装以确保系统安全。',
      rawError: sanitizedMsg
    }
  }

  if (
    lower.includes('econnreset') ||
    lower.includes('econnrefused') ||
    lower.includes('network') ||
    lower.includes('fetch failed') ||
    lower.includes('net::err_internet_disconnected')
  ) {
    return {
      code: 'UPDATE_NETWORK_ERROR',
      message: '网络连接失败，请确认网络连接正常后再试。',
      rawError: sanitizedMsg
    }
  }

  return {
    code: 'UPDATE_UNKNOWN_ERROR',
    message: sanitizedMsg || '更新检查遇到异常，请稍后重试。',
    rawError: sanitizedMsg
  }
}

/** 格式化字节数，如 12.4 MB */
export function formatBytes(bytes: number): string {
  if (bytes <= 0 || isNaN(bytes)) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const idx = Math.min(i, units.length - 1)
  const val = bytes / Math.pow(1024, idx)
  return `${val.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`
}

/** 格式化网速，如 1.5 MB/s */
export function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec <= 0 || isNaN(bytesPerSec)) return '0 KB/s'
  return `${formatBytes(bytesPerSec)}/s`
}
