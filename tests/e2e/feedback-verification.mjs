import { _electron as electron } from 'playwright'
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..', '..')
const artifactDir = 'C:\\Users\\123\\.gemini\\antigravity\\brain\\ba2ece10-8442-4527-9489-34931dabaed4'
const screenshotDir = path.join(artifactDir, 'screenshots')

async function run() {
  console.log('[E2E] 启动 Electron 进行反馈与诊断模块 UI 视觉验证...')
  await fs.mkdir(screenshotDir, { recursive: true })

  const app = await electron.launch({
    args: [projectRoot],
    env: {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: '1'
    }
  })

  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await window.waitForTimeout(2000)

    // 1. 切换到设置场景 (Settings)
    console.log('[E2E] 正在切换至「设置」页面...')
    const settingsBtn = window.locator('button:has-text("设置")')
    if (await settingsBtn.count() > 0) {
      await settingsBtn.first().click()
    } else {
      // 备用选择器
      await window.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'))
        const target = btns.find((b) => b.textContent?.includes('设置'))
        if (target) target.click()
      })
    }

    await window.waitForTimeout(1000)

    // 2. 截取「帮助与反馈」卡片视图
    console.log('[E2E] 正在检查「帮助与反馈」卡片...')
    const feedbackHeader = window.locator('text=遇到问题？告诉我们')
    await feedbackHeader.waitFor({ state: 'visible', timeout: 5000 })
    console.log('[E2E] 成功找到「遇到问题？告诉我们」反馈入口！')

    // 3. 选择分类并填入测试描述
    const syncPill = window.locator('button:has-text("课程同步")')
    if (await syncPill.count() > 0) {
      await syncPill.first().click()
    }

    const descTextarea = window.locator('textarea[placeholder*="请详细描述遇到的具体情况"]')
    if (await descTextarea.count() > 0) {
      await descTextarea.first().fill('测试反馈：课程列表同步时提示网络超时，本地已自动降级至缓存，体验正常。')
    }

    const reproTextarea = window.locator('textarea[placeholder*="登录超星账号"]')
    if (await reproTextarea.count() > 0) {
      await reproTextarea.first().fill('1. 登录账号\n2. 切换至雨课堂课程\n3. 点击右上角刷新')
    }

    // 滚动卡片使其完整居中
    await feedbackHeader.scrollIntoViewIfNeeded()
    await window.waitForTimeout(500)

    // 截取反馈表单填写状态截图
    const feedbackCardShot = path.join(screenshotDir, '01-feedback-form.png')
    await window.screenshot({ path: feedbackCardShot })
    console.log(`[E2E] 已保存反馈表单截图: ${feedbackCardShot}`)

    // 4. 点击「预览诊断内容」并截图预览弹窗
    const previewBtn = window.locator('button:has-text("预览诊断内容")')
    if (await previewBtn.count() > 0) {
      await previewBtn.first().click()
      await window.waitForTimeout(1000)

      const modalShot = path.join(screenshotDir, '02-diagnostic-preview-modal.png')
      await window.screenshot({ path: modalShot })
      console.log(`[E2E] 已保存诊断预览弹窗截图: ${modalShot}`)

      // 关闭弹窗
      const closeBtn = window.locator('button:has-text("关闭")')
      if (await closeBtn.count() > 0) {
        await closeBtn.first().click()
        await window.waitForTimeout(500)
      }
    }

    // 5. 点击「提交反馈」测试自动离线容灾回退
    const submitBtn = window.locator('button:has-text("提交反馈")')
    if (await submitBtn.count() > 0) {
      console.log('[E2E] 点击「提交反馈」...')
      await submitBtn.first().click()
      await window.waitForTimeout(2000)

      const submittedShot = path.join(screenshotDir, '04-feedback-submitted-offline.png')
      await window.screenshot({ path: submittedShot })
      console.log(`[E2E] 已保存提交反馈后离线容灾截图: ${submittedShot}`)
    }

    // 5. 切换到「课程」场景，验证课程异常降级横条交互
    console.log('[E2E] 正在切换至「课程」页面验证兼容性降级提示...')
    const coursesBtn = window.locator('button:has-text("课程")')
    if (await coursesBtn.count() > 0) {
      await coursesBtn.first().click()
      await window.waitForTimeout(1000)

      const coursesShot = path.join(screenshotDir, '03-courses-scene.png')
      await window.screenshot({ path: coursesShot })
      console.log(`[E2E] 已保存课程页视图截图: ${coursesShot}`)
    }

    console.log('[E2E] 反馈与诊断模块视觉验证圆满完成！')
  } finally {
    await app.close()
  }
}

run().catch((err) => {
  console.error('[E2E] 验证过程出现异常:', err)
  process.exit(1)
})
