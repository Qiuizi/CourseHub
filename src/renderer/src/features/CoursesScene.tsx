import { useCallback, useEffect, useState, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import {
  BookOpen,
  RefreshCw,
  ExternalLink,
  User,
  Users,
  AlertCircle,
  Globe,
  CheckCircle2,
  Play,
  Search,
  Layers,
  Sparkles,
  Calendar
} from 'lucide-react'
import { Card, Empty, Notice } from '../components/ui'
import type { PlatformId } from '@shared/types'
import type { FeedbackCategory } from '@shared/feedback'

export interface CourseItem {
  courseId: string
  classId: string
  cpi?: string
  name: string
  teacherName?: string
  clazzName?: string
  courseUrl?: string
  coverUrl?: string
  platformId?: PlatformId
  isCurrentTerm?: boolean
  termLabel?: string
}

export interface CoursesSceneProps {
  platformId: PlatformId
  platformName: string
  onOpenPlatform: (targetPlatform?: PlatformId) => void
  onNavigateCourse: (url: string, targetPlatform?: PlatformId) => void
  onEnterCourseStudy?: (course: CourseItem) => void
  onSwitchPlatform?: (targetPlatform: PlatformId) => void
  onOpenFeedback?: (category: FeedbackCategory, description: string) => void
}

interface PlatformLoadStatus {
  loading: boolean
  state: string
  error: string | null
  count: number
}

export type SyncLifecycle =
  | 'idle'
  | 'syncing'
  | 'live_success'
  | 'using_cache'
  | 'need_captcha'
  | 'network_error'
  | 'confirmed_empty'
  | 'unauthenticated'

export function CoursesScene({
  platformId: _platformId,
  platformName: _platformName,
  onOpenPlatform,
  onNavigateCourse,
  onEnterCourseStudy,
  onSwitchPlatform,
  onOpenFeedback
}: CoursesSceneProps): ReactNode {
  // 平台独立在读课程状态（从 localStorage 读取上次成功同步持久化缓存，防进程重启清空）
  const [cxCourses, setCxCourses] = useState<CourseItem[]>(() => {
    try {
      const raw = localStorage.getItem('coursehub_cached_courses_cx')
      if (raw) return JSON.parse(raw) as CourseItem[]
    } catch {}
    return []
  })
  const [yktCourses, setYktCourses] = useState<CourseItem[]>(() => {
    try {
      const raw = localStorage.getItem('coursehub_cached_courses_ykt')
      if (raw) return JSON.parse(raw) as CourseItem[]
    } catch {}
    return []
  })
  const [cxSyncedAt, setCxSyncedAt] = useState<string | null>(() => {
    return localStorage.getItem('coursehub_synced_at_cx') || null
  })
  const [_yktSyncedAt, setYktSyncedAt] = useState<string | null>(() => {
    return localStorage.getItem('coursehub_synced_at_ykt') || null
  })

  const [loading, setLoading] = useState(false)
  const [_fetchedAt, setFetchedAt] = useState<string | null>(null)

  // 双平台生命周期状态（明确区分：本次成功、使用上次缓存、需要验证码、网络错误、确认无课程、未登录）
  const [cxSyncState, setCxSyncState] = useState<SyncLifecycle>(() => {
    return localStorage.getItem('coursehub_cached_courses_cx') ? 'using_cache' : 'idle'
  })
  const [yktSyncState, setYktSyncState] = useState<SyncLifecycle>(() => {
    return localStorage.getItem('coursehub_cached_courses_ykt') ? 'using_cache' : 'idle'
  })

  // 双平台各自独立状态记录（真实反映各平台鉴权、验证码与网络情况）
  const [cxStatus, setCxStatus] = useState<PlatformLoadStatus>({
    loading: false,
    state: 'unknown',
    error: null,
    count: 0
  })
  const [yktStatus, setYktStatus] = useState<PlatformLoadStatus>({
    loading: false,
    state: 'unknown',
    error: null,
    count: 0
  })

  // 筛选与搜索：默认优先展示当前学期在读课程，降低认知负荷
  const [selectedPlatform, setSelectedPlatform] = useState<'all' | 'chaoxing' | 'yuketang'>('all')
  const [selectedTermFilter, setSelectedTermFilter] = useState<'all' | 'current' | 'history'>('current')
  const [searchKeyword, setSearchKeyword] = useState<string>('')

  // 请求序号，防止并发刷新乱序与旧请求覆盖新请求
  const refreshSeqRef = useRef(0)

  // 聚合双平台在读课程
  const courses = useMemo(() => {
    return [...cxCourses, ...yktCourses]
  }, [cxCourses, yktCourses])

  // 学期筛选以真实课程字段为依据；无法确认的课程不强行归入本学期或历史课程
  const currentTermCount = useMemo(() => courses.filter((c) => c.isCurrentTerm === true).length, [courses])
  const historyTermCount = useMemo(() => courses.filter((c) => c.isCurrentTerm === false).length, [courses])

  const loadCourses = useCallback(async (target?: 'all' | 'chaoxing' | 'yuketang') => {
    const seq = ++refreshSeqRef.current
    const doCx = target === 'all' || target === 'chaoxing' || !target
    const doYkt = target === 'all' || target === 'yuketang' || !target

    setLoading(true)
    if (doCx) {
      setCxStatus((prev) => ({ ...prev, loading: true, error: null }))
      setCxSyncState('syncing')
    }
    if (doYkt) {
      setYktStatus((prev) => ({ ...prev, loading: true, error: null }))
      setYktSyncState('syncing')
    }

    const [cxRes, yktRes] = await Promise.allSettled([
      doCx ? window.coursehub.classroom.courses('chaoxing') : Promise.resolve(null),
      doYkt ? window.coursehub.classroom.courses('yuketang') : Promise.resolve(null)
    ])

    // 乱序防护：若等待期间有更新的请求发起，则丢弃旧请求结果
    if (seq !== refreshSeqRef.current) return

    const nowTimeStr = new Date().toLocaleTimeString()

    // 1. 处理超星学习通响应
    if (doCx) {
      if (cxRes.status === 'fulfilled' && cxRes.value) {
        const res = cxRes.value
        if (res.ok) {
          const data = res.data
          const rawList = ((data.courses as CourseItem[]) || []).map((c) => ({
            ...c,
            platformId: 'chaoxing' as const
          }))

          const isCaptcha = data.state === 'need_captcha' || (data.error && (data.error.includes('安全验证') || data.error.includes('验证码')))

          if (rawList.length > 0) {
            // 本次同步成功
            setCxCourses(rawList)
            setCxSyncState('live_success')
            setCxSyncedAt(nowTimeStr)
            try {
              localStorage.setItem('coursehub_cached_courses_cx', JSON.stringify(rawList))
              localStorage.setItem('coursehub_synced_at_cx', nowTimeStr)
            } catch {}
          } else if (isCaptcha) {
            // 需要验证码：保留上次成功缓存，不予清空
            setCxSyncState('need_captcha')
          } else if (data.state === 'supported') {
            // 接口明确返回成功且确无课程
            setCxCourses([])
            setCxSyncState('confirmed_empty')
            try {
              localStorage.removeItem('coursehub_cached_courses_cx')
              localStorage.removeItem('coursehub_synced_at_cx')
            } catch {}
          } else if (data.state === 'unauthenticated' || data.state === 'expired') {
            setCxCourses([])
            setCxSyncState('unauthenticated')
          } else {
            setCxSyncState(cxCourses.length > 0 ? 'using_cache' : 'network_error')
          }

          setCxStatus((prev) => ({
            loading: false,
            state: data.state,
            error: data.error || null,
            count: rawList.length > 0 ? rawList.length : prev.count
          }))
        } else {
          setCxSyncState(cxCourses.length > 0 ? 'using_cache' : 'network_error')
          setCxStatus((prev) => ({
            loading: false,
            state: 'error',
            error: res.error.message,
            count: prev.count
          }))
        }
      } else if (cxRes.status === 'rejected') {
        setCxSyncState(cxCourses.length > 0 ? 'using_cache' : 'network_error')
        setCxStatus((prev) => ({
          loading: false,
          state: 'error',
          error: String(cxRes.reason),
          count: prev.count
        }))
      }
    }

    // 2. 处理雨课堂响应
    if (doYkt) {
      if (yktRes.status === 'fulfilled' && yktRes.value) {
        const res = yktRes.value
        if (res.ok) {
          const data = res.data
          const rawList = ((data.courses as CourseItem[]) || []).map((c) => ({
            ...c,
            platformId: 'yuketang' as const
          }))

          if (rawList.length > 0) {
            // 本次同步成功
            setYktCourses(rawList)
            setYktSyncState('live_success')
            setYktSyncedAt(nowTimeStr)
            try {
              localStorage.setItem('coursehub_cached_courses_ykt', JSON.stringify(rawList))
              localStorage.setItem('coursehub_synced_at_ykt', nowTimeStr)
            } catch {}
          } else if (data.state === 'supported') {
            // 接口明确返回成功且确无课程
            setYktCourses([])
            setYktSyncState('confirmed_empty')
            try {
              localStorage.removeItem('coursehub_cached_courses_ykt')
              localStorage.removeItem('coursehub_synced_at_ykt')
            } catch {}
          } else if (data.state === 'unauthenticated' || data.state === 'expired') {
            setYktCourses([])
            setYktSyncState('unauthenticated')
          } else {
            setYktSyncState(yktCourses.length > 0 ? 'using_cache' : 'network_error')
          }

          setYktStatus((prev) => ({
            loading: false,
            state: data.state,
            error: data.error || null,
            count: rawList.length > 0 ? rawList.length : prev.count
          }))
        } else {
          setYktSyncState(yktCourses.length > 0 ? 'using_cache' : 'network_error')
          setYktStatus((prev) => ({
            loading: false,
            state: 'error',
            error: res.error.message,
            count: prev.count
          }))
        }
      } else if (yktRes.status === 'rejected') {
        setYktSyncState(yktCourses.length > 0 ? 'using_cache' : 'network_error')
        setYktStatus((prev) => ({
          loading: false,
          state: 'error',
          error: String(yktRes.reason),
          count: prev.count
        }))
      }
    }

    setFetchedAt(nowTimeStr)
    setLoading(false)
  }, [cxCourses.length, yktCourses.length])

  useEffect(() => {
    void loadCourses('all')
  }, [loadCourses])

  const filteredCourses = useMemo(() => {
    return courses.filter((c) => {
      if (selectedPlatform !== 'all' && c.platformId !== selectedPlatform) {
        return false
      }
      if (selectedTermFilter === 'current' && c.isCurrentTerm !== true) {
        return false
      }
      if (selectedTermFilter === 'history' && c.isCurrentTerm !== false) {
        return false
      }
      if (searchKeyword.trim()) {
        const kw = searchKeyword.trim().toLowerCase()
        const matchName = c.name?.toLowerCase().includes(kw)
        const matchTeacher = c.teacherName?.toLowerCase().includes(kw)
        const matchClass = c.clazzName?.toLowerCase().includes(kw)
        if (!matchName && !matchTeacher && !matchClass) {
          return false
        }
      }
      return true
    })
  }, [courses, selectedPlatform, selectedTermFilter, searchKeyword])

  const handleEnterCourse = (c: CourseItem) => {
    if (c.platformId === 'yuketang') {
      const targetUrl = c.courseUrl || `https://www.yuketang.cn/v2/web/studentlog/${c.classId}`
      onNavigateCourse(targetUrl, 'yuketang')
    } else {
      const targetUrl =
        c.courseUrl ||
        `https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=${c.courseId}&clazzid=${c.classId}&cpi=${c.cpi || '0'}&ismooc2=1&v=2`
      onNavigateCourse(targetUrl, 'chaoxing')
    }
  }

  // 学习通与雨课堂异常分类判断
  const isCxCaptcha =
    cxSyncState === 'need_captcha' ||
    cxStatus.state === 'need_captcha' ||
    Boolean(cxStatus.error && (cxStatus.error.includes('安全验证') || cxStatus.error.includes('验证码') || cxStatus.error.includes('NEED_CAPTCHA')))

  const isYktUnauth =
    yktSyncState === 'unauthenticated' ||
    yktStatus.state === 'unauthenticated' ||
    yktStatus.state === 'expired' ||
    Boolean(yktStatus.error && (yktStatus.error.includes('未登录') || yktStatus.error.includes('sessionid') || yktStatus.error.includes('401')))

  const isCxUnauth =
    !isCxCaptcha &&
    (cxSyncState === 'unauthenticated' ||
      cxStatus.state === 'unauthenticated' ||
      cxStatus.state === 'expired' ||
      Boolean(cxStatus.error && (cxStatus.error.includes('未登录') || cxStatus.error.includes('AUTH_EXPIRED'))))

  return (
    <div style={{ maxWidth: 1040, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* 学习通触发验证码强提示 */}
      {isCxCaptcha && (
        <Notice tone="warn">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <AlertCircle size={16} style={{ color: '#f59e0b', flexShrink: 0 }} />
              <span>
                <strong>学习通安全验证：</strong>检测到学习通触发了滑动验证码或人机拦截。
                {cxCourses.length > 0
                  ? ` 当前已保留并展示上次成功同步的 ${cxCourses.length} 门在读课程${cxSyncedAt ? `（同步于 ${cxSyncedAt}）` : ''}。请前往平台浏览器完成验证码。`
                  : ' 请前往平台浏览器完成滑动验证码以加载最新课程。'}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  if (onSwitchPlatform) onSwitchPlatform('chaoxing')
                  onOpenPlatform('chaoxing')
                }}
                style={{ padding: '4px 12px', fontSize: 11, whiteSpace: 'nowrap' }}
              >
                前往学习通完成验证
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => void loadCourses('chaoxing')}
                style={{ padding: '4px 10px', fontSize: 11, whiteSpace: 'nowrap' }}
              >
                已完成验证，重新同步
              </button>
            </div>
          </div>
        </Notice>
      )}

      {/* 学习通网络异常提示 */}
      {cxSyncState === 'network_error' && !isCxCaptcha && (
        <Notice tone="warn">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <AlertCircle size={16} style={{ color: '#f59e0b', flexShrink: 0 }} />
              <span>
                <strong>学习通网络异常：</strong>无法同步学习通课程数据（{cxStatus.error || '网络连接超时'}）。
                {cxCourses.length > 0
                  ? ` 当前已展示上次成功缓存的 ${cxCourses.length} 门课程${cxSyncedAt ? `（缓存于 ${cxSyncedAt}）` : ''}。`
                  : ' 当前无可用缓存课程。'}
              </span>
            </div>
            <button
              type="button"
              className="btn"
              onClick={() => void loadCourses('chaoxing')}
              style={{ padding: '4px 10px', fontSize: 11, whiteSpace: 'nowrap' }}
            >
              重试同步
            </button>
          </div>
        </Notice>
      )}

      {/* 跨平台登录与状态通知条 */}
      {isYktUnauth && (
        <Notice tone="info">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
            <span>
              <strong>雨课堂状态：</strong>当前未在内置浏览器检测到雨课堂持久会话（需包含 sessionid）。请先在平台浏览器中完成微信扫码登录。
            </span>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                if (onSwitchPlatform) onSwitchPlatform('yuketang')
                onOpenPlatform('yuketang')
              }}
              style={{ marginLeft: 12, padding: '3px 10px', fontSize: 11, whiteSpace: 'nowrap' }}
            >
              登录雨课堂
            </button>
          </div>
        </Notice>
      )}

      {/* 雨课堂异常提示条（优雅降级与反馈） */}
      {yktStatus.state === 'error' && !isYktUnauth && (
        <Notice tone="warn">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', flexWrap: 'wrap', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5 }}>
              <AlertCircle size={15} style={{ color: '#d97706', flexShrink: 0 }} />
              <span>
                雨课堂课程暂时无法同步，可能是平台更新或网络异常。你仍可以打开原平台，也可以向开发者反馈问题。
                {yktCourses.length > 0 && `（已为你保留上次成功同步的 ${yktCourses.length} 门课程缓存）`}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                type="button"
                className="btn"
                onClick={() => void loadCourses('yuketang')}
                style={{ padding: '3px 10px', fontSize: 11 }}
              >
                重试
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  if (onSwitchPlatform) onSwitchPlatform('yuketang')
                  onOpenPlatform('yuketang')
                }}
                style={{ padding: '3px 10px', fontSize: 11 }}
              >
                打开原平台
              </button>
              {onOpenFeedback && (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => onOpenFeedback('course_sync', `雨课堂课程同步异常: ${yktStatus.error || '解析失败'}`)}
                  style={{ padding: '3px 10px', fontSize: 11 }}
                >
                  反馈问题
                </button>
              )}
            </div>
          </div>
        </Notice>
      )}

      {/* 学习通接口异常提示条 */}
      {cxStatus.state === 'error' && !isCxUnauth && !isCxCaptcha && (
        <Notice tone="warn">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', flexWrap: 'wrap', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5 }}>
              <AlertCircle size={15} style={{ color: '#d97706', flexShrink: 0 }} />
              <span>
                学习通课程暂时无法同步，可能是平台更新或网络异常。你仍可以打开原平台，也可以向开发者反馈问题。
                {cxCourses.length > 0 && `（已为你保留上次成功同步的 ${cxCourses.length} 门课程缓存）`}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                type="button"
                className="btn"
                onClick={() => void loadCourses('chaoxing')}
                style={{ padding: '3px 10px', fontSize: 11 }}
              >
                重试
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  if (onSwitchPlatform) onSwitchPlatform('chaoxing')
                  onOpenPlatform('chaoxing')
                }}
                style={{ padding: '3px 10px', fontSize: 11 }}
              >
                打开原平台
              </button>
              {onOpenFeedback && (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => onOpenFeedback('course_sync', `学习通课程同步异常: ${cxStatus.error || '解析失败'}`)}
                  style={{ padding: '3px 10px', fontSize: 11 }}
                >
                  反馈问题
                </button>
              )}
            </div>
          </div>
        </Notice>
      )}

      {isCxUnauth && (
        <Notice tone="error">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
            <span>
              <strong>学习通状态：</strong>{cxStatus.error}
            </span>
            <button
              type="button"
              className="btn"
              onClick={() => {
                if (onSwitchPlatform) onSwitchPlatform('chaoxing')
                onOpenPlatform('chaoxing')
              }}
              style={{ marginLeft: 12, padding: '3px 10px', fontSize: 11, whiteSpace: 'nowrap' }}
            >
              前往学习通登录
            </button>
          </div>
        </Notice>
      )}

      <Card
        title="我的课程"
        action={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void loadCourses('all')}
              disabled={loading}
              data-testid="courses-refresh"
              style={{ fontSize: 11.5, padding: '4px 12px', borderRadius: 999 }}
            >
              <RefreshCw size={12} className={loading ? 'spin' : undefined} />
              {loading ? '正在同步...' : '刷新课程'}
            </button>
          </div>
        }
      >
        {/* 顶部工具栏：平台切换 Pill + 快速过滤搜索框 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 12,
            paddingBottom: 12,
            borderBottom: '1px solid var(--ch-border)'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <button
                type="button"
                className={`btn ${selectedPlatform === 'all' ? 'accent' : ''}`}
                style={{ padding: '4px 10px', fontSize: 12 }}
                onClick={() => setSelectedPlatform('all')}
                data-testid="filter-platform-all"
              >
                <Layers size={13} />
                全部 ({courses.length})
              </button>
              <button
                type="button"
                className={`btn ${selectedPlatform === 'chaoxing' ? 'accent' : ''}`}
                style={{ padding: '4px 10px', fontSize: 12 }}
                onClick={() => setSelectedPlatform('chaoxing')}
                data-testid="filter-platform-chaoxing"
              >
                学习通 ({cxCourses.length})
                {isCxCaptcha && (
                  <span style={{ fontSize: 10, color: '#f59e0b', marginLeft: 4 }}>[需验证码]</span>
                )}
              </button>
              <button
                type="button"
                className={`btn ${selectedPlatform === 'yuketang' ? 'accent' : ''}`}
                style={{ padding: '4px 10px', fontSize: 12 }}
                onClick={() => setSelectedPlatform('yuketang')}
                data-testid="filter-platform-yuketang"
              >
                雨课堂 ({yktCourses.length})
                {isYktUnauth && (
                  <span style={{ fontSize: 10, color: '#f59e0b', marginLeft: 4 }}>[未登录]</span>
                )}
              </button>
            </div>

            <span style={{ color: 'var(--ch-border)', margin: '0 2px' }}>|</span>

            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <button
                type="button"
                className={`btn ${selectedTermFilter === 'all' ? 'accent' : ''}`}
                style={{ padding: '3px 8px', fontSize: 11 }}
                onClick={() => setSelectedTermFilter('all')}
                data-testid="filter-term-all"
              >
                全学期
              </button>
              <button
                type="button"
                className={`btn ${selectedTermFilter === 'current' ? 'accent' : ''}`}
                style={{ padding: '3px 8px', fontSize: 11 }}
                onClick={() => setSelectedTermFilter('current')}
                data-testid="filter-term-current"
                title="当前学期在读课程"
              >
                <Calendar size={11} />
                本学期 ({currentTermCount})
              </button>
              <button
                type="button"
                className={`btn ${selectedTermFilter === 'history' ? 'accent' : ''}`}
                style={{ padding: '3px 8px', fontSize: 11 }}
                onClick={() => setSelectedTermFilter('history')}
                data-testid="filter-term-history"
                title="往期结课与历史课程"
              >
                往期历史 ({historyTermCount})
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                background: 'var(--ch-surface-2)',
                border: '1px solid var(--ch-border)',
                borderRadius: 6,
                padding: '4px 8px',
                gap: 6
              }}
            >
              <Search size={13} style={{ color: 'var(--ch-text-3)' }} />
              <input
                type="text"
                placeholder="按课程名称/教师检索..."
                value={searchKeyword}
                onChange={(e) => setSearchKeyword(e.target.value)}
                style={{
                  border: 'none',
                  background: 'transparent',
                  outline: 'none',
                  fontSize: 12,
                  color: 'var(--ch-text)',
                  width: 180
                }}
              />
              {searchKeyword && (
                <button
                  type="button"
                  onClick={() => setSearchKeyword('')}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    color: 'var(--ch-text-3)',
                    fontSize: 12
                  }}
                >
                  ✕
                </button>
              )}
            </div>
          </div>
        </div>

        {/* 课程列表展示 */}
        {loading && courses.length === 0 ? (
          <Empty
            icon={<RefreshCw size={24} className="spin" />}
            text="正在拉取双平台真实课程列表，请稍候..."
          />
        ) : filteredCourses.length === 0 ? (
          <div style={{ padding: '24px 0', textAlign: 'center' }}>
            {selectedPlatform === 'chaoxing' && isCxCaptcha ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
                <Empty
                  icon={<AlertCircle size={28} style={{ color: '#f59e0b' }} />}
                  tone="warn"
                  text="学习通当前触发了安全验证码拦截。请在平台浏览器中完成滑动验证。"
                />
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    if (onSwitchPlatform) onSwitchPlatform('chaoxing')
                    onOpenPlatform('chaoxing')
                  }}
                >
                  <Globe size={14} />
                  打开内置浏览器完成验证
                </button>
              </div>
            ) : selectedPlatform === 'yuketang' && isYktUnauth ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
                <Empty
                  icon={<AlertCircle size={28} style={{ color: '#f59e0b' }} />}
                  tone="warn"
                  text="雨课堂尚未登录或凭证已失效。请先在平台浏览器中完成扫码登录。"
                />
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    if (onSwitchPlatform) onSwitchPlatform('yuketang')
                    onOpenPlatform('yuketang')
                  }}
                >
                  <Globe size={14} />
                  打开内置浏览器登录雨课堂
                </button>
              </div>
            ) : (
              <Empty
                icon={<AlertCircle size={24} />}
                tone="neutral"
                text={
                  searchKeyword
                    ? `没有找到匹配 “${searchKeyword}” 的课程`
                    : '当前分类下暂无在读课程。'
                }
              />
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 12 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '4px 2px',
                fontSize: 12,
                color: 'var(--ch-text-2)'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <CheckCircle2 size={14} style={{ color: '#10b981' }} />
                <span>
                  共展示 <strong>{filteredCourses.length}</strong> 门真实课程
                  {selectedPlatform === 'all' && `（学习通 ${cxCourses.length} 门，雨课堂 ${yktCourses.length} 门）`}
                </span>
              </div>
              <span style={{ fontSize: 11, color: 'var(--ch-text-3)' }}>
                点击“章节学习”进入内置视频与习题，或点击“原网页”打开平台界面
              </span>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
                gap: 14
              }}
              data-testid="courses-grid"
            >
              {filteredCourses.map((c) => {
                const isYkt = c.platformId === 'yuketang'
                return (
                  <div
                    key={`${c.platformId || 'platform'}-${c.courseId}-${c.classId}`}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      borderRadius: 8,
                      border: '1px solid var(--ch-border)',
                      background: 'var(--ch-surface-2)',
                      overflow: 'hidden',
                      transition: 'border-color 0.15s, box-shadow 0.15s'
                    }}
                    className="course-card"
                  >
                    {/* 封面区域与平台标签 */}
                    <div
                      style={{
                        height: 110,
                        background: 'var(--ch-surface-3)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        position: 'relative',
                        overflow: 'hidden'
                      }}
                    >
                      {c.coverUrl ? (
                        <img
                          src={c.coverUrl}
                          alt={c.name}
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          onError={(e) => {
                            e.currentTarget.style.display = 'none'
                          }}
                        />
                      ) : (
                        <BookOpen size={36} style={{ color: 'var(--ch-text-3)', opacity: 0.6 }} />
                      )}

                      {/* 平台 Badge */}
                      <div
                        style={{
                          position: 'absolute',
                          top: 8,
                          left: 8,
                          background: isYkt ? '#059669' : '#4f46e5',
                          color: '#fff',
                          fontSize: 10,
                          fontWeight: 600,
                          padding: '2px 8px',
                          borderRadius: 4,
                          boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4
                        }}
                      >
                        <Sparkles size={10} />
                        {isYkt ? '雨课堂' : '学习通'}
                      </div>

                      {/* 仅在非本学期时显示历史标识，本学期保持留白清爽 */}
                      {!c.isCurrentTerm && (
                        <div
                          style={{
                            position: 'absolute',
                            bottom: 8,
                            right: 8,
                            background: 'rgba(0,0,0,0.6)',
                            color: '#fff',
                            fontSize: 9.5,
                            padding: '2px 6px',
                            borderRadius: 4
                          }}
                        >
                          {c.termLabel || '往期历史'}
                        </div>
                      )}
                    </div>

                    {/* 课程内容 */}
                    <div
                      style={{
                        padding: '12px 14px',
                        display: 'flex',
                        flexDirection: 'column',
                        flex: 1,
                        justifyContent: 'space-between',
                        gap: 10
                      }}
                    >
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <h4
                          style={{
                            margin: 0,
                            fontSize: 14,
                            fontWeight: 600,
                            color: 'var(--ch-text)',
                            lineHeight: 1.4,
                            overflow: 'hidden',
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical'
                          }}
                          title={c.name}
                        >
                          {c.name}
                        </h4>

                        <div
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 3,
                            fontSize: 11,
                            color: 'var(--ch-text-3)'
                          }}
                        >
                          {c.teacherName && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                              <User size={12} style={{ color: 'var(--ch-text-3)', flexShrink: 0 }} />
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.teacherName}>
                                授课教师：{c.teacherName}
                              </span>
                            </div>
                          )}
                          {c.clazzName && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                              <Users size={12} style={{ color: 'var(--ch-accent)', flexShrink: 0 }} />
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.clazzName}>
                                {c.clazzName}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>

                      <div style={{ paddingTop: 8, borderTop: '1px solid var(--ch-border)', display: 'flex', gap: 8 }}>
                        <button
                          type="button"
                          className="btn btn-primary"
                          onClick={() => {
                            if (onEnterCourseStudy) {
                              onEnterCourseStudy(c)
                            } else {
                              handleEnterCourse(c)
                            }
                          }}
                          style={{ flex: 1.4, justifyContent: 'center' }}
                          title="查看课程章节目录并启动学习与 AI 分析"
                        >
                          <Play size={12} fill="currentColor" />
                          章节学习
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => handleEnterCourse(c)}
                          style={{ flex: 1, justifyContent: 'center' }}
                          title="在软件内置浏览器中打开原网页"
                        >
                          <ExternalLink size={12} />
                          原网页
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </Card>
    </div>
  )
}
