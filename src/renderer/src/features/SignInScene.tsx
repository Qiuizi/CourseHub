import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  MapPin,
  RefreshCw,
  CalendarClock,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Clock,
  Info
} from 'lucide-react'
import { Card, CapChip, Empty, Notice, Rows } from '../components/ui'
import { isStale } from '@shared/signin'

export interface SignInSceneProps {
  platformId: string
  platformName: string
  onOpenPlatform: () => void
}

interface SignInEventItem {
  id: string
  title: string
  kind: string
  status: string
  startAt: string | null
  endAt: string | null
  locationRequired: boolean
  locationText: string | null
}

interface SignInPayload {
  state: string
  events: SignInEventItem[]
  fetchedAt: string | null
  reason: string | null
}

/**
 * 签到中心。
 *
 * 契约：检测到活动 ≠ 已完成签到。没有真实平台数据源时明确返回
 * 「未验证」，绝不生成占位签到条目。测试台支持端到端真实测试打卡。
 */
export function SignInScene({ platformId, platformName, onOpenPlatform }: SignInSceneProps): ReactNode {
  const [data, setData] = useState<SignInPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [triggeringId, setTriggeringId] = useState<string | null>(null)
  const [triggerMsg, setTriggerMsg] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await window.coursehub.classroom.todaySignIns(platformId as any)
      setData(r.ok ? (r.data as SignInPayload) : { state: 'error', events: [], fetchedAt: null, reason: r.error.message })
    } finally {
      setLoading(false)
    }
  }, [platformId])

  const handleTrigger = async (id: string) => {
    setTriggeringId(id)
    setTriggerMsg(null)
    try {
      const res = await window.coursehub.testbed.triggerSignIn(id)
      if (res.ok) {
        setTriggerMsg(`活动 [${id}]：${res.data.message}`)
        void load()
      } else {
        setTriggerMsg(`活动 [${id}] 执行失败：${res.error.message}`)
      }
    } finally {
      setTriggeringId(null)
    }
  }

  useEffect(() => {
    void load()
  }, [load])

  const stale =
    data?.fetchedAt != null && isStale(data.fetchedAt, new Date().toISOString(), 5 * 60 * 1000)

  return (
    <div style={{ maxWidth: 860, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
      {triggerMsg && (
        <Notice tone={triggerMsg.includes('失败') || triggerMsg.includes('超出') ? 'error' : 'info'}>
          {triggerMsg}
        </Notice>
      )}

      <Card
        title="今日签到活动"
        action={
          <button type="button" className="btn" onClick={() => void load()} disabled={loading} data-testid="signin-refresh">
            <RefreshCw size={13} className={loading ? 'spin' : undefined} />
            手动刷新
          </button>
        }
      >
        {loading && !data ? (
          <Empty text="正在读取…" />
        ) : data?.state === 'error' ? (
          <Notice tone="error">
            <AlertCircle size={12} style={{ display: 'inline', marginRight: 4, verticalAlign: -1 }} />
            读取失败：{data.reason}
          </Notice>
        ) : data?.state === 'unauthenticated' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Empty
              icon={<CalendarClock size={22} />}
              text={`未在内置浏览器中检测到 ${platformName} 登录会话。`}
            />
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={onOpenPlatform}
                data-testid="signin-login-btn"
              >
                <ExternalLink size={13} />
                前往「平台浏览」登录 {platformName}
              </button>
            </div>
            <Notice tone="info">
              CourseHub 遵循安全设计原则：不要求您在聊天或外部输入密码，
              而是直接复用您在内置独立 Session 中安全完成的平台登录态。
              {data.reason ? `（${data.reason}）` : ''}
            </Notice>
          </div>
        ) : data?.state === 'unverified' ? (
          <>
            <Empty
              icon={<CalendarClock size={22} />}
              text={`${platformName} 的签到数据源尚未在真实账号验证，因此不展示任何签到条目。`}
            />
            <Notice tone="warn">
              这不是「今天没有签到」，而是<strong>「无法确认」</strong>。
              两者必须区分：确认为空 = 平台返回空列表；读取失败/未支持 = 拿不到可信数据。
              {data.reason ? ` 原因：${data.reason}` : ''}
            </Notice>
          </>
        ) : data?.events && data.events.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {data.events.map((ev) => (
              <div
                key={ev.id}
                style={{
                  padding: 16,
                  borderRadius: 'var(--r-block)',
                  background: 'var(--ch-subtle)',
                  border: '1px solid var(--ch-border)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: 12
                }}
                data-testid={`signin-item-${ev.id}`}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <strong>{ev.title}</strong>
                    <span className={`chip ${ev.kind === 'location' ? 'chip-tint' : ''}`}>{ev.kind}</span>
                    <span className="chip chip-emerald">{ev.status}</span>
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--ch-text-3)' }}>
                    {ev.locationText ? `位置限制：${ev.locationText}` : '无需位置，点击即可完成打卡'}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 8 }}>
                  {platformId === 'testbed' ? (
                    <button
                      type="button"
                      className="btn btn-primary"
                      style={{ fontSize: 11 }}
                      onClick={() => handleTrigger(ev.id)}
                      disabled={triggeringId === ev.id}
                    >
                      {triggeringId === ev.id ? '正在打卡…' : '执行测试打卡'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn"
                      style={{ fontSize: 11 }}
                      onClick={() => {
                        onOpenPlatform()
                      }}
                    >
                      <ExternalLink size={11} /> 打开活动页面
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Empty text="当前没有进行中的签到活动。" />
        )}

        {stale && (
          <div style={{ marginTop: 10 }}>
            <Notice tone="warn">
              <Clock size={12} style={{ display: 'inline', marginRight: 4, verticalAlign: -1 }} />
              数据已超过 5 分钟，可能过期。
            </Notice>
          </div>
        )}
      </Card>

      {/* 状态语义 */}
      <Card title="状态语义">
        <Rows
          items={[
            {
              k: '待开始',
              v: <span className="chip">pending</span>
            },
            { k: '进行中', v: <span className="chip chip-tint">open</span> },
            {
              k: '已签到',
              v: (
                <span>
                  <span className="chip chip-emerald">checked_in</span>
                  <span style={{ fontSize: 10.5, color: 'var(--ch-text-3)', marginLeft: 8 }}>
                    仅当平台接口本次明确返回证据
                  </span>
                </span>
              )
            },
            { k: '已结束', v: <span className="chip chip-neutral">closed</span> },
            { k: '未知', v: <span className="chip">unknown</span> }
          ]}
        />
        <div style={{ marginTop: 12 }}>
          <Notice tone="info">
            本地记忆只能表达「已处理过该活动」，<strong>永远不会</strong>把状态升级为「已签到」。
            只有平台接口的明确响应可以。
          </Notice>
        </div>
      </Card>

      {/* 定位型签到 */}
      <Card title="定位型签到">
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
              若平台要求位置，此处显示平台<strong>确实提供</strong>的位置要求与距离限制。
              未取得可信字段时不显示推测值。
            </p>
            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-primary" onClick={onOpenPlatform}>
                <ExternalLink size={13} />
                打开官方签到页面
              </button>
              <button type="button" className="btn" onClick={() => undefined}>
                <MapPin size={13} />
                打开定位测试工作台
              </button>
            </div>
            <p style={{ fontSize: 10.5, color: 'var(--ch-text-3)', margin: '10px 0 0', lineHeight: 1.6 }}>
              定位测试工作台只在独立测试会话生效，<strong>不代表现实位置，
              也不由覆盖操作自行宣告签到成功</strong>。生产平台的实际签到结果需平台响应或人工确认。
            </p>
          </div>
        </div>
      </Card>

      <Card title="能力状态">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <CapChip state="unverified" reason="签到检测端点字段映射为跨仓库推断，未实测" />
          <CapChip state="unsupported" reason="自动提交签到属违规写操作，按需求明确不实现" />
          <span className="chip chip-neutral">platform: {platformId}</span>
        </div>
      </Card>

      <Card title="说明">
        <Notice tone="info">
          <Info size={12} style={{ display: 'inline', marginRight: 4, verticalAlign: -1 }} />
          <CheckCircle2 size={12} style={{ display: 'inline', marginRight: 4, verticalAlign: -1 }} />
          本页面不提供「一键签到」入口。对第三方平台提交签到数据 + 位置信息属于欺骗性写入，
          CourseHub 按需求明确不实现该能力。
        </Notice>
      </Card>
    </div>
  )
}
