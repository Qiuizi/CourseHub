import { _electron as electron } from 'playwright'
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..', '..')
const targetDir = path.join(projectRoot, 'docs', 'screenshots', 'v0.4.2-comparison', 'after')

async function run() {
  await fs.mkdir(targetDir, { recursive: true })

  console.log('[Capture After] 启动 CourseHub 截取 v0.4.2 简化后界面...')
  const app = await electron.launch({
    args: ['.'],
    cwd: projectRoot,
    env: { ...process.env, NODE_ENV: 'test' },
    timeout: 30000
  })

  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await win.waitForSelector('[data-testid="app-shell"]', { timeout: 20000 })
    await new Promise((r) => setTimeout(r, 2500))

    // 1. Dashboard
    console.log('[Capture After] 截取 01-dashboard-after.png...')
    await win.screenshot({ path: path.join(targetDir, '01-dashboard-after.png'), fullPage: false })

    // 2. Courses
    console.log('[Capture After] 切换到课程中心并截取 02-courses-after.png...')
    await win.evaluate(() => {
      const btn = document.querySelector('[data-testid="nav-courses"]')
      btn?.click()
    })
    await new Promise((r) => setTimeout(r, 1500))
    await win.screenshot({ path: path.join(targetDir, '02-courses-after.png'), fullPage: false })

    // 3. Sign-in & Activities
    console.log('[Capture After] 切换到待办与活动并截取 03-signin-after.png...')
    await win.evaluate(() => {
      const btn = document.querySelector('[data-testid="nav-signin"]')
      btn?.click()
    })
    await new Promise((r) => setTimeout(r, 1500))
    await win.screenshot({ path: path.join(targetDir, '03-signin-after.png'), fullPage: false })

    // 4. Video / Chapter study
    console.log('[Capture After] 点击进入课程章节学习并截取 04-video-after.png...')
    await win.evaluate(() => {
      const coursesBtn = document.querySelector('[data-testid="nav-courses"]')
      coursesBtn?.click()
    })
    await new Promise((r) => setTimeout(r, 1000))
    await win.evaluate(() => {
      const studyBtns = Array.from(document.querySelectorAll('.course-card button.btn-primary'))
      if (studyBtns[0]) studyBtns[0].click()
    })
    await new Promise((r) => setTimeout(r, 2500))
    await win.screenshot({ path: path.join(targetDir, '04-video-after.png'), fullPage: false })

    // 5. Settings
    console.log('[Capture After] 切换到设置并截取 05-settings-after.png...')
    await win.evaluate(() => {
      const backBtn = document.querySelector('[data-testid="btn-back-to-courses"]')
      backBtn?.click()
    })
    await new Promise((r) => setTimeout(r, 600))
    await win.evaluate(() => {
      const btn = document.querySelector('[data-testid="nav-settings"]') || document.querySelector('button[title="打开系统设置"]')
      btn?.click()
    })
    await new Promise((r) => setTimeout(r, 1500))
    await win.screenshot({ path: path.join(targetDir, '05-settings-after.png'), fullPage: false })

    console.log('[Capture After] 全部 After 截图完成并保存至 docs/screenshots/v0.4.2-comparison/after/')
  } finally {
    await app.close().catch(() => {})
  }
}

run().catch((err) => {
  console.error('[Capture After Error]', err)
  process.exit(1)
})
