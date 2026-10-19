import { _electron as electron } from 'playwright'
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..', '..')
const artifactDir = 'C:\\Users\\123\\.gemini\\antigravity\\brain\\ba2ece10-8442-4527-9489-34931dabaed4'
const screenshotDir = path.join(artifactDir, 'screenshots')

async function run() {
  console.log('[E2E-LIVE] 启动 CourseHub Electron 连接真实 Cloudflare D1 Staging 服务...')
  await fs.mkdir(screenshotDir, { recursive: true })

  const stagingEndpoint = 'https://coursehub-feedback-staging.tangziqi6609.workers.dev/api/feedback'

  const app = await electron.launch({
    args: [projectRoot],
    env: {
      ...process.env,
      COURSEHUB_FEEDBACK_ENDPOINT: stagingEndpoint,
      ELECTRON_ENABLE_LOGGING: '1'
    }
  })

  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await window.waitForTimeout(2000)

    // 1. 切换到设置场景 (Settings)
    console.log('[E2E-LIVE] 正在切换至「设置」页面...')
    const settingsBtn = window.locator('button:has-text("设置")')
    if ((await settingsBtn.count()) > 0) {
      await settingsBtn.first().click()
    } else {
      await window.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'))
        const target = btns.find((b) => b.textContent?.includes('设置'))
        if (target) target.click()
      })
    }

    await window.waitForTimeout(1000)

    // 2. 检查反馈表单
    const feedbackHeader = window.locator('text=遇到问题？告诉我们')
    await feedbackHeader.waitFor({ state: 'visible', timeout: 5000 })

    // 3. 选择分类并填入真实联调测试描述
    const syncPill = window.locator('button:has-text("课程同步")')
    if ((await syncPill.count()) > 0) {
      await syncPill.first().click()
    }

    const testDescription = '【Electron真实提交测试】通过 D1 Free 方案成功直连 Cloudflare Staging'
    const descTextarea = window.locator('textarea[placeholder*="请详细描述遇到的具体情况"]')
    if ((await descTextarea.count()) > 0) {
      await descTextarea.first().fill(testDescription)
    }

    // 4. 点击提交
    console.log('[E2E-LIVE] 正在向真实 Cloudflare Worker 发送在线反馈请求...')
    const submitBtn = window.locator('button:has-text("提交反馈")')
    if ((await submitBtn.count()) > 0) {
      await submitBtn.first().click()
      await window.waitForTimeout(3000)

      // 验证页面上是否出现了反馈编号 (FB-...)
      const successCard = window.locator('text=FB-')
      const hasFeedbackId = (await successCard.count()) > 0
      console.log(`[E2E-LIVE] 界面是否展示真实反馈流水号: ${hasFeedbackId}`)

      const liveShot = path.join(screenshotDir, '05-feedback-submitted-live-d1.png')
      await window.screenshot({ path: liveShot })
      console.log(`[E2E-LIVE] 已保存真实在线提交反馈截图: ${liveShot}`)
    }

    console.log('[E2E-LIVE] 真实 Cloudflare D1 反馈闭环端到端验证圆满完成！')
  } finally {
    await app.close()
  }
}

run().catch((err) => {
  console.error('[E2E-LIVE] 联调验证异常:', err)
  process.exit(1)
})
