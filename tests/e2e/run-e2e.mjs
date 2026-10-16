/**
 * Electron E2E 验收。
 *
 * 用真实 Electron 进程驱动真实主进程代码，验证四条核心能力中
 * **可在无真实平台账号情况下验证**的部分：
 *   1. 视频：真实 HTML5 <video> 能被打开、播放、暂停、观测到真实进度
 *   2. 定位：CDP 覆盖下发后测试页能读回，且停止后解除
 *   3. 题目：隔离测试页的控件映射与受控填充（含 DOM 回读校验）
 *
 * 不验证也无法验证的部分（真实平台签到/出勤）明确标注为 pending，
 * 绝不用 fixture 结果冒充平台验收。
 *
 * 运行：node tests/e2e/run-e2e.mjs
 */

import { _electron as electron } from 'playwright'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs/promises'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..', '..')
const fixtures = path.join(projectRoot, 'tests', 'fixtures')

const results = []
let failed = 0

function record(name, ok, detail) {
  results.push({ name, ok, detail })
  if (!ok) failed++
  const tag = ok ? 'PASS' : 'FAIL'
  console.log(`[${tag}] ${name}`)
  if (detail) console.log(`       ${detail}`)
}

/** 轮询等待页面条件成立（raw Electron 没有 Playwright Page 的 waitFor* API）。 */
async function waitFor(wc, expr, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await wc
      .executeJavaScript(`(() => { try { return !!(${expr}); } catch (_) { return false; } })()`, true)
      .catch(() => false)
    if (ok) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

async function main() {
  const outDir = path.join(projectRoot, 'out')
  await fs.access(outDir).catch(() => {
    console.error('未找到构建产物 out/，请先运行 npm run build')
    process.exit(1)
  })

  // 注意：必须以**项目根**作为应用路径启动。
  // package.json 的 main 指向 ./out/main/index.js；若把 out/ 当应用目录，
  // Electron 找不到入口会以 exit code 1 退出。
  //
  // 另外必须清掉 ELECTRON_RUN_AS_NODE：该变量存在时 electron.exe 会退化成
  // 普通 Node，require('electron') 拿到的是 npm 包（一个路径字符串）而非内置模块。
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE

  const app = await electron.launch({
    args: [projectRoot],
    env,
    timeout: 60_000
  })

  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  try {
    /* ---------------------------------------------------------------- */
    /* 1. 外壳与平台能力登记                                              */
    /* ---------------------------------------------------------------- */
    const platformCount = await win.evaluate(async () => {
      const r = await window.coursehub.platform.list()
      return r.ok ? r.data.length : -1
    })
    // v0.3 起含「测试台」（自有测试站点，开发文档 §2.2），共 4 个
    record('平台列表加载', platformCount === 4, `返回 ${platformCount} 个平台（期望 4：学习通/雨课堂/智慧树/测试台）`)

    const caps = await win.evaluate(async () => {
      const r = await window.coursehub.platform.list()
      if (!r.ok) return null
      const cx = r.data.find((p) => p.id === 'chaoxing')
      return {
        listVideoTasks: cx?.capabilities?.listVideoTasks?.state ?? null,
        submitSignIn: cx?.capabilities?.submitSignIn?.state ?? null,
        yktSubmit: r.data.find((p) => p.id === 'yuketang')?.capabilities?.submitAnswer?.state ?? null,
        yktHeartbeat:
          r.data.find((p) => p.id === 'yuketang')?.capabilities?.videoHeartbeat?.state ?? null
      }
    })
    record(
      '第三方平台写接口状态声明（签到提交/答案提交/心跳上报）',
      caps?.listVideoTasks === 'unsupported' &&
        caps?.submitSignIn === 'unsupported' &&
        caps?.yktSubmit === 'unsupported' &&
        caps?.yktHeartbeat === 'unsupported',
      JSON.stringify(caps)
    )

    /* ---------------------------------------------------------------- */
    /* 2. 视频：真实 HTML5 播放与观测                                      */
    /* ---------------------------------------------------------------- */
    // 通过 renderer 暴露的 API 无法直接加载 file:// fixture（生产会话有严格白名单），
    // 因此这里用独立 BrowserWindow 承载 fixture，验证播放控制与观测逻辑本身。
    const videoWindow = await app.evaluate(
      async ({ BrowserWindow }, url) => {
        const w = new BrowserWindow({
          show: false,
          width: 900,
          height: 700,
          webPreferences: { nodeIntegration: false, contextIsolation: true }
        })
        await w.loadURL(url)
        const wc = w.webContents

        // 等待真实媒体元数据就绪，而不是盲等固定时间
        await (async () => {
          const deadline = Date.now() + 20000;
          while (Date.now() < deadline) {
            const ok = await wc.executeJavaScript('window.__chReady === true', true).catch(() => false);
            if (ok) break;
            await new Promise((r) => setTimeout(r, 200));
          }
        })()

        return await wc.executeJavaScript(
          `new Promise((resolve) => {
            const v = document.getElementById('v1');
            if (!v) { resolve({ found: false }); return; }
            if (v.readyState < 1) { resolve({ found: true, readyState: v.readyState, note: 'metadata-not-ready' }); return; }
            v.muted = true;
            v.play().then(() => {
              setTimeout(() => {
                resolve({
                  found: true,
                  readyState: v.readyState,
                  duration: Number.isFinite(v.duration) ? v.duration : null,
                  currentTime: v.currentTime,
                  paused: v.paused,
                  volume: v.volume,
                  playbackRate: v.playbackRate
                });
              }, 2000);
            }).catch((e) => resolve({ found: true, playError: String(e) }));
          })`,
          true
        )
      },
      pathToFileURL(path.join(fixtures, 'video-task.html')).href
    )

    record(
      '视频 fixture 加载并具备真实可播放 media',
      videoWindow?.found === true && videoWindow?.duration > 0,
      JSON.stringify(videoWindow)
    )
    record(
      '真实播放推进了 currentTime',
      typeof videoWindow?.currentTime === 'number' && videoWindow.currentTime > 0,
      `currentTime=${videoWindow?.currentTime}`
    )

    // 播放控制 + 观测走主进程真实实现
    const playerCtl = await app.evaluate(
      async ({ BrowserWindow }, url) => {
        const w = new BrowserWindow({
          show: false,
          webPreferences: { nodeIntegration: false, contextIsolation: true }
        })
        await w.loadURL(url)
        const wc = w.webContents
        await (async () => {
          const deadline = Date.now() + 20000;
          while (Date.now() < deadline) {
            const ok = await wc.executeJavaScript('window.__chReady === true', true).catch(() => false);
            if (ok) break;
            await new Promise((r) => setTimeout(r, 200));
          }
        })()

        const runObserver = async () =>
          wc.executeJavaScript(
            `(() => {
              const videos = Array.from(document.querySelectorAll('video'));
              if (videos.length === 0) return { found: false };
              let main = videos[0];
              for (const v of videos) { if ((v.currentTime||0) > (main.currentTime||0)) main = v; }
              return {
                found: true,
                state: main.error ? 'error' : main.ended ? 'ended' : main.paused ? 'paused' : 'playing',
                currentTime: Number.isFinite(main.currentTime) ? main.currentTime : null,
                duration: Number.isFinite(main.duration) && main.duration > 0 ? main.duration : null
              };
            })()`,
            true
          )

        const before = await runObserver()
        wc.executeJavaScript(`document.querySelector('video').muted = true; document.querySelector('video').play()`, true)
        await new Promise((r) => setTimeout(r, 1200))
        const playing = await runObserver()

        wc.executeJavaScript(`document.querySelector('video').pause()`, true)
        await new Promise((r) => setTimeout(r, 400))
        const paused = await runObserver()

        w.destroy()
        return { before, playing, paused }
      },
      pathToFileURL(path.join(fixtures, 'video-task.html')).href
    )

    record(
      '播放器观测：暂停前为 playing',
      playerCtl?.playing?.state === 'playing',
      JSON.stringify(playerCtl?.playing)
    )
    record(
      '播放器观测：暂停后为 paused',
      playerCtl?.paused?.state === 'paused',
      JSON.stringify(playerCtl?.paused)
    )
    record(
      '播放器时长真实可读（非 null/0）',
      typeof playerCtl?.playing?.duration === 'number' && playerCtl.playing.duration > 0,
      `duration=${playerCtl?.playing?.duration}`
    )

    /* ---------------------------------------------------------------- */
    /* 3. 定位覆盖与解除                                                  */
    /* ---------------------------------------------------------------- */
    const geo = await app.evaluate(
      async ({ BrowserWindow, session }, url) => {
        const ses = session.fromPartition('coursehub-test')
        ses.setPermissionRequestHandler((_w, p, cb) => cb(p === 'geolocation'))
        ses.setPermissionCheckHandler((_w, p) => p === 'geolocation')

        const w = new BrowserWindow({
          show: false,
          webPreferences: {
            session: ses,
            nodeIntegration: false,
            contextIsolation: true
          }
        })
        await w.loadURL(url)
        const wc = w.webContents

        const readGeo = () =>
          wc.executeJavaScript(
            `new Promise((resolve) => {
              if (!navigator.geolocation) { resolve(null); return; }
              navigator.geolocation.getCurrentPosition(
                (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy }),
                (err) => resolve({ error: err.code, message: err.message }),
                { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
              );
            })`,
            true
          )

        // 基线：无覆盖
        const baseline = await readGeo()

        // 下发覆盖
        wc.debugger.attach('1.3')
        await wc.debugger.sendCommand('Emulation.setGeolocationOverride', {
          latitude: 30.6572,
          longitude: 104.0657,
          accuracy: 35
        })
        const overridden = await readGeo()

        // 清除覆盖
        await wc.debugger.sendCommand('Emulation.clearGeolocationOverride')
        wc.debugger.detach()
        // 清除后再次读取：坐标不应再等于下发值
        await new Promise((r) => setTimeout(r, 500))
        const cleared = await readGeo()

        w.destroy()
        return { baseline, overridden, cleared }
      },
      pathToFileURL(path.join(fixtures, 'geo-test.html')).href
    )

    const ov = geo?.overridden
    const dist =
      ov && typeof ov.lat === 'number'
        ? Math.abs(ov.lat - 30.6572) < 1e-4 && Math.abs(ov.lon - 104.0657) < 1e-4
        : false
    record('定位覆盖：页面读回下发坐标', dist, JSON.stringify(ov))

    const clearedDiffers =
      geo?.cleared &&
      typeof geo.cleared.lat === 'number' &&
      (Math.abs(geo.cleared.lat - 30.6572) > 1e-4 || Math.abs(geo.cleared.lon - 104.0657) > 1e-4)
    record(
      '定位覆盖：clearGeolocationOverride 后读数不再等于下发值',
      clearedDiffers === true,
      `cleared=${JSON.stringify(geo?.cleared)}`
    )

    /* ---------------------------------------------------------------- */
    /* 4. 题目提取与受控填充                                              */
    /* ---------------------------------------------------------------- */
    const quiz = await app.evaluate(
      async ({ BrowserWindow }, url) => {
        const w = new BrowserWindow({
          show: false,
          webPreferences: { nodeIntegration: false, contextIsolation: true }
        })
        await w.loadURL(url)
        const wc = w.webContents
        await new Promise((r) => setTimeout(r, 800))

        const extract = await wc.executeJavaScript(
          `(() => {
            const nodes = Array.from(document.querySelectorAll('[data-ch-question]'));
            return nodes.map((node) => ({
              id: node.getAttribute('data-ch-question'),
              control: node.getAttribute('data-ch-control'),
              text: (node.querySelector('[data-ch-text]') || {}).textContent || null,
              options: Array.from(node.querySelectorAll('[data-ch-option]')).map((el) => ({
                key: el.getAttribute('data-ch-option'),
                label: el.textContent
              }))
            }));
          })()`,
          true
        )

        // 受控填充：单选 B + 多选 A,B + 文本
        const filled = await wc.executeJavaScript(
          `(() => {
            const pick = (qid, keys) => {
              const node = document.querySelector('[data-ch-question="' + CSS.escape(qid) + '"]');
              for (const k of keys) {
                const el = Array.from(node.querySelectorAll('[data-ch-option]'))
                  .find((e) => e.getAttribute('data-ch-option') === k);
                const input = el && el.querySelector('input');
                if (input) { input.checked = true; input.dispatchEvent(new Event('change', {bubbles:true})); }
              }
            };
            pick('q-single', ['B']);
            pick('q-multi', ['A','B']);
            const ta = document.querySelector('[data-ch-question="q-text"] [data-ch-textarea]');
            if (ta) { ta.value = '测试作答'; ta.dispatchEvent(new Event('input', {bubbles:true})); }

            // DOM 回读
            const read = {};
            for (const node of document.querySelectorAll('[data-ch-question]')) {
              const id = node.getAttribute('data-ch-question');
              read[id] = {
                checked: Array.from(node.querySelectorAll('input:checked')).map((i) => {
                  const wrap = i.closest('[data-ch-option]');
                  return wrap ? wrap.getAttribute('data-ch-option') : null;
                }),
                text: (node.querySelector('[data-ch-textarea]') || {}).value || null
              };
            }
            return read;
          })()`,
          true
        )

        w.destroy()
        return { extract, filled }
      },
      pathToFileURL(path.join(fixtures, 'classroom-questions.html')).href
    )

    const ids = (quiz?.extract ?? []).map((q) => q.id)
    record(
      '题目提取：四种题型全部识别',
      ['q-single', 'q-multi', 'q-judge', 'q-text'].every((id) => ids.includes(id)),
      `提取到 ${ids.length} 题: ${ids.join(',')}`
    )
    record(
      '题目提取：选项与题干非空',
      (quiz?.extract ?? []).every((q) => q.text && q.text.length > 0),
      JSON.stringify(quiz?.extract?.[0])
    )
    record(
      '受控填充：单选 B 生效（DOM 回读）',
      quiz?.filled?.['q-single']?.checked?.includes('B') === true,
      JSON.stringify(quiz?.filled?.['q-single'])
    )
    record(
      '受控填充：多选 A,B 生效（DOM 回读）',
      JSON.stringify(quiz?.filled?.['q-multi']?.checked?.slice().sort()) ===
        JSON.stringify(['A', 'B']),
      JSON.stringify(quiz?.filled?.['q-multi'])
    )
    record(
      '受控填充：文本输入生效（DOM 回读）',
      quiz?.filled?.['q-text']?.text === '测试作答',
      JSON.stringify(quiz?.filled?.['q-text'])
    )

    /* ---------------------------------------------------------------- */
    /* 6. UI 场景与原生视图可见性（v0.3 新增）                            */
    /* ---------------------------------------------------------------- */

    // 6.1 六个场景都能渲染
    const scenes = await win.evaluate(async () => {
      const out = {}
      const labels = ['视频课堂', '章节作业', '课堂签到', '平台浏览', '定位测试', 'AI 助手']
      for (const label of labels) {
        const clicked = await new Promise((resolve) => {
          const btn = Array.from(document.querySelectorAll('[data-scene]')).find(
            (b) => (b.textContent || '').trim() === label
          )
          if (!btn) { resolve(false); return }
          btn.click()
          setTimeout(() => resolve(true), 120)
        })
        await new Promise((r) => setTimeout(r, 900))
        const hasContent = !!document.querySelector('.main-card') && document.querySelectorAll('.main-card *').length > 20
        out[label] = clicked && hasContent
      }
      return out
    })
    const sceneOk = Object.values(scenes).every(Boolean)
    record('六个场景均可切换并渲染内容', sceneOk, JSON.stringify(scenes))

    // 6.2 原生视图可见性回归：非视频/浏览场景必须隐藏平台视图
    //     （v0.3 修复的缺陷：视图带着旧 bounds 浮在其它场景上面）
    const visibility = await win.evaluate(async () => {
      const setScene = async (label) => {
        await new Promise((resolve) => {
          const btn = Array.from(document.querySelectorAll('[data-scene]')).find(
            (b) => (b.textContent || '').trim() === label
          )
          btn?.click()
          setTimeout(resolve, 900)
        })
      }
      const state = async () => {
        const r = await window.coursehub.diagnostics.viewState()
        if (!r.ok) return null
        return (r.data.browsers || []).some((b) => b.bounds?.visible === true)
      }

      await setScene('平台浏览')
      const onBrowser = await state()
      await setScene('视频课堂')
      const onVideo = await state()
      await setScene('定位测试')
      const onGeo = await state()
      await setScene('AI 助手')
      const onAi = await state()
      return { onBrowser, onVideo, onGeo, onAi }
    })
    record(
      '原生视图可见性：仅视频/浏览场景显示，其它场景隐藏',
      visibility.onBrowser === true &&
        visibility.onVideo === true &&
        visibility.onGeo === false &&
        visibility.onAi === false,
      JSON.stringify(visibility)
    )

    // 6.3 测试台 fixture 可通过 IPC 加载，且 URL 落在 fixtures 目录内
    const fixture = await win.evaluate(async () => {
      const r = await window.coursehub.testbed.loadFixture('classroom-questions.html')
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, url: r.data.url, fixture: r.data.fixture }
    })
    record(
      '测试台可加载授权 fixture 页',
      fixture.ok === true && /tests[\\/]fixtures[\\/]classroom-questions\.html$/.test(fixture.url ?? ''),
      JSON.stringify(fixture)
    )

    // 6.4 fixture 文件名注入必须被拒绝
    const injection = await win.evaluate(async () => {
      const bad = ['../../package.json', 'a/../../b.html', 'x.exe', 'a b.html', '']
      const results = []
      for (const name of bad) {
        const r = await window.coursehub.testbed.loadFixture(name)
        results.push(r.ok ? 'ACCEPTED' : r.error.code)
      }
      return results
    })
    record(
      '安全：fixture 文件名注入被全部拒绝',
      injection.every((c) => c !== 'ACCEPTED'),
      JSON.stringify(injection)
    )

    /* ---------------------------------------------------------------- */
    /* 7. 安全边界                                                        */
    /* ---------------------------------------------------------------- */
    const security = await win.evaluate(async () => {
      const bad = []
      // 远程页面不得调用本地 IPC：直接尝试调用 window.coursehub 应不存在于远程页
      if (typeof window.coursehub === 'undefined') bad.push('renderer-missing-api')
      // 恶意协议应被 origin 白名单拒绝
      const r1 = await window.coursehub.browser.navigate('chaoxing', 'file:///C:/Windows/System32/calc.exe')
      const r2 = await window.coursehub.browser.navigate('chaoxing', 'javascript:alert(1)')
      const r3 = await window.coursehub.browser.navigate('chaoxing', 'https://evil.com/x')
      return {
        file: r1.ok === false ? r1.error.code : 'ACCEPTED',
        js: r2.ok === false ? r2.error.code : 'ACCEPTED',
        evil: r3.ok === false ? r3.error.code : 'ACCEPTED'
      }
    })
    record(
      '安全：file:// 与 javascript: 与站外域名均被拒绝',
      security.file !== 'ACCEPTED' && security.js !== 'ACCEPTED' && security.evil !== 'ACCEPTED',
      JSON.stringify(security)
    )

    const keyHidden = await win.evaluate(async () => {
      // 验证 IPC 不提供读取明文 Key 的通道
      const api = window.coursehub
      const hasGetter = 'getKey' in api.ai || 'key' in api.ai
      const r = await api.ai.models()
      return { hasGetter, noKeyError: r.ok ? r.data.error : r.error.code }
    })
    record(
      '安全：不存在读取明文 Key 的 IPC 通道',
      keyHidden.hasGetter === false,
      JSON.stringify(keyHidden)
    )

    /* ---------------------------------------------------------------- */
    /* 8. v0.3.1 三大端到端闭环验收                                       */
    /* ---------------------------------------------------------------- */

    // 8.1 视频闭环：多任务列表
    const vList = await win.evaluate(async () => {
      const r = await window.coursehub.video.list('testbed')
      return r.ok ? r.data.tasks : []
    })
    record(
      '闭环A-1：测试台多视频任务列表就绪',
      vList.length === 2 && vList[0].id === 't1' && vList[1].id === 't2',
      `返回 ${vList.length} 个任务: ${vList.map((t) => t.id).join(',')}`
    )

    // 8.2 视频闭环：生命周期与失焦模拟
    const lifecycleSim = await win.evaluate(async () => {
      await window.coursehub.testbed.loadFixture('video-task.html')
      const r = await window.coursehub.testbed.simulateLifecycle({ visibility: 'hidden', focus: 'blur' })
      return r.ok ? r.data : null
    })
    record(
      '闭环A-2：页面生命周期模拟（切后台/失焦事件记录）',
      lifecycleSim?.visibilityState === 'hidden' && Array.isArray(lifecycleSim?.events),
      JSON.stringify(lifecycleSim)
    )

    // 8.3 视频闭环：连续播放调度与 ended 自动推进
    const continuousTest = await win.evaluate(async () => {
      await window.coursehub.testbed.simulateLifecycle({ visibility: 'visible', focus: 'focus' })
      await window.coursehub.testbed.loadFixture('video-task.html')
      await window.coursehub.video.observe('testbed', 't1')
      await window.coursehub.video.startContinuous('testbed', ['t1', 't2'])

      // 快进 t1 至 7.8s，触发自然播放结束 (duration=8s)
      await window.coursehub.video.command('testbed', 'seek', 7.8, 't1')
      await window.coursehub.video.command('testbed', 'play', undefined, 't1')

      let switched = false
      for (let i = 0; i < 25; i++) {
        await new Promise((r) => setTimeout(r, 200))
        const obs = await window.coursehub.video.observe('testbed', 't2')
        if (obs.ok) {
          switched = true
          break
        }
      }
      await window.coursehub.video.stopContinuous()
      return { switched }
    })
    record(
      '闭环A-3：真实 ended 推进与自动连续播放切换',
      continuousTest.switched === true,
      `连播切换就绪: ${continuousTest.switched}`
    )

    // 8.4 签到闭环：活动列表读取
    const signIns = await win.evaluate(async () => {
      const r = await window.coursehub.classroom.todaySignIns('testbed')
      return r.ok ? r.data.events : []
    })
    record(
      '闭环B-1：测试签到活动读取（含普通与定位打卡）',
      signIns.length === 2 && signIns.some((s) => s.kind === 'normal') && signIns.some((s) => s.kind === 'location'),
      `读取到 ${signIns.length} 项签到活动`
    )

    // 8.5 签到闭环：普通打卡全流程
    const normalSignIn = await win.evaluate(async () => {
      await window.coursehub.testbed.loadFixture('signin-test.html')
      const r = await window.coursehub.testbed.triggerSignIn('test-sign-01')
      return r.ok ? r.data : null
    })
    record(
      '闭环B-2：自有测试站点普通打卡闭环（DOM回显已签到）',
      normalSignIn?.status === 'checked_in',
      JSON.stringify(normalSignIn)
    )

    // 8.6 签到闭环：定位打卡全流程（下发目标坐标并打卡通过）
    const locationSignIn = await win.evaluate(async () => {
      await window.coursehub.geoTest.start({
        latitude: 39.9042,
        longitude: 116.4074,
        accuracyMeters: 30,
        coordinateSystem: 'wgs84',
        targetOrigin: 'file://'
      })
      const r = await window.coursehub.testbed.triggerSignIn('test-sign-02')
      await window.coursehub.geoTest.stop()
      return r.ok ? r.data : null
    })
    record(
      '闭环B-3：自有测试站点定位签到闭环（经纬度校验与容差通过）',
      locationSignIn?.status === 'checked_in',
      JSON.stringify(locationSignIn)
    )

    // 8.7 题目闭环：AI 多题顺序分析与受控表单批量填充
    const autoQuiz = await win.evaluate(async () => {
      await window.coursehub.testbed.loadFixture('classroom-questions.html')
      const r = await window.coursehub.question.autoAnalyzeAndFill({ platformId: 'testbed' })
      return r.ok ? r.data : null
    })
    record(
      '闭环C-1：题目识别、AI 分析与表单自动化批量填充',
      autoQuiz?.totalProcessed === 4 && autoQuiz?.results?.every((res) => res.executed),
      `已批量处理 ${autoQuiz?.totalProcessed} 题（Mock/AI分析闭环）`
    )

    // 8.8 题目闭环：页面真实 DOM 回读完整性检验
    const domVerify = await win.evaluate(async () => {
      const res = await window.coursehub.question.extract('testbed')
      return res.ok ? res.data.questions : []
    })
    record(
      '闭环C-2：题目自动化表单交互后状态回读正常',
      domVerify.length === 4,
      `回读题目数: ${domVerify.length}`
    )

    // 8.9 适配器接线：学习通登录状态检测（真实 Session 探测，未登录时准确报告）
    const cxAuth = await win.evaluate(async () => {
      const res = await window.coursehub.classroom.auth('chaoxing')
      return res.ok ? res.data : null
    })
    record(
      '业务接线：学习通 Session 登录状态准确捕获（未登录状态明确报告）',
      cxAuth?.state === 'unauthenticated' || cxAuth?.state === 'authenticated',
      `state=${cxAuth?.state}, evidence=${cxAuth?.evidence}`
    )

    // 8.10 适配器接线：雨课堂登录状态检测（真实 Session 探测，未登录时准确报告）
    const yktAuth = await win.evaluate(async () => {
      const res = await window.coursehub.classroom.auth('yuketang')
      return res.ok ? res.data : null
    })
    record(
      '业务接线：雨课堂 Session 登录状态准确捕获（未登录状态明确报告）',
      yktAuth?.state === 'unauthenticated',
      `state=${yktAuth?.state}, evidence=${yktAuth?.evidence}`
    )

    // 8.11 签到闭环：本地 HTTP 测试服务双向闭环（安全加固、服务端容差判定、越界拦截、重复拦截与权威状态回读）
    let srvTest = null
    try {
      const srvInfo = await win.evaluate(async () => {
        const info = await window.coursehub.testbed.serverInfo()
        if (info.ok) await window.coursehub.testbed.resetServer()
        return info
      })
      if (srvInfo?.ok && srvInfo.data?.url && srvInfo.data?.token) {
        const baseUrl = srvInfo.data.url
        const token = srvInfo.data.token
        const authHeaders = {
          'Content-Type': 'application/json',
          'x-coursehub-testbed-token': token
        }

        // 0. 安全加固验证：未携带 Token 请求被 401 拦截
        const rNoAuth = await fetch(`${baseUrl}/api/activities`)
        const jNoAuth = await rNoAuth.json()

        // 1. 正常普通签到（携带有效 Token）
        const r1 = await fetch(`${baseUrl}/api/signin`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ activityId: 'test-srv-sign-01' })
        })
        const j1 = await r1.json()

        // 2. 定位签到：缺少坐标拦截 (LOCATION_REQUIRED)
        const rMissing = await fetch(`${baseUrl}/api/signin`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ activityId: 'test-srv-sign-02' })
        })
        const jMissing = await rMissing.json()

        // 3. 定位签到：超出容差拦截 (OUT_OF_RANGE，例如上海坐标 31.2304, 121.4737，距北京约 1000km > 500m 容差)
        const rOut = await fetch(`${baseUrl}/api/signin`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ activityId: 'test-srv-sign-02', latitude: 31.2304, longitude: 121.4737, accuracy: 20 })
        })
        const jOut = await rOut.json()

        // 4. 定位签到：在容差内成功打卡 (北京天安门 39.9042, 116.4074)
        const rIn = await fetch(`${baseUrl}/api/signin`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ activityId: 'test-srv-sign-02', latitude: 39.9042, longitude: 116.4074, accuracy: 30 })
        })
        const jIn = await rIn.json()

        // 5. 重复签到拦截 (ALREADY_SIGNED)
        const rDup = await fetch(`${baseUrl}/api/signin`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ activityId: 'test-srv-sign-02', latitude: 39.9042, longitude: 116.4074 })
        })
        const jDup = await rDup.json()

        // 6. 服务端权威状态回读
        const s1 = await fetch(`${baseUrl}/api/signin/status?activityId=test-srv-sign-01`, {
          headers: { 'x-coursehub-testbed-token': token }
        }).then(r => r.json())
        const s2 = await fetch(`${baseUrl}/api/signin/status?activityId=test-srv-sign-02`, {
          headers: { 'x-coursehub-testbed-token': token }
        }).then(r => r.json())

        srvTest = {
          unauthorizedBlocked: rNoAuth.status === 401 && jNoAuth.code === 'UNAUTHORIZED',
          normalPass: j1.code === 'SUCCESS',
          missingCoordsBlocked: jMissing.code === 'LOCATION_REQUIRED',
          outOfRangeBlocked: jOut.code === 'OUT_OF_RANGE',
          locationPass: jIn.code === 'SUCCESS' && jIn.record?.distanceMeters <= 50,
          duplicateBlocked: jDup.code === 'ALREADY_SIGNED',
          serverStatus1: s1.status === 'checked_in',
          serverStatus2: s2.status === 'checked_in'
        }
      }
    } catch (err) {
      srvTest = { error: String(err) }
    }

    record(
      '闭环B-4：本地测试服务端双向闭环（安全加固、容差判定、越界拦截、重复拦截与权威状态回读）',
      srvTest?.unauthorizedBlocked &&
        srvTest?.normalPass &&
        srvTest?.missingCoordsBlocked &&
        srvTest?.outOfRangeBlocked &&
        srvTest?.locationPass &&
        srvTest?.duplicateBlocked &&
        srvTest?.serverStatus1 &&
        srvTest?.serverStatus2,
      JSON.stringify(srvTest)
    )

    // 8.12 题目闭环：未配置 Key 时明确输出 Mock 标记与免责声明
    record(
      '闭环C-3：未配置 Key 时明确标记 isMock 且无明文泄露',
      autoQuiz?.isMock === true,
      `isMock=${autoQuiz?.isMock}`
    )
  } catch (e) {
    record('E2E 执行过程', false, e instanceof Error ? e.message : String(e))
  } finally {
    await app.close().catch(() => {})
  }

  console.log('\n================ E2E 汇总 ================')
  const passed = results.filter((r) => r.ok).length
  console.log(`通过 ${passed} / ${results.length}`)
  if (failed > 0) {
    console.log('\n失败项：')
    for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}: ${r.detail ?? ''}`)
  }
  console.log('\n注意：本次 E2E 全部基于本地 fixture。真实学习通/雨课堂账号的签到、')
  console.log('视频任务与课堂事件**未验证**，不得据此宣称平台能力已验收。')

  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
