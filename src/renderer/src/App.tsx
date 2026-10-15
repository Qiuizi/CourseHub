import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  RotateCw,
  ExternalLink,
  AlertTriangle,
  Loader2,
  Globe
} from 'lucide-react'
import type { PlatformId, PlaybackObservation, GeoTestRun, ClassroomQuestion } from '@shared/types'
import { TopBar, SCENES, type SceneId, type PlatformEntry } from './components/TopBar'
import { Drawer, type SubmitMode } from './components/Drawer'
import { CapChip, Notice } from './components/ui'
import { VideoScene, type ChapterTask } from './features/VideoScene'
import { DashboardScene } from './features/DashboardScene'
import { SignInScene } from './features/SignInScene'
import { QuizScene } from './features/QuizScene'
import { GeoScene } from './features/GeoScene'
import { AiScene } from './features/AiScene'
import { SettingsScene } from './features/SettingsScene'

const TEST_TASKS: ChapterTask[] = [
  { id: 'fixture-t1', title: '开场导学（测试素材）', order: 1, durationSeconds: 8, platformStatus: 'unknown' },
  { id: 'fixture-t2', title: '章节小测（测试素材）', order: 2, durationSeconds: 8, platformStatus: 'unknown' }
]

export default function App(): JSX.Element {
  const [scene, setScene] = useState<SceneId>('video')
  const [platforms, setPlatforms] = useState<PlatformEntry[]>([])
  const [activeId, setActiveId] = useState<PlatformId>('testbed')
  const [drawerOpen, setDrawerOpen] = useState(true)

  const [observation, setObservation] = useState<PlaybackObservation | null>(null)
  const [geoRun, setGeoRun] = useState<GeoTestRun | null>(null)
  const [geoBusy, setGeoBusy] = useState(false)

  const [continuous, setContinuous] = useState(false)
  const [autoMute, setAutoMute] = useState(true)
  const [submitMode, setSubmitMode] = useState<SubmitMode>('confirm')
  const [volume, setVolume] = useState(1)
  const [rate, setRate] = useState(1)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [models, setModels] = useState<{ id: string; inputModalities: readonly string[] }[]>([])
  const [modelError, setModelError] = useState<string | null>(null)
  const [aiPrefill, setAiPrefill] = useState<ClassroomQuestion | null>(null)
  const [activity, setActivity] = useState<{ id: string; time: string; title: string }[]>([])
  const [theme, setTheme] = useState<'light' | 'dark'>('light')

  const [tasks, setTasks] = useState<ChapterTask[]>([])
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null)

  const videoViewportRef = useRef<HTMLDivElement | null>(null)
  const browserViewportRef = useRef<HTMLDivElement | null>(null)
  const geoViewportRef = useRef<HTMLDivElement | null>(null)
  /** 已打开过视图的平台，避免重复 attach/load。 */
  const openedRef = useRef<Set<PlatformId>>(new Set())

  const api = window.coursehub

  /* ------------------------------ 主题 ------------------------------ */
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  /* ---------------------------- 平台列表 ---------------------------- */
  useEffect(() => {
    void api.platform.list().then((r) => {
      if (!r.ok) {
        setNotice(`平台列表加载失败：${r.error.code} ${r.error.message}`)
        return
      }
      setPlatforms(
        r.data.map((p) => ({
          id: p.id,
          name: p.name,
          shortName: p.id === 'chaoxing' ? '学习通' : p.id === 'yuketang' ? '雨课堂' : p.id === 'zhihuishu' ? '智慧树' : '测试台',
          homeUrl: p.homeUrl,
          auth: 'unknown'
        }))
      )
    })
  }, [api])

  const pushActivity = useCallback((title: string) => {
    setActivity((prev) => [
      { id: `a-${Date.now()}`, time: new Date().toLocaleTimeString(), title },
      ...prev.slice(0, 7)
    ])
  }, [])

  /* --------------------------- 事件订阅 --------------------------- */
  useEffect(() => api.events.onVideoObservation(setObservation), [api])
  useEffect(() => api.events.onGeoUpdate(setGeoRun), [api])

  useEffect(() => {
    const unsub1 = api.events.onContinuousStopped(() => {
      setContinuous(false)
      pushActivity('已停止连续播放')
    })
    const unsub2 = api.events.onTaskSwitched((evt) => {
      setActiveTaskId(evt.currentTaskId)
      pushActivity(`自动连续播放：切换至 ${evt.currentTaskId}`)
      setNotice(`自动连播：已切换至 ${evt.currentTaskId}`)
    })
    const unsub3 = api.events.onContinuousCompleted(() => {
      setContinuous(false)
      pushActivity('连续播放队列已全部完成')
      setNotice('连续播放队列已全部完成')
    })
    return () => {
      unsub1()
      unsub2()
      unsub3()
    }
  }, [api, pushActivity])

  /* --------------------------- 原生视图 bounds --------------------------- */

  /**
   * 原生视图可见性控制。
   *
   * 关键：WebContentsView 不受 React CSS z-index 约束。若不在使用它的场景里
   * 隐藏/移除视图，它会带着上一次的 bounds 浮在其它场景上面——
   * 这正是开发文档 §5.1 警告的「原生视图挡住 UI」问题。
   */
  useEffect(() => {
    const usesPlatformView = scene === 'video' || scene === 'browser'
    void api.browser.setVisible(activeId, usesPlatformView)
    // 定位测试视图同样只在 geo 场景可见
    void api.geoTest.setActive(scene === 'geo')
  }, [scene, activeId, api])

  useEffect(() => {
    const el =
      scene === 'video'
        ? videoViewportRef.current
        : scene === 'browser'
          ? browserViewportRef.current
          : scene === 'geo'
            ? geoViewportRef.current
            : null
    if (!el) return

    const push = (): void => {
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) return
      const bounds = { x: r.x, y: r.y, width: r.width, height: r.height }
      if (scene === 'geo') void api.geoTest.setBounds(bounds)
      else void api.browser.setBounds(activeId, bounds)
    }

    push()
    const ro = new ResizeObserver(push)
    ro.observe(el)
    window.addEventListener('resize', push)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', push)
    }
  }, [scene, activeId, api, drawerOpen])

  /* ------------------------------ 动作 ------------------------------ */

  const checkAuth = useCallback(
    async (id: PlatformId) => {
      if (id === 'testbed' || id === 'zhihuishu') return
      try {
        const res = await api.classroom.auth(id)
        if (res.ok) {
          const authState =
            res.data.state === 'authenticated'
              ? 'authenticated'
              : res.data.state === 'expired'
                ? 'expired'
                : 'unknown'
          setPlatforms((prev) =>
            prev.map((p) => (p.id === id ? { ...p, auth: authState } : p))
          )
        }
      } catch {
        /* 静默忽略探测异常 */
      }
    },
    [api]
  )

  useEffect(() => {
    void checkAuth(activeId)
    if (scene === 'browser' && (activeId === 'chaoxing' || activeId === 'yuketang')) {
      const timer = setInterval(() => {
        void checkAuth(activeId)
      }, 5000)
      return () => clearInterval(timer)
    }
    return undefined
  }, [activeId, scene, checkAuth])

  const openPlatform = useCallback(
    async (id: PlatformId) => {
      setActiveId(id)
      setNotice(null)
      const r = await api.platform.open({ platformId: id, fixture: 'video-task.html' })
      if (!r.ok) {
        setNotice(`打开失败：${r.error.code} ${r.error.message}`)
        return
      }
      openedRef.current.add(id)
      setNotice(`已打开 ${id}`)
      pushActivity(`打开平台 ${id}`)
      void checkAuth(id)
    },
    [api, pushActivity, checkAuth]
  )

  const runCommand = useCallback(
    async (action: string, value?: number) => {
      setBusy(action)
      try {
        const r = await api.video.command(activeId, action, value, activeTaskId ?? undefined)
        setNotice(r.ok ? null : `失败：${r.error.code} ${r.error.message}`)
        if (r.ok && action === 'setRate') pushActivity(`倍速设为 ${value}x`)
      } finally {
        setBusy(null)
      }
    },
    [activeId, activeTaskId, api, pushActivity]
  )

  const startObserving = useCallback(
    async (taskId: string) => {
      const r = await api.video.observe(activeId, taskId)
      if (r.ok) pushActivity(`开始观测播放器 ${taskId}`)
      else setNotice(`观测失败：${r.error.code} ${r.error.message}`)
    },
    [activeId, api, pushActivity]
  )

  /**
   * 确保当前平台的视图已打开。
   * 切到依赖原生视图的场景（视频/浏览）时必须先打开，
   * 否则 WebContentsView 从未创建，区域呈现空白。
   */
  const ensureOpen = useCallback(
    async (id: PlatformId = activeId, fixture = 'video-task.html') => {
      if (openedRef.current.has(id)) return
      const r = await api.platform.open({ platformId: id, fixture })
      if (!r.ok) {
        setNotice(`打开失败：${r.error.code} ${r.error.message}`)
        return
      }
      openedRef.current.add(id)
      setNotice(`已打开 ${id}`)
      pushActivity(`打开平台 ${id}`)
    },
    [activeId, api, pushActivity]
  )

  const loadFixture = useCallback(
    async (name: string) => {
      const r = await api.testbed.loadFixture(name)
      if (!r.ok) {
        setNotice(`加载 fixture 失败：${r.error.code} ${r.error.message}`)
        return
      }
      openedRef.current.add('testbed')
      setNotice(`已加载 ${r.data.fixture}`)
      pushActivity(`加载测试素材 ${r.data.fixture}`)
      // 测试台有真实可播放视频：装载章节目录并开始观测
      if (name === 'video-task.html') {
        const vList = await api.video.list('testbed')
        const currentTasks = (vList.ok && vList.data.tasks.length > 0)
          ? (vList.data.tasks as ChapterTask[])
          : TEST_TASKS
        setTasks(currentTasks)
        const first = currentTasks[0]!
        setActiveTaskId(first.id)
        await startObserving(first.id)
      }
    },
    [api, pushActivity, startObserving]
  )

  const startGeo = useCallback(
    async (cfg: {
      latitude: number
      longitude: number
      accuracyMeters: number
      coordinateSystem: 'wgs84' | 'gcj02'
      targetOrigin: string
    }) => {
      setGeoBusy(true)
      try {
        const r = await api.geoTest.start(cfg)
        if (r.ok) {
          setGeoRun(r.data)
          pushActivity('启动定位覆盖（测试分区）')
        } else {
          setNotice(`定位测试失败：${r.error.code} ${r.error.message}`)
        }
      } finally {
        setGeoBusy(false)
      }
    },
    [api, pushActivity]
  )

  const stopGeo = useCallback(async () => {
    setGeoBusy(true)
    try {
      const r = await api.geoTest.stop()
      if (r.ok) {
        setGeoRun(r.data)
        pushActivity('解除定位覆盖')
      }
    } finally {
      setGeoBusy(false)
    }
  }, [api, pushActivity])

  const refreshModels = useCallback(async () => {
    const r = await api.ai.models()
    if (r.ok) {
      setModels(r.data.models)
      setModelError(r.data.error)
    } else {
      setModelError(`${r.error.code}: ${r.error.message}`)
    }
  }, [api])

  useEffect(() => {
    void refreshModels()
  }, [refreshModels])

  /**
   * 首屏打开默认平台（测试台）。
   * 不打开的话 WebContentsView 从不创建，视频/浏览场景会是一片空白——
   * 这是 v0.3 修复的关键缺陷。
   */
  useEffect(() => {
    void (async () => {
      const r = await api.testbed.loadFixture('video-task.html')
      if (!r.ok) {
        setNotice(`加载测试素材失败：${r.error.code} ${r.error.message}`)
        return
      }
      openedRef.current.add('testbed')
      setTasks(TEST_TASKS)
      const first = TEST_TASKS[0]!
      setActiveTaskId(first.id)
      pushActivity(`加载测试素材 ${r.data.fixture}`)
      await startObserving(first.id)
    })()
    // 故意只在挂载时跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const current = platforms.find((p) => p.id === activeId)

  /* ---------------------------- 场景渲染 ---------------------------- */

  const renderScene = (): JSX.Element => {
    switch (scene) {
      case 'video':
        return (
          <VideoScene
            platformName={current?.name ?? '测试台'}
            observation={observation}
            courseName={activeId === 'testbed' ? '测试台 · 本地 fixture' : null}
            chapterName={
              activeTaskId
                ? (tasks.find((t) => t.id === activeTaskId)?.title ?? null)
                : '尚未打开视频任务'
            }
            tasks={tasks}
            activeTaskId={activeTaskId}
            continuous={continuous}
            autoMute={autoMute}
            volume={volume}
            rate={rate}
            busy={busy}
            message={notice}
            viewportRef={videoViewportRef}
            onSelectTask={(id) => {
              setActiveTaskId(id)
              void startObserving(id)
              void api.video.command(activeId, 'play', undefined, id)
              pushActivity(`切换到任务 ${id}`)
            }}
            onCommand={(a, v) => void runCommand(a, v)}
            onVolumeChange={setVolume}
            onRateChange={(r) => {
              setRate(r)
              void runCommand('setRate', r)
            }}
            onLoadFixture={() => {
              setScene('video')
              void loadFixture('video-task.html')
            }}
            onSimulateLifecycle={(input) => {
              void api.testbed.simulateLifecycle(input).then((res) => {
                if (res.ok) {
                  pushActivity(`模拟生命周期: ${JSON.stringify(input)} -> state=${res.data.visibilityState}`)
                  setNotice(`生命周期已模拟：visibilityState=${res.data.visibilityState}, hasFocus=${res.data.hasFocus}`)
                }
              })
            }}
          />
        )

      case 'browser':
        return (
          <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 14px',
                borderBottom: '1px solid var(--ch-hairline)',
                flexWrap: 'wrap'
              }}
            >              <button type="button" className="icon-btn plain" onClick={() => void api.browser.command(activeId, 'back')} title="后退">
                <ChevronLeft size={16} />
              </button>
              <button type="button" className="icon-btn plain" onClick={() => void api.browser.command(activeId, 'forward')} title="前进">
                <ChevronRight size={16} />
              </button>
              <button type="button" className="icon-btn plain" onClick={() => void api.browser.command(activeId, 'reload')} title="刷新">
                <RotateCw size={15} />
              </button>

              <span className="chip chip-neutral">{current?.name ?? activeId}</span>
              <span style={{ fontSize: 11, color: 'var(--ch-text-2)' }}>
                独立持久化会话 · 权限默认全拒
              </span>

              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void loadFixture('video-task.html')}
                  title="加载测试台视频 fixture"
                >
                  <Globe size={13} />
                  测试视频页
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void loadFixture('classroom-questions.html')}
                >
                  测试题目页
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    const r = api.browser.openExternal(activeId, current?.homeUrl ?? '')
                    if (!r) setNotice('该 URL 不在平台白名单内，已拒绝用外部浏览器打开')
                  }}
                  title="用系统浏览器打开当前平台首页"
                >
                  <ExternalLink size={13} />
                  外部打开
                </button>
              </div>
            </div>

            <div
              ref={browserViewportRef}
              className="viewport"
              data-testid="browser-viewport"
              style={{ background: 'var(--ch-surface)' }}
            />

            <div style={{ padding: 10 }}>
              <Notice tone="info">
                远程平台页运行在 <code>nodeIntegration:false</code> / <code>contextIsolation:true</code> /
                <code>sandbox:true</code> 且<strong>不加载任何 preload</strong>，
                物理上无法调用本地 IPC 或读取 DeepSeek Key。
              </Notice>
            </div>
          </div>
        )

      case 'geo':
        return (
          <GeoScene
            run={geoRun}
            busy={geoBusy}
            onStart={(cfg) => void startGeo(cfg)}
            onStop={() => void stopGeo()}
          />
        )

      case 'ai':
        return (
          <AiScene
            models={models}
            modelError={modelError}
            onRefreshModels={() => void refreshModels()}
            onGenerate={(input) => api.ai.generate(input)}
            onCancel={() => void api.ai.cancel()}
            onExtractQuestions={async () => {
              const r = await api.question.extract(activeId)
              if (!r.ok) throw new Error(r.error.message)
              return r.data.questions
            }}
            onOpenSettings={() => setScene('settings')}
          />
        )

      case 'quiz':
        return (
          <QuizScene
            onAskAi={(q) => {
              setAiPrefill(q)
              setScene('ai')
            }}
            onGoExtract={() => {
              setScene('browser')
              void loadFixture('classroom-questions.html')
            }}
          />
        )

      case 'signin':
        return (
          <SignInScene
            platformId={activeId}
            platformName={current?.name ?? '测试台'}
            onOpenPlatform={() => void openPlatform(activeId)}
          />
        )

      case 'settings':
        return (
          <SettingsScene
            theme={theme}
            onThemeChange={setTheme}
            onModelsChanged={() => void refreshModels()}
            onNotify={setNotice}
          />
        )

      default:
        return (
          <DashboardScene
            platformName={current?.name ?? '测试台'}
            authLabel="未检测"
            authState="unknown"
            onOpenScene={(s) => setScene(s as SceneId)}
            onOpenPlatform={() => void openPlatform(activeId)}
          />
        )
    }
  }

  const aiReady = models.length > 0

  return (
    <div className="shell" data-testid="app-shell">
      <TopBar
        platforms={platforms}
        activePlatformId={activeId}
        onPlatformChange={(id) => {
          setActiveId(id)
          void openPlatform(id)
        }}
        scene={scene}
        onSceneChange={(s) => {
          setScene(s)
          // 依赖原生视图的场景必须先确保视图已创建，否则区域空白
          if (s === 'browser' || s === 'video') void ensureOpen(activeId)
          if (s === 'video' && tasks.length === 0) void loadFixture('video-task.html')
          if (s === 'geo') setNotice(null)
        }}
        aiReady={aiReady}
        drawerOpen={drawerOpen}
        onToggleDrawer={() => setDrawerOpen((v) => !v)}
        onOpenApiModal={() => setScene('settings')}
      />

      <div className="shell-body">
        <main className="main-card">
          {/* 工具栏 */}
          <div className="main-toolbar">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
              <span className={`chip ${current && current.auth === 'authenticated' ? 'chip-emerald' : 'chip-neutral'}`}>
                <span className={`dot ${current?.auth === 'authenticated' ? 'on' : 'off'}`} />
                {current?.auth === 'authenticated' ? '已登录' : '登录态未知'}
              </span>
              <span style={{ fontSize: 11.5, color: 'var(--ch-text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {SCENES.find((s) => s.id === scene)?.label ?? '工作台'}
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {busy && (
                <span className="chip chip-tint">
                  <Loader2 size={11} className="spin" />
                  {busy}
                </span>
              )}
              {activeId !== 'testbed' && (
                <span className="chip" title="真实平台能力未验证">
                  <AlertTriangle size={11} />
                  平台能力待验证
                </span>
              )}
              <CapChip state="supported" compact reason="本地 fixture 可重复验证" />
            </div>
          </div>

          {/* 场景内容 */}
          <div
            className="main-scroll"
            style={scene === 'browser' || scene === 'video' ? { padding: 0, background: 'var(--ch-content)' } : undefined}
          >
            {renderScene()}
          </div>
        </main>

        <Drawer
          observation={observation}
          continuous={continuous}
          onContinuousChange={(v) => {
            setContinuous(v)
            pushActivity(v ? '开启连续播放' : '关闭连续播放')
            if (v) void api.video.startContinuous(activeId, tasks.map(t => t.id))
            else void api.video.stopContinuous()
          }}
          autoMute={autoMute}
          onAutoMuteChange={setAutoMute}
          submitMode={submitMode}
          onSubmitModeChange={setSubmitMode}
          testLocation={geoRun ? `${geoRun.latitude.toFixed(4)}, ${geoRun.longitude.toFixed(4)}` : '未设置'}
          onChangeTestLocation={() => setScene('geo')}
          activity={activity}
          drawerOpen={drawerOpen}
        />
      </div>

      {notice && (
        <div
          style={{
            position: 'fixed',
            bottom: 16,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 90,
            background: 'var(--ch-surface)',
            border: '1px solid var(--ch-border)',
            borderRadius: 999,
            boxShadow: 'var(--sh-modal)',
            padding: '8px 18px',
            fontSize: 11.5,
            color: 'var(--ch-text)',
            display: 'flex',
            alignItems: 'center',
            gap: 8
          }}
          data-testid="notice"
        >
          {notice}
          <button type="button" className="btn btn-ghost" style={{ padding: '2px 6px' }} onClick={() => setNotice(null)}>
            ✕
          </button>
        </div>
      )}

      {aiPrefill && scene === 'ai' && (
        <div style={{ display: 'none' }} data-testid="ai-prefill">
          {JSON.stringify(aiPrefill)}
        </div>
      )}
    </div>
  )
}
