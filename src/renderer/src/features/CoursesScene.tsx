import { useCallback, useEffect, useState, useMemo } from 'react'
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
  Sparkles
} from 'lucide-react'
import { Card, CapChip, Empty, Notice } from '../components/ui'
import type { PlatformId } from '@shared/types'

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
}

export interface CoursesSceneProps {
  platformId: PlatformId
  platformName: string
  onOpenPlatform: (targetPlatform?: PlatformId) => void
  onNavigateCourse: (url: string, targetPlatform?: PlatformId) => void
  onEnterCourseStudy?: (course: CourseItem) => void
  onSwitchPlatform?: (targetPlatform: PlatformId) => void
}

interface PlatformLoadStatus {
  loading: boolean
  state: string
  error: string | null
  count: number
}

export function CoursesScene({
  platformId,
  platformName,
  onOpenPlatform,
  onNavigateCourse,
  onEnterCourseStudy,
  onSwitchPlatform
}: CoursesSceneProps): ReactNode {
  // 平台课程聚合
  const [courses, setCourses] = useState<CourseItem[]>([])
  const [loading, setLoading] = useState(false)
  const [fetchedAt, setFetchedAt] = useState<string | null>(null)

  // 双平台各自独立状态记录（真实反映各平台鉴权与网络情况）
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

  // 筛选与搜索
  const [selectedPlatform, setSelectedPlatform] = useState<'all' | 'chaoxing' | 'yuketang'>('all')
  const [searchKeyword, setSearchKeyword] = useState<string>('')

  const loadAllCourses = useCallback(async () => {
    setLoading(true)

    // 并发拉取学习通与雨课堂真实课程
    setCxStatus((prev) => ({ ...prev, loading: true, error: null }))
    setYktStatus((prev) => ({ ...prev, loading: true, error: null }))

    const [cxRes, yktRes] = await Promise.allSettled([
      window.coursehub.classroom.courses('chaoxing'),
      window.coursehub.classroom.courses('yuketang')
    ])

    const aggregated: CourseItem[] = []

    // 1. 处理超星学习通响应
    if (cxRes.status === 'fulfilled' && cxRes.value.ok) {
      const data = cxRes.value.data
      const list = ((data.courses as CourseItem[]) || []).map((c) => ({
        ...c,
        platformId: 'chaoxing' as const
      }))
      aggregated.push(...list)
      setCxStatus({
        loading: false,
        state: data.state,
        error: data.error || null,
        count: list.length
      })
    } else {
      let err = '学习通接口响应异常'
      if (cxRes.status === 'rejected') {
        err = String(cxRes.reason)
      } else if (!cxRes.value.ok) {
        err = cxRes.value.error.message
      }
      setCxStatus({
        loading: false,
        state: 'error',
        error: err,
        count: 0
      })
    }

    // 2. 处理雨课堂响应
    if (yktRes.status === 'fulfilled' && yktRes.value.ok) {
      const data = yktRes.value.data
      const list = ((data.courses as CourseItem[]) || []).map((c) => ({
        ...c,
        platformId: 'yuketang' as const
      }))
      aggregated.push(...list)
      setYktStatus({
        loading: false,
        state: data.state,
        error: data.error || null,
        count: list.length
      })
    } else {
      let err = '雨课堂接口响应异常'
      if (yktRes.status === 'rejected') {
        err = String(yktRes.reason)
      } else if (!yktRes.value.ok) {
        err = yktRes.value.error.message
      }
      setYktStatus({
        loading: false,
        state: 'error',
        error: err,
        count: 0
      })
    }

    setCourses(aggregated)
    setFetchedAt(new Date().toLocaleTimeString())
    setLoading(false)
  }, [])

  useEffect(() => {
    void loadAllCourses()
  }, [loadAllCourses])

  const filteredCourses = useMemo(() => {
    return courses.filter((c) => {
      if (selectedPlatform !== 'all' && c.platformId !== selectedPlatform) {
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
  }, [courses, selectedPlatform, searchKeyword])

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

  const isYktUnauth = yktStatus.error && (yktStatus.error.includes('未登录') || yktStatus.error.includes('sessionid') || yktStatus.error.includes('401') || yktStatus.state === 'unauthenticated' || yktStatus.state === 'expired')
  const isCxUnauth = cxStatus.error && (cxStatus.error.includes('未登录') || cxStatus.error.includes('过期') || cxStatus.state === 'unauthenticated' || cxStatus.state === 'expired')

  return (
    <div style={{ maxWidth: 1040, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
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
        title={`跨平台课程中心（当前聚焦：${platformName}）`}
        action={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <CapChip
              state={courses.length > 0 ? 'supported' : cxStatus.state === 'error' && yktStatus.state === 'error' ? 'error' : 'unverified'}
              reason={`已读取双平台共 ${courses.length} 门在读课程`}
              compact
            />
            {fetchedAt && (
              <span style={{ fontSize: 11, color: 'var(--ch-text-3)' }}>
                更新于 {fetchedAt}
              </span>
            )}
            <button
              type="button"
              className="btn"
              onClick={() => void loadAllCourses()}
              disabled={loading}
              data-testid="courses-refresh"
            >
              <RefreshCw size={13} className={loading ? 'spin' : undefined} />
              刷新全部课程
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => onOpenPlatform(platformId)}
              title={`在软件内打开当前平台主页`}
            >
              <Globe size={13} />
              平台浏览器
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              type="button"
              className={`btn ${selectedPlatform === 'all' ? 'accent' : ''}`}
              style={{ padding: '4px 12px', fontSize: 12 }}
              onClick={() => setSelectedPlatform('all')}
            >
              <Layers size={13} />
              全部课程 ({courses.length})
            </button>
            <button
              type="button"
              className={`btn ${selectedPlatform === 'chaoxing' ? 'accent' : ''}`}
              style={{ padding: '4px 12px', fontSize: 12 }}
              onClick={() => setSelectedPlatform('chaoxing')}
            >
              学习通 ({cxStatus.count})
            </button>
            <button
              type="button"
              className={`btn ${selectedPlatform === 'yuketang' ? 'accent' : ''}`}
              style={{ padding: '4px 12px', fontSize: 12 }}
              onClick={() => setSelectedPlatform('yuketang')}
            >
              雨课堂 ({yktStatus.count})
              {isYktUnauth && (
                <span style={{ fontSize: 10, color: '#f59e0b', marginLeft: 4 }}>[未登录]</span>
              )}
            </button>
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
            {selectedPlatform === 'yuketang' && isYktUnauth ? (
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
                  {selectedPlatform === 'all' && `（学习通 ${cxStatus.count} 门，雨课堂 ${yktStatus.count} 门）`}
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
                          background: isYkt ? 'rgba(16, 185, 129, 0.9)' : 'rgba(99, 102, 241, 0.9)',
                          color: '#fff',
                          fontSize: 10,
                          fontWeight: 600,
                          padding: '2px 8px',
                          borderRadius: 4,
                          boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4
                        }}
                      >
                        <Sparkles size={10} />
                        {isYkt ? '雨课堂' : '学习通'}
                      </div>

                      <div
                        style={{
                          position: 'absolute',
                          top: 8,
                          right: 8,
                          background: 'rgba(0,0,0,0.65)',
                          color: '#fff',
                          fontSize: 10,
                          padding: '2px 6px',
                          borderRadius: 4
                        }}
                      >
                        ID: {c.courseId}
                      </div>
                    </div>

                    {/* 课程内容 */}
                    <div
                      style={{
                        padding: 12,
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
                            gap: 4,
                            fontSize: 11,
                            color: 'var(--ch-text-2)'
                          }}
                        >
                          {c.clazzName && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                              <Users size={12} style={{ color: 'var(--ch-accent)', flexShrink: 0 }} />
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.clazzName}>
                                {c.clazzName}
                              </span>
                            </div>
                          )}
                          {c.teacherName && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                              <User size={12} style={{ color: 'var(--ch-text-3)', flexShrink: 0 }} />
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.teacherName}>
                                {c.teacherName}
                              </span>
                            </div>
                          )}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'var(--ch-text-3)', fontSize: 10 }}>
                            <span>班级ID: {c.classId}</span>
                          </div>
                        </div>
                      </div>

                      <div style={{ paddingTop: 8, borderTop: '1px solid var(--ch-border)', display: 'flex', gap: 8 }}>
                        <button
                          type="button"
                          className="btn accent"
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
