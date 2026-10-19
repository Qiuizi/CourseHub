/**
 * 坐标与定位参数校验。
 *
 * 契约（开发文档 §7.2）：内部一律以 WGS-84 存储。
 * latitude ∈ [-90,90]、longitude ∈ [-180,180]、accuracyMeters > 0，
 * 且三者都必须是有限数。GCJ-02 仅在显示层做近似换算，必须标注误差。
 */

export interface GeoPoint {
  latitude: number
  longitude: number
  accuracyMeters: number
}

export type GeoValidationError =
  | 'LATITUDE_OUT_OF_RANGE'
  | 'LONGITUDE_OUT_OF_RANGE'
  | 'ACCURACY_INVALID'
  | 'NOT_FINITE'

export interface GeoValidationOk {
  ok: true
  point: GeoPoint
}

export interface GeoValidationFail {
  ok: false
  errors: GeoValidationError[]
}

export type GeoValidationResult = GeoValidationOk | GeoValidationFail

/** WGS-84 相对 GCJ-02 的最大偏移量（米），用于向用户标注近似误差。 */
export const GCJ02_MAX_OFFSET_METERS = 800

export function validateGeoPoint(input: {
  latitude: unknown
  longitude: unknown
  accuracyMeters: unknown
}): GeoValidationResult {
  const errors: GeoValidationError[] = []
  const { latitude, longitude, accuracyMeters } = input

  if (
    typeof latitude !== 'number' ||
    typeof longitude !== 'number' ||
    typeof accuracyMeters !== 'number' ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    !Number.isFinite(accuracyMeters)
  ) {
    return { ok: false, errors: ['NOT_FINITE'] }
  }

  if (latitude < -90 || latitude > 90) errors.push('LATITUDE_OUT_OF_RANGE')
  if (longitude < -180 || longitude > 180) errors.push('LONGITUDE_OUT_OF_RANGE')
  if (accuracyMeters <= 0) errors.push('ACCURACY_INVALID')

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    point: { latitude, longitude, accuracyMeters }
  }
}

/**
 * GCJ-02 -> WGS-84 近似反偏移。
 *
 * 注意：这是**近似**算法，不是精确解算。GCJ-02 的加密算法官方未公开，
 * 不存在精确逆变换。本函数只用于「地图来源是 GCJ-02 时给出一个大致 WGS-84 值」，
 * 调用方必须把 GCJ02_MAX_OFFSET_METERS 作为误差一并展示。
 */
export function gcj02ToWgs84Approx(
  latitude: number,
  longitude: number
): { latitude: number; longitude: number; approximate: true; maxErrorMeters: number } {
  const a = 6378245.0
  const ee = 0.00669342162296594323

  const transformLat = (x: number, y: number): number => {
    let ret =
      -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
    ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0
    ret += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0
    ret += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0
    return ret
  }

  const transformLon = (x: number, y: number): number => {
    let ret =
      300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
    ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0
    ret += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0
    ret += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0
    return ret
  }

  const dLat = transformLat(longitude - 105.0, latitude - 35.0)
  const dLon = transformLon(longitude - 105.0, latitude - 35.0)
  const radLat = (latitude / 180.0) * Math.PI
  let magic = Math.sin(radLat)
  magic = 1 - ee * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  const dLat2 = (dLat * 180.0) / (((a * (1 - ee)) / (magic * sqrtMagic)) * Math.PI)
  const dLon2 = (dLon * 180.0) / ((a / sqrtMagic) * Math.cos(radLat) * Math.PI)

  return {
    latitude: latitude - dLat2,
    longitude: longitude - dLon2,
    approximate: true,
    maxErrorMeters: GCJ02_MAX_OFFSET_METERS
  }
}

/** 两点球面距离（米），用于覆盖前后误差对比。 */
export function haversineMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number }
): number {
  const R = 6371008.8
  const toRad = (d: number): number => (d * Math.PI) / 180
  const dLat = toRad(b.latitude - a.latitude)
  const dLon = toRad(b.longitude - a.longitude)
  const lat1 = toRad(a.latitude)
  const lat2 = toRad(b.latitude)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** 严格校验自定义瓦片 URL 模板：必须为 https:// 协议且包含 {z}、{x}、{y} 占位符 */
export function isValidCustomTileUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false
  const trimmed = url.trim()
  if (!trimmed.startsWith('https://')) return false
  try {
    const dummy = trimmed.replace(/\{[a-z0-9_]+\}/gi, '0')
    const parsed = new URL(dummy)
    if (parsed.protocol !== 'https:') return false
  } catch {
    return false
  }
  return trimmed.includes('{z}') && trimmed.includes('{x}') && trimmed.includes('{y}')
}
