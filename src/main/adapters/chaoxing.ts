/**
 * 学习通（超星）适配器请求构建与响应解析。
 *
 * 源码证据：
 * - 请求端点与递归收集算法：`XueXiTongPlugin/src/core/api.ts:43-89`
 * - 活动类型与状态常量：`XueXiTongPlugin/src/shared/constants.ts:8-16`
 *
 * 设计原则：
 * - 纯函数设计，不依赖 Electron 运行时，可独立单测。
 * - 字段解析宽容：兼容历史版本键名差异（如 courseId / courseid / classId / clazzid）。
 * - 状态标注：若缺少真实线上账号联调，网络请求层返回 unverified，但不妨碍本地 Schema 校验。
 */

export interface ChaoxingCourse {
  courseId: string
  classId: string
  cpi: string
  name: string
}

export interface ChaoxingActivity {
  id: string
  title: string
  activeType: number
  status: number
  courseId: string
  classId: string
  isSignIn: boolean
}

export const CHAOXING_ENDPOINTS = {
  courseList: 'https://mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json&rss=1',
  activeList: (courseId: string, classId: string): string =>
    `https://mobilelearn.chaoxing.com/v2/apis/active/student/activelist?fid=0&courseId=${encodeURIComponent(courseId)}&classId=${encodeURIComponent(classId)}`
}

function str(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return ''
}

function num(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return 0
}

/** 递归遍历任意嵌套对象 */
function walk(obj: unknown, visitor: (node: Record<string, unknown>) => void): void {
  if (!obj || typeof obj !== 'object') return
  if (Array.isArray(obj)) {
    for (const item of obj) walk(item, visitor)
    return
  }
  const record = obj as Record<string, unknown>
  visitor(record)
  for (const val of Object.values(record)) {
    if (val && typeof val === 'object') walk(val, visitor)
  }
}

/** 构建课程列表请求信息 */
export function buildCourseListRequest(): { url: string; method: string; headers: Record<string, string> } {
  return {
    url: CHAOXING_ENDPOINTS.courseList,
    method: 'GET',
    headers: {
      Accept: 'application/json, text/plain, */*'
    }
  }
}

/**
 * 解析 backclazzdata 课程列表响应。
 * 兼容 courseId/courseid、classId/clazzid/clazzId、name/courseName/coursename 等变体。
 */
export function parseCourseListResponse(raw: unknown): {
  ok: boolean
  courses: ChaoxingCourse[]
  error?: string
} {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, courses: [], error: 'INVALID_JSON: 响应不是对象' }
  }

  const rawRecord = raw as Record<string, unknown>
  // 检查是否有明确的未登录或认证失效标识
  if (rawRecord.result === 0 && typeof rawRecord.msg === 'string' && rawRecord.msg.includes('登录')) {
    return { ok: false, courses: [], error: 'AUTH_EXPIRED: 学习通登录会话已过期' }
  }

  const found: ChaoxingCourse[] = []
  const seen = new Set<string>()

  walk(raw, (node) => {
    const courseId = str(node.courseId ?? node.courseid)
    const classId = str(node.classId ?? node.clazzid ?? node.clazzId)
    if (!courseId || !classId) return

    const key = `${courseId}:${classId}`
    if (seen.has(key)) return
    seen.add(key)

    const cpi = str(node.cpi) || '0'
    const name = str(node.name ?? node.courseName ?? node.coursename) || `课程 ${courseId}`
    found.push({ courseId, classId, cpi, name })
  })

  return { ok: true, courses: found }
}

/** 构建活动列表请求信息 */
export function buildActiveListRequest(
  courseId: string,
  classId: string
): { url: string; method: string } {
  return {
    url: CHAOXING_ENDPOINTS.activeList(courseId, classId),
    method: 'GET'
  }
}

/**
 * 解析 activelist 活动列表响应。
 * activeType === 2 为签到活动。
 */
export function parseActiveListResponse(
  raw: unknown,
  courseId = '',
  classId = ''
): {
  ok: boolean
  activities: ChaoxingActivity[]
  error?: string
} {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, activities: [], error: 'INVALID_JSON: 响应不是对象' }
  }

  const record = raw as Record<string, unknown>
  const list = Array.isArray(record.activeList)
    ? (record.activeList as unknown[])
    : Array.isArray(record.data)
      ? (record.data as unknown[])
      : Array.isArray(record.list)
        ? (record.list as unknown[])
        : []

  const items: ChaoxingActivity[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const node = item as Record<string, unknown>
    const id = str(node.id ?? node.activeId ?? node.activePrimaryId)
    if (!id) continue

    const activeType = num(node.activeType ?? node.type)
    const title = str(node.nameOne ?? node.name ?? node.title) || `活动 ${id}`
    const status = num(node.status)

    items.push({
      id,
      title,
      activeType,
      status,
      courseId: str(node.courseId) || courseId,
      classId: str(node.classId) || classId,
      isSignIn: activeType === 2 // 学习通签到活动类型为 2
    })
  }

  return { ok: true, activities: items }
}

import type { SignInEvent } from '@shared/types'

export interface SessionLike {
  cookies: {
    get: (filter: { domain?: string }) => Promise<Array<{ name: string; value: string }>>
  }
  fetch: (input: any, init?: any) => Promise<any>
}

/** 探测学习通 Session 登录状态（通过读取 Cookie 及尝试拉取课程） */
export async function detectChaoxingAuth(ses: SessionLike): Promise<{
  state: 'unauthenticated' | 'authenticated' | 'expired' | 'error'
  evidence: string | null
}> {
  try {
    const cookies = await ses.cookies.get({ domain: 'chaoxing.com' }).catch(() => [])
    const passportCookies = await ses.cookies.get({ domain: 'passport2.chaoxing.com' }).catch(() => [])
    const all = [...cookies, ...passportCookies]
    const hasAuthCookie = all.some((c) =>
      ['_uid', 'UID', 'vc3', 'k8s', 'fid', 'cx_rt'].some((k) => c.name.toLowerCase().includes(k.toLowerCase()))
    )
    if (!hasAuthCookie && all.length === 0) {
      return { state: 'unauthenticated', evidence: '未在内置浏览器中检测到学习通登录 Cookie' }
    }

    const req = buildCourseListRequest()
    const resp = await ses.fetch(req.url, { method: req.method, headers: req.headers })
    if (resp.status === 401 || resp.status === 403) {
      return { state: 'expired', evidence: '学习通登录凭证已失效（HTTP 401/403）' }
    }
    const json = (await resp.json().catch(() => null)) as unknown
    const parsed = parseCourseListResponse(json)
    if (!parsed.ok) {
      if (parsed.error?.includes('AUTH_EXPIRED')) {
        return { state: 'expired', evidence: '学习通登录会话已过期，需要重新登录' }
      }
      return { state: 'unauthenticated', evidence: parsed.error ?? '无法验证身份' }
    }
    return {
      state: 'authenticated',
      evidence: `已成功认证，读取到 ${parsed.courses.length} 门在读课程`
    }
  } catch (e) {
    return { state: 'error', evidence: e instanceof Error ? e.message : String(e) }
  }
}

/** 通过 Session 拉取学习通课程列表 */
export async function fetchChaoxingCourses(ses: SessionLike): Promise<{
  ok: boolean
  state: 'supported' | 'unauthenticated' | 'expired' | 'error'
  courses: ChaoxingCourse[]
  error?: string
}> {
  const auth = await detectChaoxingAuth(ses)
  if (auth.state !== 'authenticated') {
    return { ok: false, state: auth.state, courses: [], error: auth.evidence ?? '未登录' }
  }

  const req = buildCourseListRequest()
  const resp = await ses.fetch(req.url, { method: req.method, headers: req.headers })
  const json = (await resp.json().catch(() => null)) as unknown
  const parsed = parseCourseListResponse(json)
  return {
    ok: parsed.ok,
    state: parsed.ok ? 'supported' : 'error',
    courses: parsed.courses,
    error: parsed.error
  }
}

/** 通过 Session 拉取学习通今日签到活动 */
export async function fetchChaoxingSignIns(ses: SessionLike): Promise<{
  state: 'supported' | 'unauthenticated' | 'expired' | 'unverified' | 'error'
  events: SignInEvent[]
  fetchedAt: string
  reason: string | null
}> {
  const courseRes = await fetchChaoxingCourses(ses)
  if (!courseRes.ok) {
    return {
      state: courseRes.state,
      events: [],
      fetchedAt: new Date().toISOString(),
      reason: courseRes.error ?? '无法拉取课程'
    }
  }

  const events: SignInEvent[] = []
  // 针对前 6 门有效课程并行查询签到活动
  const targetCourses = courseRes.courses.slice(0, 6)
  await Promise.all(
    targetCourses.map(async (course) => {
      try {
        const req = buildActiveListRequest(course.courseId, course.classId)
        const resp = await ses.fetch(req.url, { method: req.method })
        if (!resp.ok) return
        const json = (await resp.json().catch(() => null)) as unknown
        const parsed = parseActiveListResponse(json, course.courseId, course.classId)
        if (!parsed.ok) return

        for (const act of parsed.activities) {
          if (act.isSignIn) {
            events.push({
              id: `cx-${act.id}`,
              platformId: 'chaoxing',
              courseId: course.courseId,
              kind: 'normal',
              title: `${course.name} · ${act.title}`,
              startAt: new Date().toISOString(),
              endAt: null,
              sourceUrl: `https://mobilelearn.chaoxing.com/v2/apis/active/getPPTActiveInfo?activeId=${act.id}`,
              fetchedAt: new Date().toISOString(),
              status: act.status === 1 ? 'open' : 'closed',
              statusSource: 'provider_api',
              locationText: null,
              locationRequired: false
            })
          }
        }
      } catch {
        // 单个课程异常不阻断其它课程查询
      }
    })
  )

  return {
    state: 'supported',
    events,
    fetchedAt: new Date().toISOString(),
    reason: events.length === 0 ? '当前在读课程无进行中的签到活动' : null
  }
}

