/**
 * 真实截图验收。
 *
 * 用真实 Electron 进程打开真实界面并截图，作为视觉证据留档。
 * 运行：unset ELECTRON_RUN_AS_NODE && node tests/e2e/capture-screens.mjs
 */

import { _electron as electron } from 'playwright'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs/promises'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..', '..')
const shotDir = path.join(projectRoot, 'docs', 'screenshots')

const VIEWS = [
  { id: 'dashboard', label: '工作台' },
  { id: 'signin', label: '签到中心' },
  { id: 'video', label: '视频任务' },
  { id: 'geo', label: '定位测试' },
  { id: 'ai', label: '课堂 AI' },
  { id: 'settings', label: '设置' }
]

async function main() {
  await fs.mkdir(shotDir, { recursive: true })

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE

  const app = await electron.launch({ args: [projectRoot], env, timeout: 60_000 })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  // 等 React 挂载并完成首次平台列表加载
  await win.waitForSelector('.app-shell', { timeout: 20_000 }).catch(() => {})
  await new Promise((r) => setTimeout(r, 1500))

  const navLabels = await win.$$eval('.rail .btn', (els) =>
    els.map((e) => (e.textContent || '').trim()).filter(Boolean)
  )
  console.log('导航项:', navLabels.join(' | '))

  for (const v of VIEWS) {
    const clicked = await win.evaluate((label) => {
      const btns = Array.from(document.querySelectorAll('.rail .btn'))
      const target = btns.find((b) => (b.textContent || '').trim() === label)
      if (!target) return false
      target.click()
      return true
    }, v.label)

    if (!clicked) {
      console.log(`[SKIP] 未找到导航项 ${v.label}`)
      continue
    }
    await new Promise((r) => setTimeout(r, 900))
    const file = path.join(shotDir, `${v.id}.png`)
    await win.screenshot({ path: file })
    const st = await fs.stat(file)
    console.log(`[SHOT] ${v.label} -> ${path.relative(projectRoot, file)} (${st.size} bytes)`)
  }

  await app.close().catch(() => {})
  console.log('\n截图完成。')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
