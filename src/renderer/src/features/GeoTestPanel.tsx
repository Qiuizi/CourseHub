import { useCallback, useEffect, useState } from 'react'
import type { GeoTestRun } from '@shared/types'
import { validateGeoPoint, gcj02ToWgs84Approx, haversineMeters } from '@shared/geo'
import type { GeoCoordinateSystem } from '@shared/types'

const PRESETS = [
  { name: '北京 · 天安门', lat: 39.9087, lon: 116.3975 },
  { name: '成都 · 天府广场', lat: 30.6572, lon: 104.0657 },
  { name: '上海 · 人民广场', lat: 31.2304, lon: 121.4737 }
]

/**
 * 定位模拟测试控制面板。
 *
 * 明确边界：这里只验证 Web Geolocation API 的行为与解除覆盖，
 * 不代表现实位置、平台出勤或签到结果。
 */
export default function GeoTestPanel({
  run,
  onRun
}: {
  run: GeoTestRun | null
  onRun: (r: GeoTestRun) => void
}): JSX.Element {
  const [lat, setLat] = useState('30.6572')
  const [lon, setLon] = useState('104.0657')
  const [acc, setAcc] = useState('50')
  const [system, setSystem] = useState<GeoCoordinateSystem>('wgs84')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [cleared, setCleared] = useState<{ lat: number; lon: number } | null>(null)

  const start = useCallback(async () => {
    setError(null)
    setCleared(null)

    const parsed = {
      latitude: Number(lat),
      longitude: Number(lon),
      accuracyMeters: Number(acc)
    }

    const v = validateGeoPoint(parsed)
    if (!v.ok) {
      setError(`坐标非法：${v.errors.join(', ')}`)
      return
    }

    let point = v.point
    if (system === 'gcj02') {
      const conv = gcj02ToWgs84Approx(point.latitude, point.longitude)
      point = { ...point, latitude: conv.latitude, longitude: conv.longitude }
    }

    setBusy(true)
    const res = await window.coursehub.geoTest.start({
      latitude: point.latitude,
      longitude: point.longitude,
      accuracyMeters: point.accuracyMeters,
      coordinateSystem: system,
      targetOrigin: 'file://tests/fixtures/geo-test.html'
    })
    setBusy(false)
    if (res.ok) onRun(res.data)
    else setError(`${res.error.code}: ${res.error.message}`)
  }, [lat, lon, acc, system, onRun])

  const stop = useCallback(async () => {
    setBusy(true)
    const before = run ? { lat: run.latitude, lon: run.longitude } : null
    const res = await window.coursehub.geoTest.stop()
    setBusy(false)
    if (res.ok) {
      onRun(res.data)
      if (before) setCleared(before)
    } else setError(res.error.message)
  }, [run, onRun])

  useEffect(() => {
    if (run?.status === 'cleared') setCleared({ lat: run.latitude, lon: run.longitude })
  }, [run])

  const conversion =
    system === 'gcj02'
      ? gcj02ToWgs84Approx(Number(lat) || 0, Number(lon) || 0)
      : null

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <h2 style={{ fontSize: 13, margin: '0 0 10px' }}>定位测试控制</h2>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 10 }}>
        <div>
          <label>纬度 latitude</label>
          <input type="number" step="0.00001" value={lat} onChange={(e) => setLat(e.target.value)} />
        </div>
        <div>
          <label>经度 longitude</label>
          <input type="number" step="0.00001" value={lon} onChange={(e) => setLon(e.target.value)} />
        </div>
        <div>
          <label>精度 (m)</label>
          <input type="number" step="1" min="1" value={acc} onChange={(e) => setAcc(e.target.value)} />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 10 }}>
        <div style={{ flex: 1 }}>
          <label>坐标系</label>
          <select value={system} onChange={(e) => setSystem(e.target.value as GeoCoordinateSystem)}>
            <option value="wgs84">WGS-84（内部存储）</option>
            <option value="gcj02">GCJ-02（近似转换）</option>
          </select>
        </div>
        <div style={{ flex: 2 }}>
          <label>快速预设</label>
          <div style={{ display: 'flex', gap: 4 }}>
            {PRESETS.map((p) => (
              <button
                key={p.name}
                className="btn"
                style={{ fontSize: 11 }}
                onClick={() => {
                  setLat(String(p.lat))
                  setLon(String(p.lon))
                }}
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>
      </div>

      {conversion && (
        <div
          style={{
            fontSize: 11,
            color: '#c4b5fd',
            background: '#1e1038',
            border: '1px solid #4c1d95',
            borderRadius: 6,
            padding: '6px 8px',
            marginBottom: 10,
            lineHeight: 1.6
          }}
        >
          GCJ-02 → WGS-84 近似值：{conversion.latitude.toFixed(6)}, {conversion.longitude.toFixed(6)}
          <br />
          偏移 {haversineMeters(
            { latitude: Number(lat) || 0, longitude: Number(lon) || 0 },
            { latitude: conversion.latitude, longitude: conversion.longitude }
          ).toFixed(0)} m · 该算法为近似，误差可达 ±{conversion.maxErrorMeters} m
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        <button className="btn btn-primary" disabled={busy} onClick={() => void start()}>
          启动覆盖
        </button>
        <button className="btn btn-danger" disabled={busy} onClick={() => void stop()}>
          停止并解除
        </button>
      </div>

      {error && (
        <div style={{ fontSize: 11, color: '#fca5a5', marginBottom: 8 }}>{error}</div>
      )}

      {run && (
        <div style={{ fontSize: 11, color: '#93a4bd', lineHeight: 1.8 }}>
          <div>
            当前状态：<strong style={{ color: '#e6edf7' }}>{run.status}</strong>
          </div>
          <div>
            下发时间：{run.appliedAt ? new Date(run.appliedAt).toLocaleTimeString() : '—'}
          </div>
          <div>
            清除时间：{run.clearedAt ? new Date(run.clearedAt).toLocaleTimeString() : '—'}
          </div>
          {cleared && (
            <div style={{ color: '#6ee7b7', marginTop: 4 }}>
              覆盖已解除（{cleared.lat.toFixed(5)}, {cleared.lon.toFixed(5)} 不再生效）
            </div>
          )}
        </div>
      )}
    </div>
  )
}
