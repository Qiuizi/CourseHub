import { useCallback, useEffect, useState, useRef } from 'react'
import type { ReactNode } from 'react'
import {
  MapPin,
  RefreshCw,
  CalendarClock,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Clock,
  Info,
  Timer
} from 'lucide-react'
import { Card, Empty, Notice, Rows } from '../components/ui'
import type { ClassroomActivityItem, PlatformId } from '@shared/types'
import { isStale } from '@shared/signin'

export interface SignInSceneProps {
  platformId: string
  platformName: string
  onOpenPlatform: (url?: string, targetPlatform?: PlatformId) => void
  onOpenGeoScene?: () => void
}

type CategoryFilter = 'all' | 'sign_in' | 'quiz' | 'questionnaire' | 'notice' | 'other'
type StatusFilter = 'all' | 'open' | 'pending' | 'closed'

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    const hours = String(d.getHours()).padStart(2, '0')
    const minutes = String(d.getMinutes()).padStart(2, '0')
    return `${month}-${day} ${hours}:${minutes}`
  } catch {
    return iso
  }
}

/**
 * 课堂活动与签到工作台。
 *
 * 核心能力（开发规范 §4）：
 * 1. 多课程活动汇总（签到、问卷、测验、通知及其他互动）。
 * 2. 精确分类与时间展示（真实开始/结束时间，状态区隔 open / pending / closed）。
 * 3. 支持配置自动刷新间隔（手动 / 30s / 60s / 120s / 300s）并记录最近成功同步时间。
 * 4. 点击活动可直达平台内嵌页面；保留本地测试台定位模拟与测试打卡能力。
 */
export function SignInScene({
  platformId,
  platformName,
  onOpenPlatform,
  onOpenGeoScene
}: SignInSceneProps): ReactNode {
  const [activities, setActivities] = useState<ClassroomActivityItem[]>([])
  const [platformState, setPlatformState] = useState<string>('unknown')
  const [stateReason, setStateReason] = useState<string | null>(null)
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [triggeringId, setTriggeringId] = useState<string | null>(null)
  const [triggerMsg, setTriggerMsg] = useState<string | null>(null)

  // 筛选与自动刷新
  const [platformFilter, setPlatformFilter] = useState<'all' | 'chaoxing' | 'yuketang' | 'testbed'>('all')
  const [courseFilter, setCourseFilter] = useState<string>('')
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [showClosedHistory, setShowClosedHistory] = useState(false)
  const [autoRefreshInterval, setAutoRefreshInterval] = useState<number>(60) // 默认 60 秒
  const [countdown, setCountdown] = useState<number>(60)

  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadActivities = useCallback(async () => {
    setLoading(true)
    try {
      if (platformFilter === 'all') {
        const [cxRes, yktRes, tbRes] = await Promise.allSettled([
          window.coursehub.classroom.activities('chaoxing'),
          window.coursehub.classroom.activities('yuketang'),
          window.coursehub.classroom.activities('testbed')
        ])
        const combined: ClassroomActivityItem[] = []
        if (cxRes.status === 'fulfilled' && cxRes.value.ok && cxRes.value.data.activities) {
          combined.push(...cxRes.value.data.activities.map((a) => ({ ...a, platformId: 'chaoxing' as const })))
        }
        if (yktRes.status === 'fulfilled' && yktRes.value.ok && yktRes.value.data.activities) {
          combined.push(...yktRes.value.data.activities.map((a) => ({ ...a, platformId: 'yuketang' as const })))
        }
        if (tbRes.status === 'fulfilled' && tbRes.value.ok && tbRes.value.data.activities) {
          combined.push(...tbRes.value.data.activities.map((a) => ({ ...a, platformId: 'testbed' as const })))
        }
        setActivities(combined)
        setPlatformState('supported')
        setStateReason(`已聚合学习通、雨课堂与测试台共 ${combined.length} 项课堂活动`)
        setLastSyncAt(new Date().toISOString())
      } else {
        const targetPid = platformFilter || platformId
        const res = await window.coursehub.classroom.activities(targetPid as any)
        if (res.ok) {
          setActivities(res.data.activities || [])
          setPlatformState(res.data.state)
          setStateReason(res.data.reason)
          setLastSyncAt(res.data.fetchedAt || new Date().toISOString())
        } else {
          const fb = await window.coursehub.classroom.todaySignIns(targetPid as any)
          if (fb.ok && fb.data.events) {
            const mapped: ClassroomActivityItem[] = (fb.data.events as any[]).map((ev) => ({
              id: ev.id,
              platformId: targetPid as any,
              courseId: ev.courseId || 'unknown',
              courseName: ev.courseName || '未命名课程',
              classId: 'default',
              title: ev.title,
              category: 'sign_in',
              status: ev.status === 'open' ? 'open' : ev.status === 'closed' ? 'closed' : 'pending',
              startAt: ev.startAt,
              endAt: ev.endAt,
              sourceUrl: ev.sourceUrl || null,
              fetchedAt: ev.fetchedAt || new Date().toISOString(),
              locationRequired: Boolean(ev.locationRequired),
              locationText: ev.locationText || null,
              signInKind: ev.kind || 'normal',
              confidence: 'high'
            }))
            setActivities(mapped)
            setPlatformState(fb.data.state)
            setStateReason(fb.data.reason)
            setLastSyncAt(fb.data.fetchedAt || new Date().toISOString())
          } else {
            setPlatformState('error')
            setStateReason(res.error.message)
          }
        }
      }
    } catch (err) {
      setPlatformState('error')
      setStateReason(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
      setCountdown(autoRefreshInterval)
    }
  }, [platformFilter, platformId, autoRefreshInterval])

  // 挂载与自动刷新倒计时
  useEffect(() => {
    void loadActivities()
  }, [loadActivities])

  useEffect(() => {
    if (autoRefreshInterval <= 0) {
      if (countdownTimerRef.current) clearInterval(countdownTimerRef.current)
      return
    }

    setCountdown(autoRefreshInterval)
    countdownTimerRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          void loadActivities()
          return autoRefreshInterval
        }
        return prev - 1
      })
    }, 1000)

    return () => {
      if (countdownTimerRef.current) clearInterval(countdownTimerRef.current)
    }
  }, [autoRefreshInterval, loadActivities])

  const handleTrigger = async (id: string) => {
    setTriggeringId(id)
    setTriggerMsg(null)
    try {
      const res = await window.coursehub.testbed.triggerSignIn(id)
      if (res.ok) {
        setTriggerMsg(`活动 [${id}]：${res.data.message}`)
        void loadActivities()
      } else {
        setTriggerMsg(`活动 [${id}] 执行失败：${res.error.message}`)
      }
    } finally {
      setTriggeringId(null)
    }
  }

  // 过滤活动
  const filteredActivities = activities.filter((act) => {
    if (platformFilter !== 'all' && act.platformId !== platformFilter) {
      return false
    }
    if (courseFilter.trim()) {
      const kw = courseFilter.trim().toLowerCase()
      if (!act.courseName?.toLowerCase().includes(kw) && !act.title?.toLowerCase().includes(kw)) {
        return false
      }
    }
    if (categoryFilter !== 'all') {
      if (categoryFilter === 'sign_in' && act.category !== 'sign_in') return false
      if (categoryFilter === 'quiz' && act.category !== 'quiz' && act.category !== 'exercise') return false
      if (categoryFilter === 'questionnaire' && act.category !== 'questionnaire') return false
      if (categoryFilter === 'notice' && act.category !== 'notice') return false
      if (
        categoryFilter === 'other' &&
        (act.category === 'sign_in' ||
          act.category === 'quiz' ||
          act.category === 'exercise' ||
          act.category === 'questionnaire' ||
          act.category === 'notice')
      )
        return false
    }
    if (statusFilter !== 'all' && act.status !== statusFilter) return false
    return true
  })

  const isDataStale = lastSyncAt != null && isStale(lastSyncAt, new Date().toISOString(), 5 * 60 * 1000)

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
      {triggerMsg && (
        <Notice tone={triggerMsg.includes('失败') || triggerMsg.includes('超出') ? 'error' : 'info'}>
          {triggerMsg}
        </Notice>
      )}

      {/* 顶部控制栏与统计 */}
      <Card
        title="跨平台课堂活动中心"
        action={
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* 自动刷新间隔选择 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
              <Timer size={13} style={{ color: 'var(--ch-text-3)' }} />
              <span style={{ color: 'var(--ch-text-2)' }}>自动同步:</span>
              <select
                className="select"
                style={{ fontSize: 11, padding: '2px 6px', height: 26 }}
                value={autoRefreshInterval}
                onChange={(e) => setAutoRefreshInterval(Number(e.target.value))}
              >
                <option value={0}>手动刷新</option>
                <option value={30}>每 30 秒</option>
                <option value={60}>每 60 秒</option>
                <option value={120}>每 120 秒</option>
                <option value={300}>每 5 分钟</option>
              </select>
              {autoRefreshInterval > 0 && (
                <span style={{ fontSize: 10, color: 'var(--ch-text-3)', minWidth: 28 }}>
                  ({countdown}s)
                </span>
              )}
            </div>

            <button
              type="button"
              className="btn"
              onClick={() => void loadActivities()}
              disabled={loading}
              data-testid="signin-refresh"
            >
              <RefreshCw size={13} className={loading ? 'spin' : undefined} />
              手动同步
            </button>
          </div>
        }
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11.5, color: 'var(--ch-text-2)' }}>
              当前视图：<strong>{platformFilter === 'all' ? '全部平台聚合' : platformFilter === 'chaoxing' ? '超星学习通' : platformFilter === 'yuketang' ? '雨课堂' : '测试台'}</strong>
            </span>
            <span style={{ fontSize: 11, color: 'var(--ch-text-3)' }}>
              最近成功同步：{lastSyncAt ? fmtDateTime(lastSyncAt) : '尚未同步'}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <span className="chip chip-tint">共 {filteredActivities.length} 项活动</span>
            <span className="chip chip-emerald">
              进行中 {filteredActivities.filter((a) => a.status === 'open').length}
            </span>
          </div>
        </div>

        {/* 筛选选项卡 */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            marginTop: 14,
            paddingTop: 12,
            borderTop: '1px solid var(--ch-hairline)'
          }}
        >
          {/* 平台过滤与课程检索 */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, color: 'var(--ch-text-3)', marginRight: 4 }}>平台：</span>
              {(
                [
                  { id: 'all', label: '全部平台' },
                  { id: 'chaoxing', label: '学习通' },
                  { id: 'yuketang', label: '雨课堂' },
                  { id: 'testbed', label: '测试台' }
                ] as const
              ).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`platform-pill ${platformFilter === p.id ? 'active' : ''}`}
                  style={{
                    padding: '3px 10px',
                    fontSize: 11,
                    background: platformFilter === p.id ? 'var(--ch-primary)' : 'var(--ch-subtle)',
                    color: platformFilter === p.id ? '#fff' : 'inherit'
                  }}
                  onClick={() => setPlatformFilter(p.id)}
                >
                  {p.label}
                </button>
              ))}
            </div>

            <input
              type="text"
              placeholder="按课程/活动名称搜索..."
              value={courseFilter}
              onChange={(e) => setCourseFilter(e.target.value)}
              style={{
                fontSize: 11,
                padding: '3px 8px',
                borderRadius: 4,
                border: '1px solid var(--ch-border)',
                background: 'var(--ch-surface-2)',
                color: 'var(--ch-text)',
                width: 160
              }}
            />
          </div>

          {/* 分类过滤 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: 'var(--ch-text-3)', marginRight: 4 }}>类型：</span>
            {(
              [
                { id: 'all', label: '全部' },
                { id: 'sign_in', label: '签到打卡' },
                { id: 'quiz', label: '随堂测验' },
                { id: 'questionnaire', label: '调查问卷' },
                { id: 'notice', label: '教学通知' },
                { id: 'other', label: '其它互动' }
              ] as const
            ).map((cat) => (
              <button
                key={cat.id}
                type="button"
                className={`platform-pill ${categoryFilter === cat.id ? 'active' : ''}`}
                style={{
                  padding: '3px 10px',
                  fontSize: 11,
                  background: categoryFilter === cat.id ? 'var(--ch-primary)' : 'var(--ch-subtle)',
                  color: categoryFilter === cat.id ? '#fff' : 'inherit'
                }}
                onClick={() => setCategoryFilter(cat.id)}
              >
                {cat.label}
              </button>
            ))}
          </div>

          {/* 状态过滤 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: 'var(--ch-text-3)', marginRight: 4 }}>状态：</span>
            {(
              [
                { id: 'all', label: '全部状态' },
                { id: 'open', label: '进行中' },
                { id: 'pending', label: '未开始' },
                { id: 'closed', label: '已结束' }
              ] as const
            ).map((st) => (
              <button
                key={st.id}
                type="button"
                className={`platform-pill ${statusFilter === st.id ? 'active' : ''}`}
                style={{
                  padding: '3px 10px',
                  fontSize: 11,
                  background: statusFilter === st.id ? 'var(--ch-primary)' : 'var(--ch-subtle)',
                  color: statusFilter === st.id ? '#fff' : 'inherit'
                }}
                onClick={() => setStatusFilter(st.id)}
              >
                {st.label}
              </button>
            ))}
          </div>
        </div>
      </Card>

      {/* 活动列表区 */}
      <Card title="活动日程与任务明细">
        {loading && activities.length === 0 ? (
          <Empty text="正在读取平台课程活动..." />
        ) : platformState === 'error' ? (
          <Notice tone="error">
            <AlertCircle size={12} style={{ display: 'inline', marginRight: 4, verticalAlign: -1 }} />
            活动读取失败：{stateReason}
          </Notice>
        ) : platformState === 'unauthenticated' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Empty
              icon={<CalendarClock size={22} />}
              text={`未在内置浏览器中检测到 ${platformName} 登录会话。`}
            />
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => onOpenPlatform()}
                data-testid="signin-login-btn"
              >
                <ExternalLink size={13} />
                前往「平台浏览」登录 {platformName}
              </button>
            </div>
            <Notice tone="info">
              CourseHub 严格保护账号安全：不要求用户在聊天界面输入密码，直接复用您在内置安全 Session 中的官方登录凭证。
              {stateReason ? `（${stateReason}）` : ''}
            </Notice>
          </div>
        ) : platformState === 'unverified' ? (
          <>
            <Empty
              icon={<CalendarClock size={22} />}
              text={`${platformName} 的活动数据源尚未在真实账号验证，因此不展示任何未经确认的活动条目。`}
            />
            <Notice tone="warn">
              无法确认 ≠ 今天没有活动。数据源未经验证时绝不伪造虚假数据。
              {stateReason ? ` 原因：${stateReason}` : ''}
            </Notice>
          </>
        ) : filteredActivities.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* 正在进行或未开始的待办事项 */}
            {(statusFilter === 'all'
              ? filteredActivities.filter((a) => a.status !== 'closed')
              : filteredActivities
            ).map((act) => {
              const isOpen = act.status === 'open'
              const isClosed = act.status === 'closed'
              const isPending = act.status === 'pending'
              const isSignIn = act.category === 'sign_in'
              const isQuiz = act.category === 'quiz' || act.category === 'exercise'
              const isSurvey = act.category === 'questionnaire'
              const isNotice = act.category === 'notice'

              return (
                <div
                  key={act.id}
                  style={{
                    padding: '14px 16px',
                    borderRadius: 'var(--r-block)',
                    background: 'var(--ch-surface)',
                    border: '1px solid var(--ch-border)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: 12,
                    boxShadow: 'var(--sh-2xs)'
                  }}
                  data-testid={`signin-item-${act.id}`}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                      <span
                        className="chip"
                        style={{
                          fontSize: 10,
                          fontWeight: 600,
                          padding: '2px 6px',
                          background: act.platformId === 'yuketang' ? '#10b981' : act.platformId === 'chaoxing' ? '#6366f1' : '#64748b',
                          color: '#fff'
                        }}
                      >
                        {act.platformId === 'yuketang' ? '雨课堂' : act.platformId === 'chaoxing' ? '学习通' : '测试台'}
                      </span>
                      <span
                        className="chip chip-tint"
                        style={{ fontSize: 10.5, fontWeight: 600, padding: '2px 6px' }}
                      >
                        {act.courseName}
                      </span>
                      <strong style={{ fontSize: 13 }}>{act.title}</strong>
                      <span
                        className={`chip ${
                          isSignIn
                            ? 'chip-accent'
                            : isQuiz
                              ? 'chip-warning'
                              : isSurvey
                                ? 'chip-tint'
                                : 'chip-neutral'
                        }`}
                        style={{ fontSize: 10 }}
                      >
                        {isSignIn
                          ? act.signInKind === 'location'
                            ? '位置签到'
                            : act.signInKind === 'qr'
                              ? '二维码签到'
                              : act.signInKind === 'code'
                                ? '签到码'
                                : '普通签到'
                          : isQuiz
                            ? '随堂测验'
                            : isSurvey
                              ? '问卷调查'
                              : isNotice
                                ? '通知公告'
                                : '课堂互动'}
                      </span>
                      <span
                        className={`chip ${
                          isOpen ? 'chip-emerald' : isPending ? 'chip-warning' : 'chip-neutral'
                        }`}
                        style={{ fontSize: 10 }}
                      >
                        {isOpen ? '进行中' : isPending ? '未开始' : isClosed ? '已结束' : '未知'}
                      </span>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 11, color: 'var(--ch-text-3)', flexWrap: 'wrap' }}>
                      <span>开始: {fmtDateTime(act.startAt)}</span>
                      <span>
                        截止: {fmtDateTime(act.endAt)}
                        {act.deadlineSource === 'semester_default' && (
                          <span style={{ marginLeft: 4, color: 'var(--ch-text-4)', fontSize: 10 }}>
                            (学期默认参考)
                          </span>
                        )}
                      </span>
                      {act.locationRequired && (
                        <span style={{ color: 'var(--ch-warning)' }}>
                          <MapPin size={11} style={{ display: 'inline', verticalAlign: -1 }} />{' '}
                          {act.locationText ?? '需现场定位'}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* 动作区 */}
                  <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                    {platformId === 'testbed' && isSignIn && (
                      <button
                        type="button"
                        className="btn btn-primary"
                        style={{ fontSize: 11 }}
                        onClick={() => handleTrigger(act.id)}
                        disabled={triggeringId === act.id}
                      >
                        {triggeringId === act.id ? '正在打卡…' : '执行测试打卡'}
                      </button>
                    )}

                    {act.locationRequired && onOpenGeoScene && (
                      <button
                        type="button"
                        className="btn"
                        style={{ fontSize: 11 }}
                        onClick={onOpenGeoScene}
                        title="打开定位测试台进行 GPS 模拟"
                      >
                        <MapPin size={12} /> 定位测试
                      </button>
                    )}

                    <button
                      type="button"
                      className="btn btn-primary"
                      style={{ fontSize: 11 }}
                      onClick={() => onOpenPlatform(act.sourceUrl ?? undefined, act.platformId)}
                    >
                      <ExternalLink size={12} /> 进入活动页面
                    </button>
                  </div>
                </div>
              )
            })}

            {/* 默认折叠历史已结束活动 */}
            {statusFilter === 'all' && filteredActivities.some((a) => a.status === 'closed') && (
              <div style={{ marginTop: 10 }}>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setShowClosedHistory((v) => !v)}
                  style={{
                    width: '100%',
                    padding: '8px 16px',
                    fontSize: 12,
                    justifyContent: 'center',
                    color: 'var(--ch-text-3)',
                    background: 'var(--ch-surface-2)',
                    borderRadius: 'var(--r-block)'
                  }}
                >
                  <Clock size={13} />
                  {showClosedHistory
                    ? `收起已结束历史活动 (${filteredActivities.filter((a) => a.status === 'closed').length})`
                    : `展开已结束历史活动 (${filteredActivities.filter((a) => a.status === 'closed').length})`}
                </button>

                {showClosedHistory && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10, opacity: 0.85 }}>
                    {filteredActivities.filter((a) => a.status === 'closed').map((act) => (
                      <div
                        key={act.id}
                        style={{
                          padding: '12px 16px',
                          borderRadius: 'var(--r-block)',
                          background: 'var(--ch-subtle)',
                          border: '1px solid var(--ch-border)',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          flexWrap: 'wrap',
                          gap: 12
                        }}
                        data-testid={`signin-item-${act.id}`}
                      >
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                            <span className="chip chip-neutral" style={{ fontSize: 9.5 }}>
                              {act.platformId === 'yuketang' ? '雨课堂' : act.platformId === 'chaoxing' ? '学习通' : '测试台'}
                            </span>
                            <span style={{ fontSize: 11, color: 'var(--ch-text-3)' }}>{act.courseName}</span>
                            <span style={{ fontSize: 12, color: 'var(--ch-text-2)' }}>{act.title}</span>
                            <span className="chip chip-neutral" style={{ fontSize: 9.5 }}>已结束</span>
                          </div>
                          <div style={{ fontSize: 10.5, color: 'var(--ch-text-3)' }}>
                            截止时间: {fmtDateTime(act.endAt)}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="btn"
                          style={{ fontSize: 11, padding: '3px 10px' }}
                          onClick={() => onOpenPlatform(act.sourceUrl ?? undefined, act.platformId)}
                        >
                          <ExternalLink size={11} /> 查看往期
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <Empty text="当前筛选条件下没有匹配的课堂活动。" />
        )}

        {isDataStale && (
          <div style={{ marginTop: 12 }}>
            <Notice tone="warn">
              <Clock size={12} style={{ display: 'inline', marginRight: 4, verticalAlign: -1 }} />
              数据同步时间已超过 5 分钟，建议点击「手动同步」获取最新课堂动态。
            </Notice>
          </div>
        )}
      </Card>

      {/* 状态语义说明（折叠收纳，降低视觉干扰） */}
      <details
        style={{
          borderRadius: 'var(--r-block)',
          border: '1px solid var(--ch-border)',
          background: 'var(--ch-surface)',
          padding: '10px 16px',
          fontSize: 12
        }}
      >
        <summary style={{ cursor: 'pointer', color: 'var(--ch-text-3)', fontWeight: 500 }}>
          查看状态与数据源契约说明
        </summary>
        <div style={{ marginTop: 10 }}>
          <Rows
            items={[
              {
                k: '未开始',
                v: <span className="chip chip-warning">pending · 活动已发布但尚未到开放作答时间</span>
              },
              {
                k: '进行中',
              v: <span className="chip chip-emerald">open · 正在进行，可进入页面参与或签到</span>
            },
            {
              k: '已结束',
              v: <span className="chip chip-neutral">closed · 活动时间截止</span>
            },
            {
              k: '通知去重',
              v: <span>同一活动仅在首次检测到处于进行中（open）时触发通知提醒，杜绝循环轰炸</span>
            }
          ]}
        />
        </div>
      </details>

      {/* 定位型签到指引 */}
      <Card title="定位型签到与模拟">
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 16,
              background: 'var(--ch-accent-tint)',
              color: 'var(--ch-accent)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0
            }}
          >
            <MapPin size={20} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ fontSize: 12, margin: 0, lineHeight: 1.7 }}>
              若平台要求现场位置，工作台会展示平台<strong>官方明确给出</strong>的位置要求与距离范围。
              自有测试站点支持通过 CDP 模拟精确定位与地图选点打卡，不影响生产平台。
            </p>
            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-primary" onClick={() => onOpenPlatform()}>
                <ExternalLink size={13} />
                打开平台活动列表
              </button>
              {onOpenGeoScene && (
                <button type="button" className="btn" onClick={onOpenGeoScene}>
                  <MapPin size={13} />
                  打开定位模拟测试
                </button>
              )}
            </div>
          </div>
        </div>
      </Card>

      <Card title="平台能力说明">
        <Notice tone="info">
          <Info size={12} style={{ display: 'inline', marginRight: 4, verticalAlign: -1 }} />
          <CheckCircle2 size={12} style={{ display: 'inline', marginRight: 4, verticalAlign: -1 }} />
          课堂活动工作台支持自动轮询聚合多门课程的实际动态。对第三方平台需要二次签名、验证码或特殊交互的签到与测验，用户可点击「进入活动页面」在受保护的内置浏览器中直接人工完成，状态与提交均由平台官方接口确认。
        </Notice>
      </Card>
    </div>
  )
}
