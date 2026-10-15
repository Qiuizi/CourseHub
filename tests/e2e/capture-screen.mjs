/**
 * OS 级整屏截图验收。
 *
 * 为什么需要它：
 * - Playwright 的 `win.screenshot()` 只截 renderer 的 web 内容；
 * - Electron 的 `win.capturePage()` 截的是窗口 web contents，同样不含原生 WebContentsView。
 * 两者都拿不到「用户实际看到的画面」。要证明平台网页/视频/地图真的渲染出来，
 * 只能用操作系统级屏幕捕获。
 *
 * 流程：Playwright 切场景 -> 调 PowerShell 截主屏 -> 存为 PNG。
 * 运行：unset ELECTRON_RUN_AS_NODE && node tests/e2e/capture-screen.mjs
 */

import { _electron as electron } from 'playwright'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const pexec = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..', '..')
const shotDir = path.join(projectRoot, 'docs', 'screenshots')

const SHOTS = [
  { id: 'video', label: '视频课堂' },
  { id: 'browser', label: '平台浏览' },
  { id: 'geo', label: '定位测试' },
  { id: 'quiz', label: '章节作业' },
  { id: 'signin', label: '课堂签到' },
  { id: 'ai', label: 'AI 助手' }
]

/** 用 PowerShell + .NET 捕获主屏幕。 */
async function captureScreen(outPath) {
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save('${outPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
`
  await pexec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000
  })
}

async function main() {
  await fs.mkdir(shotDir, { recursive: true })

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE

  const app = await electron.launch({ args: [projectRoot], env, timeout: 60_000 })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForSelector('[data-testid="app-shell"]', { timeout: 20_000 }).catch(() => {})

  // 把窗口放到前台并给足加载时间
  await win.evaluate(() => {
    const w = window
    void w
  })
  await new Promise((r) => setTimeout(r, 4500))
  await win.bringToFront().catch(() => {})

  const tmp = path.join(shotDir, '_raw.png')

  for (const s of SHOTS) {
    const ok = await win.evaluate((label) => {
      const btn = Array.from(document.querySelectorAll('[data-scene]')).find(
        (b) => (b.textContent || '').trim() === label
      )
      if (!btn) return false
      btn.click()
      return true
    }, s.label)
    if (!ok) {
      console.log(`[SKIP] 未找到场景 ${s.label}`)
      continue
    }
    await new Promise((r) => setTimeout(r, 3500))
    await win.bringToFront().catch(() => {})
    await new Promise((r) => setTimeout(r, 600))

    await captureScreen(tmp)
    const dest = path.join(shotDir, `screen-${s.id}.png`)
    await fs.copyFile(tmp, dest)
    const st = await fs.stat(dest)
    console.log(`[SHOT] ${s.label} -> docs/screenshots/screen-${s.id}.png (${st.size} bytes)`)
  }

  await fs.rm(tmp, { force: true })
  await app.close().catch(() => {})
  console.log('\nOS 级截图完成。这些图包含原生 WebContentsView 的真实渲染内容。')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
