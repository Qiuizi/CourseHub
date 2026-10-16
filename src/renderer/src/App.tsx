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
import type { PlatformId, PlaybackObservation, GeoTestRun, ClassroomQuestion, PlayPolicy, TaskType, AIModelInfo } from '@shared/types'
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
import { CoursesScene, type CourseItem } from './features/CoursesScene'

const TEST_TASKS: ChapterTask[] = [
  { id: 'fixture-t1', title: '开场导学（测试素材）', order: 1, durationSeconds: 8, platformStatus: 'unknown' },
  { id: 'fixture-t2', title: '章节小测（测试素材）', order: 2, durationSeconds: 8, platformStatus: 'unknown' }
]

export default function App(): JSX.Element {
  const [scene, setScene] = useState<SceneId>('courses')
  const [platforms, setPlatforms] = useState<PlatformEntry[]>([])
  const [activeId, setActiveId] = useState<PlatformId>(() => {
    try {
      const saved = localStorage.getItem('coursehub_active_platform')
      if (saved && ['chaoxing', 'yuketang', 'zhihuishu', 'testbed'].includes(saved)) {
        return saved as PlatformId
      }
    } catch {}
    return 'chaoxing' // 默认优先进入实际业务平台
  })
  const [drawerOpen, setDrawerOpen] = useState(true)

  const [observation, setObservation] = useState<PlaybackObservation | null>(null)
  const [geoRun, setGeoRun] = useState<GeoTestRun | null>(null)
  const [geoBusy, setGeoBusy] = useState(false)

  const [continuous, setContinuous] = useState(false)
  const [playPolicy, setPlayPolicy] = useState<PlayPolicy>('video_only')
  const [autoMute, setAutoMute] = useState(true)
  const [submitMode, setSubmitMode] = useState<SubmitMode>('confirm')
  const [volume, setVolume] = useState(1)
  const [rate, setRate] = useState(1)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [models, setModels] = useState<AIModelInfo[]>([])
  const [modelError, setModelError] = useState<string | null>(null)
  const [aiPrefill, setAiPrefill] = useState<ClassroomQuestion | null>(null)
  const [activity, setActivity] = useState<{ id: string; time: string; title: string }[]>([])
  const [theme, setTheme] = useState<'light' | 'dark'>('light')

  const [tasks, setTasks] = useState<ChapterTask[]>([])
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null)
  const [selectedCourseName, setSelectedCourseName] = useState<string | null>(null)

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

  const tasksRef = useRef<ChapterTask[]>([])
  useEffect(() => {
    tasksRef.current = tasks
  }, [tasks])

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
      const target = tasksRef.current.find((x) => x.id === evt.currentTaskId)
      if (target?.sourceUrl && (target.sourceUrl.startsWith('http://') || target.sourceUrl.startsWith('https://'))) {
        void api.browser.navigate(activeId, target.sourceUrl)
      }
      void api.video.observe(activeId, evt.currentTaskId)
      pushActivity(`自动连续播放：切换至 ${target?.title ?? evt.currentTaskId}`)
      setNotice(`自动连播：已切换至 ${target?.title ?? evt.currentTaskId}`)
      if (!target?.taskType || target.taskType === 'unknown') {
        void api.video.inspectChapter({ platformId: activeId, chapterId: evt.currentTaskId })
      }
    })
    const unsub3 = api.events.onContinuousCompleted(() => {
      setContinuous(false)
      pushActivity('连续播放队列已全部完成')
      setNotice('连续播放队列已全部完成')
    })
    const unsub4 = api.events.onChapterInspected((res) => {
      setTasks((prev) =>
        prev.map((t) =>
          t.id === res.chapterId ? { ...t, taskType: res.taskType } : t
        )
      )
      pushActivity(`章节 [${res.chapterId}] 任务组件探测完毕：${res.taskType}`)
    })
    const unsub5 = api.events.onTaskSkipped((evt) => {
      pushActivity(`连播跳过非视频任务: ${evt.title}（自动跳过不代表平台任务完成）`)
      setNotice(`连播跳过非视频任务: ${evt.title}（自动跳过不代表平台任务完成）`)
    })
    const unsub6 = api.events.onContinuousPausedNonVideo((evt) => {
      setContinuous(false)
      pushActivity(`连播遇到非视频任务（${evt.title}），已安全暂停等待操作`)
      setNotice(`连播遇到非视频任务（${evt.title}），已安全暂停等待操作`)
    })
    const unsub7 = api.events.onContinuousError((evt) => {
      setContinuous(false)
      pushActivity(`连播异常中断: ${evt.message}`)
      setNotice(`连播中断：${evt.message}`)
    })
    const unsub8 = api.events.onActivityNotify((act) => {
      pushActivity(`【课堂活动通知】${act.courseName} · ${act.title}`)
      setNotice(`【课堂活动进行中】${act.courseName} - ${act.title}，点击课堂活动查看`)
    })
    return () => {
      unsub1()
      unsub2()
      unsub3()
      unsub4()
      unsub5()
      unsub6()
      unsub7()
      unsub8()
    }
  }, [api, activeId, pushActivity])

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
    const allPlatformIds: PlatformId[] = ['testbed', 'chaoxing', 'yuketang', 'zhihuishu']
    for (const id of allPlatformIds) {
      void api.browser.setVisible(id, usesPlatformView && id === activeId)
    }
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
    const currentPlatform = platforms.find((p) => p.id === activeId)
    // 关键优化：已登录状态下绝不进行 5 秒高频轰炸，避免触发平台风控踢出登录态；
    // 只有在未登录状态时才 5 秒轮询等待扫码；已登录后切换为低频保活（60 秒）
    if (scene === 'browser' && (activeId === 'chaoxing' || activeId === 'yuketang')) {
      const intervalMs = currentPlatform?.auth === 'authenticated' ? 60000 : 5000
      const timer = setInterval(() => {
        void checkAuth(activeId)
      }, intervalMs)
      return () => clearInterval(timer)
    }
    return undefined
  }, [activeId, scene, checkAuth, platforms])

  // 静音托管与底层物理音频管线联动：开关开启时确保全局静音，杜绝外放
  useEffect(() => {
    void api.video.setAudioMute(activeId, autoMute)
  }, [activeId, autoMute, api])

  const openPlatform = useCallback(
    async (id: PlatformId) => {
      setActiveId(id)
      try {
        localStorage.setItem('coursehub_active_platform', id)
      } catch {}
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

  const handlePolicyChange = useCallback(
    (nextPolicy: PlayPolicy) => {
      setPlayPolicy(nextPolicy)
      void api.video.setContinuousPolicy(nextPolicy)
      pushActivity(`连播策略切换为：${nextPolicy === 'stop_on_non_video' ? '遇到非视频暂停' : '仅播放视频'}`)
    },
    [api, pushActivity]
  )

  const handleContinuousChange = useCallback(
    (v: boolean) => {
      const confirmedVideoTasks = tasks.filter((t) => t.taskType === 'video')
      const allPlayableTasks = tasks.filter((t) => t.taskType === 'video' || t.taskType === 'unknown')

      if (v && confirmedVideoTasks.length === 0 && allPlayableTasks.length === 0) {
        setNotice('当前课程章节没有可播放的视频任务')
        setContinuous(false)
        return
      }

      setContinuous(v)
      pushActivity(
        v
          ? `开启连续播放（策略：${playPolicy === 'stop_on_non_video' ? '遇到非视频暂停' : '仅播放视频'}）`
          : '关闭连续播放'
      )
      if (v) {
        const queuePayload = tasks.map((t) => ({
          id: t.id,
          title: t.title,
          sourceUrl: t.sourceUrl,
          taskType: (t.taskType as TaskType) || 'unknown'
        }))
        void api.video.startContinuous({
          platformId: activeId,
          courseId: selectedCourseName ?? 'default',
          taskQueue: queuePayload,
          initialTaskId: activeTaskId ?? undefined,
          policy: playPolicy
        })
      } else {
        void api.video.stopContinuous()
      }
    },
    [tasks, activeId, activeTaskId, selectedCourseName, playPolicy, api, pushActivity]
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

  const handleEnterCourseStudy = useCallback(
    async (course: CourseItem) => {
      // 切换课程时彻底清理原队列及观察器，杜绝跨课程串队列
      void api.video.resetCourse()
      setContinuous(false)

      setSelectedCourseName(course.name)
      setScene('video')
      setNotice(`正在读取 ${course.name} 真实章节目录...`)
      pushActivity(`进入课程学习：${course.name}`)

      await ensureOpen(activeId)

      try {
        const res = await api.platform.chapters({
          platformId: activeId,
          courseId: course.courseId,
          clazzId: course.classId,
          cpi: course.cpi || '0'
        })

        if (!res.ok) {
          setNotice(`获取章节目录失败: ${res.error.message}`)
          return
        }

        if (!res.data.ok) {
          setNotice(`获取章节目录失败: ${res.data.error ?? '平台返回异常'}`)
          return
        }

        const rawChapters = res.data.chapters || []
        // 筛选叶子任务节点（具有学习跳转链接）
        const taskNodes = rawChapters.filter((ch) => ch.taskUrl)

        if (taskNodes.length === 0) {
          setNotice(`该课程暂无在线章节任务点，已在视图中打开课程首页`)
          const fallbackUrl =
            course.courseUrl ||
            `https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=${course.courseId}&clazzid=${course.classId}&cpi=${course.cpi || '0'}&ismooc2=1&v=2`
          void api.browser.navigate(activeId, fallbackUrl)
          setTasks([])
          setActiveTaskId(null)
          return
        }

        const chapterTasks: ChapterTask[] = taskNodes.map((ch) => ({
          id: ch.chapterId,
          title: ch.title,
          order: ch.order,
          durationSeconds: null,
          platformStatus: ch.status === 'completed' ? 'completed' : 'unknown',
          sourceUrl: ch.taskUrl ?? undefined,
          taskType: ch.taskType
        }))

        setTasks(chapterTasks)
        const first = chapterTasks[0]!
        setActiveTaskId(first.id)
        setNotice(`已加载 ${chapterTasks.length} 个章节任务点，正在打开第 1 个任务`)

        if (first.sourceUrl) {
          void api.browser.navigate(activeId, first.sourceUrl)
        }
        void startObserving(first.id)
        pushActivity(`已载入任务：${first.title}`)
        if (!first.taskType || first.taskType === 'unknown') {
          void api.video.inspectChapter({ platformId: activeId, chapterId: first.id })
        }
      } catch (err) {
        setNotice(`加载章节失败: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [activeId, api, ensureOpen, pushActivity, startObserving]
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
            courseName={selectedCourseName ?? (activeId === 'testbed' ? '测试台 · 本地 fixture' : null)}
            chapterName={
              activeTaskId
                ? (tasks.find((t) => t.id === activeTaskId)?.title ?? null)
                : '尚未打开视频任务'
            }
            tasks={tasks}
            activeTaskId={activeTaskId}
            continuous={continuous}
            onContinuousChange={handleContinuousChange}
            policy={playPolicy}
            onPolicyChange={handlePolicyChange}
            autoMute={autoMute}
            volume={volume}
            rate={rate}
            busy={busy}
            message={notice}
            viewportRef={videoViewportRef}
            onSelectTask={(id) => {
              setActiveTaskId(id)
              const t = tasks.find((x) => x.id === id)
              if (t?.sourceUrl) {
                void api.browser.navigate(activeId, t.sourceUrl)
              }
              void startObserving(id)
              pushActivity(`切换到任务 ${t?.title ?? id}`)
              if (!t?.taskType || t.taskType === 'unknown') {
                void api.video.inspectChapter({ platformId: activeId, chapterId: id })
              }
            }}
            onCommand={(a, v) => {
              if (a === 'mute') setAutoMute(true)
              if (a === 'unmute') setAutoMute(false)
              void runCommand(a, v)
            }}
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
              
              {/* 平台快捷切换组，避免用户找不到入口 */}
              <div style={{ display: 'inline-flex', gap: 4, background: 'var(--ch-nav)', padding: '2px 4px', borderRadius: 999 }}>
                {platforms.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="platform-pill"
                    aria-current={p.id === activeId}
                    style={{ padding: '3px 10px', fontSize: 11 }}
                    onClick={() => {
                      setActiveId(p.id)
                      void openPlatform(p.id)
                    }}
                  >
                    <span className={`dot ${p.auth === 'authenticated' ? 'on' : 'off'}`} />
                    {p.shortName}
                  </button>
                ))}
              </div>

              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                {activeId === 'testbed' ? (
                  <>
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
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn"
                    onClick={async () => {
                      await openPlatform(activeId)
                    }}
                    title={`打开 ${current?.name ?? activeId} 官方登录/主页`}
                  >
                    <Globe size={13} />
                    前往官方页面
                  </button>
                )}
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

      case 'courses':
        return (
          <CoursesScene
            platformId={activeId}
            platformName={current?.name ?? '学习通'}
            onOpenPlatform={() => void openPlatform(activeId)}
            onNavigateCourse={(url) => {
              setScene('browser')
              void ensureOpen(activeId).then(() => {
                void api.browser.navigate(activeId, url)
              })
            }}
            onEnterCourseStudy={(course) => void handleEnterCourseStudy(course)}
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
            onOpenPlatform={(url) => {
              setScene('browser')
              void ensureOpen(activeId).then(() => {
                if (url) void api.browser.navigate(activeId, url)
                else void openPlatform(activeId)
              })
            }}
            onOpenGeoScene={() => setScene('geo')}
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
          onContinuousChange={handleContinuousChange}
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
          <span>{notice}</span>
          {notice.includes('验证') && (
            <button
              type="button"
              className="btn btn-primary"
              style={{ padding: '2px 8px', fontSize: 11 }}
              onClick={() => {
                setScene('browser')
                setNotice(null)
              }}
            >
              前往内置验证
            </button>
          )}
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
