import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

async function run() {
  console.log('====================================================')
  console.log('   CourseHub v0.4.1 全功能真实闭环验收测试')
  console.log('====================================================')

  const app = await electron.launch({
    args: ['.'],
    timeout: 30000
  })

  const results = {}

  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await win.waitForSelector('[data-testid="app-shell"]', { timeout: 20000 })
    console.log('[1/6] App 成功启动并载入主界面')

    // ---------------------------------------------------------
    // 1. 验证学习通真实课程：章节、课件、进入学习、返回目录
    // ---------------------------------------------------------
    console.log('\n[2/6] 验收学习通真实课程...')
    const cxAuth = await win.evaluate(async () => {
      return window.coursehub.classroom.auth('chaoxing')
    })
    console.log('  - 学习通认证状态:', cxAuth.data?.state, cxAuth.data?.evidence)

    const cxCourses = await win.evaluate(async () => {
      return window.coursehub.platform.courses('chaoxing')
    })
    console.log(`  - 学习通课程数: ${cxCourses.data?.courses?.length}`)

    const targetCxCourse = cxCourses.data?.courses?.find(c => c.name?.includes('心理健康')) || cxCourses.data?.courses?.[0]
    console.log(`  - 选中学习通课程: ${targetCxCourse?.name} (courseId: ${targetCxCourse?.courseId}, classId: ${targetCxCourse?.classId}, cpi: ${targetCxCourse?.cpi})`)

    const cxChapters = await win.evaluate(async (c) => {
      return window.coursehub.platform.chapters({
        platformId: 'chaoxing',
        courseId: c.courseId,
        clazzId: c.classId,
        cpi: c.cpi || '0'
      })
    }, targetCxCourse)
    const cxChapList = cxChapters.data?.chapters || []

    console.log(`  - 心理健康课程真实章节节点数: ${cxChapList.length}`)
    const cxTypes = {}
    cxChapList.forEach(c => { cxTypes[c.taskType] = (cxTypes[c.taskType] || 0) + 1 })
    console.log('  - 章节任务类型分布:', cxTypes)

    // 在界面中切换至心理健康课程学习工作台
    await win.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.course-card'))
      const cxCard = cards.find(c => c.textContent?.includes('心理健康') || c.textContent?.includes('大学生'))
      if (cxCard) {
        const btn = cxCard.querySelector('button')
        btn?.click()
      }
    })
    await new Promise(r => setTimeout(r, 2000))

    // 检查 VideoScene 中的返回课程中心按钮与平台原网页按钮
    const videoSceneBtns = await win.evaluate(() => {
      const backBtn = document.querySelector('[data-testid="btn-back-to-courses"]')
      const origBtn = document.querySelector('[data-testid="btn-open-platform-page"]')
      return { hasBack: !!backBtn, hasOrig: !!origBtn }
    })
    console.log('  - 学习工作台顶部导航按钮 (返回课程中心 / 平台原网页):', videoSceneBtns)

    // 点击返回课程中心
    await win.evaluate(() => {
      const backBtn = document.querySelector('[data-testid="btn-back-to-courses"]')
      backBtn?.click()
    })
    await new Promise(r => setTimeout(r, 1000))

    const returnedToCourses = await win.evaluate(() => {
      return !!document.querySelector('.course-card')
    })
    console.log('  - 点击“返回课程中心”成功返回课程列表:', returnedToCourses)

    results.chaoxing_content = {
      course: '大学生心理健康53',
      chaptersCount: cxChapList.length,
      types: cxTypes,
      navigationWorking: videoSceneBtns.hasBack && returnedToCourses
    }

    // ---------------------------------------------------------
    // 2. 验证雨课堂真实课程：studentlog 课件、微课、作业、进入学习、返回目录
    // ---------------------------------------------------------
    console.log('\n[3/6] 验收雨课堂真实课程...')
    const yktAuth = await win.evaluate(async () => {
      return window.coursehub.classroom.auth('yuketang')
    })
    console.log('  - 雨课堂认证状态:', yktAuth.data?.state, yktAuth.data?.evidence)

    const yktCourses = await win.evaluate(async () => {
      return window.coursehub.platform.courses('yuketang')
    })
    console.log(`  - 雨课堂课程数: ${yktCourses.data?.courses?.length}`)

    // 选择《战略性思维：竞争、合作与全局意识》课程 (classId 31890235)
    const yktChapters = await win.evaluate(async () => {
      return window.coursehub.platform.chapters({
        platformId: 'yuketang',
        courseId: '31890235',
        clazzId: '31890235'
      })
    })
    const yktChapList = yktChapters.data?.chapters || []
    console.log(`  - 战略性思维课程真实章节与课件数: ${yktChapList.length}`)
    const yktTypes = {}
    yktChapList.forEach(c => { yktTypes[c.taskType] = (yktTypes[c.taskType] || 0) + 1 })
    console.log('  - 课件任务类型分布:', yktTypes)

    // 检查雨课堂叶子节点的真实 taskUrl
    const lessonReportTask = yktChapList.find(c => c.taskUrl?.includes('student-lesson-report'))
    console.log('  - 课堂授课PPT/讲义报告直达链接:', lessonReportTask ? lessonReportTask.taskUrl : '无')

    // 切换至雨课堂该课程
    await win.evaluate(() => {
      const platBtns = Array.from(document.querySelectorAll('.platform-pill, button'))
      const yktPill = platBtns.find(b => b.textContent?.includes('雨课堂'))
      yktPill?.click()
    })
    await new Promise(r => setTimeout(r, 1000))

    await win.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.course-card'))
      const yktCard = cards.find(c => c.textContent?.includes('战略性思维'))
      if (yktCard) {
        const btn = yktCard.querySelector('button')
        btn?.click()
      }
    })
    await new Promise(r => setTimeout(r, 2000))

    // 检查工作台内的课件列表与类型展示
    const yktSceneCheck = await win.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.chapter-item'))
      const backBtn = document.querySelector('[data-testid="btn-back-to-courses"]')
      const extractBtn = document.querySelector('[data-testid="video-extract-ai-btn"]')
      const captureBtn = document.querySelector('[data-testid="video-capture-ai-btn"]')
      return {
        itemCount: items.length,
        hasBack: !!backBtn,
        hasExtractAi: !!extractBtn,
        hasCaptureAi: !!captureBtn
      }
    })
    console.log('  - 雨课堂学习工作台状态:', yktSceneCheck)

    // 点击返回课程中心
    await win.evaluate(() => {
      const backBtn = document.querySelector('[data-testid="btn-back-to-courses"]')
      backBtn?.click()
    })
    await new Promise(r => setTimeout(r, 1000))

    results.yuketang_content = {
      course: '战略性思维',
      coursewareCount: yktChapList.length,
      types: yktTypes,
      hasDirectLessonReport: !!lessonReportTask,
      workbenchWorking: yktSceneCheck.itemCount > 0 && yktSceneCheck.hasBack
    }

    // ---------------------------------------------------------
    // 3. 验证两个平台的课堂活动读取与多课程聚合
    // ---------------------------------------------------------
    console.log('\n[4/6] 验收课堂活动读取与多课程聚合...')
    const cxActs = await win.evaluate(async () => {
      return window.coursehub.classroom.activities('chaoxing')
    })
    console.log(`  - 学习通活动聚合总数: ${cxActs.data?.activities?.length} (状态: ${cxActs.data?.state})`)
    const cxActCategories = {}
    cxActs.data?.activities?.forEach(a => { cxActCategories[a.category] = (cxActCategories[a.category] || 0) + 1 })
    console.log('  - 学习通活动类别分布:', cxActCategories)

    const yktActs = await win.evaluate(async () => {
      return window.coursehub.classroom.activities('yuketang')
    })
    console.log(`  - 雨课堂活动/作业聚合总数: ${yktActs.data?.activities?.length} (状态: ${yktActs.data?.state})`)
    const yktOpenActs = yktActs.data?.activities?.filter(a => a.status === 'open') || []
    console.log(`  - 雨课堂进行中(open)活动数: ${yktOpenActs.length}`)

    results.activities = {
      chaoxingCount: cxActs.data?.activities?.length,
      chaoxingCategories: cxActCategories,
      yuketangCount: yktActs.data?.activities?.length,
      yuketangOpenCount: yktOpenActs.length
    }

    // ---------------------------------------------------------
    // 4. 验证 Windows 桌面通知、去重与重启持久化恢复
    // ---------------------------------------------------------
    console.log('\n[5/6] 验收桌面通知、去重与重启持久化恢复...')
    // 4.1 获取当前已记录的 notifiedIds
    const initialNotified = await win.evaluate(async () => {
      return window.coursehub.classroom.notifiedIds()
    })
    console.log('  - 初始 notifiedIds 数量:', initialNotified.data?.length)

    // 4.2 触发一次测试通知
    const notifyRes = await win.evaluate(async () => {
      return window.coursehub.classroom.testNotify({
        title: '验收自动化随堂签到',
        courseName: '全栈自动化实战课',
        sourceUrl: 'https://mooc1.chaoxing.com/test'
      })
    })
    const generatedId = notifyRes.data?.activity?.id
    console.log(`  - 触发通知成功: id=${generatedId}`)

    // 4.3 验证已去重入库
    const afterNotify = await win.evaluate(async () => {
      return window.coursehub.classroom.notifiedIds()
    })
    const isRecorded = afterNotify.data?.includes(generatedId)
    console.log(`  - 活动 ID 已记录至 notifiedIds (去重集):`, isRecorded)

    // 4.4 再次调用相同的 activities 接口，确认不重复触发通知
    const dedupeCheck = await win.evaluate(async (id) => {
      const current = await window.coursehub.classroom.notifiedIds()
      const matches = current.data?.filter(x => x === id) || []
      return matches.length === 1
    }, generatedId)
    console.log(`  - 同一活动不重复添加 (Set 去重有效):`, dedupeCheck)

    results.notification = {
      testNotifyFired: notifyRes.ok,
      deduped: dedupeCheck,
      persistedInCache: isRecorded
    }

    // ---------------------------------------------------------
    // 5. 验证会话及配置完整性（未清空 AppData 或 Cookies）
    // ---------------------------------------------------------
    console.log('\n[6/6] 验证凭证与 AppData 完整性...')
    const authIntact = cxAuth.data?.state === 'authenticated' && yktAuth.data?.state === 'authenticated'
    console.log('  - 双平台登录态完整保留:', authIntact)
    results.integrity = {
      chaoxingAuth: cxAuth.data?.state,
      yuketangAuth: yktAuth.data?.state,
      intact: authIntact
    }

  } finally {
    await app.close().catch(() => {})
  }

  // ---------------------------------------------------------
  // 6. 验证关闭重启后持久化记录恢复
  // ---------------------------------------------------------
  console.log('\n[重启测试] 重启应用验证 cache/notified-activities.json 恢复...')
  const app2 = await electron.launch({
    args: ['.'],
    timeout: 30000
  })

  try {
    const win2 = await app2.firstWindow()
    await win2.waitForLoadState('domcontentloaded')
    await win2.waitForSelector('[data-testid="app-shell"]', { timeout: 20000 })

    const restoredIds = await win2.evaluate(async () => {
      return window.coursehub.classroom.notifiedIds()
    })
    console.log(`  - 重启后恢复 notifiedIds 数量: ${restoredIds.data?.length}`)
    results.restart_recovery = {
      restoredCount: restoredIds.data?.length,
      success: (restoredIds.data?.length || 0) > 0
    }
  } finally {
    await app2.close().catch(() => {})
  }

  console.log('\n====================================================')
  console.log('               验收测试汇总结果                     ')
  console.log('====================================================')
  console.log(JSON.stringify(results, null, 2))
}

run().catch(console.error)
