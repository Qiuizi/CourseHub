import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'node:path'
import { TestbedServer } from '../../src/main/testbed/testbed-server'

describe('TestbedServer 本地测试服务端双向闭环', () => {
  const fixturesDir = path.resolve(__dirname, '..', 'fixtures')
  let server: TestbedServer
  let baseUrl: string

  beforeAll(async () => {
    server = new TestbedServer(fixturesDir)
    const port = await server.start()
    baseUrl = `http://127.0.0.1:${port}`
  })

  afterAll(async () => {
    await server.stop()
  })

  it('GET /api/activities 返回活动列表并标明类型', async () => {
    const res = await fetch(`${baseUrl}/api/activities`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as any
    expect(json.ok).toBe(true)
    expect(json.activities.length).toBe(2)
    expect(json.activities.some((a: any) => a.kind === 'normal')).toBe(true)
    expect(json.activities.some((a: any) => a.kind === 'location')).toBe(true)
  })

  it('普通打卡成功，并在服务端生成已打卡记录', async () => {
    const res = await fetch(`${baseUrl}/api/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activityId: 'test-srv-sign-01' })
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as any
    expect(json.ok).toBe(true)
    expect(json.code).toBe('SUCCESS')

    // 查询状态校验服务端真实记录
    const statusRes = await fetch(`${baseUrl}/api/signin/status?activityId=test-srv-sign-01`)
    const statusJson = (await statusRes.json()) as any
    expect(statusJson.status).toBe('checked_in')
    expect(statusJson.record.status).toBe('checked_in')
  })

  it('普通打卡重复提交被服务端 409 拒绝', async () => {
    const res = await fetch(`${baseUrl}/api/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activityId: 'test-srv-sign-01' })
    })
    expect(res.status).toBe(409)
    const json = (await res.json()) as any
    expect(json.ok).toBe(false)
    expect(json.code).toBe('ALREADY_SIGNED')
  })

  it('定位打卡缺少坐标时被服务端 400 拒绝', async () => {
    const res = await fetch(`${baseUrl}/api/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activityId: 'test-srv-sign-02' })
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as any
    expect(json.ok).toBe(false)
    expect(json.code).toBe('LOCATION_REQUIRED')
  })

  it('定位打卡超出容差（如成都坐标距离北京~1500km）被服务端 400 拒绝', async () => {
    const res = await fetch(`${baseUrl}/api/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activityId: 'test-srv-sign-02',
        latitude: 30.6572,
        longitude: 104.0657,
        accuracy: 30
      })
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as any
    expect(json.ok).toBe(false)
    expect(json.code).toBe('OUT_OF_RANGE')
    expect(json.distanceMeters).toBeGreaterThan(1000 * 1000)

    // 状态确认为未签到
    const statusRes = await fetch(`${baseUrl}/api/signin/status?activityId=test-srv-sign-02`)
    const statusJson = (await statusRes.json()) as any
    expect(statusJson.status).toBe('open')
    expect(statusJson.record).toBeNull()
  })

  it('定位打卡在容差内（北京天安门 39.9042, 116.4074）通过服务端验证并记录', async () => {
    const res = await fetch(`${baseUrl}/api/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activityId: 'test-srv-sign-02',
        latitude: 39.9042,
        longitude: 116.4074,
        accuracy: 25
      })
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as any
    expect(json.ok).toBe(true)
    expect(json.code).toBe('SUCCESS')
    expect(json.record.distanceMeters).toBeLessThanOrEqual(50)

    // 查询状态确认为 checked_in
    const statusRes = await fetch(`${baseUrl}/api/signin/status?activityId=test-srv-sign-02`)
    const statusJson = (await statusRes.json()) as any
    expect(statusJson.status).toBe('checked_in')
    expect(statusJson.record.coords.latitude).toBe(39.9042)
  })

  it('POST /api/reset 重置全部打卡记录', async () => {
    const res = await fetch(`${baseUrl}/api/reset`, { method: 'POST' })
    expect(res.status).toBe(200)

    const statusRes = await fetch(`${baseUrl}/api/signin/status?activityId=test-srv-sign-02`)
    const statusJson = (await statusRes.json()) as any
    expect(statusJson.status).toBe('open')
    expect(statusJson.record).toBeNull()
  })
})
