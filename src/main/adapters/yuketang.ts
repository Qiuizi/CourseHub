/**
 * 雨课堂适配器请求构建与响应解析。
 *
 * 源码证据：
 * - 课程列表与在课状态端点：`yuketang_plugin/src/shared/constants.js:7-20`
 * - API 响应格式及错误处理：`yuketang_plugin/src/background/api-client.js:30-67`
 * - WebSocket 操作码协议：`yuketang_plugin/src/shared/constants.js:23-39`
 */

export interface YuketangCourse {
  classroomCourseId: string
  courseName: string
  teacherName: string
  coverUrl: string | null
}

export interface YuketangOnLessonStatus {
  onLesson: boolean
  lessonId: string | null
  classroomId: string | null
  courseName: string | null
  rawStatus?: unknown
}

export const YUKETANG_ENDPOINTS = {
  courseList: 'https://www.yuketang.cn/v2/api/web/courses/list?identity=2',
  onLesson: 'https://www.yuketang.cn/api/v3/classroom/on-lesson-upcoming-exam'
}

export const KNOWN_WS_OPS = new Set([
  'hello',
  'unlockproblem',
  'extendtime',
  'callpaused',
  'lessonfinished',
  'fetchtimeline',
  'showpresentation',
  'presentationcreated',
  'slidenav',
  'probleminfo',
  'problemfinished'
])

export function buildYktCourseListRequest(): { url: string; method: string } {
  return {
    url: YUKETANG_ENDPOINTS.courseList,
    method: 'GET'
  }
}

export function parseYktCourseListResponse(raw: unknown): {
  ok: boolean
  courses: YuketangCourse[]
  error?: string
} {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, courses: [], error: 'INVALID_JSON: 响应不是对象' }
  }
  const record = raw as Record<string, unknown>
  const code = typeof record.code === 'number' ? record.code : null
  if (code !== 0 && code !== null) {
    const msg = typeof record.msg === 'string' ? record.msg : `错误码 ${code}`
    return { ok: false, courses: [], error: `API_ERROR: ${msg}` }
  }

  const data = record.data as Record<string, unknown> | undefined
  const list = Array.isArray(data?.courses) ? (data!.courses as unknown[]) : []

  const courses: YuketangCourse[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const c = item as Record<string, unknown>
    const id = String(c.classroom_id ?? c.id ?? '')
    if (!id) continue
    courses.push({
      classroomCourseId: id,
      courseName: String(c.course_name ?? c.name ?? `未命名课程 ${id}`),
      teacherName: String(c.teacher_name ?? c.teacher ?? ''),
      coverUrl: typeof c.cover === 'string' ? c.cover : null
    })
  }

  return { ok: true, courses }
}

export function buildOnLessonRequest(): { url: string; method: string } {
  return {
    url: YUKETANG_ENDPOINTS.onLesson,
    method: 'GET'
  }
}

export function parseOnLessonResponse(raw: unknown): {
  ok: boolean
  status: YuketangOnLessonStatus
  error?: string
} {
  if (!raw || typeof raw !== 'object') {
    return {
      ok: false,
      status: { onLesson: false, lessonId: null, classroomId: null, courseName: null },
      error: 'INVALID_JSON: 响应不是对象'
    }
  }

  const record = raw as Record<string, unknown>
  const data = (record.data ?? record) as Record<string, unknown>

  // 雨课堂在课通常返回 on_lesson 为 true，或存在当前 lesson 信息
  const onLesson = Boolean(data.on_lesson ?? data.onLesson ?? (data.lesson_id != null && data.lesson_id !== 0))
  const lessonId = data.lesson_id != null ? String(data.lesson_id) : null
  const classroomId = data.classroom_id != null ? String(data.classroom_id) : null
  const courseName = typeof data.course_name === 'string' ? data.course_name : null

  return {
    ok: true,
    status: {
      onLesson,
      lessonId,
      classroomId,
      courseName,
      rawStatus: data
    }
  }
}

export interface WsAppMessage {
  op: string
  data: unknown
  isKnown: boolean
}

/**
 * 解析雨课堂 WebSocket /wsapp/ 文本消息。
 * 格式通常为 JSON 包含 op 字段与数据载荷。
 */
export function parseWsAppMessage(rawText: string): WsAppMessage | null {
  if (!rawText || typeof rawText !== 'string') return null
  try {
    const json = JSON.parse(rawText) as Record<string, unknown>
    if (!json || typeof json !== 'object') return null
    const op = typeof json.op === 'string' ? json.op.toLowerCase() : 'unknown'
    return {
      op,
      data: json.data ?? json,
      isKnown: KNOWN_WS_OPS.has(op)
    }
  } catch {
    return null
  }
}
