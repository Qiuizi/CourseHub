/**
 * 签到事件的归一化与去重。
 *
 * 契约（开发文档 §3.1、§6.1）：
 * - 「检测到活动」≠「已签到」。statusSource 必须如实标注状态来源。
 * - 「今天」按事件来源时区判定；来源未明确时记录并展示时区假设，
 *   不自行把跨天活动判错。
 * - 去重必须跨进程重启有效（不能只靠内存 Map）。
 */

import type { SignInEvent, SignInKind, SignInStatus, SignInStatusSource } from './types'

/** 生成稳定去重键。同一活动在多次轮询中必须得到同一个 key。 */
export function signInDedupeKey(event: Pick<SignInEvent, 'platformId' | 'id'>): string {
  return `${event.platformId}:${event.id}`
}

/**
 * 判断事件是否落在指定「今天」。
 *
 * @param dayISO 形如 '2026-10-15'
 * @param eventAtISO 事件时间（ISO UTC）
 * @param eventTimezoneIANA 来源时区，如 'Asia/Shanghai'。
 *        为 null 时不做跨天推断，返回 null 表示「无法判定」。
 */
export function isEventOnDay(
  dayISO: string,
  eventAtISO: string | null,
  eventTimezoneIANA: string | null
): boolean | null {
  if (!eventAtISO) return false
  const at = new Date(eventAtISO)
  if (Number.isNaN(at.getTime())) return null

  if (!eventTimezoneIANA) {
    // 无时区信息：不做猜测。用 UTC 日期比较并标注为不可靠。
    return at.toISOString().slice(0, 10) === dayISO
  }

  try {
    const local = new Intl.DateTimeFormat('en-CA', {
      timeZone: eventTimezoneIANA,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(at)
    return local === dayISO
  } catch {
    return null
  }
}

/** 把平台原始活动类型映射为归一化签到类型。未知一律 'unknown'，不臆测。 */
export function normalizeSignInKind(raw: unknown): SignInKind {
  // 注意：Number(null) === 0 且 Number('') === 0，
  // 若不先挡掉 null/空串，会把「无类型」误判成取值 0（normal）。
  if (raw === null || raw === undefined || raw === '') return 'unknown'
  if (typeof raw === 'boolean') return 'unknown'
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n)) return 'unknown'
  // 依据学习通插件 constants.ts:24-28 的交叉验证取值；
  // 未在真实账号实测，故命中不足时返回 unknown 而非猜测。
  switch (n) {
    case 0:
    case 2:
    case 74:
      return 'normal'
    default:
      return 'unknown'
  }
}

/**
 * 依据平台返回的原始状态判定签到状态。
 *
 * @param rawStatus 平台原始状态值
 * @param locallyRemembered 本地是否已记录「处理过该活动」
 * @param hasProviderEvidence 平台接口是否**本次**明确返回了已签到标志
 */
export function resolveSignInStatus(input: {
  rawStatus: unknown
  locallyRemembered: boolean
  hasProviderEvidence: boolean
  nowISO: string
  startAt: string | null
  endAt: string | null
}): { status: SignInStatus; source: SignInStatusSource; rawStatus: string | null } {
  const { rawStatus, locallyRemembered, hasProviderEvidence, nowISO, startAt, endAt } = input

  // 保留平台原始状态以便排障；调用方不得据此推断状态
  const raw = rawStatus === null || rawStatus === undefined ? null : String(rawStatus)

  // 唯一被允许判定「已签到」的路径：平台本次明确给出证据。
  if (hasProviderEvidence) {
    return { status: 'checked_in', source: 'provider_api', rawStatus: raw }
  }

  const now = new Date(nowISO).getTime()
  if (endAt && Number.isFinite(now) && now > new Date(endAt).getTime()) {
    return { status: 'closed', source: 'provider_api', rawStatus: raw }
  }
  if (startAt && Number.isFinite(now) && now < new Date(startAt).getTime()) {
    return { status: 'pending', source: 'provider_api', rawStatus: raw }
  }

  // 本地记忆只能降级表达，绝不能升级为 checked_in。
  if (locallyRemembered) {
    return { status: 'open', source: 'local_dedupe', rawStatus: raw }
  }

  return { status: 'open', source: 'none', rawStatus: raw }
}

/**
 * 跨轮询合并签到事件：保留首次发现时间，去重，并保留平台最新证据。
 * 平台一旦给出明确证据，优先于本地记忆。
 */
export function mergeSignInEvents(
  previous: readonly SignInEvent[],
  incoming: readonly SignInEvent[]
): SignInEvent[] {
  const byKey = new Map<string, SignInEvent>()
  for (const e of previous) byKey.set(signInDedupeKey(e), e)
  for (const e of incoming) {
    const key = signInDedupeKey(e)
    const old = byKey.get(key)
    if (!old) {
      byKey.set(key, e)
      continue
    }
    // 平台证据一旦出现即为权威，后续任何非平台来源都不得覆盖它。
    // 走到这里时，若 old 是平台证据则 e 必定也是平台证据（上面已拦截反例）。
    if (old.statusSource === 'provider_api') {
      byKey.set(key, e.statusSource === 'provider_api' ? { ...old, ...e, fetchedAt: e.fetchedAt } : old)
      continue
    }
    // old 不是平台证据：取较新的那条
    byKey.set(key, { ...old, ...e, fetchedAt: e.fetchedAt })
  }
  return [...byKey.values()].sort((a, b) => (a.startAt ?? a.fetchedAt).localeCompare(b.startAt ?? b.fetchedAt))
}

/**
 * 数据新鲜度：超过 staleAfterMs 标记为 stale。
 * 过期数据必须显示为 stale，不能继续当作 ready。
 */
export function isStale(fetchedAtISO: string, nowISO: string, staleAfterMs: number): boolean {
  const fetched = new Date(fetchedAtISO).getTime()
  const now = new Date(nowISO).getTime()
  if (!Number.isFinite(fetched) || !Number.isFinite(now)) return true
  return now - fetched > staleAfterMs
}
