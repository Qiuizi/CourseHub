import { _electron as electron } from 'playwright'
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..', '..')
const exePath = path.join(projectRoot, 'release', 'win-unpacked', 'CourseHub Beta.exe')
const artifactDir = 'C:\\Users\\123\\.gemini\\antigravity\\brain\\8df6774d-b4d7-4d87-bda8-70eef4cd7aac'
const screenshotDir = path.join(artifactDir, 'screenshots')

async function run() {
  console.log('[Updater E2E] 正在启动打包后的 CourseHub Beta 进行自动更新 UI 验收...')
  await fs.mkdir(screenshotDir, { recursive: true })

  const app = await electron.launch({
    executablePath: exePath,
    env: {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: '1'
    }
  })

  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await window.waitForTimeout(2000)

    // 1. 验证版本与基本 API
    const version = await app.evaluate(async ({ app }) => app.getVersion())
    console.log(`[Updater E2E] 打包应用主进程实际版本: ${version}`)
    if (version !== '0.4.3-beta.4') {
      throw new Error(`版本不匹配：期望 0.4.3-beta.4，实际为 ${version}`)
    }

    // 2. 检查 updater API 是否在 preload 中正确暴露
    const apiCheck = await window.evaluate(() => {
      const hasUpdater = typeof window.coursehub?.updater?.check === 'function'
      const hasGetState = typeof window.coursehub?.updater?.getState === 'function'
      const hasOnUpdateStatus = typeof window.coursehub?.events?.onUpdateStatus === 'function'
      return { hasUpdater, hasGetState, hasOnUpdateStatus }
    })
    console.log('[Updater E2E] Preload API 注入检查:', JSON.stringify(apiCheck))
    if (!apiCheck.hasUpdater || !apiCheck.hasGetState || !apiCheck.hasOnUpdateStatus) {
      throw new Error('Preload updater API 注入缺失！')
    }

    // 3. 读取当前更新状态
    const updateState = await window.evaluate(async () => {
      const res = await window.coursehub.updater.getState()
      return res.data
    })
    console.log('[Updater E2E] 当前更新服务状态:', JSON.stringify(updateState))

    // 4. 切换到设置场景 (Settings)
    console.log('[Updater E2E] 正在切换至「设置」页面...')
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

    // 5. 检查「软件更新」卡片
    console.log('[Updater E2E] 正在查找「软件更新 (CourseHub Update)」卡片...')
    const updateCard = window.locator('text=软件更新 (CourseHub Update)')
    await updateCard.waitFor({ state: 'visible', timeout: 5000 })
    console.log('[Updater E2E] 成功找到「软件更新 (CourseHub Update)」卡片！')

    // 6. 验证检查更新按钮
    const checkBtn = window.locator('[data-testid="settings-check-update"]')
    await checkBtn.waitFor({ state: 'visible', timeout: 3000 })
    console.log('[Updater E2E] 发现「检查更新」按钮，触发点击测试...')
    await checkBtn.click()
    await window.waitForTimeout(2000)

    // 7. 截图保存至 artifact 目录
    const ssPath = path.join(screenshotDir, 'v0.4.3-beta.3-settings-updater.png')
    await window.screenshot({ path: ssPath, fullPage: false })
    console.log(`[Updater E2E] 设置页自动更新卡片截图已保存: ${ssPath}`)

    console.log('[Updater E2E] 所有打包应用自动更新 UI 与 IPC 验收项全部通过！')
  } finally {
    await app.close()
  }
}

run().catch((err) => {
  console.error('[Updater E2E] 验收失败:', err)
  process.exit(1)
})
