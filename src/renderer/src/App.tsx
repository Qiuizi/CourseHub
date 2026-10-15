import { useCallback, useEffect, useRef, useState } from 'react'
import type { PlatformId, PlaybackObservation, GeoTestRun } from '@shared/types'
import { observedProgressPercent, ALLOWED_PLAYBACK_RATES } from '@shared/video'
import { haversineMeters } from '@shared/geo'
import { CapabilityChip, Panel, Empty } from './components/ui'
import GeoTestPanel from './features/GeoTestPanel'

type View = 'dashboard' | 'browser' | 'signin' | 'video' | 'geo' | 'ai' | 'settings'

interface PlatformSummary {
  id: PlatformId
  name: string
  homeUrl: string
  capabilities: Record<string, { state: string; reason: string; verifiedAt: string | null }>
  adapterVersion: string | null
}

const NAV: { id: View; label: string }[] = [
  { id: 'dashboard', label: '工作台' },
  { id: 'browser', label: '平台浏览' },
  { id: 'signin', label: '签到中心' },
  { id: 'video', label: '视频任务' },
  { id: 'geo', label: '定位测试' },
  { id: 'ai', label: '课堂 AI' },
  { id: 'settings', label: '设置' }
]

export default function App(): JSX.Element {
  const [view, setView] = useState<View>('dashboard')
  const [platforms, setPlatforms] = useState<PlatformSummary[]>([])
  const [active, setActive] = useState<PlatformId>('testbed')
  const [observation, setObservation] = useState<PlaybackObservation | null>(null)
  const [geoRun, setGeoRun] = useState<GeoTestRun | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)

  const api = window.coursehub

  useEffect(() => {
    void api.platform
      .list()
      .then((r) => {
        if (r.ok) setPlatforms(r.data)
        else setNotice(`平台列表加载失败：${r.error.code} ${r.error.message}`)
      })
      .catch(() => setNotice('平台列表加载失败'))
  }, [api])

  // 播放器观测推送
  useEffect(() => api.events.onVideoObservation(setObservation), [api])

  // 定位测试状态推送
  useEffect(() => api.events.onGeoUpdate(setGeoRun), [api])

  /**
   * 报告中央区域矩形给主进程设置原生视图 bounds。
   * 用 ResizeObserver 而非固定值，以适配 DPI / 抽屉折叠 / 窗口缩放。
   */
  useEffect(() => {
    if (view !== 'browser' && view !== 'geo') return
    const el = viewportRef.current
    if (!el) return

    const push = (): void => {
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) return
      const bounds = { x: r.x, y: r.y, width: r.width, height: r.height }
      if (view === 'geo') void api.geoTest.setBounds(bounds)
      else void api.browser.setBounds(active, bounds)
    }

    push()
    const ro = new ResizeObserver(push)
    ro.observe(el)
    window.addEventListener('resize', push)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', push)
    }
  }, [view, active, api])

  const current = platforms.find((p) => p.id === active) ?? null

  const openPlatform = useCallback(
    async (id: PlatformId) => {
      setActive(id)
      setView('browser')
      setNotice(null)
      const res = await api.platform.open(id)
      if (res.ok) {
        setNotice(`已打开：${res.data.url ?? '（加载中）'}`)
      } else {
        setNotice(`打开失败：${res.error.code} ${res.error.message}`)
      }
    },
    [api]
  )

  return (
    <div className="app-shell">
      {/* 左侧导航 */}
      <nav className="rail">
        <div style={{ padding: '14px 14px 10px' }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>CourseHub</div>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>v0.2.0 · 课堂交互测试工作台</div>
        </div>

        <div style={{ padding: '0 8px' }}>
          {NAV.map((n) => (
            <button
              key={n.id}
              className="btn"
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                marginBottom: 3,
                background: view === n.id ? '#1d2b49' : 'transparent',
                borderColor: view === n.id ? '#2f4470' : 'transparent'
              }}
              onClick={() => setView(n.id)}
            >
              {n.label}
            </button>
          ))}
        </div>

        <div style={{ padding: '12px 14px' }}>
          <div style={{ fontSize: 11, color: '#64748b', marginBottom: 6 }}>平台会话</div>
          {platforms.length === 0 && <div style={{ fontSize: 11, color: '#64748b' }}>加载中…</div>}
          {platforms.map((p) => (
            <button
              key={p.id}
              className="btn"
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                marginBottom: 4,
                fontSize: 12,
                background: active === p.id ? '#16213a' : 'transparent'
              }}
              onClick={() => void openPlatform(p.id)}
              title={p.homeUrl}
            >
              {p.name}
            </button>
          ))}
        </div>
      </nav>

      {/* 中央区域 */}
      <main className="center">
        {view === 'browser' && (
          <>
            <div
              style={{
                display: 'flex',
                gap: 6,
                padding: '8px 10px',
                borderBottom: '1px solid #1c2942',
                alignItems: 'center'
              }}
            >
              <button className="btn" onClick={() => void api.browser.command(active, 'back')}>
                后退
              </button>
              <button className="btn" onClick={() => void api.browser.command(active, 'forward')}>
                前进
              </button>
              <button className="btn" onClick={() => void api.browser.command(active, 'reload')}>
                刷新
              </button>
              <span style={{ fontSize: 11, color: '#64748b', marginLeft: 6 }}>
                {current?.name ?? active} · 独立持久化 Session · 权限默认全拒
              </span>
            </div>
            <div className="viewport" ref={viewportRef} />
          </>
        )}

        {view === 'geo' && (
          <div className="scroll" style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: 12, paddingBottom: 0 }}>
              <GeoTestPanel run={geoRun} onRun={setGeoRun} />
            </div>
            <div style={{ padding: '0 12px 12px' }}>
              <div
                style={{
                  fontSize: 11,
                  color: '#64748b',
                  borderTop: '1px solid #1c2942',
                  paddingTop: 8,
                  marginBottom: 8
                }}
              >
                测试视图渲染在下方矩形。覆盖只作用于独立测试分区，不进入任何生产会话。
              </div>
              <div
                style={{
                  height: 320,
                  border: '1px dashed #24324f',
                  borderRadius: 8,
                  background: '#0b1220'
                }}
                className="viewport"
                ref={viewportRef}
              />
            </div>
          </div>
        )}

        {view === 'dashboard' && <Dashboard platforms={platforms} onOpen={openPlatform} />}
        {view === 'signin' && <SignInCenter />}
        {view === 'video' && (
          <VideoPanel active={active} observation={observation} setObservation={setObservation} />
        )}
        {view === 'ai' && <AiPanel />}
        {view === 'settings' && <SettingsPanel platforms={platforms} />}

        {notice && (
          <div
            style={{
              padding: '7px 12px',
              borderTop: '1px solid #1c2942',
              fontSize: 11,
              color: '#93a4bd',
              background: '#0f1626'
            }}
          >
            {notice}
          </div>
        )}
      </main>

      {/* 右侧抽屉 */}
      <aside className="drawer">
        <div style={{ padding: 14 }}>
          <Panel title="播放器观测（真实来源）">
            {observation ? (
              <div style={{ fontSize: 12, lineHeight: 1.9 }}>
                <div>
                  状态：<strong>{observation.playerState}</strong>{' '}
                  <span className="chip">{observation.origin}</span>
                </div>
                <div style={{ color: '#93a4bd' }}>
                  进度 {observation.currentTimeSeconds ?? '—'} / {observation.durationSeconds ?? '—'} 秒
                </div>
                <div style={{ color: '#93a4bd' }}>
                  本地观测：{observedProgressPercent(observation)?.toFixed(1) ?? '—'}%
                </div>
                <div style={{ color: '#93a4bd' }}>
                  倍速 {observation.playbackRate ?? '—'} · 音量{' '}
                  {observation.volume === null ? '—' : observation.volume.toFixed(2)}
                </div>
                <div style={{ color: '#475569', fontSize: 11, marginTop: 6 }}>
                  观测时间 {new Date(observation.observedAt).toLocaleTimeString()}
                </div>
              </div>
            ) : (
              <Empty text="尚未开始观测。播放器状态与平台任务状态是两个独立字段，此处只显示前者。" />
            )}
          </Panel>

          <Panel title="定位测试状态">
            {geoRun ? (
              <div style={{ fontSize: 12, lineHeight: 1.9 }}>
                <div>
                  状态：<strong>{geoRun.status}</strong>
                </div>
                <div style={{ color: '#93a4bd' }}>
                  下发 {geoRun.latitude.toFixed(5)}, {geoRun.longitude.toFixed(5)} ±
                  {geoRun.accuracyMeters}m
                </div>
                {geoRun.observedLocation ? (
                  <div style={{ color: '#6ee7b7' }}>
                    页面读回 {geoRun.observedLocation.latitude.toFixed(5)},{' '}
                    {geoRun.observedLocation.longitude.toFixed(5)}
                  </div>
                ) : (
                  <div style={{ color: '#64748b' }}>页面读回：—</div>
                )}
                {geoRun.error && (
                  <div style={{ color: '#fca5a5', marginTop: 4 }}>{geoRun.error}</div>
                )}
                {geoRun.observedLocation && (
                  <div style={{ color: '#475569', fontSize: 11 }}>
                    偏差{' '}
                    {haversineMeters(
                      { latitude: geoRun.latitude, longitude: geoRun.longitude },
                      {
                        latitude: geoRun.observedLocation.latitude,
                        longitude: geoRun.observedLocation.longitude
                      }
                    ).toFixed(2)}
                    m
                  </div>
                )}
              </div>
            ) : (
              <Empty text="尚未启动定位覆盖。覆盖坐标与授予 geolocation 权限是两件独立的事，两者都会验证。" />
            )}
          </Panel>

          <Panel title="平台能力">
            {current ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {Object.entries(current.capabilities).map(([k, v]) => (
                  <div key={k} style={{ fontSize: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                      <span style={{ color: '#cbd5e1' }}>{k}</span>
                      <CapabilityChip state={v.state} reason={v.reason} />
                    </div>
                    {v.reason && (
                      <div style={{ fontSize: 10, color: '#64748b', marginTop: 2, lineHeight: 1.5 }}>
                        {v.reason}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <Empty text="未选择平台" />
            )}
          </Panel>
        </div>
      </aside>
    </div>
  )
}

/* ------------------------------- 工作台 ------------------------------- */

function Dashboard({
  platforms,
  onOpen
}: {
  platforms: PlatformSummary[]
  onOpen: (id: PlatformId) => void
}): JSX.Element {
  return (
    <div className="scroll" style={{ padding: 16 }}>
      <Panel title="今日签到">
        <Empty text="未接入真实平台数据源。适配器能力为 unverified 时不展示任何签到条目，避免把未验证数据呈现为事实。" />
      </Panel>
      <Panel title="活跃课堂事件">
        <Empty text="同上：无真实事件源时不生成占位事件。" />
      </Panel>
      <Panel title="继续播放">
        <Empty text="尚无视频任务来源。" />
      </Panel>
      <Panel title="平台连接">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {platforms.map((p) => (
            <button key={p.id} className="btn" onClick={() => onOpen(p.id)}>
              打开 {p.name}
            </button>
          ))}
        </div>
      </Panel>
    </div>
  )
}

/* ------------------------------ 签到中心 ------------------------------ */

function SignInCenter(): JSX.Element {
  const [data, setData] = useState<{
    state: string
    events: unknown[]
    fetchedAt: string | null
    reason: string | null
  } | null>(null)

  const load = useCallback(() => {
    void window.coursehub.classroom.todaySignIns().then((r) => {
      if (r.ok) setData(r.data)
      else setData({ state: 'error', events: [], fetchedAt: null, reason: r.error.message })
    })
  }, [])

  useEffect(load, [load])

  return (
    <div className="scroll" style={{ padding: 16 }}>
      <Panel
        title="签到中心"
        right={
          <button className="btn" onClick={load}>
            手动刷新
          </button>
        }
      >
        {!data ? (
          <Empty text="加载中…" />
        ) : data.state === 'unverified' ? (
          <div style={{ fontSize: 12, color: '#c4b5fd', lineHeight: 1.7 }}>
            <CapabilityChip state="unverified" /> 平台数据源未在真实账号验证
            <div style={{ color: '#64748b', marginTop: 6 }}>{data.reason}</div>
          </div>
        ) : (
          <Empty text="当前无签到数据。" />
        )}
      </Panel>
      <Panel title="状态语义说明">
        <div style={{ fontSize: 12, color: '#93a4bd', lineHeight: 1.9 }}>
          <div>· 检测到活动 ≠ 已完成签到</div>
          <div>· 已签到必须有平台明确证据（statusSource = provider_api）</div>
          <div>· 本地记忆只能表达「已处理」，不会升级为已签到</div>
          <div>· 无结果时区分「确认为空」与「读取失败/未支持」</div>
        </div>
      </Panel>
    </div>
  )
}

/* ------------------------------ 视频任务 ------------------------------ */

function VideoPanel({
  active,
  observation,
  setObservation
}: {
  active: PlatformId
  observation: PlaybackObservation | null
  setObservation: (o: PlaybackObservation | null) => void
}): JSX.Element {
  const [volume, setVolume] = useState(1)
  const [rate, setRate] = useState(1)
  const [continuous, setContinuous] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const act = useCallback(
    async (action: string, value?: number) => {
      const r = await window.coursehub.video.command(active, action, value)
      setMsg(r.ok ? `${action} 已执行` : `失败：${r.error.code} ${r.error.message}`)
    },
    [active]
  )

  useEffect(() => {
    const off = window.coursehub.events.onContinuousStopped(() => setContinuous(false))
    return off
  }, [])

  return (
    <div className="scroll" style={{ padding: 16 }}>
      <Panel
        title="视频任务列表"
        right={
          <button
            className="btn"
            onClick={() => {
              void window.coursehub.video.list(active).then((r) =>
                setMsg(
                  r.ok
                    ? `能力状态 ${r.data.state}：${r.data.reason ?? '无'}`
                    : `失败：${r.error.message}`
                )
              )
            }}
          >
            刷新任务
          </button>
        }
      >
        <Empty text="当前平台无已验证的视频任务来源。任务列表只接受平台接口或页面真实解析结果，不生成占位任务。" />
      </Panel>

      <Panel title="播放器控制（仅当前已打开页面）">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          <button className="btn btn-primary" onClick={() => void act('play')}>
            播放
          </button>
          <button className="btn" onClick={() => void act('pause')}>
            暂停
          </button>
          <button className="btn" onClick={() => void act('mute')}>
            静音
          </button>
          <button className="btn" onClick={() => void act('unmute')}>
            取消静音
          </button>
          <button className="btn" onClick={() => void act('stop')}>
            停止
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 10 }}>
          <div>
            <label>音量 {volume.toFixed(2)}</label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              onChange={(e) => setVolume(Number(e.target.value))}
            />
            <button
              className="btn"
              style={{ marginTop: 6 }}
              onClick={() => void act('setVolume', volume)}
            >
              应用音量
            </button>
          </div>
          <div>
            <label>倍速（平台白名单）</label>
            <select value={rate} onChange={(e) => setRate(Number(e.target.value))}>
              {ALLOWED_PLAYBACK_RATES.map((r) => (
                <option key={r} value={r}>
                  {r}x
                </option>
              ))}
            </select>
            <button className="btn" style={{ marginTop: 6 }} onClick={() => void act('setRate', rate)}>
              应用倍速
            </button>
          </div>
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={continuous}
            onChange={(e) => setContinuous(e.target.checked)}
          />
          开启连续播放（仅在真实观测到 ended 且平台允许时推进）
        </label>

        <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
          <button
            className="btn"
            onClick={() => {
              void window.coursehub.video
                .observe(active, `${active}:current`)
                .then((r) => setMsg(r.ok ? '已开始观测播放器' : `观测失败：${r.error.message}`))
            }}
          >
            开始观测
          </button>
          <button
            className="btn btn-danger"
            onClick={() => {
              void window.coursehub.video.stopContinuous().then(() => {
                setObservation(null)
                setMsg('已停止连续播放并清理观察器')
              })
            }}
          >
            停止连续播放
          </button>
        </div>

        {msg && (
          <div style={{ fontSize: 11, color: '#93a4bd', marginTop: 10 }}>{msg}</div>
        )}
      </Panel>

      <Panel title="双状态对照">
        <div style={{ fontSize: 12, color: '#93a4bd', lineHeight: 1.9 }}>
          <div>播放器状态：{observation?.playerState ?? '未观测'}</div>
          <div>平台任务状态：需平台接口返回，本版本无已验证来源</div>
          <div style={{ color: '#fcd34d', marginTop: 6 }}>
            播放器 ended 不会自动把平台状态改为已完成。
          </div>
        </div>
      </Panel>
    </div>
  )
}

/* ------------------------------- 课堂 AI ------------------------------- */

function AiPanel(): JSX.Element {
  const [key, setKey] = useState('')
  const [models, setModels] = useState<{ id: string; inputModalities: readonly string[] }[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [stream, setStream] = useState('')
  const [busy, setBusy] = useState(false)

  const loadModels = useCallback(() => {
    void window.coursehub.ai.models().then((r) => {
      if (r.ok) {
        setModels(r.data.models)
        setErr(r.data.error)
      } else setErr(`${r.error.code}: ${r.error.message}`)
    })
  }, [])

  useEffect(() => {
    const off = window.coursehub.events.onAiDelta((c) => setStream((s) => s + c))
    return off
  }, [])

  return (
    <div className="scroll" style={{ padding: 16 }}>
      <Panel title="DeepSeek API Key">
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type="password"
            placeholder="sk-..."
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <button
            className="btn btn-primary"
            onClick={() => {
              void window.coursehub.ai.setKey(key).then((r) => {
                if (r.ok) {
                  setKey('')
                  setErr(null)
                  loadModels()
                } else setErr(r.error.message)
              })
            }}
          >
            保存
          </button>
          <button className="btn" onClick={() => void window.coursehub.ai.deleteKey()}>
            删除
          </button>
        </div>
        <div style={{ fontSize: 11, color: '#64748b', marginTop: 8, lineHeight: 1.6 }}>
          Key 经 Electron safeStorage 加密落盘，渲染进程永远读不到明文。
        </div>
      </Panel>

      <Panel
        title="模型发现（/models）"
        right={
          <button className="btn" onClick={loadModels}>
            刷新
          </button>
        }
      >
        {err && <div style={{ fontSize: 12, color: '#fca5a5', marginBottom: 8 }}>{err}</div>}
        {models.length === 0 ? (
          <Empty text="未配置 Key 或尚未拉取模型列表。图片能力一律以 /models 的 input_modalities 为准，不凭模型名猜测。" />
        ) : (
          models.map((m) => (
            <div key={m.id} style={{ fontSize: 12, marginBottom: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>{m.id}</span>
                <span className="chip">
                  {m.inputModalities.includes('image') ? '支持图片' : '仅文本'}
                </span>
              </div>
            </div>
          ))
        )}
      </Panel>

      <Panel title="流式输出">
        <button
          className="btn"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            setStream('')
            void window.coursehub.ai
              .generate({
                model: models[0]?.id ?? 'deepseek-flash',
                systemPrompt: '你是课堂助手。只依据给定材料回答，不确定时明确说明。',
                userText: '（此输入框将在接入课堂题目后填充真实题干）'
              })
              .then((r) => {
                if (!r.ok) {
                  setStream((s) => `${s}\n[失败] ${r.error.code} ${r.error.message}`)
                  return
                }
                if (r.data.cancelled) setStream((s) => `${s}\n[已取消]`)
                else if (r.data.error) setStream((s) => `${s}\n[失败] ${r.data.error}`)
              })
              .finally(() => setBusy(false))
          }}
        >
          发送测试请求
        </button>
        <button className="btn" style={{ marginLeft: 6 }} onClick={() => void window.coursehub.ai.cancel()}>
          取消
        </button>
        <pre
          style={{
            marginTop: 10,
            fontSize: 11,
            whiteSpace: 'pre-wrap',
            background: '#0b1220',
            border: '1px solid #1e2b45',
            borderRadius: 6,
            padding: 10,
            maxHeight: 260,
            overflow: 'auto'
          }}
        >
          {stream || '（无输出）'}
        </pre>
      </Panel>
    </div>
  )
}

/* -------------------------------- 设置 -------------------------------- */

function SettingsPanel({ platforms }: { platforms: PlatformSummary[] }): JSX.Element {
  const [diag, setDiag] = useState<string | null>(null)

  return (
    <div className="scroll" style={{ padding: 16 }}>
      <Panel title="适配器版本">
        {platforms.map((p) => (
          <div key={p.id} style={{ fontSize: 12, marginBottom: 6 }}>
            {p.name} · v{p.adapterVersion ?? '—'}
          </div>
        ))}
      </Panel>

      <Panel title="诊断导出">
        <button
          className="btn"
          onClick={() => {
            void window.coursehub.diagnostics.export().then((r) =>
              setDiag(r.ok ? `${r.data.note} → ${r.data.path}` : r.error.message)
            )
          }}
        >
          导出脱敏诊断
        </button>
        {diag && <div style={{ fontSize: 11, color: '#93a4bd', marginTop: 8 }}>{diag}</div>}
      </Panel>

      <Panel title="权限边界">
        <div style={{ fontSize: 12, color: '#93a4bd', lineHeight: 1.9 }}>
          <div>· 远程平台页：nodeIntegration 关 / contextIsolation 开 / sandbox 开</div>
          <div>· 每个平台独立持久化 Session，权限请求与检查均默认拒绝</div>
          <div>· 定位覆盖只作用于独立测试分区，绝不进入生产会话</div>
          <div>· 不实现自动签到、自动提交答案、伪造观看心跳</div>
        </div>
      </Panel>
    </div>
  )
}
