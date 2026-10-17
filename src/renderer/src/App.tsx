import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  RotateCw,
  ExternalLink,
  AlertTriangle,
  Loader2,
  Globe,
  Camera,
  Sparkles
} from 'lucide-react'
import type { PlatformId, PlaybackObservation, GeoTestRun, ClassroomQuestion, PlayPolicy, TaskType, AIModelInfo, AIResult, ActiveQuestionContext } from '@shared/types'
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
  const [drawerTab, setDrawerTab] = useState<'ai' | 'controls'>('ai')
  const [drawerAiModelId, setDrawerAiModelId] = useState<string>('deepseek-flash')
  const [aiPromptText, setAiPromptText] = useState('')
  const [aiImagePreview, setAiImagePreview] = useState<string | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiStreamingText, setAiStreamingText] = useState('')
  const [aiResult, setAiResult] = useState<AIResult | null>(null)
  const [aiError, setAiError] = useState<string | null>(null)
  const [aiPrefill, setAiPrefill] = useState<ClassroomQuestion | null>(null)
  const [extractedQuestions, setExtractedQuestions] = useState<ClassroomQuestion[]>([])
  const [activeQuestionIdx, setActiveQuestionIdx] = useState<number>(0)
  const [questionContext, setQuestionContext] = useState<ActiveQuestionContext | null>(null)
  const [imageInfo, setImageInfo] = useState<{ width: number; height: number; mode: string } | null>(null)
  const [captureNotice, setCaptureNotice] = useState<string | null>(null)
  const activeContextIdRef = useRef<string | null>(null)
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
  useEffect(() => api.events.onAiDelta((chunk) => setAiStreamingText((prev) => prev + chunk)), [api])

  useEffect(() => {
    const unsub1 = api.events.onContinuousStopped(() => {
      setContinuous(false)
      pushActivity('已停止连续播放')
    })
    const unsub2 = api.events.onTaskSwitched((evt) => {
      // 切换任务/章节时：中断旧请求并重置上下文，避免旧回答错误标记为新题目
      void api.ai.cancel()
      activeContextIdRef.current = null
      setQuestionContext(null)
      setExtractedQuestions([])
      setActiveQuestionIdx(0)
      setAiPromptText('')
      setAiImagePreview(null)
      setImageInfo(null)
      setCaptureNotice(null)
      setAiStreamingText('')
      setAiResult(null)
      setAiError(null)

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
      // 切换课程时复位 AI 助教上下文，不混用不同课程的题目或截图
      void api.ai.cancel()
      activeContextIdRef.current = null
      setQuestionContext(null)
      setExtractedQuestions([])
      setActiveQuestionIdx(0)
      setAiPromptText('')
      setAiImagePreview(null)
      setImageInfo(null)
      setCaptureNotice(null)
      setAiStreamingText('')
      setAiResult(null)
      setAiError(null)

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

  useEffect(() => {
    if (models.length > 0) {
      setDrawerAiModelId((cur) => {
        if (cur && models.some((m) => m.id === cur)) return cur
        const vision = models.find((m) => m.inputModalities?.includes('image'))
        return vision?.id || models[0]!.id
      })
    }
  }, [models])

  const formatQuestionPrompt = (q: ClassroomQuestion, idx: number, total: number) => {
    const typeLabel =
      q.questionType === 'single'
        ? '单选题'
        : q.questionType === 'multiple'
          ? '多选题'
          : q.questionType === 'judgement'
            ? '判断题'
            : q.questionType === 'text'
              ? '填空/简答题'
              : '课堂题目'
    let formatted = `【${typeLabel}】（第 ${idx + 1}/${total} 题）\n${q.extractedText || ''}\n`
    if (q.options && q.options.length > 0) {
      formatted += '\n选项：\n' + q.options.map((opt) => `${opt.key}. ${opt.label}`).join('\n')
    }
    return formatted
  }

  const handleDrawerExtract = useCallback(async () => {
    try {
      setNotice('正在从当前课堂页面（含嵌套框架）穿透提取题目...')
      const r = await api.question.extract(activeId)
      if (!r.ok) {
        const errMsg = r.error.message ?? '未知错误'
        setNotice(`提取失败：${errMsg}（请确认平台视图已打开并加载完成）`)
        setDrawerTab('ai')
        setDrawerOpen(true)
        return
      }
      if (!r.data.questions || r.data.questions.length === 0) {
        // 生成诊断提示：从 debugInfo 中获取 frame URL 和 bodyClass
        const debugInfo = (r.data as { debugInfo?: { frameUrl?: string; candidateCount?: number; bodyClass?: string }[] }).debugInfo ?? []
        const frameCount = debugInfo.length
        const anyCandidate = debugInfo.some((d) => (d.candidateCount ?? 0) > 0)
        let diagMsg = '当前页面未检测到结构化题目。'
        if (frameCount === 0) {
          diagMsg += '平台视图未打开或页面未加载完成。'
        } else if (anyCandidate) {
          diagMsg += `已检测到候选题目节点但提取为空（共 ${frameCount} 个 frame）。可能是题目文本被图片替代，请使用截图分析。`
        } else {
          diagMsg += `共检查了 ${frameCount} 个 frame，未匹配到超星/主流平台的题目选择器。`
          diagMsg += '请先导航到包含题目的课堂测验页面，或点击「截当前视口」发送截图。'
        }
        setNotice(diagMsg)
        setDrawerTab('ai')
        setDrawerOpen(true)
        return
      }
      const qList = r.data.questions
      setExtractedQuestions(qList)
      setActiveQuestionIdx(0)

      const first = qList[0]!
      const ctxId = `ctx-${Date.now()}`
      activeContextIdRef.current = ctxId

      const currentChapter = tasks.find((t) => t.id === activeTaskId)
      const ctx: ActiveQuestionContext = {
        contextId: ctxId,
        platformId: activeId,
        courseName: selectedCourseName,
        courseId: null,
        chapterId: activeTaskId,
        chapterTitle: currentChapter?.title ?? null,
        questionId: first.id,
        questionIndex: 0,
        totalQuestions: qList.length,
        questionType: first.questionType,
        stemText: first.extractedText || '',
        options: first.options,
        images: first.images,
        imageSource: null,
        extractedAt: new Date().toISOString()
      }
      setQuestionContext(ctx)

      const formatted = formatQuestionPrompt(first, 0, qList.length)
      setAiPromptText(formatted)

      if (first.images && first.images.length > 0 && !aiImagePreview) {
        setAiImagePreview(first.images[0])
        setImageInfo({ width: 0, height: 0, mode: 'embedded' })
        setCaptureNotice('已自动选用该题目内嵌的高清原图')
      }

      setDrawerTab('ai')
      setDrawerOpen(true)
      setNotice(`已提取 ${qList.length} 道题目中的第 1 题，可在右侧编辑或直接发送`)
      pushActivity(`提取题目: ${first.extractedText?.slice(0, 24) ?? first.id}`)
    } catch (err) {
      setNotice(`提取题目失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [activeId, activeTaskId, tasks, selectedCourseName, aiImagePreview, api, pushActivity])

  const handleSelectQuestionIndex = useCallback((targetIdx: number) => {
    if (targetIdx < 0 || targetIdx >= extractedQuestions.length) return
    void api.ai.cancel()
    setActiveQuestionIdx(targetIdx)
    const targetQ = extractedQuestions[targetIdx]!
    const ctxId = `ctx-${Date.now()}`
    activeContextIdRef.current = ctxId

    const currentChapter = tasks.find((t) => t.id === activeTaskId)
    const ctx: ActiveQuestionContext = {
      contextId: ctxId,
      platformId: activeId,
      courseName: selectedCourseName,
      courseId: null,
      chapterId: activeTaskId,
      chapterTitle: currentChapter?.title ?? null,
      questionId: targetQ.id,
      questionIndex: targetIdx,
      totalQuestions: extractedQuestions.length,
      questionType: targetQ.questionType,
      stemText: targetQ.extractedText || '',
      options: targetQ.options,
      images: targetQ.images,
      imageSource: null,
      extractedAt: new Date().toISOString()
    }
    setQuestionContext(ctx)

    setAiPromptText(formatQuestionPrompt(targetQ, targetIdx, extractedQuestions.length))
    setAiStreamingText('')
    setAiResult(null)
    setAiError(null)

    if (targetQ.images && targetQ.images.length > 0) {
      setAiImagePreview(targetQ.images[0])
      setImageInfo({ width: 0, height: 0, mode: 'embedded' })
      setCaptureNotice('已自动选用该题目内嵌的高清原图')
    } else {
      setAiImagePreview(null)
      setImageInfo(null)
      setCaptureNotice(null)
    }

    setNotice(`已切换至第 ${targetIdx + 1} / ${extractedQuestions.length} 题`)
  }, [extractedQuestions, activeTaskId, tasks, selectedCourseName, activeId, api])

  const handleDrawerCapture = useCallback(async (mode: 'viewport' | 'full-question' = 'viewport') => {
    try {
      setNotice(mode === 'full-question' ? '正在完整捕获当前长题（含跨视口区域）...' : '正在截取当前画面...')
      const targetQid = questionContext?.questionId
      const r = await api.browser.captureView({
        platformId: activeId,
        mode,
        questionId: targetQid
      })
      if (!r.ok || !r.data.dataUrl) {
        setNotice(`截屏失败: ${r.ok ? '未获取到画面' : r.error.message}`)
        return
      }
      setAiImagePreview(r.data.dataUrl)
      setImageInfo({ width: r.data.width, height: r.data.height, mode: r.data.mode })
      setCaptureNotice(r.data.notice ?? null)
      if (questionContext) {
        setQuestionContext((prev) => prev ? {
          ...prev,
          imageSource: r.data.mode === 'full-question' ? 'full_question' : 'viewport'
        } : null)
      }
      setDrawerTab('ai')
      setDrawerOpen(true)
      if (!aiPromptText.trim()) {
        setAiPromptText('请逐字识别图中的文字，并分析题目给出答案与解析。')
      }
      setNotice(r.data.notice ?? (mode === 'full-question' ? '已完成长题完整截取，所有题干与选项已捕获' : '已截取当前课堂视口画面'))
      pushActivity(mode === 'full-question' ? '截取长题完整画面送入 AI' : '截取当前课堂画面送入 AI')
    } catch (err) {
      setNotice(`截屏失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [activeId, questionContext, api, aiPromptText, pushActivity])

  const handleUseEmbeddedImage = useCallback((url: string) => {
    setAiImagePreview(url)
    setImageInfo({ width: 0, height: 0, mode: 'embedded' })
    setCaptureNotice('已选用题目内嵌高清原图')
    if (questionContext) {
      setQuestionContext((prev) => prev ? { ...prev, imageSource: 'embedded' } : null)
    }
    setDrawerTab('ai')
    setDrawerOpen(true)
    setNotice('已选用题目内嵌的高清原图')
  }, [questionContext])

  const handleDrawerPickImageFile = useCallback((file: File) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string
      if (dataUrl) {
        setAiImagePreview(dataUrl)
        setImageInfo({ width: 0, height: 0, mode: 'file' })
        setCaptureNotice('已加载本地图片')
        if (questionContext) {
          setQuestionContext((prev) => prev ? { ...prev, imageSource: 'file' } : null)
        }
      }
    }
    reader.readAsDataURL(file)
  }, [questionContext])

  const handleDrawerSubmit = useCallback(async () => {
    if (!aiPromptText.trim() && !aiImagePreview) return
    setAiBusy(true)
    setAiStreamingText('')
    setAiResult(null)
    setAiError(null)

    const submissionCtxId = activeContextIdRef.current
    const chosenModel = drawerAiModelId || (models[0]?.id ?? 'deepseek-flash')
    const isImage = Boolean(aiImagePreview)
    const systemPrompt = isImage
      ? '你是一位大学专业课教学与答疑专家。请仔细阅读用户提供的图片与问题，提取题干与选项，给出推导过程和明确的答案建议。'
      : '你是一位大学专业课教学与答疑专家。请分析题目，给出清晰的推理过程、依据以及最终的推荐答案。'

    try {
      const res = await api.ai.generate({
        model: chosenModel,
        systemPrompt,
        userText: aiPromptText,
        imageDataUrl: aiImagePreview ?? null
      })

      // 切换上下文保护：若在等待期间用户切换了章节或题目，抛弃旧响应，严禁串题
      if (submissionCtxId && activeContextIdRef.current !== submissionCtxId) {
        return
      }

      if (res.ok) {
        if (res.data.cancelled) {
          setAiError('请求已由用户取消')
        } else if (res.data.error) {
          setAiError(res.data.error)
        } else if (res.data.result) {
          setAiResult(res.data.result)
          pushActivity(`AI 分析完成（${res.data.result.isMock ? 'Mock' : chosenModel}）`)
        }
      } else {
        setAiError(`生成失败: ${res.error.code} ${res.error.message}`)
      }
    } catch (err) {
      if (submissionCtxId && activeContextIdRef.current !== submissionCtxId) return
      setAiError(`请求异常: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      if (!submissionCtxId || activeContextIdRef.current === submissionCtxId) {
        setAiBusy(false)
      }
    }
  }, [aiPromptText, aiImagePreview, drawerAiModelId, models, api, pushActivity])

  const handleDrawerCancel = useCallback(async () => {
    await api.ai.cancel()
    setAiBusy(false)
    setNotice('已取消 AI 生成')
  }, [api])

  const handleDrawerClearAll = useCallback(() => {
    void api.ai.cancel()
    activeContextIdRef.current = null
    setQuestionContext(null)
    setExtractedQuestions([])
    setActiveQuestionIdx(0)
    setAiPromptText('')
    setAiImagePreview(null)
    setImageInfo(null)
    setCaptureNotice(null)
    setAiStreamingText('')
    setAiResult(null)
    setAiError(null)
  }, [api])

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
            onCaptureAndAskAi={() => void handleDrawerCapture()}
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

              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void handleDrawerExtract()}
                  title="从当前课堂网页中提取题目并载入右侧 AI 助手"
                  data-testid="browser-ai-extract"
                  style={{ fontSize: 11.5 }}
                >
                  <Sparkles size={13} />
                  AI 分析当前题目
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void handleDrawerCapture()}
                  title="截取当前视口画面并载入右侧 AI 助手"
                  data-testid="browser-ai-capture"
                  style={{ fontSize: 11.5 }}
                >
                  <Camera size={13} />
                  截屏分析
                </button>
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
                    <button
                      type="button"
                      className="btn"
                      onClick={() => void loadFixture('chaoxing-classroom-quiz.html')}
                      data-testid="load-cx-quiz-btn"
                    >
                      超星测验页
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
              const typeLabel =
                q.questionType === 'single'
                  ? '单选题'
                  : q.questionType === 'multiple'
                    ? '多选题'
                    : q.questionType === 'judgement'
                      ? '判断题'
                      : q.questionType === 'text'
                        ? '填空/简答题'
                        : '练习题'
              let formatted = `【${typeLabel}】${q.extractedText || ''}\n`
              if (q.options && q.options.length > 0) {
                formatted += '\n选项：\n' + q.options.map((opt) => `${opt.key}. ${opt.label}`).join('\n')
              }
              setAiPromptText(formatted)
              setDrawerTab('ai')
              setDrawerOpen(true)
              setNotice('已将作业题目载入右侧 AI 助教，可直接发送分析')
              pushActivity(`导入作业题至 AI: ${q.extractedText?.slice(0, 20) ?? q.id}`)
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
          drawerTab={drawerTab}
          onDrawerTabChange={setDrawerTab}
          aiProps={{
            models,
            modelError,
            selectedModelId: drawerAiModelId,
            onSelectModelId: setDrawerAiModelId,
            busy: aiBusy,
            promptText: aiPromptText,
            onChangePromptText: setAiPromptText,
            imagePreview: aiImagePreview,
            imageInfo,
            captureNotice,
            onClearImage: () => {
              setAiImagePreview(null)
              setImageInfo(null)
              setCaptureNotice(null)
              if (questionContext) {
                setQuestionContext((prev) => prev ? { ...prev, imageSource: null } : null)
              }
            },
            onPickImageFile: handleDrawerPickImageFile,
            onExtractFromPage: handleDrawerExtract,
            onCaptureFromPage: handleDrawerCapture,
            onUseEmbeddedImage: handleUseEmbeddedImage,
            onSubmit: handleDrawerSubmit,
            onCancel: handleDrawerCancel,
            onRegenerate: handleDrawerSubmit,
            onClearAll: handleDrawerClearAll,
            streamingText: aiStreamingText,
            result: aiResult,
            error: aiError,
            courseName: selectedCourseName,
            questionContext,
            onPrevQuestion: () => handleSelectQuestionIndex(activeQuestionIdx - 1),
            onNextQuestion: () => handleSelectQuestionIndex(activeQuestionIdx + 1)
          }}
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
