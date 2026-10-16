import { describe, expect, it } from 'vitest'
import {
  buildCourseListRequest,
  parseCourseListResponse,
  buildMooc2CourseListRequest,
  parseMooc2CourseListResponse,
  buildMooc2ChapterListRequest,
  parseMooc2ChapterListResponse,
  fetchChaoxingChapters,
  buildActiveListRequest,
  parseActiveListResponse,
  classifyChaoxingActivityType
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
          status: 1,
          createtime: 1760000000000,
          endTime: 1760003600000
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
    expect(res.activities[0]?.category).toBe('sign_in')
    expect(res.activities[0]?.startAt).toBeTruthy()
    expect(res.activities[0]?.endAt).toBeTruthy()
    expect(res.activities[1]?.isSignIn).toBe(false)
    expect(res.activities[1]?.category).toBe('other')
  })

  it('classifyChaoxingActivityType 精准区分类别（严格排除问卷、通知、作业作为签到）', () => {
    expect(classifyChaoxingActivityType(2)).toBe('sign_in')
    expect(classifyChaoxingActivityType(14)).toBe('questionnaire')
    expect(classifyChaoxingActivityType(11)).toBe('rollcall')
    expect(classifyChaoxingActivityType(42)).toBe('exercise')
    expect(classifyChaoxingActivityType(45)).toBe('notice')
    expect(classifyChaoxingActivityType(77)).toBe('task')
    expect(classifyChaoxingActivityType(35)).toBe('group')
    expect(classifyChaoxingActivityType(999)).toBe('other')
  })

  it('buildMooc2CourseListRequest 返回正确的端点、请求体与 headers', () => {
    const req = buildMooc2CourseListRequest()
    expect(req.url).toContain('/mooc2-ans/visit/courselistdata')
    expect(req.method).toBe('POST')
    expect(req.headers['Content-Type']).toContain('application/x-www-form-urlencoded')
    expect(req.body).toContain('courseType=1')
  })

  it('parseMooc2CourseListResponse 准确解析 MOOC2 HTML 片段中的课程信息', () => {
    const htmlFixture = `
      <div class="course clearfix learnCourse">
        <input type="hidden" class="courseId" value="268029278" />
        <input type="hidden" class="clazzId" value="157089353" />
        <input type="hidden" class="curPersonId" value="123456" />
        <div class="course-cover">
          <a href="https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=268029278&amp;clazzid=157089353&amp;cpi=123456&amp;ismooc2=1">
            <img src="https://p.ananas.chaoxing.com/star3/origin/cover.png" />
          </a>
        </div>
        <div class="course-info">
          <span class="course-name" title="马克思主义基本原理">马克思主义基本原理</span>
          <p class="color2" title="张教授">张教授</p>
          <p class="color3" title="2025春季班">2025春季班</p>
        </div>
      </div>
      <div class="course clearfix learnCourse">
        <input type="hidden" class="courseId" value="265867291" />
        <input type="hidden" class="clazzId" value="151361493" />
        <input type="hidden" class="curPersonId" value="123456" />
        <div class="course-info">
          <span class="course-name" title="学术英语交流">学术英语交流</span>
        </div>
      </div>
    `
    const res = parseMooc2CourseListResponse(htmlFixture)
    expect(res.ok).toBe(true)
    expect(res.courses).toHaveLength(2)
    expect(res.courses[0]).toEqual({
      courseId: '268029278',
      classId: '157089353',
      cpi: '123456',
      name: '马克思主义基本原理',
      teacherName: '张教授',
      clazzName: '2025春季班',
      courseUrl: 'https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=268029278&clazzid=157089353&cpi=123456&ismooc2=1',
      coverUrl: 'https://p.ananas.chaoxing.com/star3/origin/cover.png'
    })
    expect(res.courses[1]?.name).toBe('学术英语交流')
    expect(res.courses[1]?.courseId).toBe('265867291')
  })

  it('parseMooc2CourseListResponse 权威核验四门易混淆课程：准确映射 ID、班级与课程名称', () => {
    const fixture = `
      <div class="course clearfix learnCourse">
        <input type="hidden" class="courseId" value="235923072" />
        <input type="hidden" class="clazzId" value="79717594" />
        <input type="hidden" class="curPersonId" value="486109891" />
        <div class="course-info">
          <span class="course-name" title="本科生入馆教育之走进图书馆">本科生入馆教育之走进图书馆</span>
          <p class="color2" title="图书馆">图书馆</p>
        </div>
      </div>
      <div class="course clearfix learnCourse">
        <input type="hidden" class="courseId" value="256533729" />
        <input type="hidden" class="clazzId" value="130678886" />
        <input type="hidden" class="curPersonId" value="490827278" />
        <div class="course-info">
          <span class="course-name" title="程序设计基础2025">程序设计基础2025</span>
          <p class="color2" title="冯子亮">冯子亮</p>
        </div>
      </div>
      <div class="course clearfix learnCourse">
        <input type="hidden" class="courseId" value="255556164" />
        <input type="hidden" class="clazzId" value="128300469" />
        <input type="hidden" class="curPersonId" value="490827278" />
        <div class="course-info">
          <span class="course-name" title="军事理论-2025年秋">军事理论-2025年秋</span>
          <p class="color2" title="周凤">周凤</p>
        </div>
      </div>
      <div class="course clearfix learnCourse">
        <input type="hidden" class="courseId" value="258206267" />
        <input type="hidden" class="clazzId" value="134433014" />
        <input type="hidden" class="curPersonId" value="490827278" />
        <div class="course-info">
          <span class="course-name" title="2025-2026大学生心理健康53">2025-2026大学生心理健康53</span>
          <p class="color2" title="青思含">青思含</p>
        </div>
      </div>
    `
    const res = parseMooc2CourseListResponse(fixture)
    expect(res.ok).toBe(true)
    expect(res.courses).toHaveLength(4)

    const c1 = res.courses.find((c) => c.courseId === '235923072')!
    expect(c1.name).toBe('本科生入馆教育之走进图书馆')
    expect(c1.classId).toBe('79717594')
    expect(c1.name).not.toBe('思想道德与法治')

    const c2 = res.courses.find((c) => c.courseId === '256533729')!
    expect(c2.name).toBe('程序设计基础2025')
    expect(c2.classId).toBe('130678886')
    expect(c2.name).not.toBe('大学生心理健康')

    const c3 = res.courses.find((c) => c.courseId === '255556164')!
    expect(c3.name).toBe('军事理论-2025年秋')
    expect(c3.classId).toBe('128300469')
    expect(c3.classId).not.toBe('132646271')

    const c4 = res.courses.find((c) => c.courseId === '258206267')!
    expect(c4.name).toBe('2025-2026大学生心理健康53')
    expect(c4.classId).toBe('134433014')
  })

  it('parseMooc2CourseListResponse 遇到会话过期提示时报告 AUTH_EXPIRED', () => {
    const expiredHtml = '<div><script>location.href="https://passport2.chaoxing.com/login"</script></div>'
    const res = parseMooc2CourseListResponse(expiredHtml)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('AUTH_EXPIRED')
  })

  it('parseMooc2CourseListResponse 遇到空输入时报告 INVALID_HTML', () => {
    const res = parseMooc2CourseListResponse('')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('INVALID_HTML')
  })

  it('buildMooc2ChapterListRequest 返回正确的端点与 headers', () => {
    const req = buildMooc2ChapterListRequest('255556164', '140001', '999')
    expect(req.url).toContain('/mooc2-ans/mycourse/studentcourse')
    expect(req.url).toContain('courseid=255556164')
    expect(req.url).toContain('clazzid=140001')
    expect(req.url).toContain('cpi=999')
    expect(req.method).toBe('GET')
    expect(req.headers['X-Requested-With']).toBe('XMLHttpRequest')
  })

  it('parseMooc2ChapterListResponse 准确解析大单元（章）、节（任务点）、任务类型与完成状态', () => {
    const html = `
      <input type="hidden" id="enc" value="62f8373b9e4a3" />
      <div class="chapter_unit">
        <div class="catalog_title chapter_Thats_bnt">
          <a class="clicktitle" href="javascript:void(0);">第一单元 军事科学概论</a>
        </div>
        <div class="catalog_level">
          <ul>
            <li id="cur101" onclick="toOld('101', '101')">
              <a class="clicktitle" href="javascript:void(0);">1.1 军事科学的定义与研究对象</a>
              <i class="icon_yiwanc"></i>
            </li>
            <li id="cur102" onclick="toOld('102', '102')">
              <a class="clicktitle" href="javascript:void(0);">1.2 单元测验</a>
              <i class="icon-ceshi"></i>
            </li>
            <li id="cur103" onclick="toOld('103', '103')">
              <a class="clicktitle" href="javascript:void(0);">1.3 拓展阅读文档</a>
              <i class="icon-wendang"></i>
            </li>
          </ul>
        </div>
      </div>
    `
    const res = parseMooc2ChapterListResponse(html, '255556164', '140001', '999')
    expect(res.ok).toBe(true)
    expect(res.enc).toBe('62f8373b9e4a3')
    expect(res.chapters).toHaveLength(4)

    // 一级单元
    const unit = res.chapters[0]!
    expect(unit.title).toBe('第一单元 军事科学概论')
    expect(unit.parentId).toBeNull()
    expect(unit.order).toBe(1)
    expect(unit.taskType).toBe('unknown')

    // 视频任务点
    const t1 = res.chapters[1]!
    expect(t1.title).toBe('1.1 军事科学的定义与研究对象')
    expect(t1.parentId).toBe(unit.chapterId)
    expect(t1.chapterId).toBe('101')
    expect(t1.status).toBe('completed')
    expect(t1.taskType).toBe('video')
    expect(t1.taskUrl).toContain('chapterId=101')
    expect(t1.taskUrl).toContain('courseId=255556164')
    expect(t1.taskUrl).toContain('clazzid=140001')
    expect(t1.taskUrl).toContain('enc=62f8373b9e4a3')

    // 测验
    const t2 = res.chapters[2]!
    expect(t2.title).toBe('1.2 单元测验')
    expect(t2.taskType).toBe('quiz')
    expect(t2.status).toBe('not_started')

    // 文档
    const t3 = res.chapters[3]!
    expect(t3.title).toBe('1.3 拓展阅读文档')
    expect(t3.taskType).toBe('doc')
    expect(t3.status).toBe('not_started')
  })

  it('parseMooc2ChapterListResponse 遇到 nodata 或空页面时返回空数组', () => {
    const nodataHtml = '<div><p class="nodata">No chapter content available</p></div>'
    const res = parseMooc2ChapterListResponse(nodataHtml, '265867291', '151361493')
    expect(res.ok).toBe(true)
    expect(res.chapters).toHaveLength(0)
  })

  it('parseMooc2ChapterListResponse 遇到样式表中包含 .nodata 类名但不为空时能正常解析章节', () => {
    const htmlWithStyle = `
      <style>.nodata { text-align: center; }</style>
      <input type="hidden" id="enc" value="abc123enc" />
      <div class="chapter_unit">
        <div class="catalog_title chapter_Thats_bnt">
          <a class="clicktitle" href="javascript:void(0);">第一单元</a>
        </div>
        <div class="catalog_level">
          <ul>
            <li id="cur999" onclick="toOld('999', '999')">
              <a class="clicktitle" href="javascript:void(0);">1.1 视频导学</a>
            </li>
          </ul>
        </div>
      </div>
    `
    const res = parseMooc2ChapterListResponse(htmlWithStyle, '258206267', '134433014')
    expect(res.ok).toBe(true)
    expect(res.chapters.length).toBeGreaterThan(0)
    expect(res.enc).toBe('abc123enc')
  })

  it('parseMooc2ChapterListResponse 遇到防爬验证码页面时报告 ANTISPIDER_VERIFY', () => {
    const verifyHtml = '<div>【9010】操作异常，请输入图片中的验证码 <form action="/html/processVerify.ac"></form></div>'
    const res = parseMooc2ChapterListResponse(verifyHtml, '255556164', '140001')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('ANTISPIDER_VERIFY')
  })

  it('parseMooc2ChapterListResponse 遇到会话过期提示时报告 AUTH_EXPIRED', () => {
    const expiredHtml = '<div><script>location.href="https://passport2.chaoxing.com/login"</script></div>'
    const res = parseMooc2ChapterListResponse(expiredHtml, '255556164', '140001')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('AUTH_EXPIRED')
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

  it('fetchChaoxingCourses 双轨容灾：MOOC2 优先成功时直接返回，MOOC2 失败时自动降级至 MOOC1', async () => {
    // 场景 A: MOOC2 成功
    const mooc2Html = `
      <div class="course clearfix learnCourse">
        <input type="hidden" class="courseId" value="20001" />
        <input type="hidden" class="clazzId" value="30001" />
        <div class="course-info">
          <span class="course-name" title="现代控制理论">现代控制理论</span>
        </div>
      </div>
    `
    const mockSesMooc2: SessionLike = {
      cookies: { get: async () => [{ name: '_uid', value: '123' }, { name: 'vc3', value: 'tok' }] },
      fetch: async (url: string | URL) => {
        const urlStr = String(url)
        if (urlStr.includes('courselistdata')) {
          return new Response(mooc2Html)
        }
        return new Response('{}')
      }
    }
    const resA = await fetchChaoxingCourses(mockSesMooc2)
    expect(resA.ok).toBe(true)
    expect(resA.courses).toHaveLength(1)
    expect(resA.courses[0]?.name).toBe('现代控制理论')
    expect(resA.courses[0]?.courseId).toBe('20001')

    // 场景 B: MOOC2 抛出网络异常，自动降级至 MOOC1 (backclazzdata)
    const mockSesFallback: SessionLike = {
      cookies: { get: async () => [{ name: '_uid', value: '123' }, { name: 'vc3', value: 'tok' }] },
      fetch: async (url: string | URL) => {
        const urlStr = String(url)
        if (urlStr.includes('courselistdata')) {
          throw new Error('MOOC2 网络超时')
        }
        if (urlStr.includes('backclazzdata')) {
          return new Response(
            JSON.stringify({
              result: 1,
              channelList: [
                {
                  content: {
                    course: {
                      data: [{ id: 99, courseId: '10002', classId: '20002', name: '降级-数字信号处理' }]
                    }
                  }
                }
              ]
            })
          )
        }
        return new Response('{}')
      }
    }
    const resB = await fetchChaoxingCourses(mockSesFallback)
    expect(resB.ok).toBe(true)
    expect(resB.courses).toHaveLength(1)
    expect(resB.courses[0]?.name).toBe('降级-数字信号处理')
    expect(resB.courses[0]?.courseId).toBe('10002')
  })

  it('fetchChaoxingChapters 通过 SessionLike 拉取真实章节目录并完成结构化映射', async () => {
    const chapterHtml = `
      <input type="hidden" id="enc" value="abc123enc" />
      <div class="chapter_unit">
        <div class="catalog_title chapter_Thats_bnt">
          <a class="clicktitle">第一章 自动化控制</a>
        </div>
        <div class="catalog_level">
          <ul>
            <li id="cur501" onclick="toOld('501', '501')">
              <a class="clicktitle">1.1 闭环控制系统理论</a>
              <i class="icon_yiwanc"></i>
            </li>
          </ul>
        </div>
      </div>
    `
    const mockSes: SessionLike = {
      cookies: { get: async () => [{ name: '_uid', value: '123' }] },
      fetch: async (url: string | URL) => {
        expect(String(url)).toContain('/mooc2-ans/mycourse/studentcourse')
        return new Response(chapterHtml)
      }
    }
    const res = await fetchChaoxingChapters(mockSes, 'c101', 'cl202', '999')
    expect(res.ok).toBe(true)
    expect(res.enc).toBe('abc123enc')
    expect(res.chapters).toHaveLength(2)
    expect(res.chapters[0]?.title).toBe('第一章 自动化控制')
    expect(res.chapters[1]?.title).toBe('1.1 闭环控制系统理论')
    expect(res.chapters[1]?.status).toBe('completed')
    expect(res.chapters[1]?.taskUrl).toContain('chapterId=501')
  })

  it('fetchChaoxingSignIns 全量在读课程中准确分类位置签到、二维码与普通签到', async () => {
    const mockSes: SessionLike = {
      cookies: { get: async () => [{ name: '_uid', value: '123' }, { name: 'vc3', value: 'tok' }] },
      fetch: async (url: string | URL) => {
        const urlStr = String(url)
        if (urlStr.includes('courselistdata')) {
          return new Response(`
            <div class="course clearfix learnCourse">
              <input type="hidden" class="courseId" value="101" />
              <input type="hidden" class="clazzId" value="201" />
              <div class="course-info"><span class="course-name" title="计算机网络">计算机网络</span></div>
            </div>
          `)
        }
        if (urlStr.includes('activelist') || urlStr.includes('active/getPPTActiveList')) {
          expect(urlStr).toContain('showNotStartedActive=1')
          return new Response(
            JSON.stringify({
              result: 1,
              data: {
                activeList: [
                  { id: '1001', nameOne: '现场位置签到', activeType: 2, status: 1 },
                  { id: '1002', nameOne: '课前二维码签到', activeType: 2, status: 2 },
                  { id: '1003', nameOne: '课堂普通签到', activeType: 2, status: 1 }
                ]
              }
            })
          )
        }
        return new Response('{}')
      }
    }
    const res = await fetchChaoxingSignIns(mockSes)
    expect(res.state).toBe('supported')
    expect(res.events).toHaveLength(3)

    const loc = res.events.find((e) => e.id === 'cx-1001')!
    expect(loc.kind).toBe('location')
    expect(loc.locationRequired).toBe(true)
    expect(loc.status).toBe('open')

    const qr = res.events.find((e) => e.id === 'cx-1002')!
    expect(qr.kind).toBe('qr')
    expect(qr.status).toBe('closed')

    const normal = res.events.find((e) => e.id === 'cx-1003')!
    expect(normal.kind).toBe('normal')
    expect(normal.locationRequired).toBe(false)
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

