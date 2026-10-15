import { describe, expect, it } from 'vitest'
import {
  buildCourseListRequest,
  parseCourseListResponse,
  buildActiveListRequest,
  parseActiveListResponse
} from '../../src/main/adapters/chaoxing'
import {
  buildYktCourseListRequest,
  parseYktCourseListResponse,
  buildOnLessonRequest,
  parseOnLessonResponse,
  parseWsAppMessage
} from '../../src/main/adapters/yuketang'

describe('ChaoxingAdapter 解析与请求构造', () => {
  it('buildCourseListRequest 返回正确的端点与 headers', () => {
    const req = buildCourseListRequest()
    expect(req.url).toContain('backclazzdata')
    expect(req.method).toBe('GET')
  })

  it('parseCourseListResponse 兼容递归嵌套与多种键名', () => {
    const rawFixture = {
      result: 1,
      channelList: [
        {
          content: {
            course: {
              data: [
                {
                  id: 101,
                  courseid: '2026101',
                  clazzid: '9901',
                  name: '计算机体系结构',
                  cpi: '12345'
                },
                {
                  id: 102,
                  courseId: '2026102',
                  classId: '9902',
                  courseName: '操作系统原理'
                }
              ]
            }
          }
        }
      ]
    }

    const res = parseCourseListResponse(rawFixture)
    expect(res.ok).toBe(true)
    expect(res.courses).toHaveLength(2)
    expect(res.courses[0]).toEqual({
      courseId: '2026101',
      classId: '9901',
      cpi: '12345',
      name: '计算机体系结构'
    })
    expect(res.courses[1]?.name).toBe('操作系统原理')
  })

  it('parseCourseListResponse 遇到未登录响应时正确报告 AUTH_EXPIRED', () => {
    const expiredFixture = {
      result: 0,
      msg: '用户未登录或登录已超时'
    }
    const res = parseCourseListResponse(expiredFixture)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('AUTH_EXPIRED')
  })

  it('parseActiveListResponse 能够正确提取签到活动 (activeType === 2)', () => {
    const req = buildActiveListRequest('c1', 'cl1')
    expect(req.url).toContain('activelist')

    const rawActive = {
      activeList: [
        {
          id: '88801',
          nameOne: '第一周随堂签到',
          activeType: 2,
          status: 1
        },
        {
          id: '88802',
          title: '课堂讨论题',
          activeType: 4,
          status: 1
        }
      ]
    }
    const res = parseActiveListResponse(rawActive, 'c1', 'cl1')
    expect(res.ok).toBe(true)
    expect(res.activities).toHaveLength(2)
    expect(res.activities[0]?.isSignIn).toBe(true)
    expect(res.activities[1]?.isSignIn).toBe(false)
  })
})

describe('YuketangAdapter 解析与请求构造', () => {
  it('buildYktCourseListRequest 与 buildOnLessonRequest 返回正确 URL', () => {
    const req = buildYktCourseListRequest()
    expect(req.url).toContain('/v2/api/web/courses/list')
    const reqOnLesson = buildOnLessonRequest()
    expect(reqOnLesson.url).toContain('/api/v3/classroom/on-lesson-upcoming-exam')
  })

  it('parseYktCourseListResponse 正确提取课程列表', () => {
    const rawFixture = {
      code: 0,
      msg: 'ok',
      data: {
        courses: [
          {
            classroom_id: 601,
            course_name: '分布式计算',
            teacher_name: '张教授',
            cover: 'https://cover.example/img.png'
          }
        ]
      }
    }
    const res = parseYktCourseListResponse(rawFixture)
    expect(res.ok).toBe(true)
    expect(res.courses).toHaveLength(1)
    expect(res.courses[0]).toEqual({
      classroomCourseId: '601',
      courseName: '分布式计算',
      teacherName: '张教授',
      coverUrl: 'https://cover.example/img.png'
    })
  })

  it('parseOnLessonResponse 能够准确解析正在上课状态', () => {
    const activeFixture = {
      code: 0,
      data: {
        on_lesson: true,
        lesson_id: 998877,
        classroom_id: 601,
        course_name: '分布式计算'
      }
    }
    const res = parseOnLessonResponse(activeFixture)
    expect(res.ok).toBe(true)
    expect(res.status.onLesson).toBe(true)
    expect(res.status.lessonId).toBe('998877')
  })

  it('parseWsAppMessage 准确识别已知与未知操作码', () => {
    const unlockMsg = JSON.stringify({ op: 'unlockproblem', data: { problemId: 'p-1' } })
    const res1 = parseWsAppMessage(unlockMsg)
    expect(res1?.op).toBe('unlockproblem')
    expect(res1?.isKnown).toBe(true)

    const unknownMsg = JSON.stringify({ op: 'custom_new_feature_2026', data: {} })
    const res2 = parseWsAppMessage(unknownMsg)
    expect(res2?.op).toBe('custom_new_feature_2026')
    expect(res2?.isKnown).toBe(false)
  })
})

import {
  detectChaoxingAuth,
  fetchChaoxingCourses,
  fetchChaoxingSignIns,
  type SessionLike
} from '../../src/main/adapters/chaoxing'
import {
  detectYuketangAuth,
  fetchYuketangCourses,
  fetchYuketangSignIns
} from '../../src/main/adapters/yuketang'

describe('ChaoxingAdapter 与 YuketangAdapter 会话探测与业务接线', () => {
  it('detectChaoxingAuth 无 Cookie 时返回 unauthenticated', async () => {
    const mockSes: SessionLike = {
      cookies: { get: async () => [] },
      fetch: async () => new Response('{}')
    }
    const res = await detectChaoxingAuth(mockSes)
    expect(res.state).toBe('unauthenticated')
    expect(res.evidence).toContain('未在内置浏览器中检测到')
  })

  it('detectChaoxingAuth 会话过期时返回 expired', async () => {
    const mockSes: SessionLike = {
      cookies: { get: async () => [{ name: '_uid', value: '12345' }] },
      fetch: async () => new Response(JSON.stringify({ result: 0, msg: '登录已超时' }))
    }
    const res = await detectChaoxingAuth(mockSes)
    expect(res.state).toBe('expired')
    expect(res.evidence).toContain('过期')
  })

  it('detectChaoxingAuth 凭证有效时返回 authenticated 并能拉取签到活动', async () => {
    const mockSes: SessionLike = {
      cookies: { get: async () => [{ name: '_uid', value: '12345' }, { name: 'vc3', value: 'token' }] },
      fetch: async (url: string | URL) => {
        const urlStr = String(url)
        if (urlStr.includes('backclazzdata')) {
          return new Response(
            JSON.stringify({
              result: 1,
              channelList: [
                {
                  content: {
                    course: {
                      data: [{ id: 101, courseId: 'c-101', classId: 'cl-101', name: '软件工程' }]
                    }
                  }
                }
              ]
            })
          )
        }
        if (urlStr.includes('activelist')) {
          return new Response(
            JSON.stringify({
              activeList: [
                { id: 'act-901', nameOne: '课堂点名签到', activeType: 2, status: 1 }
              ]
            })
          )
        }
        return new Response('{}')
      }
    }
    const auth = await detectChaoxingAuth(mockSes)
    expect(auth.state).toBe('authenticated')
    expect(auth.evidence).toContain('1 门在读课程')

    const courses = await fetchChaoxingCourses(mockSes)
    expect(courses.ok).toBe(true)
    expect(courses.courses).toHaveLength(1)

    const signins = await fetchChaoxingSignIns(mockSes)
    expect(signins.state).toBe('supported')
    expect(signins.events).toHaveLength(1)
    expect(signins.events[0]?.title).toBe('软件工程 · 课堂点名签到')
    expect(signins.events[0]?.platformId).toBe('chaoxing')
  })

  it('detectYuketangAuth 无 Cookie 时返回 unauthenticated', async () => {
    const mockSes: SessionLike = {
      cookies: { get: async () => [] },
      fetch: async () => new Response('{}')
    }
    const res = await detectYuketangAuth(mockSes)
    expect(res.state).toBe('unauthenticated')
  })

  it('detectYuketangAuth 探测在课状态有效时返回 authenticated 并生成签到事件', async () => {
    const mockSes: SessionLike = {
      cookies: { get: async () => [{ name: 'sessionid', value: 'mock_sess' }] },
      fetch: async (url: string | URL) => {
        const urlStr = String(url)
        if (urlStr.includes('on-lesson-upcoming-exam')) {
          return new Response(
            JSON.stringify({
              code: 0,
              data: {
                on_lesson: true,
                lesson_id: 887766,
                classroom_id: 301,
                course_name: '高级计算机体系结构'
              }
            })
          )
        }
        if (urlStr.includes('courses/list')) {
          return new Response(
            JSON.stringify({
              code: 0,
              data: {
                courses: [{ classroom_id: 301, course_name: '高级计算机体系结构', teacher_name: '李老师', cover: null }]
              }
            })
          )
        }
        return new Response('{}')
      }
    }
    const auth = await detectYuketangAuth(mockSes)
    expect(auth.state).toBe('authenticated')

    const courses = await fetchYuketangCourses(mockSes)
    expect(courses.ok).toBe(true)
    expect(courses.courses).toHaveLength(1)

    const signins = await fetchYuketangSignIns(mockSes)
    expect(signins.state).toBe('supported')
    expect(signins.events).toHaveLength(1)
    expect(signins.events[0]?.id).toBe('ykt-887766')
    expect(signins.events[0]?.title).toContain('高级计算机体系结构 · 正在上课')
  })
})

