import { _electron as electron } from 'playwright'

async function run() {
  console.log('====================================================')
  console.log('   CourseHub 课堂活动真实状态审计 (阶段一)')
  console.log('====================================================')

  const app = await electron.launch({
    args: ['.'],
    timeout: 30000
  })

  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')

    // 1. 获取学习通课程及活动列表
    const cxCourses = await win.evaluate(async () => {
      return window.coursehub.platform.courses('chaoxing')
    })
    const cxActs = await win.evaluate(async () => {
      return window.coursehub.classroom.activities('chaoxing')
    })

    console.log(`\n[学习通] 课程数: ${cxCourses.data?.courses?.length}, 课堂活动总数: ${cxActs.data?.activities?.length}`)
    const cxList = cxActs.data?.activities || []

    const now = Date.now()
    const cxDetailed = cxList.map((a, i) => {
      const isPast = a.endAt ? new Date(a.endAt).getTime() < now : false
      const year = a.startAt ? a.startAt.slice(0, 4) : 'unknown'
      return {
        idx: i + 1,
        id: a.id,
        courseId: a.courseId,
        courseName: a.courseName,
        title: a.title,
        category: a.category,
        status: a.status,
        startAt: a.startAt,
        endAt: a.endAt,
        isPast,
        year
      }
    })

    // 分类统计
    const cxCatCount = {}
    const cxStatusCount = {}
    const cxYearCount = {}
    let cxOpenCount = 0
    let cxClosedCount = 0
    let cxPastCount = 0

    for (const a of cxDetailed) {
      cxCatCount[a.category] = (cxCatCount[a.category] || 0) + 1
      cxStatusCount[a.status] = (cxStatusCount[a.status] || 0) + 1
      cxYearCount[a.year] = (cxYearCount[a.year] || 0) + 1
      if (a.status === 'open') cxOpenCount++
      if (a.status === 'closed') cxClosedCount++
      if (a.isPast) cxPastCount++
    }

    console.log('--- 学习通活动分类统计 ---')
    console.log('类别分布:', cxCatCount)
    console.log('状态分布:', cxStatusCount)
    console.log('发布年份分布:', cxYearCount)
    console.log(`已结束(closed): ${cxClosedCount}, 进行中(open): ${cxOpenCount}, 时间已过(isPast): ${cxPastCount}`)

    console.log('\n--- 学习通活动抽样检查（前 10 项） ---')
    console.log(JSON.stringify(cxDetailed.slice(0, 10), null, 2))

    // 检查是否有任何一项 status 为 open
    const cxOpenList = cxDetailed.filter(a => a.status === 'open')
    console.log(`\n学习通当前真正处于 open 状态的活动数量: ${cxOpenList.length}`)
    if (cxOpenList.length > 0) {
      console.log('Open 活动详情:', JSON.stringify(cxOpenList, null, 2))
    }

    // 2. 获取雨课堂课程及活动列表
    const yktCourses = await win.evaluate(async () => {
      return window.coursehub.platform.courses('yuketang')
    })
    const yktActs = await win.evaluate(async () => {
      return window.coursehub.classroom.activities('yuketang')
    })

    console.log(`\n[雨课堂] 课程数: ${yktCourses.data?.courses?.length}, 课堂活动总数: ${yktActs.data?.activities?.length}`)
    const yktList = yktActs.data?.activities || []

    const yktDetailed = yktList.map((a, i) => {
      const isPast = a.endAt ? new Date(a.endAt).getTime() < now : false
      const year = a.startAt ? a.startAt.slice(0, 4) : 'unknown'
      return {
        idx: i + 1,
        id: a.id,
        courseId: a.courseId,
        courseName: a.courseName,
        title: a.title,
        category: a.category,
        status: a.status,
        startAt: a.startAt,
        endAt: a.endAt,
        isPast,
        year
      }
    })

    console.log(`\n====================================================`)
    console.log(`学习通全量 41 项活动只读审计明细：`)
    console.log(`====================================================`)
    cxDetailed.forEach((a) => {
      console.log(`${a.idx}. [${a.id}] 课程: ${a.courseName} (${a.courseId}) | 标题: ${a.title} | 类别: ${a.category} | 平台状态: ${a.status} | 开始: ${a.startAt || '无'} | 截止: ${a.endAt || '无'} | 已过截止: ${a.isPast} | 年份: ${a.year}`)
    })

    console.log(`\n====================================================`)
    console.log(`雨课堂全量 4 项作业只读审计明细：`)
    console.log(`====================================================`)
    yktDetailed.forEach((a) => {
      console.log(`${a.idx}. [${a.id}] 课程: ${a.courseName} (${a.courseId}) | 标题: ${a.title} | 类别: ${a.category} | 平台状态: ${a.status} | 发布: ${a.startAt || '无'} | 截止: ${a.endAt || '无'} | 已过截止: ${a.isPast} | 年份: ${a.year}`)
    })
  } finally {
    await app.close().catch(() => {})
  }
}

run().catch(console.error)
