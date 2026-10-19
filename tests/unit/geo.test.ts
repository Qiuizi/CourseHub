/**
 * 坐标校验、GCJ-02 近似换算与距离计算测试。
 */

import { describe, it, expect } from 'vitest'
import {
  validateGeoPoint,
  gcj02ToWgs84Approx,
  haversineMeters,
  GCJ02_MAX_OFFSET_METERS,
  isValidCustomTileUrl
} from '@shared/geo'

describe('validateGeoPoint', () => {
  it('接受合法坐标', () => {
    const r = validateGeoPoint({ latitude: 30.556, longitude: 103.989, accuracyMeters: 50 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.point.accuracyMeters).toBe(50)
  })

  it('接受边界值', () => {
    expect(validateGeoPoint({ latitude: 90, longitude: 180, accuracyMeters: 1 }).ok).toBe(true)
    expect(validateGeoPoint({ latitude: -90, longitude: -180, accuracyMeters: 1 }).ok).toBe(true)
    expect(validateGeoPoint({ latitude: 0, longitude: 0, accuracyMeters: 0.1 }).ok).toBe(true)
  })

  it('纬度越界', () => {
    const r = validateGeoPoint({ latitude: 91, longitude: 0, accuracyMeters: 10 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors).toContain('LATITUDE_OUT_OF_RANGE')
  })

  it('经度越界', () => {
    const r = validateGeoPoint({ latitude: 0, longitude: 181, accuracyMeters: 10 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors).toContain('LONGITUDE_OUT_OF_RANGE')
  })

  it('精度必须为正数', () => {
    for (const acc of [0, -1, -0.5]) {
      const r = validateGeoPoint({ latitude: 0, longitude: 0, accuracyMeters: acc })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.errors).toContain('ACCURACY_INVALID')
    }
  })

  it('非有限数与非数字类型被拒绝', () => {
    for (const v of [NaN, Infinity, -Infinity]) {
      expect(validateGeoPoint({ latitude: v, longitude: 0, accuracyMeters: 1 }).ok).toBe(false)
      expect(validateGeoPoint({ latitude: 0, longitude: v, accuracyMeters: 1 }).ok).toBe(false)
      expect(validateGeoPoint({ latitude: 0, longitude: 0, accuracyMeters: v }).ok).toBe(false)
    }
    expect(validateGeoPoint({ latitude: '30', longitude: 0, accuracyMeters: 1 }).ok).toBe(false)
    expect(validateGeoPoint({ latitude: null, longitude: 0, accuracyMeters: 1 }).ok).toBe(false)
    expect(
      validateGeoPoint({ latitude: undefined, longitude: undefined, accuracyMeters: undefined }).ok
    ).toBe(false)
  })
})

describe('gcj02ToWgs84Approx', () => {
  it('标注为近似并给出误差上限', () => {
    const r = gcj02ToWgs84Approx(30.556, 103.989)
    expect(r.approximate).toBe(true)
    expect(r.maxErrorMeters).toBe(GCJ02_MAX_OFFSET_METERS)
  })

  it('在中国境内会产生非零偏移（GCJ-02 加密区）', () => {
    const r = gcj02ToWgs84Approx(30.556, 103.989)
    const shifted = haversineMeters(
      { latitude: 30.556, longitude: 103.989 },
      { latitude: r.latitude, longitude: r.longitude }
    )
    expect(shifted).toBeGreaterThan(100)
    expect(shifted).toBeLessThan(GCJ02_MAX_OFFSET_METERS)
  })

  it('结果仍是合法坐标', () => {
    const r = gcj02ToWgs84Approx(30.556, 103.989)
    expect(validateGeoPoint({ latitude: r.latitude, longitude: r.longitude, accuracyMeters: 10 }).ok).toBe(true)
  })
})

describe('haversineMeters', () => {
  it('相同点距离为 0', () => {
    expect(haversineMeters({ latitude: 30, longitude: 103 }, { latitude: 30, longitude: 103 })).toBe(0)
  })

  it('已知距离：赤道上 1 度经度约 111.19 km', () => {
    const d = haversineMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 })
    expect(d).toBeGreaterThan(111_000)
    expect(d).toBeLessThan(112_000)
  })

  it('对称性', () => {
    const a = { latitude: 30.5, longitude: 103.9 }
    const b = { latitude: 30.6, longitude: 104.0 }
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 6)
  })

  it('跨半球大距离不超过半周长', () => {
    const d = haversineMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 180 })
    expect(d).toBeLessThan(20_100_000)
  })
})

describe('isValidCustomTileUrl', () => {
  it('接受合法且安全的 HTTPS 瓦片 URL 模板', () => {
    expect(isValidCustomTileUrl('https://tile.openstreetmap.org/{z}/{x}/{y}.png')).toBe(true)
    expect(isValidCustomTileUrl('https://my-cdn.com/maps/{z}/{x}/{y}?token=abc')).toBe(true)
  })

  it('拒绝非 HTTPS 协议 (http, file, data, javascript 等)', () => {
    expect(isValidCustomTileUrl('http://insecure.com/tiles/{z}/{x}/{y}.png')).toBe(false)
    expect(isValidCustomTileUrl('file:///C:/tiles/{z}/{x}/{y}.png')).toBe(false)
    expect(isValidCustomTileUrl('data:text/html,{z}{x}{y}')).toBe(false)
    expect(isValidCustomTileUrl('javascript:alert(1)')).toBe(false)
  })

  it('拒绝缺少 {z}、{x} 或 {y} 占位符的非法 URL', () => {
    expect(isValidCustomTileUrl('https://example.com/tiles/{z}/{x}.png')).toBe(false)
    expect(isValidCustomTileUrl('https://example.com/tiles/{x}/{y}.png')).toBe(false)
    expect(isValidCustomTileUrl('https://example.com/tiles/{z}/{y}.png')).toBe(false)
    expect(isValidCustomTileUrl('https://example.com/tiles/plain.png')).toBe(false)
    expect(isValidCustomTileUrl('')).toBe(false)
    expect(isValidCustomTileUrl(null as any)).toBe(false)
  })
})

