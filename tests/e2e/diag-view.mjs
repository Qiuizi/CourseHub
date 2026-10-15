/**
 * 诊断：WebContentsView 是否真的挂载、加载、设定了 bounds。
 */
import { _electron as electron } from 'playwright'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

async function main() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: [projectRoot], env, timeout: 60_000 })
  const win = await app.firstWindow()
  await win.waitForSelector('[data-testid="app-shell"]', { timeout: 20_000 }).catch(() => {})
  await new Promise((r) => setTimeout(r, 2500))

  // 切到平台浏览场景
  await win.evaluate(() => {
    const b = Array.from(document.querySelectorAll('[data-scene]')).find(
      (x) => (x.textContent || '').trim() === '平台浏览'
    )
    b?.click()
  })
  await new Promise((r) => setTimeout(r, 2500))

  const rect = await win.evaluate(() => {
    const el = document.querySelector('[data-testid="browser-viewport"]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height, scrollH: el.scrollHeight }
  })
  console.log('renderer viewport rect:', JSON.stringify(rect))

  // 主进程侧状态
  const diag = await win.evaluate(async () => {
    const r = await window.coursehub.diagnostics.viewState()
    return r.ok ? r.data : { error: r.error }
  })
  console.log('main-process diag:', JSON.stringify(diag, null, 2))

  // 从主进程直接 capturePage：若拿到非空白图，说明页面在渲染，只是合成/遮挡问题
  const cap = await win.evaluate(async () => {
    const r = await window.coursehub.diagnostics.capture('testbed')
    return r.ok ? r.data : { error: r.error }
  })
  console.log('capturePage:', JSON.stringify(cap))

  await app.close().catch(() => {})
}
main().catch((e) => { console.error(e); process.exit(1) })
