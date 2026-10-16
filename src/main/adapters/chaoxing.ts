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
  teacherName?: string
  clazzName?: string
  courseUrl?: string
  coverUrl?: string
}

export type ChaoxingActivityCategory =
  | 'sign_in'        // activeType === 2 (真实签到)
  | 'questionnaire'  // activeType === 14 (问卷调查)
  | 'rollcall'       // activeType === 11 (随堂选人/点名)
  | 'exercise'       // activeType === 42 (随堂主题/练习)
  | 'notice'         // activeType === 45 (通知公告)
  | 'task'           // activeType === 77 (作业/阅读/实践任务)
  | 'group'          // activeType === 35 (分组任务/讨论)
  | 'other'          // 其余类型

export function classifyChaoxingActivityType(activeType: number): ChaoxingActivityCategory {
  switch (activeType) {
    case 2:
      return 'sign_in'
    case 14:
      return 'questionnaire'
    case 11:
      return 'rollcall'
    case 42:
      return 'exercise'
    case 45:
      return 'notice'
    case 77:
      return 'task'
    case 35:
      return 'group'
    default:
      return 'other'
  }
}

export interface ChaoxingActivity {
  id: string
  title: string
  activeType: number
  category: ChaoxingActivityCategory
  status: number
  courseId: string
  classId: string
  isSignIn: boolean
  startAt?: string | null
  endAt?: string | null
}

export const CHAOXING_ENDPOINTS = {
  courseList: 'https://mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json&rss=1',
  mooc2CourseList: 'https://mooc2-ans.chaoxing.com/mooc2-ans/visit/courselistdata',
  chapterList: (courseId: string, clazzId: string, cpi = '0'): string =>
    `https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/studentcourse?courseid=${encodeURIComponent(courseId)}&clazzid=${encodeURIComponent(clazzId)}&cpi=${encodeURIComponent(cpi)}`,
  activeList: (courseId: string, classId: string, showAll = true): string =>
    `https://mobilelearn.chaoxing.com/v2/apis/active/student/activelist?fid=0&courseId=${encodeURIComponent(courseId)}&classId=${encodeURIComponent(classId)}${showAll ? '&showNotStartedActive=1' : ''}`
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

function parseTimeOrNull(val: unknown): string | null {
  if (!val) return null
  if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
    const ms = val < 1e11 ? val * 1000 : val
    return new Date(ms).toISOString()
  }
  if (typeof val === 'string') {
    const s = val.trim()
    if (!s) return null
    if (/^\d+$/.test(s)) {
      const n = Number(s)
      const ms = n < 1e11 ? n * 1000 : n
      return new Date(ms).toISOString()
    }
    const d = new Date(s)
    if (!Number.isNaN(d.getTime())) return d.toISOString()
  }
  return null
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

/** 构建 MOOC1 课程列表请求信息 */
export function buildCourseListRequest(): { url: string; method: string; headers: Record<string, string> } {
  return {
    url: CHAOXING_ENDPOINTS.courseList,
    method: 'GET',
    headers: {
      Accept: 'application/json, text/plain, */*'
    }
  }
}

/** 构建 MOOC2 现代课程列表请求信息 */
export function buildMooc2CourseListRequest(): {
  url: string
  method: string
  headers: Record<string, string>
  body: string
} {
  return {
    url: CHAOXING_ENDPOINTS.mooc2CourseList,
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'text/html, */*; q=0.01'
    },
    body: 'courseType=1&courseFolderId=0&query=&pageHeader=-1&single=0&superstarClass=0&isFirefly=0&fid=&from='
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
    const item: ChaoxingCourse = { courseId, classId, cpi, name }

    const teacherName = str(node.teacherfactor ?? node.teacherName)
    if (teacherName) item.teacherName = teacherName
    const clazzName = str(node.clazzName ?? node.className)
    if (clazzName) item.clazzName = clazzName
    const courseUrl = str(node.courseUrl ?? node.courseurl)
    if (courseUrl) item.courseUrl = courseUrl
    const coverUrl = str(node.imageurl ?? node.coverUrl)
    if (coverUrl) item.coverUrl = coverUrl

    found.push(item)
  })

  return { ok: true, courses: found }
}

/**
 * 解析 MOOC2 courselistdata HTML 响应。
 * 提取 courseId、clazzId、cpi、课程名称、任课教师、班级名称、封面和直达链接。
 */
export function parseMooc2CourseListResponse(html: unknown): {
  ok: boolean
  courses: ChaoxingCourse[]
  error?: string
} {
  if (typeof html !== 'string' || html.trim().length === 0) {
    return { ok: false, courses: [], error: 'INVALID_HTML: MOOC2 响应为空' }
  }
  if (
    html.includes('passport2.chaoxing.com/login') ||
    html.includes('请重新登录') ||
    html.includes('未登录')
  ) {
    return { ok: false, courses: [], error: 'AUTH_EXPIRED: 学习通 MOOC2 会话已失效，需要重新登录' }
  }

  const found: ChaoxingCourse[] = []
  const seen = new Set<string>()

  const blocks =
    html.match(
      /<div[^>]*class=["'][^"']*(?<![a-zA-Z0-9_-])course(?![a-zA-Z0-9_-])[\s\S]*?(?=<div[^>]*class=["'][^"']*(?<![a-zA-Z0-9_-])course(?![a-zA-Z0-9_-])|$)/gi
    ) || []

  for (const block of blocks) {
    const isLearn = block.includes('learnCourse') || !block.includes('teachCourse')
    if (!isLearn) continue

    const nameMatch =
      block.match(/class=["'][^"']*course-name[^"']*["'][^>]*title=["']([^"']+)["']/i) ||
      block.match(/class=["'][^"']*course-name[^"']*["'][^>]*>([^<]+)</i)
    if (!nameMatch) continue

    const name = nameMatch[1].trim()

    const courseIdInput = block.match(
      /class=["'][^"']*courseId[^"']*["'][^>]*value=["']([0-9]+)["']/i
    )
    const clazzIdInput = block.match(
      /class=["'][^"']*clazzId[^"']*["'][^>]*value=["']([0-9]+)["']/i
    )
    const cpiInput = block.match(
      /class=["'][^"']*curPersonId[^"']*["'][^>]*value=["']([0-9]+)["']/i
    )

    const linkMatch = block.match(/href=["']([^"']*(?:stucoursemiddle|courseid)[^"']*)["']/i)
    const link = linkMatch ? linkMatch[1].replace(/&amp;/g, '&') : ''
    const urlCid = link.match(/courseid=([0-9]+)/i)
    const urlClid = link.match(/clazzid=([0-9]+)/i)
    const urlCpi = link.match(/cpi=([0-9]+)/i)

    const courseId = str(courseIdInput?.[1] || urlCid?.[1])
    const classId = str(clazzIdInput?.[1] || urlClid?.[1])
    const cpi = str(cpiInput?.[1] || urlCpi?.[1]) || '0'

    if (!courseId || !classId) continue

    const key = `${courseId}:${classId}`
    if (seen.has(key)) continue
    seen.add(key)

    const teacherMatch = block.match(
      /class=["'][^"']*color2[^"']*["'][^>]*title=["']([^"']+)["']/i
    )
    const clazzMatch = block.match(
      /class=["'][^"']*color3[^"']*["'][^>]*title=["']([^"']+)["']/i
    )
    const coverMatch = block.match(/<img[^>]+src=["']([^"']+)["']/i)

    found.push({
      courseId,
      classId,
      cpi,
      name,
      teacherName: teacherMatch ? teacherMatch[1].trim() : undefined,
      clazzName: clazzMatch ? clazzMatch[1].trim() : undefined,
      courseUrl:
        link ||
        `https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=${courseId}&clazzid=${classId}&cpi=${cpi}&ismooc2=1&v=2`,
      coverUrl: coverMatch ? coverMatch[1] : undefined
    })
  }

  // 兜底扫描（如果页面结构有细微差异未匹配到 div.course 块）
  if (found.length === 0) {
    const nameMatches = [
      ...html.matchAll(/<span[^>]*class=["'][^"']*course-name[^"']*["'][^>]*title=["']([^"']+)["']/gi)
    ]
    for (const nm of nameMatches) {
      const idx = nm.index ?? 0
      const chunk = html.substring(Math.max(0, idx - 800), Math.min(html.length, idx + 800))
      const linkMatch = chunk.match(/href=["']([^"']*(?:courseid|stucoursemiddle)[^"']*)["']/i)
      const url = linkMatch ? linkMatch[1].replace(/&amp;/g, '&') : ''
      const cid =
        url.match(/courseid=([0-9]+)/i)?.[1] ||
        chunk.match(/courseId[^>]*value=["']([0-9]+)["']/i)?.[1]
      const clid =
        url.match(/clazzid=([0-9]+)/i)?.[1] ||
        chunk.match(/clazzId[^>]*value=["']([0-9]+)["']/i)?.[1]
      const cpi =
        url.match(/cpi=([0-9]+)/i)?.[1] ||
        chunk.match(/curPersonId[^>]*value=["']([0-9]+)["']/i)?.[1] ||
        '0'
      const courseName = nm[1].trim()

      if (cid && clid) {
        const key = `${cid}:${clid}`
        if (!seen.has(key)) {
          seen.add(key)
          found.push({
            courseId: cid,
            classId: clid,
            cpi,
            name: courseName,
            courseUrl:
              url ||
              `https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=${cid}&clazzid=${clid}&cpi=${cpi}&ismooc2=1&v=2`
          })
        }
      }
    }
  }

  return { ok: true, courses: found }
}

/** 构建 MOOC2 课程章节目录请求信息 */
export function buildMooc2ChapterListRequest(
  courseId: string,
  clazzId: string,
  cpi = '0'
): { url: string; method: string; headers: Record<string, string> } {
  return {
    url: CHAOXING_ENDPOINTS.chapterList(courseId, clazzId, cpi),
    method: 'GET',
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'X-Requested-With': 'XMLHttpRequest'
    }
  }
}

/**
 * 解析 MOOC2 studentcourse 课程章节列表 HTML。
 * 提取一级章节（章）、二级章节（节）、任务类型、状态与直达学习链接。
 */
export function parseMooc2ChapterListResponse(
  html: unknown,
  courseId: string,
  clazzId: string,
  cpi = '0'
): {
  ok: boolean
  chapters: ChapterNode[]
  enc?: string
  error?: string
} {
  if (typeof html !== 'string' || html.trim().length === 0) {
    return { ok: false, chapters: [], error: 'INVALID_HTML: 章节响应内容为空' }
  }
  if (html.includes('passport2.chaoxing.com/login') || html.includes('请重新登录') || html.includes('未登录')) {
    return { ok: false, chapters: [], error: 'AUTH_EXPIRED: 学习通会话已过期，需要重新登录' }
  }
  if (html.includes('antispiderShowVerify') || html.includes('【9010】操作异常')) {
    return { ok: false, chapters: [], error: 'ANTISPIDER_VERIFY: 超星触发防爬验证码，请在内置浏览器中完成一次验证' }
  }

  const encMatch =
    html.match(/var\s+enc\s*=\s*["']([^"']+)["']/i) ||
    html.match(/id=["']enc["'][^>]*value=["']([^"']+)["']/i) ||
    html.match(/value=["']([^"']+)["'][^>]*id=["']enc["']/i)
  const enc = encMatch ? encMatch[1] : ''

  if (html.includes('No chapter content available') || /<(?:div|p)[^>]*class=["'][^"']*nodata/i.test(html)) {
    return { ok: true, chapters: [], enc }
  }

  const units = [
    ...html.matchAll(
      /<div[^>]*class=["'][^"']*chapter_unit[^"']*["'][\s\S]*?(?=<div[^>]*class=["'][^"']*chapter_unit[^"']*["']|$)/gi
    )
  ].map((m) => m[0])

  const chapters: ChapterNode[] = []
  let currentOrder = 1

  for (let uIdx = 0; uIdx < units.length; uIdx++) {
    const unitHtml = units[uIdx]
    const unitItemMatch = unitHtml.match(
      /<div[^>]*class=["'][^"']*catalog_title[^"']*chapter_Thats_bnt[^"']*["'][\s\S]*?(?=<div[^>]*class=["'][^"']*catalog_level|$)/i
    )

    let unitTitle = ''
    if (unitItemMatch) {
      const clickTitle = unitItemMatch[0].match(
        /<a[^>]*class=["'][^"']*clicktitle[^"']*["'][^>]*>([\s\S]*?)<\/a>/i
      )
      if (clickTitle) {
        unitTitle = clickTitle[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      } else {
        const titleAttr = unitItemMatch[0].match(/title=["']([^"']+)["']/i)
        unitTitle = titleAttr ? titleAttr[1].trim() : `第 ${uIdx + 1} 章`
      }
    } else {
      unitTitle = `第 ${uIdx + 1} 章`
    }

    const parentId = `unit-${courseId}-${uIdx + 1}`

    chapters.push({
      courseId,
      clazzId,
      chapterId: parentId,
      parentId: null,
      title: unitTitle,
      order: currentOrder++,
      taskType: 'unknown',
      taskUrl: null,
      status: 'unknown',
      source: 'mooc2-unit'
    })

    const levelHtmlMatch = unitHtml.match(
      /<div[^>]*class=["'][^"']*catalog_level[^"']*["'][\s\S]*$/i
    )
    if (!levelHtmlMatch) continue

    const liMatches = [...levelHtmlMatch[0].matchAll(/<li[\s\S]*?<\/li>/gi)].map((m) => m[0])
    for (let lIdx = 0; lIdx < liMatches.length; lIdx++) {
      const li = liMatches[lIdx]
      const toOldMatch = li.match(/onclick=["']toOld\(([^)]+)\)["']/i)
      const idMatch = li.match(/id=["']cur([0-9]+)["']/i)

      let chapterId = ''
      if (toOldMatch) {
        const parts = toOldMatch[1].split(',').map((s) => s.trim().replace(/['"]/g, ''))
        chapterId = parts[1] || ''
      } else if (idMatch) {
        chapterId = idMatch[1]
      }

      if (!chapterId) continue

      let title = ''
      const clickTitle = li.match(
        /<a[^>]*class=["'][^"']*clicktitle[^"']*["'][^>]*>([\s\S]*?)<\/a>/i
      )
      if (clickTitle) {
        title = clickTitle[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      } else {
        const titleAttr = li.match(/title=["']([^"']+)["']/i)
        title = titleAttr ? titleAttr[1].trim() : `节 ${chapterId}`
      }

      let status: 'completed' | 'in_progress' | 'not_started' | 'unknown' = 'not_started'
      if (
        li.includes('icon_yiwanc') ||
        li.includes('icon_Completed') ||
        li.includes('Completed') ||
        li.includes('已完成')
      ) {
        status = 'completed'
      } else if (li.includes('icon-bukaifang') || li.includes('未开放') || li.includes('Closed')) {
        status = 'not_started'
      } else if (li.includes('icon-jindu') || li.includes('in_progress') || li.includes('catalog_points_bing')) {
        status = 'in_progress'
      } else if (li.includes('catalog_points_yi') || li.includes('catalog_points_no')) {
        status = 'not_started'
      }

      let taskType: 'video' | 'doc' | 'quiz' | 'unknown' = 'video'
      if (
        li.includes('icon-ceshi') ||
        title.includes('测试') ||
        title.includes('作业') ||
        title.includes('测验')
      ) {
        taskType = 'quiz'
      } else if (
        li.includes('icon-wendang') ||
        title.includes('文档') ||
        title.includes('教案') ||
        title.includes('PDF')
      ) {
        taskType = 'doc'
      } else {
        taskType = 'video'
      }

      const taskUrl = `https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=${chapterId}&courseId=${courseId}&clazzid=${clazzId}&cpi=${cpi}&enc=${enc}&mooc2=1`

      chapters.push({
        courseId,
        clazzId,
        chapterId,
        parentId,
        title,
        order: currentOrder++,
        taskType,
        taskUrl,
        status,
        source: 'mooc2-chapter'
      })
    }
  }

  return { ok: true, chapters, enc }
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
  const dataObj = record.data && typeof record.data === 'object' ? (record.data as Record<string, unknown>) : null
  const list = Array.isArray(record.activeList)
    ? (record.activeList as unknown[])
    : Array.isArray(dataObj?.activeList)
      ? (dataObj!.activeList as unknown[])
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
    const category = classifyChaoxingActivityType(activeType)
    const status = num(node.status ?? node.activeStatus ?? 0)
    const startAt = parseTimeOrNull(node.createtime ?? node.startTime ?? node.start_time ?? node.createTime)
    const endAt = parseTimeOrNull(node.endTime ?? node.end_time)
    items.push({
      id,
      title,
      activeType,
      category,
      status,
      courseId: str(node.courseId) || courseId,
      classId: str(node.classId) || classId,
      isSignIn: category === 'sign_in',
      startAt,
      endAt
    })
  }

  return { ok: true, activities: items }
}

import type { SignInEvent, ChapterNode } from '@shared/types'

export interface SessionLike {
  cookies: {
    get: (filter: { domain?: string }) => Promise<Array<{ name: string; value: string }>>
  }
  fetch: (input: any, init?: any) => Promise<any>
}

let cachedCourses: ChaoxingCourse[] = []

/** 探测学习通 Session 登录状态（通过读取 Cookie 及尝试拉取课程） */
export async function detectChaoxingAuth(ses: SessionLike): Promise<{
  state: 'unauthenticated' | 'authenticated' | 'expired' | 'error'
  evidence: string | null
}> {
  try {
    // 获取该会话下的所有 Cookie，不限特定子域，确保 .chaoxing.com 等通配域完整捕获
    const all = await ses.cookies.get({}).catch(() => [])
    const hasAuthCookie = all.some((c) =>
      ['_uid', 'UID', 'vc3', 'k8s', 'fid', 'cx_rt', 'xxtenc'].some((k) =>
        c.name.toLowerCase().includes(k.toLowerCase())
      )
    )
    if (!hasAuthCookie) {
      return { state: 'unauthenticated', evidence: '未在内置浏览器中检测到学习通登录 Cookie' }
    }

    // 已有本地核心 Cookie，尝试在线探测验证
    try {
      // 1. 优先尝试 MOOC2 现代端点
      try {
        const req2 = buildMooc2CourseListRequest()
        const resp2 = await ses.fetch(req2.url, {
          method: req2.method,
          headers: req2.headers,
          body: req2.body
        })
        if (resp2.ok) {
          const html = await resp2.text().catch(() => '')
          const parsed2 = parseMooc2CourseListResponse(html)
          if (parsed2.ok && parsed2.courses.length > 0) {
            cachedCourses = parsed2.courses
            return {
              state: 'authenticated',
              evidence: `已成功认证（MOOC2），读取到 ${parsed2.courses.length} 门在读课程`
            }
          }
        }
      } catch {
        // MOOC2 探测异常，继续尝试 MOOC1
      }

      // 2. 备选尝试 MOOC1 端点
      const req = buildCourseListRequest()
      const resp = await ses.fetch(req.url, { method: req.method, headers: req.headers })
      if (resp.status === 401 || resp.status === 403) {
        return { state: 'expired', evidence: '学习通登录凭证已失效（HTTP 401/403）' }
      }
      const json = (await resp.json().catch(() => null)) as unknown
      const parsed = parseCourseListResponse(json)
      if (parsed.ok && parsed.courses.length > 0) {
        cachedCourses = parsed.courses
        return {
          state: 'authenticated',
          evidence: `已成功认证（MOOC1），读取到 ${parsed.courses.length} 门在读课程`
        }
      }
      if (parsed.error?.includes('AUTH_EXPIRED')) {
        return { state: 'expired', evidence: '学习通登录会话已过期，需要重新登录' }
      }
    } catch {
      // 在线探测网络超时或限流，但由于本地 Cookie 依然有效，保持 authenticated 状态，不掉登录
    }

    return {
      state: 'authenticated',
      evidence: `本地登录凭证有效（Cookie 已持久化，${cachedCourses.length > 0 ? `已缓存 ${cachedCourses.length} 门课程` : '在线数据同步中'}）`
    }
  } catch (e) {
    return { state: 'error', evidence: e instanceof Error ? e.message : String(e) }
  }
}

/** 通过 Session 拉取学习通课程列表（MOOC2 优先 + MOOC1 降级双轨容灾） */
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

  // 1. 优先尝试现代 MOOC2 端点
  let mooc2Failed = false
  try {
    const req2 = buildMooc2CourseListRequest()
    const resp2 = await ses.fetch(req2.url, {
      method: req2.method,
      headers: req2.headers,
      body: req2.body
    })
    if (resp2.ok) {
      const html = await resp2.text().catch(() => '')
      const parsed2 = parseMooc2CourseListResponse(html)
      if (parsed2.ok && parsed2.courses.length > 0) {
        cachedCourses = parsed2.courses
        return { ok: true, state: 'supported', courses: parsed2.courses }
      }
      if (parsed2.error?.includes('AUTH_EXPIRED')) {
        cachedCourses = []
        return { ok: false, state: 'expired', courses: [], error: parsed2.error }
      }
    }
    mooc2Failed = true
  } catch {
    mooc2Failed = true
  }

  // 2. 降级尝试 MOOC1 端点
  try {
    const req1 = buildCourseListRequest()
    const resp1 = await ses.fetch(req1.url, { method: req1.method, headers: req1.headers })
    const json1 = (await resp1.json().catch(() => null)) as unknown
    const parsed1 = parseCourseListResponse(json1)
    if (parsed1.ok && parsed1.courses.length > 0) {
      cachedCourses = parsed1.courses
      return { ok: true, state: 'supported', courses: parsed1.courses }
    }
    if (parsed1.error?.includes('AUTH_EXPIRED')) {
      cachedCourses = []
      return { ok: false, state: 'expired', courses: [], error: parsed1.error }
    }
    if (cachedCourses.length > 0) {
      return { ok: true, state: 'supported', courses: cachedCourses }
    }
    return {
      ok: false,
      state: 'error',
      courses: [],
      error: parsed1.error ?? (mooc2Failed ? 'MOOC2 与 MOOC1 均未获取到课程数据' : '课程列表解析失败')
    }
  } catch (err) {
    if (cachedCourses.length > 0) {
      return { ok: true, state: 'supported', courses: cachedCourses }
    }
    return {
      ok: false,
      state: 'error',
      courses: [],
      error: `网络请求失败: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

/** 通过 Session 拉取课程章节与任务列表 */
export async function fetchChaoxingChapters(
  ses: SessionLike,
  courseId: string,
  clazzId: string,
  cpi = '0'
): Promise<{
  ok: boolean
  chapters: ChapterNode[]
  enc?: string
  error?: string
}> {
  try {
    const req = buildMooc2ChapterListRequest(courseId, clazzId, cpi)
    const resp = await ses.fetch(req.url, { method: req.method, headers: req.headers })
    if (!resp.ok) {
      return { ok: false, chapters: [], error: `HTTP ${resp.status} ${resp.statusText}` }
    }
    const html = await resp.text().catch(() => '')
    return parseMooc2ChapterListResponse(html, courseId, clazzId, cpi)
  } catch (err) {
    return {
      ok: false,
      chapters: [],
      error: `拉取章节网络异常: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

/** 通过 Session 拉取学习通今日签到活动（全量在读课程 + 精准签到类型识别） */
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
  // 覆盖全部在读课程，并包含进行中与未开始/历史活动 (showNotStartedActive=1)
  const targetCourses = courseRes.courses
  await Promise.all(
    targetCourses.map(async (course) => {
      try {
        const reqUrl = CHAOXING_ENDPOINTS.activeList(course.courseId, course.classId, true)
        const resp = await ses.fetch(reqUrl, { method: 'GET' })
        if (!resp.ok) return
        const json = (await resp.json().catch(() => null)) as unknown
        const parsed = parseActiveListResponse(json, course.courseId, course.classId)
        if (!parsed.ok) return

        for (const act of parsed.activities) {
          if (act.isSignIn) {
            let kind: 'normal' | 'location' | 'qr' | 'code' | 'other' = 'normal'
            if (act.title.includes('位置')) kind = 'location'
            else if (act.title.includes('二维码')) kind = 'qr'
            else if (act.title.includes('签到码') || act.title.includes('手势')) kind = 'code'

            const status: 'open' | 'closed' | 'pending' | 'unknown' =
              act.status === 1 ? 'open' : act.status === 2 ? 'closed' : act.status === 0 ? 'pending' : 'unknown'

            events.push({
              id: `cx-${act.id}`,
              platformId: 'chaoxing',
              courseId: course.courseId,
              kind,
              title: `${course.name} · ${act.title}`,
              startAt: act.startAt ?? new Date().toISOString(),
              endAt: act.endAt ?? null,
              sourceUrl: `https://mobilelearn.chaoxing.com/v2/apis/active/getPPTActiveInfo?activeId=${act.id}`,
              fetchedAt: new Date().toISOString(),
              status,
              statusSource: 'provider_api',
              locationText: kind === 'location' ? '需现场定位' : null,
              locationRequired: kind === 'location'
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
    reason: events.length === 0 ? '当前在读课程无进行中的签到活动' : `已同步 ${targetCourses.length} 门在读课程签到记录`
  }
}

