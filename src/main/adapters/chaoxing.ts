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
