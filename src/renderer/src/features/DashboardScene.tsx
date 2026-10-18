import { useMemo } from 'react'
import type { ReactNode } from 'react'
import {
  BookOpen,
  Clock,
  ChevronRight,
  CheckCircle2,
  ArrowRight,
  GraduationCap,
  Play,
  Compass
} from 'lucide-react'
import type { CourseItem } from './CoursesScene'
import type { ClassroomActivityItem, PlatformId } from '@shared/types'

export interface RecentStudyRecord {
  courseId: string
  classId?: string
  platformId: PlatformId
  courseName: string
  chapterName?: string
  lastVisitedAt: string
}

export interface DashboardSceneProps {
  courses: CourseItem[]
  activities: ClassroomActivityItem[]
  recentStudy: RecentStudyRecord | null
  onOpenCourse: (course: CourseItem) => void
  onOpenActivity: (act: ClassroomActivityItem) => void
  onNavigateTab: (tab: 'courses' | 'signin' | 'settings') => void
  onRefreshCourses?: () => void
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    const h = String(d.getHours()).padStart(2, '0')
    const min = String(d.getMinutes()).padStart(2, '0')
    return `${m}-${day} ${h}:${min}`
  } catch {
    return iso
  }
}

/**
 * C 端消费者首页：简洁直观，3 秒看清重点。
 *
 * 核心三模块：
 * 1. 顶部：智能继续学习卡片（上次学习课程与课件）
 * 2. 中部：近期待办与活动（即将截止/进行中高亮提醒）
 * 3. 底部：本学期在读课程快捷入口
 */
export function DashboardScene({
  courses,
  activities,
  recentStudy,
  onOpenCourse,
  onOpenActivity,
  onNavigateTab
}: DashboardSceneProps): ReactNode {
  // 1. 本学期课程 (按当前学期标记过滤，上限 6 门卡片快捷展示)
  const currentTermCourses = useMemo(() => {
    const list = courses.filter((c) => c.isCurrentTerm)
    return list.length > 0 ? list : courses.slice(0, 6)
  }, [courses])

  // 2. 统计数据
  const termCourseCount = courses.filter((c) => c.isCurrentTerm).length
  const totalCourseCount = courses.length

  // 3. 筛选有效待办：进行中或未开始的活动，排除已关闭或已过期的历史活动
  const pendingActivities = useMemo(() => {
    const now = Date.now()
    return activities
      .filter((a) => {
        if (a.status === 'closed') return false
        if (a.endAt && new Date(a.endAt).getTime() < now) return false
        return true
      })
      .slice(0, 5) // 首页至多展示 5 条待办，避免视觉噪音
  }, [activities])

  return (
    <div
      style={{
        maxWidth: 1080,
        margin: '0 auto',
        padding: '8px 4px 40px',
        display: 'flex',
        flexDirection: 'column',
        gap: 24
      }}
      data-testid="dashboard-scene"
    >
      {/* ================= 问候与状态总览 ================= */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12,
          padding: '4px 0'
        }}
      >
        <div>
          <h1
            style={{
              fontSize: 22,
              fontWeight: 700,
              color: 'var(--ch-text)',
              margin: '0 0 4px',
              display: 'flex',
              alignItems: 'center',
              gap: 8
            }}
          >
            <span>👋 今日学习</span>
          </h1>
          <p style={{ fontSize: 13, color: 'var(--ch-text-3)', margin: 0 }}>
            本学期在读 <strong>{termCourseCount}</strong> 门课程 · 双平台共收录 {totalCourseCount} 门
          </p>
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <button
            type="button"
            className="btn btn-primary"
            style={{ borderRadius: 999, padding: '7px 16px', fontSize: 12 }}
            onClick={() => onNavigateTab('courses')}
            data-testid="dash-btn-courses"
          >
            <BookOpen size={14} />
            查看我的课程
          </button>
          <button
            type="button"
            className="btn"
            style={{ borderRadius: 999, padding: '7px 16px', fontSize: 12 }}
            onClick={() => onNavigateTab('signin')}
            data-testid="dash-btn-signin"
          >
            <Clock size={14} />
            课堂待办 ({pendingActivities.length})
          </button>
        </div>
      </header>

      {/* ================= 核心模块 1: 继续学习 ================= */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ch-text)', letterSpacing: 0.2 }}>
            ▶ 继续上次学习
          </span>
          {recentStudy && (
            <span style={{ fontSize: 11, color: 'var(--ch-text-3)' }}>
              上次访问：{fmtDate(recentStudy.lastVisitedAt)}
            </span>
          )}
        </div>

        {recentStudy ? (
          <div
            style={{
              borderRadius: 16,
              background: 'linear-gradient(135deg, var(--ch-surface) 0%, var(--ch-accent-tint) 100%)',
              border: '1px solid var(--ch-border)',
              padding: '18px 24px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 20,
              boxShadow: '0 2px 8px rgba(11, 87, 208, 0.06)',
              transition: 'transform 0.15s, box-shadow 0.15s'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, minWidth: 0 }}>
              <div
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: 12,
                  background: 'var(--ch-accent)',
                  color: '#fff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0
                }}
              >
                <GraduationCap size={24} />
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      padding: '2px 6px',
                      borderRadius: 4,
                      background: recentStudy.platformId === 'yuketang' ? '#10b981' : '#6366f1',
                      color: '#fff'
                    }}
                  >
                    {recentStudy.platformId === 'yuketang' ? '雨课堂' : '学习通'}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--ch-text-3)' }}>
                    {recentStudy.chapterName || '章节课件'}
                  </span>
                </div>
                <h3
                  style={{
                    fontSize: 16,
                    fontWeight: 600,
                    color: 'var(--ch-text)',
                    margin: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                  title={recentStudy.courseName}
                >
                  {recentStudy.courseName}
                </h3>
              </div>
            </div>

            <button
              type="button"
              className="btn btn-primary"
              style={{
                borderRadius: 999,
                padding: '8px 20px',
                fontSize: 13,
                fontWeight: 500,
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                gap: 6
              }}
              onClick={() => {
                const matched = courses.find((c) => c.courseId === recentStudy.courseId)
                if (matched) {
                  onOpenCourse(matched)
                } else {
                  onOpenCourse({
                    courseId: recentStudy.courseId,
                    classId: recentStudy.classId || '',
                    name: recentStudy.courseName,
                    platformId: recentStudy.platformId
                  })
                }
              }}
              data-testid="dash-continue-btn"
            >
              <Play size={14} fill="currentColor" />
              继续学习
            </button>
          </div>
        ) : (
          <div
            style={{
              borderRadius: 16,
              background: 'var(--ch-surface)',
              border: '1px dashed var(--ch-border)',
              padding: '24px',
              textAlign: 'center',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 8
            }}
          >
            <Compass size={28} style={{ color: 'var(--ch-text-3)', opacity: 0.6 }} />
            <p style={{ fontSize: 13, color: 'var(--ch-text-2)', margin: 0 }}>
              暂无最近学习记录，从本学期课程挑选一门开始吧
            </p>
            <button
              type="button"
              className="btn btn-primary"
              style={{ marginTop: 4, fontSize: 12, borderRadius: 999, padding: '5px 14px' }}
              onClick={() => onNavigateTab('courses')}
            >
              挑选课程
            </button>
          </div>
        )}
      </section>

      {/* ================= 核心模块 2: 近期待办与活动 ================= */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ch-text)' }}>
              🔔 近期任务与活动
            </span>
            {pendingActivities.length > 0 && (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  padding: '1px 6px',
                  borderRadius: 999,
                  background: 'var(--ch-accent-tint)',
                  color: 'var(--ch-accent)'
                }}
              >
                {pendingActivities.length} 项进行中
              </span>
            )}
          </div>
          <button
            type="button"
            className="btn-subtle"
            style={{ fontSize: 11, color: 'var(--ch-text-3)', display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', cursor: 'pointer' }}
            onClick={() => onNavigateTab('signin')}
          >
            全部活动 <ChevronRight size={12} />
          </button>
        </div>

        {pendingActivities.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {pendingActivities.map((act) => {
              const isUrgent =
                act.deadlineSource === 'teacher_explicit' &&
                act.endAt &&
                new Date(act.endAt).getTime() - Date.now() < 24 * 60 * 60 * 1000

              return (
                <div
                  key={act.id}
                  style={{
                    borderRadius: 12,
                    background: 'var(--ch-surface)',
                    border: '1px solid var(--ch-border)',
                    padding: '12px 18px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 16,
                    transition: 'border-color 0.15s'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                    <div
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 10,
                        background: isUrgent ? 'rgba(239, 68, 68, 0.1)' : 'var(--ch-surface-2)',
                        color: isUrgent ? '#ef4444' : 'var(--ch-text-2)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0
                      }}
                    >
                      <Clock size={16} />
                    </div>

                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                        <span
                          style={{
                            fontSize: 9.5,
                            fontWeight: 600,
                            padding: '1px 5px',
                            borderRadius: 4,
                            background: act.platformId === 'yuketang' ? '#10b981' : '#6366f1',
                            color: '#fff'
                          }}
                        >
                          {act.platformId === 'yuketang' ? '雨课堂' : '学习通'}
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--ch-text-3)' }}>
                          {act.courseName}
                        </span>
                        {isUrgent && (
                          <span
                            style={{
                              fontSize: 9.5,
                              color: '#ef4444',
                              background: '#fef2f2',
                              padding: '1px 5px',
                              borderRadius: 4,
                              fontWeight: 600
                            }}
                          >
                            即将截止
                          </span>
                        )}
                      </div>

                      <h4
                        style={{
                          fontSize: 13,
                          fontWeight: 600,
                          color: 'var(--ch-text)',
                          margin: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap'
                        }}
                        title={act.title}
                      >
                        {act.title}
                      </h4>

                      <div style={{ fontSize: 11, color: 'var(--ch-text-3)', marginTop: 2 }}>
                        <span>截止: {fmtDate(act.endAt)}</span>
                        {act.deadlineSource === 'semester_default' && (
                          <span style={{ marginLeft: 4, color: 'var(--ch-text-3)', fontSize: 10 }}>
                            (学期默认参考)
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ fontSize: 11, padding: '4px 12px', borderRadius: 999, flexShrink: 0 }}
                    onClick={() => onOpenActivity(act)}
                  >
                    查看详情
                  </button>
                </div>
              )
            })}
          </div>
        ) : (
          <div
            style={{
              borderRadius: 12,
              background: 'var(--ch-surface)',
              border: '1px solid var(--ch-border)',
              padding: '16px 20px',
              display: 'flex',
              alignItems: 'center',
              gap: 12
            }}
          >
            <CheckCircle2 size={18} style={{ color: '#10b981' }} />
            <span style={{ fontSize: 12, color: 'var(--ch-text-2)' }}>
              当前暂无待办任务或临期活动，请保持节奏！
            </span>
          </div>
        )}
      </section>

      {/* ================= 核心模块 3: 本学期课程快速直达 ================= */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ch-text)' }}>
              📚 本学期课程 ({termCourseCount})
            </span>
            <span style={{ fontSize: 11, color: 'var(--ch-text-3)', marginLeft: 8 }}>
              点击卡片即可直达章节学习
            </span>
          </div>
          <button
            type="button"
            className="btn-subtle"
            style={{ fontSize: 11, color: 'var(--ch-text-3)', display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', cursor: 'pointer' }}
            onClick={() => onNavigateTab('courses')}
          >
            全部 {totalCourseCount} 门课程 <ArrowRight size={12} />
          </button>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
            gap: 14
          }}
        >
          {currentTermCourses.map((c) => {
            const isYkt = c.platformId === 'yuketang'
            return (
              <div
                key={`${c.platformId}-${c.courseId}`}
                style={{
                  borderRadius: 12,
                  border: '1px solid var(--ch-border)',
                  background: 'var(--ch-surface)',
                  padding: '14px',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  gap: 12,
                  boxShadow: 'var(--sh-xs)',
                  transition: 'transform 0.15s, box-shadow 0.15s'
                }}
                className="course-card"
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span
                      style={{
                        fontSize: 9.5,
                        fontWeight: 600,
                        padding: '1px 6px',
                        borderRadius: 4,
                        background: isYkt ? 'rgba(16, 185, 129, 0.15)' : 'rgba(99, 102, 241, 0.15)',
                        color: isYkt ? '#059669' : '#4f46e5'
                      }}
                    >
                      {isYkt ? '雨课堂' : '学习通'}
                    </span>
                    <span style={{ fontSize: 10, color: 'var(--ch-text-3)' }}>
                      {c.termLabel || '2026秋'}
                    </span>
                  </div>

                  <h4
                    style={{
                      fontSize: 13.5,
                      fontWeight: 600,
                      color: 'var(--ch-text)',
                      margin: '0 0 6px',
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

                  {c.teacherName && (
                    <p style={{ fontSize: 11, color: 'var(--ch-text-3)', margin: 0 }}>
                      教师：{c.teacherName}
                    </p>
                  )}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 'auto' }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{
                      flex: 1,
                      fontSize: 11,
                      padding: '5px 10px',
                      borderRadius: 6,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 4
                    }}
                    onClick={() => onOpenCourse(c)}
                  >
                    <Play size={11} fill="currentColor" />
                    进入学习
                  </button>
                  {c.courseUrl && (
                    <button
                      type="button"
                      className="btn"
                      style={{
                        fontSize: 11,
                        padding: '5px 8px',
                        borderRadius: 6,
                        color: 'var(--ch-text-3)'
                      }}
                      onClick={() => {
                        window.open(c.courseUrl, '_blank')
                      }}
                      title="打开官方原网页"
                    >
                      原网页
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}
