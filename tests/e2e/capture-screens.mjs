/**
 * 新版 UI 真实截图验收。
 *
 * 关键点：Playwright 的 `win.screenshot()` 只截 renderer 的 web 内容，
 * **不含原生 WebContentsView**。要拿到含平台网页/视频/地图的完整视觉证据，
 * 必须用主进程的 `win.capturePage()`（整窗捕获）。
 * 因此本脚本：Playwright 负责切场景，主进程负责截图。
 *
 * 运行：unset ELECTRON_RUN_AS_NODE && node tests/e2e/capture-screens.mjs
 */

import { _electron as electron } from 'playwright'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..', '..')
const shotDir = path.join(projectRoot, 'docs', 'screenshots')

const SHOTS = [
  { id: 'dashboard', label: '工作台', nav: null },
  { id: 'video', label: '视频课堂', nav: '视频课堂' },
  { id: 'quiz', label: '章节作业', nav: '章节作业' },
  { id: 'signin', label: '课堂签到', nav: '课堂签到' },
  { id: 'geo', label: '定位测试', nav: '定位测试' },
  { id: 'ai', label: 'AI 助手', nav: 'AI 助手' },
  { id: 'browser', label: '平台浏览', nav: '平台浏览' },
  { id: 'settings', label: '设置', nav: null, via: 'settings' }
]

async function main() {
  await fs.mkdir(shotDir, { recursive: true })

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE

  const app = await electron.launch({ args: [projectRoot], env, timeout: 60_000 })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForSelector('[data-testid="app-shell"]', { timeout: 20_000 }).catch(() => {})
  // 等首屏打开测试台并加载 fixture
  await new Promise((r) => setTimeout(r, 4000))

  // 视觉对照实测：关键元素的计算样式，与原型期望值比对
  const probe = await win.evaluate(() => {
    const pick = (sel, props) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const cs = getComputedStyle(el)
      const out = {}
      for (const p of props) out[p] = cs.getPropertyValue(p)
      return out
    }
    return {
      rootTheme: document.documentElement.getAttribute('data-theme'),
      topbar: pick('[data-testid="topbar"]', ['height', 'display', 'align-items']),
      platformNav: pick('[data-testid="platform-nav"]', ['border-radius', 'padding', 'background-color']),
      mainCard: pick('.main-card', ['border-radius', 'background-color', 'box-shadow']),
      sceneNav: pick('[data-testid="scene-nav"]', ['border-radius', 'background-color']),
      tokens: {
        accent: getComputedStyle(document.documentElement).getPropertyValue('--ch-accent').trim(),
        page: getComputedStyle(document.documentElement).getPropertyValue('--ch-page').trim(),
        surface: getComputedStyle(document.documentElement).getPropertyValue('--ch-surface').trim(),
        text: getComputedStyle(document.documentElement).getPropertyValue('--ch-text').trim(),
        text2: getComputedStyle(document.documentElement).getPropertyValue('--ch-text-2').trim(),
        border: getComputedStyle(document.documentElement).getPropertyValue('--ch-border').trim(),
        rCard: getComputedStyle(document.documentElement).getPropertyValue('--r-card').trim()
      },
      drawerPresent: !!document.querySelector('[data-testid="drawer"]'),
      platformCount: document.querySelectorAll('[data-platform]').length,
      sceneCount: document.querySelectorAll('[data-scene]').length
    }
  })

  console.log('=== 视觉令牌实测（对照原型） ===')
  console.log(JSON.stringify(probe, null, 2))

  /** 用主进程整窗截图，含原生 WebContentsView。 */
  const shoot = async (id) => {
    const r = await win.evaluate(async (name) => {
      const res = await window.coursehub.diagnostics.captureWindow(name)
      return res.ok ? res.data : { error: res.error }
    }, id)
    if (r.error) {
      console.log(`[FAIL] ${id}: ${JSON.stringify(r.error)}`)
      return null
    }
    const dest = path.join(shotDir, `${id}.png`)
    await fs.copyFile(r.path, dest)
    const st = await fs.stat(dest)
    console.log(`[SHOT] ${id} -> docs/screenshots/${id}.png (${st.size} bytes, ${r.size.width}x${r.size.height})`)
    return { id, bytes: st.size, size: r.size }
  }

  const shots = []

  // 工作台（默认场景，直接截）
  shots.push(await shoot('dashboard'))

  for (const s of SHOTS) {
    if (s.id === 'dashboard') continue

    if (s.via === 'settings') {
      await win.evaluate(() => {
        document.querySelector('[data-testid="ai-status-pill"]')?.click()
      })
    } else if (s.nav) {
      const ok = await win.evaluate((label) => {
        const btn = Array.from(document.querySelectorAll('[data-scene]')).find(
          (b) => (b.textContent || '').trim() === label
        )
        if (!btn) return false
        btn.click()
        return true
      }, s.nav)
      if (!ok) {
        console.log(`[SKIP] 未找到场景 ${s.nav}`)
        continue
      }
    }

    // 等场景渲染 + 原生视图 bounds 生效 + 地图瓦片
    await new Promise((r) => setTimeout(r, 3000))
    const shot = await shoot(s.id)
    if (shot) shots.push(shot)
  }

  // 深色主题
  await win.evaluate(() => {
    const dark = Array.from(document.querySelectorAll('.seg button')).find(
      (b) => (b.textContent || '').trim() === '深色'
    )
    dark?.click()
  })
  await new Promise((r) => setTimeout(r, 1500))
  shots.push(await shoot('settings-dark'))

  // 抽屉收起
  await win.evaluate(() => {
    document.querySelector('[data-testid="drawer-toggle"]')?.click()
  })
  await new Promise((r) => setTimeout(r, 1200))
  shots.push(await shoot('settings-nodrawer'))

  await fs.writeFile(
    path.join(shotDir, 'visual-probe.json'),
    JSON.stringify({ probe, shots, capturedAt: new Date().toISOString() }, null, 2)
  )
  console.log(`\n共 ${shots.filter(Boolean).length} 张整窗截图（含原生视图）。`)

  await app.close().catch(() => {})
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
