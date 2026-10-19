import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import {
  Crosshair,
  Play,
  Square,
  RotateCcw,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw
} from 'lucide-react'
import type { GeoTestRun, GeoCoordinateSystem } from '@shared/types'
import { validateGeoPoint, gcj02ToWgs84Approx, haversineMeters, GCJ02_MAX_OFFSET_METERS } from '@shared/geo'
import { Card, Notice, Rows, Seg, CapChip } from '../components/ui'

export interface TileProvider {
  id: string
  name: string
  url: string
  attribution: string
  subdomains?: string[]
}

/** 瓦片源：默认首选 OpenStreetMap 官方（免 Key 合规），备选 CARTO 浅色（需 API Key）与自定义源 */
export const TILE_PROVIDERS: TileProvider[] = [
  {
    id: 'osm_standard',
    name: 'OpenStreetMap 官方 (默认)',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors'
  },
  {
    id: 'carto_light',
    name: 'CARTO 浅色 (需 API Key / 无 Key 含水印)',
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; <a href="https://carto.com/attributions" target="_blank" rel="noreferrer">CARTO</a>, &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
    subdomains: ['a', 'b', 'c', 'd']
  },
  {
    id: 'custom',
    name: '自定义瓦片 URL',
    url: '',
    attribution: '自定义地图图源'
  }
]

/** 修复 Leaflet 默认 marker 图标在打包后的路径问题（用内联 SVG，不依赖图片资源）。 */
const MARKER_ICON = L.divIcon({
  className: 'ch-marker',
  html: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 2C7.58 2 4 5.58 4 10c0 5.25 6.75 11.5 7.4 12.18a1 1 0 0 0 1.2 0C13.25 21.5 20 15.25 20 10c0-4.42-3.58-8-8-8z" fill="#0B57D0"/>
    <circle cx="12" cy="10" r="3" fill="#fff"/>
  </svg>`,
  iconSize: [28, 28],
  iconAnchor: [14, 28]
})

export interface GeoSceneProps {
  run: GeoTestRun | null
  busy: boolean
  onStart: (cfg: {
    latitude: number
    longitude: number
    accuracyMeters: number
    coordinateSystem: GeoCoordinateSystem
    targetOrigin: string
  }) => void
  onStop: () => void
}

/**
 * 定位测试场景。
 *
 * 这是 **Web Geolocation API 行为测试**，不是位置伪装工具：
 * - 只在下方的独立测试 webContents 上生效；
 * - 必须读回测试页 navigator.geolocation 的实际返回值才算成功；
 * - 停止时清除覆盖；结果与任何真实平台出勤记录无关。
 */
export function GeoScene({ run, busy, onStart, onStop }: GeoSceneProps): ReactNode {
  const mapEl = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const markerRef = useRef<L.Marker | null>(null)
  const tileLayerRef = useRef<L.TileLayer | null>(null)
  const errorLoggedRef = useRef<string | null>(null)

  const [lat, setLat] = useState('30.6572')
  const [lon, setLon] = useState('104.0657')
  const [acc, setAcc] = useState('50')
  const [system, setSystem] = useState<GeoCoordinateSystem>('wgs84')
  const [error, setError] = useState<string | null>(null)
  const [tilesFailed, setTilesFailed] = useState(false)
  const [providerId, setProviderId] = useState<string>(() => {
    try {
      return localStorage.getItem('coursehub_tile_provider') || 'osm_standard'
    } catch {
      return 'osm_standard'
    }
  })
  const [cartoApiKey, setCartoApiKey] = useState<string>(() => {
    try {
      return localStorage.getItem('coursehub_carto_api_key') || ''
    } catch {
      return ''
    }
  })
  const [customTileUrl, setCustomTileUrl] = useState<string>(() => {
    try {
      return localStorage.getItem('coursehub_custom_tile_url') || ''
    } catch {
      return ''
    }
  })
  const [tileRetryKey, setTileRetryKey] = useState(0)

  // 当前瓦片源
  const currentProvider = TILE_PROVIDERS.find((p) => p.id === providerId) || TILE_PROVIDERS[0]

  // 输入值 -> WGS-84 合法点。非法时返回 null，地图不跳到 NaN。
  const point = (() => {
    const v = validateGeoPoint({
      latitude: Number(lat),
      longitude: Number(lon),
      accuracyMeters: Number(acc)
    })
    return v.ok ? v.point : null
  })()
  const latLng: L.LatLngTuple | null = point ? [point.latitude, point.longitude] : null

  // ---------------- 绑定或切换瓦片图层 ----------------
  const attachTileLayer = useCallback(
    (map: L.Map, provider: TileProvider, currentCartoKey: string, currentCustomUrl: string) => {
      if (tileLayerRef.current) {
        map.removeLayer(tileLayerRef.current)
        tileLayerRef.current = null
      }

      setTilesFailed(false)

      let urlPattern = provider.url
      if (provider.id === 'carto_light') {
        const trimmedKey = currentCartoKey.trim()
        if (trimmedKey) {
          urlPattern = `${provider.url}?key=${encodeURIComponent(trimmedKey)}`
        }
      } else if (provider.id === 'custom') {
        urlPattern = currentCustomUrl.trim() || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
      }

      const layer = L.tileLayer(urlPattern, {
        attribution: provider.attribution,
        maxZoom: 19,
        subdomains: provider.subdomains || 'abc'
      })

      layer.on('tileerror', () => {
        setTilesFailed(true)
        // 防抖记录安全诊断事件，不污染或影响平台状态机
        if (errorLoggedRef.current !== `${provider.id}:${urlPattern}`) {
          errorLoggedRef.current = `${provider.id}:${urlPattern}`
          void window.coursehub.diagnostics
            .recordError({
              module: 'geo',
              type: 'map_tile_error',
              code: 'MAP_TILE_LOAD_ERROR',
              summary: `地图瓦片加载失败 (${provider.name})，可能由于国内网络受阻或连接超时`,
              platform: undefined,
              data: {
                providerId: provider.id,
                urlPattern
              }
            })
            .catch(() => {})
        }
      })

      layer.addTo(map)
      tileLayerRef.current = layer
    },
    []
  )

  // ---------------- 初始化地图 ----------------
  useEffect(() => {
    if (!mapEl.current || mapRef.current) return

    const map = L.map(mapEl.current, {
      center: [30.6572, 104.0657],
      zoom: 15,
      zoomControl: true,
      attributionControl: true
    })

    attachTileLayer(map, currentProvider, cartoApiKey, customTileUrl)

    const marker = L.marker([30.6572, 104.0657], { icon: MARKER_ICON, draggable: true }).addTo(map)

    // 点选地图设点
    map.on('click', (e: L.LeafletMouseEvent) => {
      setLat(e.latlng.lat.toFixed(6))
      setLon(e.latlng.lng.toFixed(6))
    })

    // 拖动标记设点
    marker.on('dragend', () => {
      const p = marker.getLatLng()
      setLat(p.lat.toFixed(6))
      setLon(p.lng.toFixed(6))
    })

    mapRef.current = map
    markerRef.current = marker

    // 容器尺寸变化或初次渲染时刷新，避免抽屉折叠后地图空白
    const ro = new ResizeObserver(() => map.invalidateSize())
    ro.observe(mapEl.current)
    const t1 = setTimeout(() => map.invalidateSize(), 200)
    const t2 = setTimeout(() => map.invalidateSize(), 600)

    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
      ro.disconnect()
      map.remove()
      mapRef.current = null
      markerRef.current = null
      tileLayerRef.current = null
    }
  }, [])

  // 瓦片源切换或重试触发
  useEffect(() => {
    if (mapRef.current) {
      attachTileLayer(mapRef.current, currentProvider, cartoApiKey, customTileUrl)
    }
  }, [providerId, tileRetryKey, attachTileLayer, currentProvider, cartoApiKey, customTileUrl])

  // 坐标变化时同步标记与视图
  useEffect(() => {
    const map = mapRef.current
    const marker = markerRef.current
    if (!map || !marker || !latLng) return

    marker.setLatLng(latLng)
    map.panTo(latLng, { animate: true })
  }, [latLng])

  // ---------------- 动作 ----------------
  const handleStart = useCallback(() => {
    setError(null)
    if (!point) {
      const v = validateGeoPoint({
        latitude: Number(lat),
        longitude: Number(lon),
        accuracyMeters: Number(acc)
      })
      const names: Record<string, string> = {
        LATITUDE_OUT_OF_RANGE: '纬度必须在 -90 ~ 90',
        LONGITUDE_OUT_OF_RANGE: '经度必须在 -180 ~ 180',
        ACCURACY_INVALID: '精度必须是大于 0 的米数',
        NOT_FINITE: '坐标必须是有限数字'
      }
      setError(v.ok ? '坐标非法' : v.errors.map((e) => names[e] ?? e).join('；'))
      return
    }

    let target = point
    if (system === 'gcj02') {
      const c = gcj02ToWgs84Approx(point.latitude, point.longitude)
      target = { ...point, latitude: c.latitude, longitude: c.longitude }
    }

    onStart({
      latitude: target.latitude,
      longitude: target.longitude,
      accuracyMeters: target.accuracyMeters,
      coordinateSystem: system,
      targetOrigin: 'file://tests/fixtures/geo-test.html'
    })
  }, [point, lat, lon, acc, system, onStart])

  const conv = system === 'gcj02' && point
    ? gcj02ToWgs84Approx(point.latitude, point.longitude)
    : null

  const observed = run?.observedLocation ?? null
  const drift =
    observed !== null && run
      ? haversineMeters(
          { latitude: run.latitude, longitude: run.longitude },
          { latitude: observed.latitude, longitude: observed.longitude }
        )
      : null

  return (
    <div style={{ maxWidth: 1120, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1.35fr 1fr', gap: 16, alignItems: 'start' }}>
        {/* ---------------- 左：地图 ---------------- */}
        <Card
          title="测试地图"
          style={{ padding: 14 }}
          action={
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <select
                className="field"
                style={{ padding: '3px 6px', fontSize: 11, height: 26, width: 'auto' }}
                value={providerId}
                onChange={(e) => {
                  const val = e.target.value
                  setProviderId(val)
                  setTilesFailed(false)
                  try {
                    localStorage.setItem('coursehub_tile_provider', val)
                  } catch {}
                }}
                title="切换地图瓦片源"
              >
                {TILE_PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ padding: '3px 8px', fontSize: 11, height: 26 }}
                onClick={() => {
                  setTilesFailed(false)
                  setTileRetryKey((k) => k + 1)
                }}
                title="重新加载瓦片"
              >
                <RefreshCw size={12} />
                重试
              </button>
            </div>
          }
        >
          <div
            id="ch-map"
            ref={mapEl}
            data-testid="geo-map"
            role="application"
            aria-label="定位测试地图，点击或拖动标记选择坐标"
          />

          {/* 瓦片图层设置 (当选择 CARTO 或 自定义 时展示) */}
          {providerId === 'carto_light' && (
            <div
              style={{
                marginTop: 8,
                padding: '6px 10px',
                background: 'var(--ch-subtle)',
                borderRadius: 6,
                fontSize: 11,
                display: 'flex',
                flexDirection: 'column',
                gap: 4
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                <span style={{ fontWeight: 600 }}>CARTO API Key:</span>
                <span style={{ fontSize: 10.5, color: 'var(--ch-text-3)' }}>
                  无 Key 含斜向官方水印。可前往{' '}
                  <a
                    href="https://carto.com/basemaps/apikey/"
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: 'var(--ch-primary)', textDecoration: 'underline' }}
                  >
                    carto.com/basemaps/apikey
                  </a>{' '}
                  免费申请（非商用 500 万次/月）
                </span>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  className="field"
                  style={{ fontSize: 11, height: 26, flex: 1 }}
                  placeholder="粘贴 CARTO API Key (可选)"
                  value={cartoApiKey}
                  onChange={(e) => {
                    const val = e.target.value
                    setCartoApiKey(val)
                    try {
                      localStorage.setItem('coursehub_carto_api_key', val)
                    } catch {}
                  }}
                />
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ fontSize: 11, height: 26, padding: '2px 8px' }}
                  onClick={() => {
                    setTilesFailed(false)
                    setTileRetryKey((k) => k + 1)
                  }}
                >
                  应用
                </button>
              </div>
            </div>
          )}

          {providerId === 'custom' && (
            <div
              style={{
                marginTop: 8,
                padding: '6px 10px',
                background: 'var(--ch-subtle)',
                borderRadius: 6,
                fontSize: 11,
                display: 'flex',
                flexDirection: 'column',
                gap: 4
              }}
            >
              <span style={{ fontWeight: 600 }}>自定义瓦片 URL 模板:</span>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  className="field"
                  style={{ fontSize: 11, height: 26, flex: 1 }}
                  placeholder="https://example.com/tiles/{z}/{x}/{y}.png"
                  value={customTileUrl}
                  onChange={(e) => {
                    const val = e.target.value
                    setCustomTileUrl(val)
                    try {
                      localStorage.setItem('coursehub_custom_tile_url', val)
                    } catch {}
                  }}
                />
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ fontSize: 11, height: 26, padding: '2px 8px' }}
                  onClick={() => {
                    setTilesFailed(false)
                    setTileRetryKey((k) => k + 1)
                  }}
                >
                  应用
                </button>
              </div>
            </div>
          )}

          {tilesFailed && (
            <div style={{ marginTop: 10 }}>
              <Notice tone="warn">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ fontWeight: 600 }}>⚠️ 地图底图瓦片加载受阻（当前网络环境可能无法直连瓦片服务器）</div>
                  <div style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--ch-text-2)' }}>
                    <strong>【核心功能不受影响】</strong>：Web Geolocation 经纬度覆盖、页面真实读回与偏差核验<strong>完全正常工作</strong>。
                  </div>
                  <div style={{ fontSize: 11, lineHeight: 1.5 }}>
                    你可以：
                    <ul style={{ margin: '4px 0 4px 16px', padding: 0 }}>
                      <li>直接在右侧面板手动输入经纬度数值执行测试；</li>
                      <li>在地图空白网格中依然可以点选或拖动蓝色图钉选取坐标；</li>
                      <li>点击右上角<strong>「重试」</strong>重新请求瓦片；</li>
                      <li>切换图源为「CARTO 浅色」（可选填免费 Key）或自定义瓦片源。</li>
                    </ul>
                  </div>
                </div>
              </Notice>
            </div>
          )}
          <div
            style={{
              marginTop: 10,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              fontSize: 10.5,
              color: 'var(--ch-text-3)'
            }}
          >
            <span>源: {currentProvider.name}</span>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ fontSize: 11 }}
              onClick={() => {
                setLat('30.6572')
                setLon('104.0657')
                setError(null)
              }}
            >
              <RotateCcw size={12} />
              重置到默认点
            </button>
          </div>
        </Card>

        {/* ---------------- 右：控制 + 读数 ---------------- */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <Card title="目标坐标">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <label className="label" htmlFor="geo-lat">纬度 latitude</label>
                <input
                  id="geo-lat"
                  className="field field-mono"
                  type="number"
                  step="0.000001"
                  value={lat}
                  onChange={(e) => setLat(e.target.value)}
                  data-testid="geo-lat"
                />
              </div>
              <div>
                <label className="label" htmlFor="geo-lon">经度 longitude</label>
                <input
                  id="geo-lon"
                  className="field field-mono"
                  type="number"
                  step="0.000001"
                  value={lon}
                  onChange={(e) => setLon(e.target.value)}
                  data-testid="geo-lon"
                />
              </div>
            </div>

            <div style={{ marginTop: 10 }}>
              <label className="label" htmlFor="geo-acc">定位精度（米）</label>
              <input
                id="geo-acc"
                className="field field-mono"
                type="number"
                step="1"
                min="1"
                value={acc}
                onChange={(e) => setAcc(e.target.value)}
                data-testid="geo-acc"
              />
            </div>

            <div style={{ marginTop: 12 }}>
              <p className="label">坐标系</p>
              <Seg
                value={system}
                onChange={setSystem}
                options={[
                  { id: 'wgs84', label: 'WGS-84（内部存储）' },
                  { id: 'gcj02', label: 'GCJ-02（近似转换）' }
                ]}
              />
            </div>

            {conv && (
              <div style={{ marginTop: 10 }}>
                <Notice tone="warn">
                  GCJ-02 → WGS-84 近似值：
                  <strong> {conv.latitude.toFixed(6)}, {conv.longitude.toFixed(6)}</strong>
                  <br />
                  偏移约 {haversineMeters(
                    { latitude: Number(lat) || 0, longitude: Number(lon) || 0 },
                    { latitude: conv.latitude, longitude: conv.longitude }
                  ).toFixed(0)} m。该算法为<strong>近似</strong>，误差可达 ±{GCJ02_MAX_OFFSET_METERS} m，
                  不可用于需要精确位置的场景。
                </Notice>
              </div>
            )}

            {error && (
              <div style={{ marginTop: 10 }}>
                <Notice tone="error">{error}</Notice>
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button
                type="button"
                className="btn btn-primary"
                style={{ flex: 1 }}
                onClick={handleStart}
                disabled={busy}
                data-testid="geo-start"
              >
                {busy ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
                开始覆盖
              </button>
              <button
                type="button"
                className="btn"
                onClick={onStop}
                disabled={busy || !run || run.status === 'idle' || run.status === 'cleared'}
                data-testid="geo-stop"
              >
                <Square size={13} />
                停止并解除
              </button>
            </div>
          </Card>

          <Card
            title="测试页实际读数"
            action={<CapChip state={run ? (run.status === 'cleared' ? 'supported' : 'unverified') : 'unsupported'} compact />}
          >
            {!run || run.status === 'idle' ? (
              <p style={{ fontSize: 11.5, color: 'var(--ch-text-2)', margin: 0, lineHeight: 1.7 }}>
                尚未启动。覆盖坐标与授予 geolocation 权限是两件独立的事，
                两者都会做，且必须读回测试页实际值才判定成功。
              </p>
            ) : (
              <>
                <Rows
                  items={[
                    { k: '运行状态', v: <strong data-testid="geo-status">{run.status}</strong> },
                    { k: '下发坐标', v: `${run.latitude.toFixed(6)}, ${run.longitude.toFixed(6)}`, mono: true },
                    { k: '下发精度', v: `±${run.accuracyMeters} m`, mono: true },
                    {
                      k: '页面读回',
                      v: observed
                        ? `${observed.latitude.toFixed(6)}, ${observed.longitude.toFixed(6)}`
                        : '—',
                      mono: true
                    },
                    {
                      k: '偏差',
                      v: drift === null ? '—' : `${drift.toFixed(2)} m`,
                      mono: true
                    },
                    { k: '下发时间', v: run.appliedAt ? new Date(run.appliedAt).toLocaleTimeString() : '—', mono: true },
                    { k: '清除时间', v: run.clearedAt ? new Date(run.clearedAt).toLocaleTimeString() : '—', mono: true }
                  ]}
                />
                {run.error && (
                  <div style={{ marginTop: 10 }}>
                    <Notice tone="error">{run.error}</Notice>
                  </div>
                )}
                {run.status === 'cleared' && (
                  <div style={{ marginTop: 10 }}>
                    <Notice tone="ok">
                      <CheckCircle2 size={12} style={{ display: 'inline', marginRight: 4, verticalAlign: -1 }} />
                      覆盖已解除，测试页读数不再等于下发值。
                    </Notice>
                  </div>
                )}
              </>
            )}
          </Card>

          <Card title="边界说明">
            <Notice tone="info">
              覆盖只作用于<strong>独立测试 webContents</strong>（<code>coursehub-test</code> 分区），
              与三个生产平台会话完全隔离。
              <br />
              本功能验证 Web API 行为，<strong>不代表现实位置，也不改变任何平台出勤或签到记录</strong>。
            </Notice>
          </Card>
        </div>
      </div>

      {/* 测试页视图：原生 WebContentsView，由主进程设置 bounds */}
      <div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 8,
            fontSize: 11,
            color: 'var(--ch-text-2)'
          }}
        >
          <Crosshair size={13} />
          <span>测试页面（独立会话 · 读取 navigator.geolocation 实际返回）</span>
        </div>
        <div
          id="geo-viewport"
          data-testid="geo-viewport"
          style={{
            height: 300,
            borderRadius: 'var(--r-block)',
            border: '1px dashed var(--ch-border)',
            background: 'var(--ch-subtle)',
            position: 'relative',
            overflow: 'hidden'
          }}
        />
      </div>

      {!run && (
        <Notice tone="warn">
          <AlertTriangle size={12} style={{ display: 'inline', marginRight: 4, verticalAlign: -1 }} />
          未启动定位测试。生产平台会话<strong>永不</strong>应用地理位置覆盖。
        </Notice>
      )}
    </div>
  )
}

