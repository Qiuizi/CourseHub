import { useCallback, useEffect, useState } from 'react'
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
  Play
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
}

export interface CoursesSceneProps {
  platformId: PlatformId
  platformName: string
  onOpenPlatform: () => void
  onNavigateCourse: (url: string) => void
  onEnterCourseStudy?: (course: CourseItem) => void
}

export function CoursesScene({
  platformId,
  platformName,
  onOpenPlatform,
  onNavigateCourse,
  onEnterCourseStudy
}: CoursesSceneProps): ReactNode {
  const [courses, setCourses] = useState<CourseItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [state, setState] = useState<string>('unverified')
  const [fetchedAt, setFetchedAt] = useState<string | null>(null)

  const loadCourses = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await window.coursehub.classroom.courses(platformId)
      if (res.ok) {
        setState(res.data.state)
        setCourses((res.data.courses as CourseItem[]) || [])
        setFetchedAt(new Date().toLocaleTimeString())
        if (res.data.error) {
          setError(res.data.error)
        }
      } else {
        setState('error')
        setError(res.error.message)
        setCourses([])
      }
    } catch (err) {
      setState('error')
      setError(err instanceof Error ? err.message : String(err))
      setCourses([])
    } finally {
      setLoading(false)
    }
  }, [platformId])

  useEffect(() => {
    void loadCourses()
  }, [loadCourses])

  const handleEnterCourse = (c: CourseItem) => {
    const targetUrl =
      c.courseUrl ||
      `https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=${c.courseId}&clazzid=${c.classId}&cpi=${c.cpi || '0'}&ismooc2=1&v=2`
    onNavigateCourse(targetUrl)
  }

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* 状态与通知条 */}
      {error && (
        <Notice tone="error">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
            <span>{error}</span>
            {(error.includes('未登录') || error.includes('AUTH_EXPIRED') || error.includes('过期')) && (
              <button
                type="button"
                className="btn"
                onClick={onOpenPlatform}
                style={{ marginLeft: 12, padding: '2px 8px', fontSize: 11 }}
              >
                前往登录
              </button>
            )}
          </div>
        </Notice>
      )}

      <Card
        title={`${platformName} · 课程中心`}
        action={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <CapChip
              state={state}
              reason={state === 'supported' ? '真实 Session 在线解析' : error ?? undefined}
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
              onClick={() => void loadCourses()}
              disabled={loading}
              data-testid="courses-refresh"
            >
              <RefreshCw size={13} className={loading ? 'spin' : undefined} />
              刷新课程
            </button>
            <button
              type="button"
              className="btn"
              onClick={onOpenPlatform}
              title={`在软件内打开 ${platformName} 官方主页`}
            >
              <Globe size={13} />
              官方主页
            </button>
          </div>
        }
      >
        {loading && courses.length === 0 ? (
          <Empty
            icon={<RefreshCw size={24} className="spin" />}
            text="正在读取真实课程列表，请稍候..."
          />
        ) : courses.length === 0 ? (
          <div style={{ padding: '16px 0', textAlign: 'center' }}>
            <Empty
              icon={<AlertCircle size={24} />}
              tone={error ? 'error' : 'neutral'}
              text={
                error
                  ? `未能读取课程：${error}`
                  : '当前平台未检测到在读课程，请确认账号是否已登录并加入了班级。'
              }
            />
            {error && (error.includes('验证') || error.includes('ANTISPIDER')) && (
              <div style={{ marginTop: 14 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={onOpenPlatform}
                  title="打开内置浏览器完成图片验证码"
                >
                  <Globe size={13} />
                  前往内置浏览器完成验证
                </button>
              </div>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '4px 2px',
                borderBottom: '1px solid var(--ch-border)',
                fontSize: 12,
                color: 'var(--ch-text-2)'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <CheckCircle2 size={14} style={{ color: '#10b981' }} />
                <span>
                  共读取到 <strong>{courses.length}</strong> 门真实在读课程（双轨容灾架构）
                </span>
              </div>
              <span style={{ fontSize: 11, color: 'var(--ch-text-3)' }}>
                点击卡片或“进入课程”即可直接在内置浏览器中学习
              </span>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                gap: 14
              }}
              data-testid="courses-grid"
            >
              {courses.map((c) => (
                <div
                  key={`${c.courseId}-${c.classId}`}
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
                  {/* 封面区域 */}
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
                          // 图片加载失败时降级显示图标
                          e.currentTarget.style.display = 'none'
                        }}
                      />
                    ) : (
                      <BookOpen size={36} style={{ color: 'var(--ch-text-3)', opacity: 0.6 }} />
                    )}
                    <div
                      style={{
                        position: 'absolute',
                        top: 6,
                        right: 6,
                        background: 'rgba(0,0,0,0.6)',
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
                        title="查看真实章节目录并启动内置视频播放与控制"
                      >
                        <Play size={12} fill="currentColor" />
                        章节学习
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => handleEnterCourse(c)}
                        style={{ flex: 1, justifyContent: 'center' }}
                        title="在内置浏览器中打开原网页"
                      >
                        <ExternalLink size={12} />
                        原网页
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>
    </div>
  )
}
