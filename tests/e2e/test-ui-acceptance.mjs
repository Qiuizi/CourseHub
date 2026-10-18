import { _electron as electron } from 'playwright'
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..', '..')
const shotDir = path.join(projectRoot, 'docs', 'screenshots', 'dual-platform')

async function run() {
  await fs.mkdir(shotDir, { recursive: true })

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE

  console.log('[UI Acceptance] 启动 CourseHub 主窗口...')
  const app = await electron.launch({
    args: [projectRoot],
    env,
    timeout: 60_000
  })

  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await win.waitForSelector('[data-testid="app-shell"]', { timeout: 20_000 })
    console.log('[UI Acceptance] AppShell 已加载')

    // 切换到课程中心场景
    console.log('[UI Acceptance] 点击导航至「课程中心」场景...')
    await win.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('[data-scene]'))
      const courseBtn = btns.find((b) => (b.textContent || '').includes('课程中心'))
      if (courseBtn) {
        courseBtn.click()
      } else {
        throw new Error('未找到「课程中心」场景按钮')
      }
    })

    // 等待课程中心加载
    await win.waitForSelector('[data-testid="courses-refresh"]', { timeout: 10_000 })
    console.log('[UI Acceptance] 进入课程中心，等待初始加载与网络请求...')

    // 触发刷新
    await win.click('[data-testid="courses-refresh"]')
    console.log('[UI Acceptance] 已触发「刷新全部课程」...')

    // 等待加载状态完成（等待 courses-grid 出现或刷新按钮不再 spinning）
    await win.waitForFunction(() => {
      const btn = document.querySelector('[data-testid="courses-refresh"]')
      const spinner = btn?.querySelector('.spin')
      return !spinner
    }, { timeout: 20_000 }).catch(() => console.log('等待刷新 spinner 结束超时，继续检查 DOM'))

    // 额外稍作等待确保 DOM 渲染完成
    await new Promise((r) => setTimeout(r, 2000))

    // 检查课程统计
    const summary = await win.evaluate(() => {
      const pills = Array.from(document.querySelectorAll('button')).map((b) => b.textContent?.trim() || '')
      const allPill = pills.find((p) => p.startsWith('全部 ('))
      const cxPill = pills.find((p) => p.startsWith('学习通 ('))
      const yktPill = pills.find((p) => p.startsWith('雨课堂 ('))
      const curTermPill = pills.find((p) => p.includes('本学期 ('))
      const histTermPill = pills.find((p) => p.includes('往期历史 ('))
      const cards = document.querySelectorAll('.course-card')

      // 获取前 5 个卡片信息
      const cardSummaries = Array.from(cards).slice(0, 8).map((c) => {
        const title = c.querySelector('h4')?.textContent?.trim()
        const meta = Array.from(c.querySelectorAll('span, div')).map((s) => s.textContent?.trim()).filter(Boolean)
        return { title, meta: meta.slice(0, 6) }
      })

      return {
        allPill,
        cxPill,
        yktPill,
        curTermPill,
        histTermPill,
        cardCount: cards.length,
        cardSummaries
      }
    })

    console.log('[UI Acceptance] 课程中心数据统计：', JSON.stringify(summary, null, 2))

    // 截图函数：使用主进程 captureWindow
    const takeShot = async (name) => {
      const r = await win.evaluate(async (n) => {
        const res = await window.coursehub.diagnostics.captureWindow(n)
        return res.ok ? res.data : { error: res.error }
      }, name)
      if (r?.path) {
        const dest = path.join(shotDir, `${name}.png`)
        await fs.copyFile(r.path, dest)
        console.log(`[UI Acceptance] 截图保存: ${dest} (${r.size.width}x${r.size.height})`)
        return dest
      } else {
        console.error(`[UI Acceptance] 截图失败:`, r?.error)
        return null
      }
    }

    // 截图 1: 全部课程视图
    await takeShot('01-courses-all')

    // 切换到学习通筛选
    console.log('[UI Acceptance] 切换到学习通筛选...')
    await win.click('[data-testid="filter-platform-chaoxing"]')
    await new Promise((r) => setTimeout(r, 600))
    const cxCount = await win.evaluate(() => document.querySelectorAll('.course-card').length)
    console.log(`[UI Acceptance] 学习通展示卡片数量: ${cxCount}`)
    await takeShot('02-courses-chaoxing')

    // 切换到雨课堂筛选
    console.log('[UI Acceptance] 切换到雨课堂筛选...')
    await win.click('[data-testid="filter-platform-yuketang"]')
    await new Promise((r) => setTimeout(r, 600))
    const yktCount = await win.evaluate(() => document.querySelectorAll('.course-card').length)
    console.log(`[UI Acceptance] 雨课堂展示卡片数量: ${yktCount}`)
    await takeShot('03-courses-yuketang')

    // 切换到全部并筛选本学期
    console.log('[UI Acceptance] 切换到全部 + 本学期筛选...')
    await win.click('[data-testid="filter-platform-all"]')
    await new Promise((r) => setTimeout(r, 300))
    await win.click('[data-testid="filter-term-current"]')
    await new Promise((r) => setTimeout(r, 600))
    const curTermCount = await win.evaluate(() => document.querySelectorAll('.course-card').length)
    console.log(`[UI Acceptance] 本学期展示卡片数量: ${curTermCount}`)
    await takeShot('04-courses-current-term')

    // 切换到往期历史筛选
    console.log('[UI Acceptance] 切换到往期历史筛选...')
    await win.click('[data-testid="filter-term-history"]')
    await new Promise((r) => setTimeout(r, 600))
    const histTermCount = await win.evaluate(() => document.querySelectorAll('.course-card').length)
    console.log(`[UI Acceptance] 往期历史展示卡片数量: ${histTermCount}`)
    await takeShot('05-courses-history-term')

    // 重置学期为全学期，并测试雨课堂课程卡片点击「原网页」
    console.log('[UI Acceptance] 测试课程卡片点击原网页跳转...')
    await win.click('[data-testid="filter-term-all"]')
    await win.click('[data-testid="filter-platform-yuketang"]')
    await new Promise((r) => setTimeout(r, 600))

    // 点击第一个雨课堂课程的「原网页」
    await win.evaluate(() => {
      const cards = document.querySelectorAll('.course-card')
      const firstCard = cards[0]
      const extBtn = Array.from(firstCard?.querySelectorAll('button') || []).find((b) => (b.textContent || '').includes('原网页'))
      extBtn?.click()
    })

    console.log('[UI Acceptance] 已点击「原网页」，等待平台浏览器与 WebContentsView 展现...')
    await new Promise((r) => setTimeout(r, 4000))
    await takeShot('06-courses-open-yuketang-detail')

    console.log('[UI Acceptance] 全部 UI 验收步骤执行完毕！')
  } finally {
    await app.close().catch(() => {})
  }
}

run().catch((err) => {
  console.error('[UI Acceptance Error]', err)
  process.exit(1)
})
